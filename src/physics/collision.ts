// Axis-aligned box sweeps against BSP brushes. Each brush is a convex set of
// planes; a box is handled by pushing each plane out by the box's support point.
// Source compiles axial and bevel planes into every brush, which keeps this exact.
import type { BspFile } from '../bsp/bsp';
import { parseVec3, type Entity } from '../bsp/entities';

export type Vec3 = [number, number, number];

export const Contents = {
    Solid: 0x1,
    Window: 0x2,
    Grate: 0x8,
    Moveable: 0x4000,
    PlayerClip: 0x10000,
    Monster: 0x2000000,
} as const;

export const MASK_PLAYERSOLID =
    Contents.Solid | Contents.Window | Contents.Grate | Contents.Moveable | Contents.PlayerClip | Contents.Monster;

/** Small gap kept between a box and the surface it stops against. */
const DIST_EPSILON = 0.03125;

export interface Trace {
    fraction: number;
    end: Vec3;
    normal: Vec3;
    startSolid: boolean;
    allSolid: boolean;
    /** When starting in solid: how far along the trace it got out (Source's fractionleftsolid). */
    fractionLeftSolid: number;
    /** The model whose brush stopped the trace. */
    model?: CollisionModel;
    /** Texinfo of the brush side hit: -1 for none, undefined for a model hull (studio). */
    surface?: number;
}

export interface CollisionBrush {
    contents: number;
    normals: Float32Array; // xyz per side
    dists: Float32Array;
    mins: Vec3;
    maxs: Vec3;
    /** Texinfo per side, for BSP brushes. */
    surfaces?: Int16Array;
    /** Corner points, where known (hulls and clipped pieces); see brushPoints. */
    points?: Vec3[];
}

/** A group of brushes moved as one; map logic toggles and moves these. */
export interface CollisionModel {
    /** Translation applied to the brushes (entity origin, or offset from the spawn position). */
    origin: Vec3;
    brushes: CollisionBrush[];
    solid: boolean;
    /** Owned by a rigid body, which moves it; the physics world doesn't mirror it. */
    rigid?: boolean;
}

/**
 * The wall behind an open portal (CPortalSimulator's wall tube): `brushes` stop colliding and
 * `pieces`, the parts of them outside the tunnel behind the opening, collide instead.
 */
export interface CollisionHole {
    brushes: Set<CollisionBrush>;
    pieces: CollisionBrush[];
}

/** Brush entities that block the player when no map logic manages them (used by tests). */
const SOLID_BRUSH_CLASSES = /^func_(brush|wall|wall_toggle|detail|movelinear|rotating|tracktrain|train|breakable|physbox|lod)$/;

export class CollisionWorld {
    readonly world: CollisionModel;
    private models: CollisionModel[] = [];
    holes: CollisionHole[] = [];

    /** @param entities if given, solid brush entities are added in their spawn state */
    constructor(private bsp: BspFile, entities?: Entity[]) {
        this.world = this.addBrushModel(0, [0, 0, 0]);
        for (const e of entities ?? []) {
            const m = /^\*(\d+)$/.exec(e.model ?? '');
            if (!m || !SOLID_BRUSH_CLASSES.test(e.classname ?? '')) continue;
            if (e.startdisabled === '1' || e.solidity === '1') continue;
            this.addBrushModel(Number(m[1]), parseVec3(e.origin));
        }
    }

    /** Every model, the world first. */
    get allModels(): readonly CollisionModel[] {
        return this.models;
    }

    removeModel(m: CollisionModel) {
        const i = this.models.indexOf(m);
        if (i >= 0) this.models.splice(i, 1);
    }

    /** Adds the brushes of BSP model `model` ("*N") at an origin. */
    addBrushModel(model: number, origin: Vec3): CollisionModel {
        const m: CollisionModel = { origin: [...origin], brushes: this.buildBrushes(this.bsp, model), solid: true };
        this.models.push(m);
        return m;
    }

    /** Adds convex hulls (world-space points and triangles), e.g. from a prop's .phy, as one model. */
    addHullModel(hulls: { points: Vec3[]; triangles: [number, number, number][] }[]): CollisionModel {
        const m: CollisionModel = { origin: [0, 0, 0], brushes: hulls.map((h) => hullBrush(h.points, h.triangles)), solid: true };
        this.models.push(m);
        return m;
    }

    /** Adds one convex hull in world space. */
    addHull(points: Vec3[], triangles: [number, number, number][]) {
        this.addHullModel([{ points, triangles }]);
    }

    /** World brushes overlapping an axis-aligned box (for carving portal holes). */
    worldBrushesIn(mins: Vec3, maxs: Vec3): CollisionBrush[] {
        return this.world.brushes.filter(
            (b) => b.mins.every((v, a) => v <= maxs[a]) && b.maxs.every((v, a) => v >= mins[a]),
        );
    }

    private buildBrushes(bsp: BspFile, model: number): CollisionBrush[] {
        if (!bsp.models[model]) return [];
        const out: CollisionBrush[] = [];
        for (const bi of bsp.modelBrushes(model)) {
            const b = bsp.brushes[bi];
            if (!b || !(b.contents & MASK_PLAYERSOLID)) continue;
            const normals = new Float32Array(b.planes.length * 3);
            const dists = new Float32Array(b.planes.length);
            const mins: Vec3 = [-Infinity, -Infinity, -Infinity];
            const maxs: Vec3 = [Infinity, Infinity, Infinity];
            b.planes.forEach((p, k) => {
                const n = [bsp.planeNormals[p * 3], bsp.planeNormals[p * 3 + 1], bsp.planeNormals[p * 3 + 2]];
                normals.set(n, k * 3);
                dists[k] = bsp.planeDists[p];
                // Axial planes give the brush bounds.
                for (let a = 0; a < 3; a++) {
                    if (n[a] === 1) maxs[a] = Math.min(maxs[a], dists[k]);
                    if (n[a] === -1) mins[a] = Math.max(mins[a], -dists[k]);
                }
            });
            out.push({ contents: b.contents, normals, dists, mins, maxs, surfaces: Int16Array.from(b.texInfos) });
        }
        return out;
    }

    /**
     * Sweeps the box [mins, maxs] from start to end and returns the first hit. With `holes` false
     * the world is traced as if no portal were open (portal shots see the uncarved wall).
     */
    trace(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask = MASK_PLAYERSOLID, holes = true): Trace {
        const result: Trace = { fraction: 1, end: [...end], normal: [0, 0, 0], startSolid: false, allSolid: false, fractionLeftSolid: 0 };
        const skip = holes ? this.holes.map((h) => h.brushes) : [];
        for (const model of this.models) {
            if (!model.solid) continue;
            const o = model.origin;
            const s: Vec3 = [start[0] - o[0], start[1] - o[1], start[2] - o[2]];
            const e: Vec3 = [end[0] - o[0], end[1] - o[1], end[2] - o[2]];
            // Swept bounds of the box, for a cheap per-brush rejection.
            const lo = [0, 1, 2].map((a) => Math.min(s[a], e[a]) + mins[a] - 1);
            const hi = [0, 1, 2].map((a) => Math.max(s[a], e[a]) + maxs[a] + 1);
            const carved = model === this.world && skip.length > 0;
            const clip = (b: CollisionBrush, piece = false) => {
                if (!(b.contents & mask)) return;
                if (b.mins[0] > hi[0] || b.mins[1] > hi[1] || b.mins[2] > hi[2]) return;
                if (b.maxs[0] < lo[0] || b.maxs[1] < lo[1] || b.maxs[2] < lo[2]) return;
                if (carved && !piece && skip.some((h) => h.has(b))) return;
                const before = result.fraction;
                clipBoxToBrush(b, s, e, mins, maxs, result);
                if (result.fraction < before) result.model = model;
            };
            for (const b of model.brushes) {
                clip(b);
                if (result.allSolid) break;
            }
            // The world around open portals collides as the pieces left after carving.
            if (carved) for (const h of this.holes) for (const b of h.pieces) clip(b, true);
        }
        const f = result.fraction;
        result.end = [start[0] + (end[0] - start[0]) * f, start[1] + (end[1] - start[1]) * f, start[2] + (end[2] - start[2]) * f];
        return result;
    }
}

/**
 * The part of a brush also behind every plane in `planes` ([nx, ny, nz, dist] each), or null if
 * that's empty or flat. Box traces push each plane out by the box, so an empty intersection of
 * nearly opposite planes would still collide; the corners are solved to rule that out, and give
 * the bounds and axial bevels.
 */
export function clipBrush(b: CollisionBrush, planes: number[][]): CollisionBrush | null {
    const all = brushPlanes(b);
    all.push(...planes);
    const corners = planeCorners(all);
    if (!corners.length) return null;
    // Flat: every corner lies on one of the planes.
    if (all.some((q) => corners.every((p) => q[0] * p[0] + q[1] * p[1] + q[2] * p[2] - q[3] > -0.01))) return null;
    const mins: Vec3 = [Infinity, Infinity, Infinity];
    const maxs: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of corners) for (let a = 0; a < 3; a++) {
        mins[a] = Math.min(mins[a], p[a]);
        maxs[a] = Math.max(maxs[a], p[a]);
    }
    for (let a = 0; a < 3; a++) {
        const n = [0, 0, 0];
        n[a] = 1;
        all.push([...n, maxs[a]]);
        n[a] = -1;
        all.push([...n, -mins[a]]);
    }
    return {
        contents: b.contents,
        normals: new Float32Array(all.flatMap((q) => q.slice(0, 3))),
        dists: new Float32Array(all.map((q) => q[3])),
        mins,
        maxs,
        points: corners,
    };
}

function brushPlanes(b: CollisionBrush): number[][] {
    const all: number[][] = [];
    for (let k = 0; k < b.dists.length; k++) all.push([b.normals[k * 3], b.normals[k * 3 + 1], b.normals[k * 3 + 2], b.dists[k]]);
    return all;
}

/** Corners of the convex region behind every plane. */
function planeCorners(all: number[][]): Vec3[] {
    const inside = (p: Vec3) => all.every((q) => q[0] * p[0] + q[1] * p[1] + q[2] * p[2] - q[3] <= 0.01);
    const corners: Vec3[] = [];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) for (let k = j + 1; k < all.length; k++) {
        const p = intersectPlanes(all[i], all[j], all[k]);
        if (p && inside(p)) corners.push(p);
    }
    return corners;
}

/** A brush's corner points (for building physics shapes). */
export function brushPoints(b: CollisionBrush): Vec3[] {
    if (!b.points) b.points = planeCorners(brushPlanes(b));
    return b.points;
}

/** The point on three planes ([nx, ny, nz, dist]), or null if they don't meet in one. */
function intersectPlanes(a: number[], b: number[], c: number[]): Vec3 | null {
    const bc = [b[1] * c[2] - b[2] * c[1], b[2] * c[0] - b[0] * c[2], b[0] * c[1] - b[1] * c[0]];
    const det = a[0] * bc[0] + a[1] * bc[1] + a[2] * bc[2];
    if (Math.abs(det) < 1e-6) return null;
    const ca = [c[1] * a[2] - c[2] * a[1], c[2] * a[0] - c[0] * a[2], c[0] * a[1] - c[1] * a[0]];
    const ab = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    return [0, 1, 2].map((i) => (a[3] * bc[i] + b[3] * ca[i] + c[3] * ab[i]) / det) as Vec3;
}

function clipBoxToBrush(b: CollisionBrush, start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, tr: Trace) {
    let enterFrac = -1;
    let leaveFrac = 1;
    let hitNormal: Vec3 | null = null;
    let hitSide = -1;
    let startOut = false;
    let endOut = false;

    for (let k = 0; k < b.dists.length; k++) {
        const nx = b.normals[k * 3], ny = b.normals[k * 3 + 1], nz = b.normals[k * 3 + 2];
        // Push the plane out by the box corner that leads into it.
        const ofs = (nx < 0 ? maxs[0] : mins[0]) * nx + (ny < 0 ? maxs[1] : mins[1]) * ny + (nz < 0 ? maxs[2] : mins[2]) * nz;
        const dist = b.dists[k] - ofs;
        const d1 = start[0] * nx + start[1] * ny + start[2] * nz - dist;
        const d2 = end[0] * nx + end[1] * ny + end[2] * nz - dist;
        if (d1 > 0) startOut = true;
        if (d2 > 0) endOut = true;
        // Fully in front of this plane: the box never touches the brush.
        if (d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1)) return;
        if (d1 <= 0 && d2 <= 0) continue;
        if (d1 > d2) {
            const f = Math.max(0, (d1 - DIST_EPSILON) / (d1 - d2));
            if (f > enterFrac) {
                enterFrac = f;
                hitNormal = [nx, ny, nz];
                hitSide = k;
            }
        } else {
            const f = Math.min(1, (d1 + DIST_EPSILON) / (d1 - d2));
            if (f < leaveFrac) leaveFrac = f;
        }
    }

    if (!startOut) {
        tr.startSolid = true;
        if (!endOut) {
            tr.allSolid = true;
            tr.fraction = 0;
            tr.fractionLeftSolid = 1;
        } else if (leaveFrac !== 1 && leaveFrac > tr.fractionLeftSolid) {
            tr.fractionLeftSolid = leaveFrac;
        }
        return;
    }
    if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < tr.fraction && hitNormal) {
        tr.fraction = Math.max(0, enterFrac);
        tr.normal = hitNormal;
        tr.surface = b.surfaces ? b.surfaces[hitSide] : undefined;
    }
}

/** Convex hull (points + triangles) to plane set, with axial bevels. */
export function hullBrush(points: Vec3[], triangles: [number, number, number][]): CollisionBrush {
    const mins: Vec3 = [Infinity, Infinity, Infinity];
    const maxs: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of points) for (let a = 0; a < 3; a++) {
        mins[a] = Math.min(mins[a], p[a]);
        maxs[a] = Math.max(maxs[a], p[a]);
    }
    const planes: number[][] = [];
    const addPlane = (n: number[], d: number) => {
        if (planes.some((q) => q[0] * n[0] + q[1] * n[1] + q[2] * n[2] > 0.9999 && Math.abs(q[3] - d) < 0.01)) return;
        planes.push([n[0], n[1], n[2], d]);
    };
    // Axial bevels keep box traces from catching on hull corners.
    for (let a = 0; a < 3; a++) {
        const n = [0, 0, 0];
        n[a] = 1;
        addPlane(n, maxs[a]);
        n[a] = -1;
        addPlane(n, -mins[a]);
    }
    for (const [i, j, k] of triangles) {
        const a = points[i], b = points[j], c = points[k];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len < 1e-6) continue;
        n = n.map((x) => x / len);
        let d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
        // Orient outward: every hull point must lie behind the plane.
        const front = Math.max(...points.map((p) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d));
        if (front > 0.05) {
            n = n.map((x) => -x);
            d = -d;
        }
        addPlane(n, d);
    }
    // Edge bevels: supporting planes through each edge and each axis. Without them a box swept
    // along a sloped edge reads the hull as bigger or smaller than it is and can end up inside.
    const seen = new Set<string>();
    for (const [i, j, k] of triangles) for (const [a, b] of [[i, j], [j, k], [k, i]]) {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const e = [points[b][0] - points[a][0], points[b][1] - points[a][1], points[b][2] - points[a][2]];
        for (let ax = 0; ax < 3; ax++) {
            const u = [0, 0, 0];
            u[ax] = 1;
            const n = [e[1] * u[2] - e[2] * u[1], e[2] * u[0] - e[0] * u[2], e[0] * u[1] - e[1] * u[0]];
            const len = Math.hypot(n[0], n[1], n[2]);
            if (len < 1e-6) continue;
            for (const s of [1, -1]) {
                const m = n.map((x) => (x * s) / len);
                // Only planes that touch this edge are bevels (others are just looser supports).
                const d = Math.max(...points.map((p) => m[0] * p[0] + m[1] * p[1] + m[2] * p[2]));
                const at = m[0] * points[a][0] + m[1] * points[a][1] + m[2] * points[a][2];
                if (d - at < 0.01) addPlane(m, d);
            }
        }
    }
    return {
        contents: Contents.Solid,
        normals: new Float32Array(planes.flatMap((q) => q.slice(0, 3))),
        dists: new Float32Array(planes.map((q) => q[3])),
        mins,
        maxs,
        points,
    };
}
