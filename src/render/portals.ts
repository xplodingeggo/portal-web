// Portals: linked pairs of 64x108 ovals. Each frame, an active linked portal gets
// a view rendered from "behind" its partner into a render target, clipped at the
// partner's plane with an oblique near plane; the portal surface then shows that
// image in screen space. Crossing a portal moves the player through the pair's
// transform, and while the player fits inside a portal, the wall behind it stops
// colliding.
import * as THREE from 'three';
import { clipBrush, type CollisionBrush, type CollisionHole, type CollisionWorld, type Vec3 } from '../physics/collision';
import type { FunnelPortal } from '../physics/player';
import type { SoundHandle, SoundSystem } from '../audio/sound';
import type { ParticleEffect, ParticleManager } from './particles';

export const PORTAL_HALF_WIDTH = 32;
export const PORTAL_HALF_HEIGHT = 54;
/** prop_portal.cpp: the player leaves a floor portal at least this fast, and nothing leaves faster than the max. */
export const MIN_FLOOR_EXIT_SPEED_PLAYER = 300;
export const MAX_EXIT_SPEED = 1000;
/** How far behind (and in front of) a portal its collision hole reaches. */
const HOLE_DEPTH = 64;
const COLORS = [new THREE.Color(0.25, 0.55, 1.0), new THREE.Color(1.0, 0.55, 0.1)];

export interface Portal {
    key: object;
    color: 0 | 1;
    group: number;
    origin: Vec3;
    angles: Vec3;
    active: boolean;
    fromGun: boolean;
    /** Local frame: x = out of the surface, y = left, z = up. */
    matrix: THREE.Matrix4;
    inverse: THREE.Matrix4;
    mesh: THREE.Mesh;
    material: THREE.ShaderMaterial;
    target: THREE.WebGLRenderTarget;
    hole: CollisionHole | null;
    /** The ambient hum while open. */
    hum: SoundHandle | null;
    /** The swirl and edge particles while open. */
    fx: ParticleEffect[];
    fxToken: number;
}

const vertexShader = /* glsl */ `
varying vec2 vEllipse;
void main() {
    vEllipse = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D view;
uniform vec2 resolution;
/** Where the portal's view starts in the texture's pixel space (the view is drawn only for its screen rectangle). */
uniform vec2 rectMin;
uniform vec3 color;
uniform bool linked;
uniform float time;
varying vec2 vEllipse;
void main() {
    float r = length(vEllipse);
    if (r > 1.0) discard;
    vec3 inside;
    if (linked) {
        inside = texture2D(view, (gl_FragCoord.xy - rectMin) / resolution).rgb;
    } else {
        // Unlinked portal: a slow swirl in its own colour.
        float a = atan(vEllipse.y, vEllipse.x);
        inside = color * (0.35 + 0.15 * sin(a * 3.0 + r * 8.0 - time * 2.0));
    }
    float rim = smoothstep(0.86, 0.97, r);
    gl_FragColor = vec4(mix(inside, color * 1.4, rim), 1.0);
}
`;

export class PortalSystem {
    readonly portals: Portal[] = [];
    /** For portal sounds; absent headless. */
    sound?: SoundSystem;
    /** For portal particles; absent headless. */
    particles?: ParticleManager;
    private camera = new THREE.PerspectiveCamera();
    private size = new THREE.Vector2(1, 1);
    private time = { value: 0 };

    constructor(
        private scene: THREE.Scene,
        private renderer: THREE.WebGLRenderer,
        private collision: CollisionWorld,
    ) {
        this.camera.matrixAutoUpdate = false;
        this.camera.matrixWorldAutoUpdate = false;
    }

    private create(key: object, color: 0 | 1, group: number, fromGun: boolean): Portal {
        const target = new THREE.WebGLRenderTarget(this.size.x, this.size.y, { depthBuffer: true });
        const material = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms: {
                view: { value: target.texture },
                resolution: { value: this.size },
                rectMin: { value: new THREE.Vector2() },
                color: { value: COLORS[color] },
                linked: { value: false },
                time: this.time,
            },
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -8,
        });
        // An upright quad in the portal's local y/z plane, just off the surface, facing +x.
        const w = PORTAL_HALF_WIDTH, h = PORTAL_HALF_HEIGHT, x = 0.5;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute([x, w, -h, x, -w, -h, x, -w, h, x, w, h], 3));
        geom.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
        // Seen from +x, +y is screen-right, so this order is counter-clockwise.
        geom.setIndex([0, 2, 1, 0, 3, 2]);
        const mesh = new THREE.Mesh(geom, material);
        mesh.matrixAutoUpdate = false;
        mesh.visible = false;
        mesh.name = 'portal';
        this.scene.add(mesh);
        const p: Portal = {
            key, color, group, fromGun,
            origin: [0, 0, 0], angles: [0, 0, 0], active: false,
            matrix: new THREE.Matrix4(), inverse: new THREE.Matrix4(),
            mesh, material, target, hole: null, hum: null, fx: [], fxToken: 0,
        };
        this.portals.push(p);
        return p;
    }

    /** Registers a prop_portal from the map (inactive until map logic activates it). */
    addMapPortal(entity: { origin: Vec3; angles: Vec3 }, color: 0 | 1, group: number) {
        const p = this.create(entity, color, group, false);
        this.place(p, entity.origin, entity.angles);
    }

    private find(key: object) {
        return this.portals.find((p) => p.key === key);
    }

    private place(p: Portal, origin: Vec3, angles: Vec3) {
        p.origin = [...origin];
        p.angles = [...angles];
        const d = Math.PI / 180;
        p.matrix.makeRotationFromEuler(new THREE.Euler(angles[2] * d, angles[0] * d, angles[1] * d, 'ZYX'));
        p.matrix.setPosition(origin[0], origin[1], origin[2]);
        p.inverse.copy(p.matrix).invert();
        p.mesh.matrix.copy(p.matrix);
        p.mesh.matrixWorldNeedsUpdate = true;
        if (p.fx.length) {
            const [f, n] = this.fxFrame(p);
            for (const fx of p.fx) fx.setControlPoint(0, p.origin, f, n);
        }
    }

    /** The particles' control point frame: x across the oval, z out of the surface. */
    private fxFrame(p: Portal): [Vec3, Vec3] {
        const col = (i: number): Vec3 => {
            const v = new THREE.Vector3().setFromMatrixColumn(p.matrix, i);
            return [v.x, v.y, v.z];
        };
        return [col(1), col(0)];
    }

    /** CProp_Portal::DispatchPortalEffects: the swirl and edge particles while a portal is open. */
    private setFx(p: Portal, on: boolean) {
        const token = ++p.fxToken;
        for (const fx of p.fx) fx.stop();
        p.fx = [];
        if (!on || !this.particles) return;
        const n = p.color + 1;
        const [f, up] = this.fxFrame(p);
        for (const name of [`portal_${n}_particles`, `portal_${n}_edge`]) {
            void this.particles.spawn(name, p.origin, f, up).then((fx) => {
                if (!fx) return;
                if (token !== p.fxToken) fx.kill();
                else p.fx.push(fx);
            });
        }
    }

    move(key: object, origin: Vec3, angles: Vec3) {
        const p = this.find(key);
        if (!p) return;
        this.place(p, origin, angles);
        this.refresh();
    }

    /** Opens or closes a portal. Opening one closes any other of the same colour and linkage group. */
    setActive(key: object, active: boolean) {
        const p = this.find(key);
        if (!p) return;
        if (active) for (const o of this.portals) if (o !== p && o.color === p.color && o.group === p.group && o.active) {
            o.active = false;
            this.setFx(o, false);
        }
        const was = p.active;
        p.active = active;
        if (active !== was || (active && !p.fx.length)) this.setFx(p, active);
        // NewLocation / SetActivatedState: the opening sound.
        if (active) this.sound?.play(p.color ? 'Portal.open_red' : 'Portal.open_blue', { position: () => p.origin });
        this.refresh();
    }

    /**
     * CProp_Portal::DoFizzleEffect's sound, at a portal or where a failed shot landed: 'killed'
     * (fizzled by map logic or a cleanser), 'invalid' (a shot that can't place), 'close'.
     */
    fizzleSound(kind: 'killed' | 'invalid' | 'close', color: 0 | 1, at: Vec3) {
        const name = kind === 'killed' ? 'Portal.fizzle_moved' : kind === 'invalid' ? 'Portal.fizzle_invalid_surface' : color ? 'Portal.close_red' : 'Portal.close_blue';
        this.sound?.play(name, { position: () => at });
    }

    /**
     * A one-shot portal particle effect (DispatchParticleEffect with fxData): `name` is the part
     * after "portal_N_". `angles` is the portal's own; the effect faces along its up with z out.
     */
    burst(name: string, color: 0 | 1, origin: Vec3, angles: Vec3) {
        const d = Math.PI / 180;
        const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(angles[2] * d, angles[0] * d, angles[1] * d, 'ZYX'));
        const col = (i: number): Vec3 => {
            const v = new THREE.Vector3().setFromMatrixColumn(m, i);
            return [v.x, v.y, v.z];
        };
        void this.particles?.spawn(`portal_${color + 1}_${name}`, origin, col(2), col(0));
    }

    /** CProp_Portal::Fizzle from map logic: closes with the fizzle sound. */
    fizzle(key: object) {
        const p = this.find(key);
        if (!p || !p.active) return;
        this.fizzleSound('killed', p.color, p.origin);
        this.burst('close', p.color, p.origin, p.angles);
        this.setActive(key, false);
    }

    /**
     * CProp_Portal::InputSetActivatedState: map logic opens or closes a portal. Opening puts it on
     * whatever surface a short line along its facing hits, facing that surface's normal, whatever
     * angles the mapper gave it; it's no longer the gun's.
     */
    setActivatedState(key: object, active: boolean) {
        const p = this.find(key);
        if (!p) return;
        if (active) {
            p.fromGun = false;
            this.snapToSurface(p);
        }
        this.setActive(key, active);
    }

    private snapToSurface(p: Portal) {
        const fwd = new THREE.Vector3().setFromMatrixColumn(p.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(p.matrix, 2);
        const o = p.origin;
        const zero: Vec3 = [0, 0, 0];
        const tr = this.collision.trace([o[0] + fwd.x, o[1] + fwd.y, o[2] + fwd.z], [o[0] - fwd.x * 8, o[1] - fwd.y * 8, o[2] - fwd.z * 8], zero, zero);
        let normal: Vec3 | null = null;
        let origin: Vec3 = o;
        if (tr.fraction < 1 && !tr.startSolid) {
            normal = tr.normal;
            origin = tr.end;
        } else {
            // The line ran along the surface (Source then gets no normal): use the axis with air
            // in front and solid behind, keeping the mapper's facing when it already fits.
            const solid = (v: Vec3, s: number) => {
                const q: Vec3 = [o[0] + v[0] * s, o[1] + v[1] * s, o[2] + v[2] * s];
                return this.collision.trace(q, q, zero, zero).startSolid;
            };
            const axes: Vec3[] = [[fwd.x, fwd.y, fwd.z], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
            normal = axes.find((v) => !solid(v, 4) && solid(v, -4)) ?? null;
        }
        if (!normal) return;
        const angles = vectorAngles(normal, [up.x, up.y, up.z]);
        if (angles.every((a, i) => Math.abs(((a - p.angles[i] + 540) % 360) - 180) < 0.01) && origin === o) return;
        this.place(p, origin, angles);
    }

    /** CProp_Portal::FindPortal: the portal of a colour in a linkage group, active ones first. */
    findPortal(color: 0 | 1, group: number): Portal | null {
        const same = this.portals.filter((q) => q.color === color && q.group === group);
        return same.find((q) => q.active) ?? same[0] ?? null;
    }

    /**
     * Places (or moves) the portal gun's portal of a colour: like the game, that's the map's own
     * portal of that colour in linkage group 0 if there is one. Returns it.
     */
    placeGunPortal(color: 0 | 1, origin: Vec3, angles: Vec3): Portal {
        const p = this.findPortal(color, 0) ?? this.create({ key: `gun${color}` }, color, 0, true);
        // Placed by the gun: no surface snap, and cleansers fizzle it.
        p.fromGun = true;
        this.place(p, origin, angles);
        this.setActive(p.key, true);
        return p;
    }

    /** Closes the player's portals; returns whether any were open. */
    fizzleGunPortals(): boolean {
        let any = false;
        for (const p of this.portals) {
            if (p.fromGun && p.active) {
                p.active = false;
                this.setFx(p, false);
                this.fizzleSound('killed', p.color, p.origin);
                this.burst('close', p.color, p.origin, p.angles);
                any = true;
            }
        }
        if (any) this.refresh();
        return any;
    }

    partner(p: Portal): Portal | null {
        if (!p.active) return null;
        return this.portals.find((o) => o !== p && o.active && o.group === p.group && o.color !== p.color) ?? null;
    }

    /** Rebuilds visibility and collision holes after portals open, close or move. */
    private refresh() {
        this.collision.holes = [];
        for (const p of this.portals) {
            p.mesh.visible = p.active;
            // CreateSounds: open portals hum (Portal.ambient_loop at 0.4).
            if (p.active && !p.hum && this.sound) p.hum = this.sound.play('Portal.ambient_loop', { position: () => p.origin, volume: 0.4, loop: true });
            if (!p.active && p.hum) {
                p.hum.stop(0.1);
                p.hum = null;
            }
            const linked = !!this.partner(p);
            p.material.uniforms.linked.value = linked;
            p.hole = linked ? this.makeHole(p) : null;
            if (p.hole) this.collision.holes.push(p.hole);
        }
    }

    private makeHole(p: Portal): CollisionHole {
        // Like CPortalSimulator's wall tube: every world brush in the slab behind the opening stops
        // colliding, however many layers the wall is built from. The slab is pulled in half a unit
        // so floors and ceilings that merely touch the oval's edge stay solid.
        const corners: Vec3[] = [];
        for (const x of [-HOLE_DEPTH, -0.5]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
            const pt = new THREE.Vector3(x, y * (PORTAL_HALF_WIDTH - 0.5), z * (PORTAL_HALF_HEIGHT - 0.5)).applyMatrix4(p.matrix);
            corners.push([pt.x, pt.y, pt.z]);
        }
        const mins = [0, 1, 2].map((a) => Math.min(...corners.map((c) => c[a]))) as Vec3;
        const maxs = [0, 1, 2].map((a) => Math.max(...corners.map((c) => c[a]))) as Vec3;
        const brushes = new Set(this.collision.worldBrushesIn(mins, maxs).filter((b) => brushTouchesHull(b, corners)));

        // What's left of those brushes: everything deeper than the tunnel, and around it the
        // slabs above and below the opening and the strips to its sides (PORTAL_HOLE_HALF_*).
        const o = new THREE.Vector3(...p.origin);
        const axis = (i: number) => {
            const v = new THREE.Vector3().setFromMatrixColumn(p.matrix, i);
            const d = v.dot(o);
            // Half-spaces local[i] <= k and local[i] >= k, as [normal, dist].
            return { below: (k: number) => [v.x, v.y, v.z, d + k], above: (k: number) => [-v.x, -v.y, -v.z, -(d + k)] };
        };
        const [fwd, left, up] = [axis(0), axis(1), axis(2)];
        const w = PORTAL_HALF_WIDTH + 0.1, h = PORTAL_HALF_HEIGHT + 0.1;
        const inTube = fwd.above(-HOLE_DEPTH);
        const cuts = [
            [fwd.below(-HOLE_DEPTH)],
            // In front of the surface nothing is carved (floors running up to a wall portal).
            [fwd.above(0.5)],
            [inTube, fwd.below(0.5), up.above(h)],
            [inTube, fwd.below(0.5), up.below(-h)],
            [inTube, fwd.below(0.5), up.below(h), up.above(-h), left.above(w)],
            [inTube, fwd.below(0.5), up.below(h), up.above(-h), left.below(-w)],
        ];
        const pieces = [...brushes].flatMap((b) => cuts.map((planes) => clipBrush(b, planes))).filter((b) => !!b);
        return { brushes, pieces };
    }

    /** Linked portals as the player's air-control funnel wants them (floor portals are filtered by the player). */
    funnelPortals(): FunnelPortal[] {
        const out: FunnelPortal[] = [];
        for (const p of this.portals) {
            if (!this.partner(p)) continue;
            const col = (i: number): Vec3 => {
                const v = new THREE.Vector3().setFromMatrixColumn(p.matrix, i);
                return [v.x, v.y, v.z];
            };
            out.push({ origin: p.origin, forward: col(0), right: col(1), up: col(2) });
        }
        return out;
    }

    /** Transform taking things that enter `from` out of its partner `to`. */
    transform(from: Portal, to: Portal): THREE.Matrix4 {
        const flip = new THREE.Matrix4().makeRotationZ(Math.PI);
        return to.matrix.clone().multiply(flip).multiply(from.inverse);
    }

    /**
     * If the segment prev -> next crosses an open, linked portal inside its oval,
     * returns that portal's transform.
     */
    crossing(prev: Vec3, next: Vec3): { matrix: THREE.Matrix4; from: Portal; to: Portal } | null {
        for (const p of this.portals) {
            const to = this.partner(p);
            if (!to) continue;
            const a = new THREE.Vector3(...prev).applyMatrix4(p.inverse);
            const b = new THREE.Vector3(...next).applyMatrix4(p.inverse);
            if (!(a.x > 0 && b.x <= 0)) continue;
            const t = a.x / (a.x - b.x);
            const y = a.y + (b.y - a.y) * t;
            const z = a.z + (b.z - a.z) * t;
            if ((y / PORTAL_HALF_WIDTH) ** 2 + (z / PORTAL_HALF_HEIGHT) ** 2 <= 1) return { matrix: this.transform(p, to), from: p, to };
        }
        return null;
    }

    /**
     * UTIL_IntersectRayWithPortal: distance along a ray (unit `dir`) to where it passes through
     * a portal's oval, from either side, or -1 if it misses within `maxDist`.
     */
    rayHitsPortal(p: Portal, start: Vec3, dir: Vec3, maxDist: number): number {
        const a = new THREE.Vector3(...start).applyMatrix4(p.inverse);
        const b = new THREE.Vector3(start[0] + dir[0] * maxDist, start[1] + dir[1] * maxDist, start[2] + dir[2] * maxDist).applyMatrix4(p.inverse);
        if (Math.sign(a.x) === Math.sign(b.x)) return -1;
        const t = a.x / (a.x - b.x);
        const y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
        return (y / PORTAL_HALF_WIDTH) ** 2 + (z / PORTAL_HALF_HEIGHT) ** 2 <= 1 ? t * maxDist : -1;
    }

    /**
     * Makes the two gun portals' resources now (render targets, shader) so the first shot doesn't
     * stall the frame doing it. They stay closed.
     */
    warmUp(camera: THREE.Camera) {
        for (const color of [0, 1] as const) {
            const p = this.findPortal(color, 0) ?? this.create({ key: `gun${color}` }, color, 0, true);
            const was = p.mesh.visible;
            p.mesh.visible = true;
            p.mesh.frustumCulled = false;
            const temp = new THREE.Scene();
            temp.add(p.mesh);
            this.renderer.setRenderTarget(p.target);
            this.renderer.clear();
            this.renderer.setRenderTarget(null);
            const small = new THREE.WebGLRenderTarget(4, 4);
            this.renderer.setRenderTarget(small);
            this.renderer.render(temp, camera);
            this.renderer.setRenderTarget(null);
            small.dispose();
            this.scene.add(p.mesh);
            p.mesh.frustumCulled = true;
            p.mesh.visible = was;
        }
    }

    /**
     * The portal's rectangle on screen in NDC, a little padded, or null when it can't be told (a corner
     * is behind the camera) and the whole screen should be drawn.
     */
    private screenRect(p: Portal, camera: THREE.PerspectiveCamera): { x0: number; y0: number; x1: number; y1: number } | null {
        const view = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
            const v = new THREE.Vector4(0.5, sy * PORTAL_HALF_WIDTH, sz * PORTAL_HALF_HEIGHT, 1).applyMatrix4(p.matrix).applyMatrix4(view);
            if (v.w <= 0.1) return null;
            x0 = Math.min(x0, v.x / v.w);
            x1 = Math.max(x1, v.x / v.w);
            y0 = Math.min(y0, v.y / v.w);
            y1 = Math.max(y1, v.y / v.w);
        }
        const pad = 0.02;
        x0 = Math.max(-1, x0 - pad);
        y0 = Math.max(-1, y0 - pad);
        x1 = Math.min(1, x1 + pad);
        y1 = Math.min(1, y1 + pad);
        return x1 - x0 > 0.01 && y1 - y0 > 0.01 ? { x0, y0, x1, y1 } : null;
    }

    setSize(width: number, height: number) {
        this.size.set(width, height);
        for (const p of this.portals) p.target.setSize(width, height);
    }

    /** Renders the view through every visible linked portal. Call before the main render. */
    render(camera: THREE.PerspectiveCamera, dt: number) {
        this.time.value += dt;
        camera.updateMatrixWorld();
        const frustum = new THREE.Frustum().setFromProjectionMatrix(
            new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        );
        const cam = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
        for (const p of this.portals) {
            const to = this.partner(p);
            if (!to) continue;
            // Skip portals off screen or seen from behind.
            const local = cam.clone().applyMatrix4(p.inverse);
            if (local.x <= 0) continue;
            p.mesh.geometry.computeBoundingSphere();
            const sphere = p.mesh.geometry.boundingSphere!.clone().applyMatrix4(p.matrix);
            if (!frustum.intersectsSphere(sphere)) continue;

            // Draw only the part of the screen the portal covers (as the game's stencil does): the view
            // gets that rectangle's frustum, so nothing outside it is drawn or even submitted, and the
            // result goes in the corner of the texture.
            const rect = this.screenRect(p, camera);
            const vcam = this.camera;
            vcam.matrixWorld.copy(this.transform(p, to)).multiply(camera.matrixWorld);
            vcam.matrixWorldInverse.copy(vcam.matrixWorld).invert();
            vcam.projectionMatrix.copy(camera.projectionMatrix);
            let px = 0, py = 0, pw = this.size.x, ph = this.size.y;
            if (rect) {
                // Snap the rectangle to whole pixels, then crop to exactly that.
                px = Math.max(0, Math.floor(((rect.x0 + 1) / 2) * this.size.x));
                py = Math.max(0, Math.floor(((rect.y0 + 1) / 2) * this.size.y));
                pw = Math.min(this.size.x, Math.ceil(((rect.x1 + 1) / 2) * this.size.x)) - px;
                ph = Math.min(this.size.y, Math.ceil(((rect.y1 + 1) / 2) * this.size.y)) - py;
                const nx0 = (px / this.size.x) * 2 - 1, nx1 = ((px + pw) / this.size.x) * 2 - 1;
                const ny0 = (py / this.size.y) * 2 - 1, ny1 = ((py + ph) / this.size.y) * 2 - 1;
                const sx = 2 / (nx1 - nx0), sy = 2 / (ny1 - ny0);
                const crop = new THREE.Matrix4().set(sx, 0, 0, -(nx1 + nx0) / (nx1 - nx0), 0, sy, 0, -(ny1 + ny0) / (ny1 - ny0), 0, 0, 1, 0, 0, 0, 0, 1);
                vcam.projectionMatrix.premultiply(crop);
            }
            vcam.projectionMatrixInverse.copy(vcam.projectionMatrix).invert();
            p.material.uniforms.rectMin.value.set(px, py);
            p.target.viewport.set(0, 0, pw, ph);
            p.target.scissor.set(0, 0, pw, ph);
            p.target.scissorTest = true;
            // Clip everything behind the exit portal's surface.
            const normal = new THREE.Vector3().setFromMatrixColumn(to.matrix, 0).normalize();
            const point = new THREE.Vector3(...to.origin);
            obliqueNearPlane(vcam, new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point));

            // A portal can't sample the target it's drawing into; hide both ends.
            p.mesh.visible = false;
            to.mesh.visible = false;
            this.renderer.setRenderTarget(p.target);
            this.renderer.clear();
            this.renderer.render(this.scene, vcam);
            p.mesh.visible = true;
            to.mesh.visible = true;
        }
        this.renderer.setRenderTarget(null);
    }
}

/** Replaces the near plane of a camera's projection with an arbitrary world plane (Lengyel's method). */
function obliqueNearPlane(camera: THREE.Camera, plane: THREE.Plane) {
    const p = plane.clone().applyMatrix4(camera.matrixWorldInverse);
    const clip = new THREE.Vector4(p.normal.x, p.normal.y, p.normal.z, p.constant);
    const m = camera.projectionMatrix.elements;
    const q = new THREE.Vector4(
        (Math.sign(clip.x) + m[8]) / m[0],
        (Math.sign(clip.y) + m[9]) / m[5],
        -1,
        (1 + m[10]) / m[14],
    );
    clip.multiplyScalar(2 / clip.dot(q));
    m[2] = clip.x;
    m[6] = clip.y;
    m[10] = clip.z + 1;
    m[14] = clip.w;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/** mathlib's VectorAngles(forward, pseudoup): Source angles [pitch, yaw, roll] for a facing and up. */
export function vectorAngles(f: Vec3, pseudoUp: Vec3): Vec3 {
    let left: Vec3 = [pseudoUp[1] * f[2] - pseudoUp[2] * f[1], pseudoUp[2] * f[0] - pseudoUp[0] * f[2], pseudoUp[0] * f[1] - pseudoUp[1] * f[0]];
    const l = Math.hypot(...left) || 1;
    left = [left[0] / l, left[1] / l, left[2] / l];
    const deg = 180 / Math.PI;
    const xy = Math.hypot(f[0], f[1]);
    const pitch = Math.atan2(-f[2], xy) * deg;
    if (xy > 0.001) {
        const upZ = left[1] * f[0] - left[0] * f[1];
        return [pitch, Math.atan2(f[1], f[0]) * deg, Math.atan2(left[2], upZ) * deg];
    }
    return [pitch, Math.atan2(-left[0], left[1]) * deg, 0];
}

/** Whether a brush overlaps the convex hull of `points`: no brush plane has every point in front of it. */
function brushTouchesHull(b: CollisionBrush, points: Vec3[]): boolean {
    for (let k = 0; k < b.dists.length; k++) {
        const nx = b.normals[k * 3], ny = b.normals[k * 3 + 1], nz = b.normals[k * 3 + 2];
        if (points.every((p) => nx * p[0] + ny * p[1] + nz * p[2] - b.dists[k] > 0.01)) return false;
    }
    return true;
}

export function pointInBrush(b: CollisionBrush, p: Vec3): boolean {
    for (let k = 0; k < b.dists.length; k++) {
        if (b.normals[k * 3] * p[0] + b.normals[k * 3 + 1] * p[1] + b.normals[k * 3 + 2] * p[2] - b.dists[k] > 0) return false;
    }
    return true;
}
