// Portal placement, ported from the Portal SDK (server/portal/portal_placement.cpp and
// CWeaponPortalgun::TraceFirePortal). A shot gives a surface point and normal; the portal is
// then bumped around until its corners all sit on that surface, clear of walls, other portals
// and portal bumpers, and judged valid or not. Returns Source's "analog success" values: below
// 0.5 the portal fizzles.
import { Contents, type CollisionModel, type CollisionWorld, type Trace, type Vec3 } from '../physics/collision';
import { PORTAL_HALF_HEIGHT, PORTAL_HALF_WIDTH, vectorAngles } from '../render/portals';

export const PORTAL_BUMP_FORGIVENESS = 2;

export const PlacementSuccess = {
    NoBump: 1.0,
    Bumped: 0.3,
    CantFit: 0.1,
    Cleanser: 0.028,
    OverlapLinked: 0.027,
    Near: 0.0265,
    InvalidVolume: 0.026,
    InvalidSurface: 0.025,
    PassthroughSurface: 0.0,
} as const;

export enum PlacedBy {
    Fixed,
    Pedestal,
    Player,
}

/** A brush entity that steers placement: soft bumpers, cleansers and no-portal volumes. */
export interface PlacementVolume {
    classname: 'func_portal_bumper' | 'trigger_portal_cleanser' | 'func_noportal_volume';
    key: object;
    mins: Vec3;
    maxs: Vec3;
    active: boolean;
}

/** A func_portal_orientation volume. */
export interface OrientationVolume {
    mins: Vec3;
    maxs: Vec3;
    anglesToFace: Vec3;
    matchLinkedAngles: boolean;
    active: boolean;
}

export interface PlacedPortal {
    key: object;
    origin: Vec3;
    angles: Vec3;
    active: boolean;
    /** The portal it's linked to, if any. */
    linked: PlacedPortal | null;
}

export interface PlacementEnv {
    collision: CollisionWorld;
    /** Surface of a brush side's texinfo: SURF_NOPORTAL or glass, and pass-through materials. */
    surface(texInfo: number): { noPortal: boolean; passThrough: boolean };
    /** Classname of the entity owning a collision model ('' for the world). */
    classOf(model: CollisionModel | undefined): string;
    /** Whether a collision model is moving right now. */
    isMoving(model: CollisionModel | undefined): boolean;
    /** Models shots pass through (UTIL_Portal_Trace_Filter: physics props and the like). */
    shotIgnores(): CollisionModel[];
    volumes(): PlacementVolume[];
    orientationVolumes(): OrientationVolume[];
    portals(): PlacedPortal[];
}

const MASK_SHOT_PORTAL = Contents.Solid | Contents.Moveable | Contents.Window | Contents.Monster;
const MASK_SOLID_BRUSHONLY = Contents.Solid | Contents.Moveable | Contents.Window | Contents.Grate;
const MAXIMUM_BUMP_DISTANCE = ((PORTAL_HALF_WIDTH * 2) ** 2 + (PORTAL_HALF_HEIGHT * 2) ** 2) / 2;
const MAX_TRACE_LENGTH = 1.732050807569 * 2 * 16384;
const LOCAL_MINS: Vec3 = [0, -PORTAL_HALF_WIDTH, -PORTAL_HALF_HEIGHT];
const LOCAL_MAXS: Vec3 = [64, PORTAL_HALF_WIDTH, PORTAL_HALF_HEIGHT];

// ---------------------------------------------------------------- vector helpers

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => {
    const l = length(a);
    return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
};
const isZero = (a: Vec3) => a[0] === 0 && a[1] === 0 && a[2] === 0;

/** mathlib AngleVectors: forward, right, up for Source angles [pitch, yaw, roll]. */
export function angleVectors(a: Vec3): { forward: Vec3; right: Vec3; up: Vec3 } {
    const d = Math.PI / 180;
    const sp = Math.sin(a[0] * d), cp = Math.cos(a[0] * d);
    const sy = Math.sin(a[1] * d), cy = Math.cos(a[1] * d);
    const sr = Math.sin(a[2] * d), cr = Math.cos(a[2] * d);
    return {
        forward: [cp * cy, cp * sy, -sp],
        right: [-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp],
        up: [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp],
    };
}

/** CalcDistanceToLine: distance from p to the infinite line through a and b. */
function distanceToLine(p: Vec3, a: Vec3, b: Vec3): number {
    const ab = sub(b, a);
    const len2 = dot(ab, ab);
    const t = len2 > 0 ? dot(sub(p, a), ab) / len2 : 0;
    return length(sub(p, add(a, scale(ab, t))));
}

/** CalcLineToLineIntersectionSegment: closest points between lines p1-p2 and p3-p4. */
function lineToLine(p1: Vec3, p2: Vec3, p3: Vec3, p4: Vec3): { a: Vec3; b: Vec3 } | null {
    const p13 = sub(p1, p3), p43 = sub(p4, p3), p21 = sub(p2, p1);
    if (length(p43) < 1e-6 || length(p21) < 1e-6) return null;
    const d1343 = dot(p13, p43), d4321 = dot(p43, p21), d1321 = dot(p13, p21);
    const d4343 = dot(p43, p43), d2121 = dot(p21, p21);
    const denom = d2121 * d4343 - d4321 * d4321;
    if (Math.abs(denom) < 1e-6) return null;
    const mua = (d1343 * d4321 - d1321 * d4343) / denom;
    const mub = (d1343 + d4321 * mua) / d4343;
    return { a: add(p1, scale(p21, mua)), b: add(p3, scale(p43, mub)) };
}

/** Clips a segment to an axis-aligned box: entry fraction and face normal, or null. */
function rayBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3): { fraction: number; normal: Vec3; startSolid: boolean } | null {
    const d = sub(end, start);
    let tmin = -Infinity, tmax = Infinity;
    let normal: Vec3 = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-9) {
            if (start[a] < mins[a] || start[a] > maxs[a]) return null;
            continue;
        }
        let t1 = (mins[a] - start[a]) / d[a], t2 = (maxs[a] - start[a]) / d[a];
        let n = -1;
        if (t1 > t2) {
            [t1, t2] = [t2, t1];
            n = 1;
        }
        if (t1 > tmin) {
            tmin = t1;
            normal = [0, 0, 0];
            normal[a] = n;
        }
        tmax = Math.min(tmax, t2);
    }
    if (tmin > tmax || tmax < 0 || tmin > 1) return null;
    return { fraction: Math.max(0, tmin), normal, startSolid: tmin < 0 };
}

/** Separating-axis test between two oriented boxes given as centers, unit axes and half sizes. */
function obbOverlap(ca: Vec3, axesA: Vec3[], ha: number[], cb: Vec3, axesB: Vec3[], hb: number[]): boolean {
    const t = sub(cb, ca);
    const axes: Vec3[] = [...axesA, ...axesB];
    for (const u of axesA) for (const v of axesB) {
        const c = cross(u, v);
        if (length(c) > 1e-6) axes.push(normalize(c));
    }
    for (const L of axes) {
        const ra = axesA.reduce((s, u, i) => s + Math.abs(dot(u, L)) * ha[i], 0);
        const rb = axesB.reduce((s, v, i) => s + Math.abs(dot(v, L)) * hb[i], 0);
        if (Math.abs(dot(t, L)) > ra + rb) return false;
    }
    return true;
}

/** A portal's local OBB (mins/maxs in its forward/left/up frame) as center + axes + halves. */
function portalOBB(origin: Vec3, angles: Vec3, mins: Vec3, maxs: Vec3) {
    const { forward, right, up } = angleVectors(angles);
    const left = scale(right, -1);
    const axes = [forward, left, up];
    const mid = [0, 1, 2].map((i) => (mins[i] + maxs[i]) / 2);
    const center = add(origin, add(add(scale(forward, mid[0]), scale(left, mid[1])), scale(up, mid[2])));
    return { center, axes, halves: [0, 1, 2].map((i) => (maxs[i] - mins[i]) / 2) };
}

const AXES: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// ---------------------------------------------------------------- traces

/** A trace_t as placement uses it. */
interface PTrace {
    fraction: number;
    normal: Vec3;
    startSolid: boolean;
    fractionLeftSolid: number;
    model?: CollisionModel;
    surface?: number;
    /** The bumper volume that was hit (TraceBumpingEntities). */
    volume?: PlacementVolume;
}

const clearTrace = (): PTrace => ({ fraction: 1, normal: [0, 0, 0], startSolid: false, fractionLeftSolid: 0 });

/** One placement attempt: the environment plus Source's per-attempt globals. */
class Placer {
    /** g_FuncBumpingEntityList: soft bumpers that have already bumped this attempt. */
    private bumped = new Set<object>();
    /** g_bBumpedByLinkedPortal */
    bumpedByLinkedPortal = false;

    constructor(readonly env: PlacementEnv, readonly ignore: object | null) {}

    line(start: Vec3, end: Vec3, mask: number): PTrace {
        const tr: Trace = this.env.collision.trace(start, end, [0, 0, 0], [0, 0, 0], mask, false);
        return { fraction: tr.fraction, normal: tr.normal, startSolid: tr.startSolid, fractionLeftSolid: tr.fractionLeftSolid, model: tr.model, surface: tr.surface };
    }

    surfaceOf(tr: PTrace) {
        if (tr.volume) return { noPortal: false, passThrough: false };
        // Model hulls are studio models: "**studio**" surfaces take no portals.
        if (tr.surface === undefined) return { noPortal: true, passThrough: false };
        return this.env.surface(tr.surface);
    }

    otherPortals() {
        return this.env.portals().filter((p) => p.key !== this.ignore && p.active);
    }

    /** TracePortals: the nearest other portal on the same face along a ray, as an AABB. */
    tracePortals(forward: Vec3, start: Vec3, end: Vec3): PTrace {
        let tr = clearTrace();
        for (const p of this.otherPortals()) {
            if (dot(forward, angleVectors(p.angles).forward) < 0.95) continue;
            const obb = portalOBB(p.origin, p.angles, LOCAL_MINS, LOCAL_MAXS);
            const ext = [0, 1, 2].map((a) => obb.axes.reduce((s, ax, i) => s + Math.abs(ax[a]) * obb.halves[i], 0));
            const hit = rayBox(start, end, sub(obb.center, ext as Vec3), add(obb.center, ext as Vec3));
            if (hit && hit.fraction < 1 && hit.fraction < tr.fraction) tr = { ...clearTrace(), fraction: hit.fraction, normal: hit.normal };
        }
        return tr;
    }

    /** TraceBumpingEntities: the nearest bumper, cleanser or no-portal volume along a ray. Returns whether it's soft. */
    traceBumpingEntities(start: Vec3, end: Vec3, out: PTrace): boolean {
        Object.assign(out, clearTrace());
        let soft = false;
        const len = length(sub(end, start));
        for (const v of this.env.volumes()) {
            const hit = rayBox(start, end, v.mins, v.maxs);
            if (!hit) continue;
            let tr: PTrace = { ...clearTrace(), fraction: hit.fraction, normal: hit.normal, startSolid: hit.startSolid, volume: v };
            const isSoft = v.classname === 'func_portal_bumper';
            if (v.classname === 'func_noportal_volume') {
                if (!v.active) continue;
                // Bump by an extra 2 units so that the portal isn't touching the no portal volume.
                const l = Math.max(0, hit.fraction * len - 2);
                tr.fraction = len > 0 ? l / len : 0;
            } else if (hit.startSolid) {
                tr = clearTrace();
            }
            if (tr.fraction < out.fraction && (!isSoft || !this.bumped.has(v.key))) {
                Object.assign(out, tr);
                soft = isSoft;
            }
        }
        return soft;
    }

    /** TracePortalCorner: what stops the portal's edge between its center and a corner. */
    tracePortalCorner(origin: Vec3, corner: Vec3, forward: Vec3, placedBy: PlacedBy): { hit: boolean; tr: PTrace; soft: boolean } {
        const toCorner = sub(corner, origin);
        const back = (p: Vec3) => sub(p, forward);

        // Surface edge: walk just behind the surface toward the corner until it leaves the wall.
        let edge = this.line(back(origin), back(corner), MASK_SHOT_PORTAL);
        let edgeFraction = 1;
        let edgeNormal: Vec3 = [0, 0, 0];
        if (edge.startSolid) {
            let total = edge.fractionLeftSolid;
            while (edge.startSolid && edge.fractionLeftSolid > 0 && total < 1) {
                edge = this.line(back(add(origin, scale(toCorner, total + 0.05))), back(add(corner, scale(toCorner, total + 0.05))), MASK_SHOT_PORTAL);
                if (edge.startSolid) total += edge.fractionLeftSolid + 0.05;
            }
            if (total < 1) {
                edge = this.line(back(add(origin, scale(toCorner, total + 0.05))), back(origin), MASK_SHOT_PORTAL);
                if (!edge.startSolid) {
                    edgeFraction = total;
                    edgeNormal = scale(edge.normal, -1);
                }
            }
        }

        // Enclosing wall: something in front of the surface that the portal would cut into.
        const wall = this.line(add(origin, forward), add(corner, forward), MASK_SOLID_BRUSHONLY | Contents.Monster);
        if (edgeFraction < wall.fraction) {
            wall.fraction = edgeFraction;
            wall.normal = edgeNormal;
        }

        const portal = placedBy !== PlacedBy.Fixed ? this.tracePortals(forward, add(origin, forward), add(corner, forward)) : clearTrace();
        const bumper = clearTrace();
        const softBumper = this.traceBumpingEntities(add(origin, forward), add(corner, forward), bumper);

        if (wall.fraction >= 1 && portal.fraction >= 1 && bumper.fraction >= 1) return { hit: false, tr: clearTrace(), soft: false };
        if (wall.fraction <= portal.fraction && wall.fraction <= bumper.fraction) return { hit: true, tr: wall, soft: false };
        if (portal.fraction <= wall.fraction && portal.fraction <= bumper.fraction) {
            this.bumpedByLinkedPortal = true;
            return { hit: true, tr: portal, soft: false };
        }
        if (!bumper.startSolid && bumper.fraction <= wall.fraction && bumper.fraction <= portal.fraction) return { hit: true, tr: bumper, soft: softBumper };
        return { hit: false, tr: clearTrace(), soft: false };
    }

    /** FitPortalOnSurface: bumps `o.origin` until no corner is cut off. Returns whether it fits. */
    fitPortalOnSurface(
        o: { origin: Vec3 },
        forward: Vec3,
        right: Vec3,
        edges: { top: Vec3; bottom: Vec3; right: Vec3; left: Vec3 },
        placedBy: PlacedBy,
        recursions = 0,
        fitIn?: CornerFit[],
        indexIn?: number[],
        countIn = 0,
    ): boolean {
        if (recursions >= 6) return false;
        const origin = o.origin;
        const corners: Vec3[] = [
            add(add(origin, edges.top), edges.left),
            add(add(origin, edges.top), edges.right),
            add(add(origin, edges.bottom), edges.left),
            add(add(origin, edges.bottom), edges.right),
        ];
        const fit: CornerFit[] = fitIn ? fitIn.map((f) => ({ ...f })) : [0, 1, 2, 3].map(() => emptyFit());
        const index = indexIn ? [...indexIn] : [0, 0, 0, 0];
        let count = countIn;
        const oldCount = count;
        const recurse = (n: number) => this.fitPortalOnSurface(o, forward, right, edges, placedBy, recursions + 1, fit, index, n);

        for (let i = 0; i < 4; i++) {
            if (count >= 4) continue; // Source guards against indexing past its arrays
            if (!fit[i].corner) {
                const r = this.tracePortalCorner(origin, corners[i], forward, placedBy);
                fit[i].corner = r.hit;
                fit[i].tr = r.tr;
                fit[i].soft = r.soft;
                if (isZero(fit[i].tr.normal)) fit[i].corner = false;
                if (fit[i].corner) {
                    fit[i].point = add(origin, scale(sub(corners[i], origin), fit[i].tr.fraction));
                    fit[i].tr.normal = normalize(fit[i].tr.normal);
                    fit[i].dir = normalize(cross(fit[i].tr.normal, forward));
                    fit[i].bump = normalize(cross(forward, fit[i].dir));
                    index[count++] = i;
                }
            } else {
                // We shouldn't be intersecting with any old corners.
                fit[i].tr.fraction = 1;
            }
        }
        for (const f of fit) if (f.soft && f.tr.volume) this.bumped.add(f.tr.volume.key);

        if (oldCount === count) return true;
        const F = (k: number) => fit[index[k]];
        const C = (k: number) => corners[index[k]];

        /** Scoot away from one of two parallel intersections, toward the side without a wall. */
        const scootFromParallel = (dirOf: CornerFit, clear: number[]) => {
            const a = this.tracePortalCorner(origin, add(origin, scale(dirOf.dir, PORTAL_HALF_WIDTH * 2)), forward, placedBy);
            const b = this.tracePortalCorner(origin, add(origin, scale(dirOf.dir, -PORTAL_HALF_WIDTH * 2)), forward, placedBy);
            let dir1 = a.hit;
            const dir2 = b.hit;
            if (dir1 && dir2) {
                if (a.soft) dir1 = false;
                else if (b.soft) dir1 = true;
                else return false;
            }
            if (!dir1 && !dir2) dir1 = true;
            o.origin = add(o.origin, scale(dirOf.dir, dir1 ? -PORTAL_HALF_WIDTH : PORTAL_HALF_WIDTH));
            for (const k of clear) fit[index[k]].corner = false;
            return recurse(0);
        };

        switch (count) {
            case 0:
                return true;

            case 1: {
                const d = distanceToLine(C(0), F(0).point, add(F(0).point, F(0).dir)) + PORTAL_BUMP_FORGIVENESS;
                o.origin = add(o.origin, scale(F(0).bump, d));
                return recurse(count);
            }

            case 2: {
                if (length(sub(F(0).point, F(1).point)) === 0) return false;
                const fDot = dot(F(0).bump, F(1).bump);
                if (fDot < -0.9) return scootFromParallel(F(0), [0, 1]);
                if (fDot > 0.9) {
                    const closest = length(sub(origin, F(0).point)) < length(sub(origin, F(1).point)) ? 0 : 1;
                    const bumpDist = [0, 1].map((k) => distanceToLine(C(k), F(closest).point, add(F(closest).point, F(closest).dir)) + PORTAL_BUMP_FORGIVENESS);
                    const largest = bumpDist[0] > bumpDist[1] ? 0 : 1;
                    o.origin = add(o.origin, scale(F(closest).bump, bumpDist[largest]));
                    if (bumpDist[0] === bumpDist[1]) {
                        F(0).corner = false;
                        F(1).corner = false;
                        return recurse(0);
                    }
                    if (largest !== closest) fit[index[largest]] = { ...F(closest) };
                    fit[index[largest === 0 ? 1 : 0]].corner = false;
                    index[0] = index[largest];
                    return recurse(1);
                }
                o.origin = add(o.origin, bumpVectorInCorner(C(0), C(1), F(0), F(1)));
                return recurse(count);
            }

            case 3: {
                const fDot = [dot(F(0).bump, F(1).bump), dot(F(1).bump, F(2).bump), dot(F(2).bump, F(0).bump)];
                let similar = 0;
                for (let k = 0; k < 3; k++) {
                    if (fDot[k] < -0.99) return scootFromParallel(F(k), [0, 1, 2]);
                    if (fDot[k] > 0.99) similar++;
                }
                if (similar === 0) {
                    const total = fDot.reduce((s, d) => s + Math.acos(Math.max(-1, Math.min(1, d))), 0);
                    // In a triangle: it can't be fit, unless a soft bumper might give way.
                    if (Math.PI - 0.01 < total && total < Math.PI + 0.01) {
                        if (F(0).soft || F(1).soft || F(2).soft) {
                            for (const k of [0, 1, 2]) F(k).corner = false;
                            return recurse(0);
                        }
                        return false;
                    }
                }
                if (similar === 3) {
                    let closest = 0;
                    let closestDist = length(sub(origin, F(0).point));
                    for (const k of [1, 2]) {
                        const dk = length(sub(origin, F(k).point));
                        if (closestDist > dk) {
                            closest = k;
                            closestDist = dk;
                        }
                    }
                    const bumpDist = [0, 1, 2].map((k) => distanceToLine(C(k), F(closest).point, add(F(closest).point, F(closest).dir)) + PORTAL_BUMP_FORGIVENESS);
                    let largest = bumpDist[0] > bumpDist[1] ? 0 : 1;
                    largest = bumpDist[largest] > bumpDist[2] ? largest : 2;
                    o.origin = add(o.origin, scale(F(closest).bump, bumpDist[largest]));
                    let still = 0;
                    const closestFit = { ...F(closest) };
                    for (let k = 0; k < 3; k++) {
                        if (bumpDist[k] !== bumpDist[largest]) {
                            fit[index[k]].corner = false;
                            count--;
                        } else {
                            fit[index[k]] = { ...closestFit };
                            index[still++] = index[k];
                        }
                    }
                    return recurse(count);
                }
                // Which corners are diagonal from each other.
                let longest = 0, longestK = 0;
                for (let k = 0; k < 3; k++) {
                    const dk = length(sub(C(k), C((k + 1) % 3)));
                    if (longest < dk) {
                        longest = dk;
                        longestK = k;
                    }
                }
                const [i1, i2, i3] = longestK === 0 ? [0, 1, 2] : longestK === 1 ? [1, 2, 0] : [2, 0, 1];
                // A 90 degree corner lined up with the portal can be bumped out of directly.
                const cornerDot = dot(F(i1).dir, F(i2).dir);
                if (cornerDot < 0.0001 && cornerDot > -0.0001) {
                    const portalDot = dot(F(i1).dir, right);
                    if ((portalDot < 0.0001 && portalDot > -0.0001) || portalDot > 0.9999 || portalDot < -0.9999) {
                        const b1 = distanceToLine(C(i1), F(i1).point, add(F(i1).point, F(i1).dir)) + PORTAL_BUMP_FORGIVENESS;
                        const b2 = distanceToLine(C(i2), F(i2).point, add(F(i2).point, F(i2).dir)) + PORTAL_BUMP_FORGIVENESS;
                        o.origin = add(add(o.origin, scale(F(i1).bump, b1)), scale(F(i2).bump, b2));
                        for (const k of [i1, i2, i3]) F(k).corner = false;
                        return recurse(0);
                    }
                }
                o.origin = add(o.origin, bumpVectorInCorner(C(i1), C(i2), F(i1), F(i2)));
                F(i3).corner = false;
                return recurse(0);
            }

            default: {
                if ([0, 1, 2, 3].some((k) => F(k).soft)) {
                    for (const k of [0, 1, 2, 3]) F(k).corner = false;
                    return recurse(0);
                }
                // All corners intersect with no soft bumps, so it can't be fit.
                return false;
            }
        }
    }

    /** FitPortalAroundOtherPortals: slide sideways off a portal already on this face. */
    fitAroundOtherPortals(o: { origin: Vec3 }, forward: Vec3, right: Vec3, up: Vec3) {
        for (const p of this.otherPortals()) {
            if (dot(forward, angleVectors(p.angles).forward) < 0.95) continue;
            const diff = sub(o.origin, p.origin);
            let projRight = scale(right, dot(diff, right));
            const projUp = scale(up, dot(diff, up));
            const rightLen = length(projRight);
            const upLen = length(projUp);
            projRight = rightLen < 1 ? right : normalize(projRight);
            if (upLen < PORTAL_HALF_HEIGHT && rightLen < PORTAL_HALF_WIDTH) {
                o.origin = add(o.origin, scale(projRight, PORTAL_HALF_WIDTH - rightLen + 1));
            }
        }
    }

    /** IsPortalIntersectingNoPortalVolume */
    inNoPortalVolume(origin: Vec3, angles: Vec3, forward: Vec3): boolean {
        const { right, up } = angleVectors(angles);
        for (const v of this.env.volumes()) {
            if (v.classname !== 'func_noportal_volume' || !v.active) continue;
            const center = scale(add(v.mins, v.maxs), 0.5);
            // Bump forgiveness on the axes the portal lies along.
            const ext = [0, 1, 2].map((a) => (v.maxs[a] - v.mins[a]) / 2 + (Math.abs(forward[a]) > 0.5 ? 0 : -PORTAL_BUMP_FORGIVENESS));
            // The portal as a flat rectangle (its two triangles).
            if (obbOverlap(center, AXES, ext, origin, [right, up], [PORTAL_HALF_WIDTH, PORTAL_HALF_HEIGHT])) return true;
        }
        return false;
    }

    /** IsPortalOverlappingOtherPortals */
    overlapsOtherPortals(origin: Vec3, angles: Vec3): boolean {
        const forward = angleVectors(angles).forward;
        const mins = add(LOCAL_MINS, [1, 1, 1]);
        const maxs = sub(LOCAL_MAXS, [1, 1, 1]);
        const a = portalOBB(origin, angles, mins, maxs);
        for (const p of this.otherPortals()) {
            if (dot(forward, angleVectors(p.angles).forward) < 0.95) continue;
            const b = portalOBB(p.origin, p.angles, mins, maxs);
            if (obbOverlap(a.center, a.axes, a.halves, b.center, b.axes, b.halves)) return true;
        }
        return false;
    }

    /** IsPortalOnValidSurface: the center and corners all on portalable, solid, still surfaces. */
    onValidSurface(origin: Vec3, forward: Vec3, right: Vec3, up: Vec3): boolean {
        const h = PORTAL_HALF_HEIGHT - PORTAL_BUMP_FORGIVENESS * 1.1;
        const w = PORTAL_HALF_WIDTH - PORTAL_BUMP_FORGIVENESS * 1.1;
        const points = [
            add(add(origin, scale(up, h)), scale(right, -w)),
            add(add(origin, scale(up, h)), scale(right, w)),
            add(add(origin, scale(up, -h)), scale(right, -w)),
            add(add(origin, scale(up, -h)), scale(right, w)),
            origin,
        ];
        for (const pt of points) {
            let tr = this.line(add(pt, forward), sub(pt, forward), MASK_SOLID_BRUSHONLY);
            if (tr.startSolid) return false;
            if (tr.fraction === 1) {
                // A portal bumper can act as the surface.
                tr = clearTrace();
                this.traceBumpingEntities(add(pt, forward), sub(pt, forward), tr);
                if (tr.fraction === 1) return false;
            }
            if (this.env.classOf(tr.model) === 'func_door') return false;
            const s = this.surfaceOf(tr);
            if (s.passThrough || s.noPortal) return false;
        }
        return true;
    }

    /** VerifyPortalPlacement: fits and validates a portal; updates `o.origin`. */
    verify(o: { origin: Vec3 }, angles: Vec3, placedBy: PlacedBy, test = false): number {
        const original: Vec3 = [...o.origin];
        let { forward, right, up } = angleVectors(angles);
        [forward, right, up] = [normalize(forward), normalize(right), normalize(up)];

        // The center must be on a surface.
        const tr = this.line(add(o.origin, forward), sub(o.origin, forward), MASK_SHOT_PORTAL);
        if (tr.fraction === 1) return PlacementSuccess.InvalidSurface;
        if (this.env.isMoving(tr.model)) return PlacementSuccess.InvalidSurface;
        const s = this.surfaceOf(tr);
        if (s.passThrough) return PlacementSuccess.PassthroughSurface;
        if (s.noPortal) return PlacementSuccess.InvalidSurface;

        this.bumpedByLinkedPortal = false;
        // Bump away from linked portal so it can be fit next to it.
        if (placedBy === PlacedBy.Player) this.fitAroundOtherPortals(o, forward, right, up);

        const top = scale(up, PORTAL_HALF_HEIGHT - PORTAL_BUMP_FORGIVENESS);
        const rightEdge = scale(right, PORTAL_HALF_WIDTH - PORTAL_BUMP_FORGIVENESS);
        this.bumped.clear();
        if (!this.fitPortalOnSurface(o, forward, right, { top, bottom: scale(top, -1), right: rightEdge, left: scale(rightEdge, -1) }, placedBy)) {
            return this.bumpedByLinkedPortal ? PlacementSuccess.OverlapLinked : PlacementSuccess.CantFit;
        }
        // Moved too far from where it was shot.
        const bumpDistance = dot(sub(o.origin, original), sub(o.origin, original));
        if (bumpDistance > MAXIMUM_BUMP_DISTANCE) return PlacementSuccess.CantFit;

        // Less than a unit and a half off the floor: bump down to match it exactly, for movement.
        if (up[2] > 0.7) {
            const small = scale(forward, 0.05);
            const from = add(o.origin, small);
            const floor = this.line(from, sub(from, scale(up, PORTAL_HALF_HEIGHT + 1.5)), MASK_SOLID_BRUSHONLY);
            if (floor.fraction < 1) {
                const verify = this.line(from, sub(from, scale(up, PORTAL_HALF_HEIGHT - 0.1)), MASK_SOLID_BRUSHONLY);
                if (verify.fraction === 1) {
                    const hit = add(from, scale(sub(sub(from, scale(up, PORTAL_HALF_HEIGHT + 1.5)), from), floor.fraction));
                    o.origin = sub(add(hit, scale(up, PORTAL_HALF_HEIGHT)), small);
                }
            }
        }

        if (this.inNoPortalVolume(o.origin, angles, forward)) return PlacementSuccess.InvalidVolume;
        if (test && this.overlapsOtherPortals(o.origin, angles)) return PlacementSuccess.OverlapLinked;
        if (!this.onValidSurface(o.origin, forward, right, up)) return PlacementSuccess.InvalidSurface;

        let m = 1 - bumpDistance / MAXIMUM_BUMP_DISTANCE;
        m *= m;
        m *= m;
        return m * (PlacementSuccess.NoBump - PlacementSuccess.Bumped) + PlacementSuccess.Bumped;
    }
}

interface CornerFit {
    tr: PTrace;
    point: Vec3;
    dir: Vec3;
    bump: Vec3;
    corner: boolean;
    soft: boolean;
}

const emptyFit = (): CornerFit => ({ tr: clearTrace(), point: [0, 0, 0], dir: [0, 0, 0], bump: [0, 0, 0], corner: false, soft: false });

/** FindBumpVectorInCorner: the bump that fits an edge between two angled intersections. */
function bumpVectorInCorner(corner1: Vec3, corner2: Vec3, f1: CornerFit, f2: CornerFit): Vec3 {
    const seg = lineToLine(f1.point, add(f1.point, f1.dir), f2.point, add(f2.point, f2.dir));
    if (!seg) return [0, 0, 0];
    const meet = scale(add(seg.a, seg.b), 0.5);
    let leg = sub(f1.point, meet);
    let leg2 = sub(f2.point, meet);
    const legLen = length(leg), leg2Len = length(leg2);
    // Our triangle is actually a point or a line, so there's nothing we can do.
    if (legLen === 0 || leg2Len === 0) return [0, 0, 0];
    leg = scale(leg, 1 / legLen);
    leg2 = scale(leg2, 1 / leg2Len);
    const edge = normalize(sub(corner2, corner1));
    const edgeDotLeg = dot(edge, leg), edgeDotLeg2 = dot(edge, leg2);
    if (edgeDotLeg < -0.9999 || edgeDotLeg > 0.9999 || edgeDotLeg2 < -0.9999 || edgeDotLeg2 > 0.9999) {
        // Corners line up with a leg: bump each corner off its own intersection.
        const d1 = distanceToLine(corner1, f1.point, add(f1.point, f1.dir)) + PORTAL_BUMP_FORGIVENESS;
        const d2 = distanceToLine(corner2, f2.point, add(f2.point, f2.dir)) + PORTAL_BUMP_FORGIVENESS;
        return add(scale(f1.bump, d1), scale(f2.bump, d2));
    }
    // Make a triangle similar to the intersections' one, with a base the width of the portal edge.
    const longBase = length(sub(corner2, corner1));
    const leg2Angle = Math.acos(Math.max(-1, Math.min(1, dot(edge, scale(leg, -1)))));
    const baseAngle = Math.acos(Math.max(-1, Math.min(1, dot(leg, leg2))));
    const legAngle = Math.PI - baseAngle - leg2Angle;
    if (Math.sin(legAngle) === 0) return [1000, 1000, 1000];
    const shortBase = Math.sin(baseAngle) * (legLen / Math.sin(legAngle));
    if (shortBase === 0) return [0, 0, 0];
    const longLeg = longBase * (legLen / shortBase);
    return sub(add(meet, scale(leg, longLeg)), corner1);
}

/** Runs `fn` with the models shots ignore made non-solid. */
function withShotFilter<T>(env: PlacementEnv, fn: () => T): T {
    const off = env.shotIgnores().filter((m) => m.solid);
    for (const m of off) m.solid = false;
    try {
        return fn();
    } finally {
        for (const m of off) m.solid = true;
    }
}

export interface PlacementResult {
    success: number;
    origin: Vec3;
    angles: Vec3;
}

/**
 * VerifyPortalPlacement for a portal at `origin`/`angles`, followed by the orientation-volume
 * check PlacePortal does. `ignore` is the portal being placed (its old spot doesn't count).
 */
export function verifyPortalPlacement(env: PlacementEnv, ignore: object | null, origin: Vec3, angles: Vec3, placedBy: PlacedBy, test = false): PlacementResult {
    return withShotFilter(env, () => {
        const o = { origin: [...origin] as Vec3 };
        const success = new Placer(env, ignore).verify(o, angles, placedBy, test);
        return { success, origin: o.origin, angles: testForOrientationVolumes(env, ignore, o.origin, angles) };
    });
}

/**
 * CWeaponPortalgun::TraceFirePortal: a shot from `start` along `dir`. On a miss the result's
 * origin is where the shot ended, for the fizzle.
 */
export function traceFirePortal(env: PlacementEnv, ignore: object | null, start: Vec3, dir: Vec3, placedBy = PlacedBy.Player): PlacementResult {
    return withShotFilter(env, () => {
        const placer = new Placer(env, ignore);
        const end = add(start, scale(dir, MAX_TRACE_LENGTH));
        const tr = placer.line(start, end, MASK_SHOT_PORTAL);
        const hit = add(start, scale(sub(end, start), tr.fraction));
        if (tr.fraction === 1 || tr.startSolid) return { success: PlacementSuccess.PassthroughSurface, origin: hit, angles: vectorAngles(scale(dir, -1), [0, 0, 1]) };

        // An active cleanser between the gun and the surface fizzles the shot.
        for (const v of env.volumes()) {
            if (v.classname !== 'trigger_portal_cleanser' || !v.active) continue;
            const c = rayBox(start, hit, v.mins, v.maxs);
            if (c) return { success: PlacementSuccess.Cleanser, origin: add(start, scale(sub(hit, start), c.fraction)), angles: vectorAngles(scale(dir, -1), [0, 0, 1]) };
        }

        // Level floors and ceilings orient the portal along the shot; everything else keeps it upright.
        const n = tr.normal;
        const up: Vec3 = Math.abs(n[0]) < 0.001 && Math.abs(n[1]) < 0.001 ? dir : [0, 0, 1];
        const angles = vectorAngles(n, up);
        const o = { origin: hit };
        const success = placer.verify(o, angles, placedBy);
        return { success, origin: success < 0.5 ? hit : o.origin, angles: testForOrientationVolumes(env, ignore, o.origin, angles) };
    });
}

/** UTIL_TestForOrientationVolumes: a func_portal_orientation the portal overlaps sets its angles. */
function testForOrientationVolumes(env: PlacementEnv, ignore: object | null, origin: Vec3, angles: Vec3): Vec3 {
    const portal = portalOBB(origin, angles, LOCAL_MINS, LOCAL_MAXS);
    for (const v of env.orientationVolumes()) {
        if (!v.active) continue;
        const center = scale(add(v.mins, v.maxs), 0.5);
        const half = [0, 1, 2].map((a) => (v.maxs[a] - v.mins[a]) / 2);
        if (!obbOverlap(portal.center, portal.axes, portal.halves, center, AXES, half)) continue;
        if (v.matchLinkedAngles) {
            // Needs a linked portal and a floor or ceiling placement.
            const self = env.portals().find((p) => p.key === ignore);
            const linked = self?.linked;
            if (!linked || !(Math.abs(Math.abs(angles[0]) - 90) < 0.1)) return angles;
            return [angles[0], 0, linked.angles[2]];
        }
        return [...v.anglesToFace];
    }
    return angles;
}
