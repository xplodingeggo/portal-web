// Draws the particle systems: every .pcf in the game archives is loaded by name; spawning one makes
// a simulation (src/particles/system.ts) plus a mesh per renderer in its definition. Sprites are
// camera-facing quads cut from the material's sprite sheet; trails stretch along the velocity and
// ropes join the particles in order.
import * as THREE from 'three';
import type { GameFS } from '../fs/gamefs';
import { loadMaterial, texturePath, type MaterialDef } from '../material/vmt';
import { parsePcf, type ParticleDef, type PcfOperator } from '../particles/pcf';
import { parseSheet, type Sheet } from '../particles/sheet';
import { ParticleSystem, type ControlPoint, type Particle, type ParticleEnv, type Vec3 } from '../particles/system';
import type { TextureCache } from './textures';

const vertexShader = /* glsl */ `
attribute vec4 color;
attribute vec2 uv2;
attribute float blend;
varying vec2 vUv;
varying vec2 vUv2;
varying float vBlend;
varying vec4 vColor;
void main() {
    vUv = uv;
    vUv2 = uv2;
    vBlend = blend;
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D map;
uniform float overbright;
uniform bool textured;
varying vec2 vUv;
varying vec2 vUv2;
varying float vBlend;
varying vec4 vColor;
void main() {
    vec4 t = textured ? mix(texture2D(map, vUv), texture2D(map, vUv2), vBlend) : vec4(1.0);
    vec4 c = t * vColor;
    c.rgb *= overbright;
    if (c.a < 0.003 && vColor.a > 0.0) discard;
    gl_FragColor = c;
}
`;

interface Resolved {
    material: THREE.ShaderMaterial | null;
    sheet: Sheet | null;
    blendFrames: boolean;
}

/** One renderer of one system: its mesh and how it fills it. */
class View {
    readonly mesh: THREE.Mesh;
    private geom = new THREE.BufferGeometry();
    private pos: Float32Array;
    private col: Float32Array;
    private uv: Float32Array;
    private uv2: Float32Array;
    private blend: Float32Array;
    private capacity: number;
    private resolved: Resolved | null = null;
    private kind: 'sprites' | 'trail' | 'rope';
    private params: Map<string, unknown>;

    constructor(private sys: ParticleSystem, op: PcfOperator, private scene: THREE.Scene, resolve: Promise<Resolved>) {
        const fn = op.fn.toLowerCase();
        this.kind = fn === 'render_sprite_trail' ? 'trail' : fn === 'render_rope' ? 'rope' : 'sprites';
        this.params = op.attrs;
        this.capacity = sys.maxParticles;
        const n = this.capacity * 4;
        this.pos = new Float32Array(n * 3);
        this.col = new Float32Array(n * 4);
        this.uv = new Float32Array(n * 2);
        this.uv2 = new Float32Array(n * 2);
        this.blend = new Float32Array(n);
        const index = new Uint32Array(this.capacity * 6);
        for (let i = 0; i < this.capacity; i++) index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
        this.geom.setIndex(new THREE.BufferAttribute(index, 1));
        this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
        this.geom.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
        this.geom.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
        this.geom.setAttribute('uv2', new THREE.BufferAttribute(this.uv2, 2).setUsage(THREE.DynamicDrawUsage));
        this.geom.setAttribute('blend', new THREE.BufferAttribute(this.blend, 1).setUsage(THREE.DynamicDrawUsage));
        this.mesh = new THREE.Mesh(this.geom, undefined);
        this.mesh.name = 'particles:' + sys.name + ':' + this.kind;
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        this.mesh.renderOrder = 10;
        scene.add(this.mesh);
        void resolve.then((r) => {
            this.resolved = r;
            sys.sheet = r.sheet;
            if (r.material) this.mesh.material = r.material;
        });
    }

    private n(key: string, d = 0) {
        const v = this.params.get(key);
        return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d;
    }

    update(camera: THREE.Camera) {
        const r = this.resolved;
        const live = this.sys.particles;
        if (!r?.material || !live.length) {
            this.mesh.visible = false;
            return;
        }
        this.mesh.visible = true;
        const m = camera.matrixWorld.elements;
        const right: Vec3 = [m[0], m[1], m[2]], up: Vec3 = [m[4], m[5], m[6]];
        const eye: Vec3 = [m[12], m[13], m[14]];
        let list: Particle[] = live;
        if (this.sys.def.attrs.get('Sort particles') !== false && r.material.blending === THREE.NormalBlending) {
            const d = (p: Particle) => (p.pos[0] - eye[0]) ** 2 + (p.pos[1] - eye[1]) ** 2 + (p.pos[2] - eye[2]) ** 2;
            list = [...live].sort((a, b) => d(b) - d(a));
        }
        let quads = 0;
        if (this.kind === 'rope') quads = this.fillRope(list, right, up, eye, r);
        else for (const p of list) {
            if (quads >= this.capacity) break;
            if (p.alpha <= 0.002 || p.radius <= 0) continue;
            if (this.kind === 'trail') this.trailQuad(quads, p, eye, r);
            else this.spriteQuad(quads, p, right, up, eye, r);
            quads++;
        }
        this.geom.setDrawRange(0, quads * 6);
        // Only what was written goes to the GPU, not the whole worst-case buffer.
        for (const a of ['position', 'color', 'uv', 'uv2', 'blend'] as const) {
            const attr = this.geom.getAttribute(a) as THREE.BufferAttribute;
            attr.clearUpdateRanges();
            attr.addUpdateRange(0, quads * 4 * attr.itemSize);
            attr.needsUpdate = true;
        }
    }

    /** Frame rects for a particle: [u0, v0, u1, v1] for the current and next frame, and the mix between. */
    private frames(p: Particle, r: Resolved): { a: number[]; b: number[]; mix: number } {
        const seq = r.sheet?.sequences.get(p.sequence) ?? r.sheet?.sequences.get(0);
        if (!seq || !seq.frames.length) return { a: [0, 0, 1, 1], b: [0, 0, 1, 1], mix: 0 };
        const count = seq.frames.length;
        let f: number;
        if (this.params.get('animation_fit_lifetime') ?? false) f = (p.age / p.life) * count;
        else f = p.age * this.n('animation rate', 1) * (this.params.get('use animation rate as FPS') ? 1 : count);
        if (count === 1) return { a: seq.frames[0].rect, b: seq.frames[0].rect, mix: 0 };
        let i0: number, i1: number;
        if (seq.clamp) {
            f = Math.min(f, count - 1);
            i0 = Math.floor(f);
            i1 = Math.min(i0 + 1, count - 1);
        } else {
            i0 = Math.floor(f) % count;
            i1 = (i0 + 1) % count;
        }
        return { a: seq.frames[i0].rect, b: seq.frames[i1].rect, mix: r.blendFrames ? f - Math.floor(f) : 0 };
    }

    private put(q: number, corners: Vec3[], p: Particle, r: Resolved, uvCorners: [number, number][] | null) {
        const f = this.frames(p, r);
        const rect = (x: number[], c: number): [number, number] => {
            // Corner order: top-left, top-right, bottom-right, bottom-left.
            const u = c === 0 || c === 3 ? x[0] : x[2], v = c < 2 ? x[1] : x[3];
            return [u, v];
        };
        for (let c = 0; c < 4; c++) {
            const i = q * 4 + c;
            this.pos.set(corners[c], i * 3);
            this.col.set([p.color[0], p.color[1], p.color[2], Math.max(0, Math.min(1, p.alpha))], i * 4);
            const [u, v] = uvCorners ? uvCorners[c] : rect(f.a, c);
            this.uv.set([u, v], i * 2);
            // A second frame to blend to; for stretched quads reuse the rect's mapping.
            const [u2, v2] = rect(f.b, c);
            this.uv2.set(uvCorners ? [u, v] : [u2, v2], i * 2);
            this.blend[i] = uvCorners ? 0 : f.mix;
        }
    }

    private spriteQuad(q: number, p: Particle, camRight: Vec3, camUp: Vec3, eye: Vec3, r: Resolved) {
        const type = this.n('orientation_type', 0);
        let right = camRight, up = camUp;
        if (type === 1) {
            // Faces the camera but stays upright.
            const to: Vec3 = [eye[0] - p.pos[0], eye[1] - p.pos[1], 0];
            const l = Math.hypot(to[0], to[1]) || 1;
            right = [to[1] / l, -to[0] / l, 0];
            up = [0, 0, 1];
        } else if (type >= 2) {
            const cp = this.sys.cp(Math.max(0, this.n('orientation control point', 0)));
            right = cp.left;
            up = cp.up;
        }
        const a = ((p.rotation + (type >= 2 ? p.yaw : 0)) * Math.PI) / 180;
        const cs = Math.cos(a) * p.radius, sn = Math.sin(a) * p.radius;
        // Corner offsets rotated about the view axis.
        const o = (x: number, y: number): Vec3 => {
            const rx = x * cs - y * sn, ry = x * sn + y * cs;
            return [p.pos[0] + right[0] * rx + up[0] * ry, p.pos[1] + right[1] * rx + up[1] * ry, p.pos[2] + right[2] * rx + up[2] * ry];
        };
        this.put(q, [o(-1, 1), o(1, 1), o(1, -1), o(-1, -1)], p, r, null);
    }

    private trailQuad(q: number, p: Particle, eye: Vec3, r: Resolved) {
        const speed = Math.hypot(...p.vel);
        const dir: Vec3 = speed > 1e-3 ? [p.vel[0] / speed, p.vel[1] / speed, p.vel[2] / speed] : [0, 0, 1];
        const length = Math.max(this.n('min length'), Math.min(this.n('max length', 2000), speed * p.trail));
        const tail: Vec3 = [p.pos[0] - dir[0] * length, p.pos[1] - dir[1] * length, p.pos[2] - dir[2] * length];
        const view: Vec3 = [eye[0] - p.pos[0], eye[1] - p.pos[1], eye[2] - p.pos[2]];
        let side: Vec3 = [dir[1] * view[2] - dir[2] * view[1], dir[2] * view[0] - dir[0] * view[2], dir[0] * view[1] - dir[1] * view[0]];
        const l = Math.hypot(...side) || 1;
        side = [(side[0] / l) * p.radius, (side[1] / l) * p.radius, (side[2] / l) * p.radius];
        const add = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
        // The head is the first column of the sprite, the tail the last; V runs across.
        const f = this.frames(p, r).a;
        const uvs: [number, number][] = [[f[0], f[1]], [f[2], f[1]], [f[2], f[3]], [f[0], f[3]]];
        this.put(q, [add(p.pos, side, 1), add(tail, side, 1), add(tail, side, -1), add(p.pos, side, -1)], p, r, uvs);
    }

    private fillRope(list: Particle[], _right: Vec3, _up: Vec3, eye: Vec3, r: Resolved): number {
        // Ropes join the particles in the order they were made, not the sorted order.
        const ps = this.sys.particles;
        let q = 0, along = 0;
        const step = 1 / Math.max(1, this.n('texel_size', 0.1) * 40);
        for (let i = 0; i + 1 < ps.length && q < this.capacity; i++) {
            const a = ps[i], b = ps[i + 1];
            const d: Vec3 = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]];
            const dl = Math.hypot(...d) || 1;
            const view: Vec3 = [eye[0] - a.pos[0], eye[1] - a.pos[1], eye[2] - a.pos[2]];
            let side: Vec3 = [d[1] * view[2] - d[2] * view[1], d[2] * view[0] - d[0] * view[2], d[0] * view[1] - d[1] * view[0]];
            const l = Math.hypot(...side) || 1;
            const sa: Vec3 = [(side[0] / l) * a.radius, (side[1] / l) * a.radius, (side[2] / l) * a.radius];
            const sb: Vec3 = [(side[0] / l) * b.radius, (side[1] / l) * b.radius, (side[2] / l) * b.radius];
            side = sa;
            const u0 = along * step, u1 = (along + dl) * step;
            along += dl;
            const f = this.frames(a, r).a;
            const mapU = (u: number) => f[0] + (f[2] - f[0]) * (u - Math.floor(u));
            const corners: Vec3[] = [
                [a.pos[0] + sa[0], a.pos[1] + sa[1], a.pos[2] + sa[2]],
                [b.pos[0] + sb[0], b.pos[1] + sb[1], b.pos[2] + sb[2]],
                [b.pos[0] - sb[0], b.pos[1] - sb[1], b.pos[2] - sb[2]],
                [a.pos[0] - sa[0], a.pos[1] - sa[1], a.pos[2] - sa[2]],
            ];
            const uvs: [number, number][] = [[mapU(u0), f[1]], [u1 - Math.floor(u1) < 0.001 ? f[2] : mapU(u1), f[1]], [u1 - Math.floor(u1) < 0.001 ? f[2] : mapU(u1), f[3]], [mapU(u0), f[3]]];
            this.put(q, corners, a, r, uvs);
            q++;
        }
        void list;
        return q;
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.geom.dispose();
    }
}

/** Something the game spawned: the root system and what draws it. */
export class ParticleEffect {
    private binds = new Map<number, () => Vec3 | null>();
    readonly views: View[] = [];
    private seen = new Set<ParticleSystem>();

    constructor(readonly sys: ParticleSystem) {}

    get done() { return this.sys.done; }

    /** Control point `i` follows `get()` every frame. */
    bind(i: number, get: () => Vec3 | null) {
        this.binds.set(i, get);
        return this;
    }

    setControlPoint(i: number, pos: Vec3, fwd?: Vec3, up?: Vec3) {
        this.sys.setControlPoint(i, pos, fwd, up);
    }

    stop() { this.sys.stop(); }

    /** Ends the effect at once, without letting what's alive finish. */
    kill() { this.sys.kill(); }

    /** @internal */
    applyBinds() {
        for (const [i, get] of this.binds) {
            const p = get();
            if (p) this.sys.cp(i).pos = [...p];
        }
    }

    /** @internal */
    has(s: ParticleSystem) { return this.seen.has(s); }
    /** @internal */
    mark(s: ParticleSystem) { this.seen.add(s); }
}

export class ParticleManager {
    private defs = new Map<string, ParticleDef>();
    private effects: ParticleEffect[] = [];
    private resolved = new Map<string, Promise<Resolved>>();
    private env: ParticleEnv;
    private scene: THREE.Scene;
    private ready: Promise<void>;
    trace: ParticleEnv['trace'];
    playerPos: ParticleEnv['playerPos'];

    constructor(private fs: GameFS, private textures: TextureCache, scene: THREE.Scene) {
        this.scene = scene;
        this.env = {
            find: (n) => this.defs.get(n.toLowerCase()),
            trace: (a, b) => this.trace?.(a, b) ?? null,
            playerPos: () => this.playerPos?.() ?? null,
            spawned: (s) => this.adopt(s),
        };
        this.ready = this.loadAll();
    }

    private currentRoot: ParticleEffect | null = null;
    private flights: { fx: ParticleEffect; from: Vec3; to: Vec3; age: number; duration: number }[] = [];

    private async loadAll() {
        // The DX8 variants repeat the same names with cheaper settings; the full ones are used.
        const files = this.fs.list('particles/', '.pcf').filter((f) => !f.includes('_dx80'));
        await Promise.all(files.map(async (f) => {
            const bytes = await this.fs.read(f);
            if (!bytes) return;
            try {
                for (const [name, def] of parsePcf(bytes)) if (!this.defs.has(name.toLowerCase())) this.defs.set(name.toLowerCase(), def);
            } catch (e) {
                console.warn(f, e);
            }
        }));
        // The elevator's ring-wave sprites and the glow discs at the top of its beam are left out.
        const beam = this.defs.get('elevator_beam');
        if (beam) beam.children = beam.children.filter((c) => !/^(elevator_core2?|elevator_beam_top)$/i.test(c.system));
    }

    has(name: string) { return this.defs.has(name.toLowerCase()); }

    /** A system definition from the game files, once they've loaded. */
    async find(name: string): Promise<ParticleDef | undefined> {
        await this.ready;
        return this.defs.get(name.toLowerCase());
    }

    /** Starts an effect by name; null if no such system exists. */
    async spawn(name: string, at: Vec3 = [0, 0, 0], fwd?: Vec3, up?: Vec3): Promise<ParticleEffect | null> {
        await this.ready;
        const def = this.defs.get(name.toLowerCase());
        return def ? this.spawnDef(def, at, fwd, up) : null;
    }

    /** Starts a system built in code (the map's env_steam, env_spark and so on). */
    spawnDef(def: ParticleDef, at: Vec3 = [0, 0, 0], fwd?: Vec3, up?: Vec3): ParticleEffect {
        const cps: ControlPoint[] = [];
        const sys = new ParticleSystem(def, this.env, cps);
        sys.setControlPoint(0, at, fwd, up);
        const fx = new ParticleEffect(sys);
        this.effects.push(fx);
        this.currentRoot = fx;
        this.adopt(sys);
        return fx;
    }

    /** An effect that travels from `from` to `to` over `duration` seconds, then ends (the portal gun's shot). */
    async fly(name: string, from: Vec3, to: Vec3, duration: number): Promise<boolean> {
        const fx = await this.spawn(name, from);
        if (!fx) return false;
        this.flights.push({ fx, from, to, age: 0, duration: Math.max(0.05, duration) });
        return true;
    }

    /** Gives a system (root or child) its meshes. */
    private adopt(sys: ParticleSystem) {
        const fx = sys.parent ? this.rootOf(sys) : this.currentRoot;
        if (!fx || fx.has(sys)) return;
        fx.mark(sys);
        const res = this.resolve(sys.def);
        for (const r of sys.def.renderers) {
            const fn = r.fn.toLowerCase();
            if (fn === 'render_animated_sprites' || fn === 'render_sprite_trail' || fn === 'render_rope') fx.views.push(new View(sys, r, this.scene, res));
        }
    }

    private rootOf(sys: ParticleSystem): ParticleEffect | null {
        let top = sys;
        while (top.parent) top = top.parent;
        return this.effects.find((e) => e.sys === top) ?? null;
    }

    private resolve(def: ParticleDef): Promise<Resolved> {
        const name = String(def.attrs.get('material') ?? '');
        // Code-built systems can force additive blending, which a sprite's own material leaves to the entity.
        const additive = def.attrs.get('additive') === true;
        const key = additive ? name + '|add' : name;
        let p = this.resolved.get(key);
        if (!p) this.resolved.set(key, (p = this.load(name, additive)));
        return p;
    }

    private async load(name: string, forceAdditive = false): Promise<Resolved> {
        const none: Resolved = { material: null, sheet: null, blendFrames: true };
        let def: MaterialDef | null = null;
        try {
            def = await loadMaterial(this.fs, name);
        } catch {
            return none;
        }
        if (!def || def.shader === 'refract') return none;
        const base = def.params['$basetexture'];
        const tex = base ? await this.textures.get(base) : null;
        let sheet: Sheet | null = null;
        if (base) {
            const bytes = await this.fs.read(texturePath(base));
            if (bytes) sheet = parseSheet(bytes);
        }
        const flag = (k: string) => (def!.params[k] ?? '0') !== '0';
        const additive = forceAdditive || flag('$additive') || flag('$addself') || def.params['$spriterendermode'] === '5';
        const material = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms: {
                map: { value: tex },
                textured: { value: !!tex },
                overbright: { value: Number(def.params['$overbrightfactor'] ?? 1) || 1 },
            },
            transparent: true,
            depthWrite: false,
            depthTest: !flag('$ignorez'),
            side: THREE.DoubleSide,
            blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        return { material, sheet, blendFrames: def.params['$blendframes'] !== '0' };
    }

    update(dt: number, camera: THREE.Camera) {
        camera.updateMatrixWorld();
        for (const f of this.flights) {
            f.age += dt;
            const t = Math.min(1, f.age / f.duration);
            f.fx.setControlPoint(0, [f.from[0] + (f.to[0] - f.from[0]) * t, f.from[1] + (f.to[1] - f.from[1]) * t, f.from[2] + (f.to[2] - f.from[2]) * t]);
            if (t >= 1) f.fx.stop();
        }
        this.flights = this.flights.filter((f) => f.age < f.duration);
        for (const fx of this.effects) {
            fx.applyBinds();
            fx.sys.step(dt);
            for (const v of fx.views) v.update(camera);
        }
        const gone = this.effects.filter((e) => e.done);
        for (const fx of gone) {
            for (const v of fx.views) v.dispose();
            this.effects.splice(this.effects.indexOf(fx), 1);
        }
    }

    get count() { return this.effects.length; }
}
