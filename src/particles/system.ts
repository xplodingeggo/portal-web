// CPU particle simulation: the Source particle system (CParticleCollection) as the .pcf files
// describe it. Each definition runs its emitters, initializers (on creation) and operators (every
// frame, in listed order) over its control points; movement, forces and constraints go through
// "Movement Basic", as in the game. Child systems share the parent's control points.
import type { ParticleDef, PcfOperator, PcfValue } from './pcf';
import type { Sheet } from './sheet';

export type Vec3 = [number, number, number];

export interface Particle {
    id: number;
    pos: Vec3;
    vel: Vec3;
    age: number;
    life: number;
    /** System age when it was created. */
    created: number;
    radius: number;
    radius0: number;
    rotation: number;
    rotationSpeed: number;
    yaw: number;
    color: Vec3;
    color0: Vec3;
    alpha: number;
    alpha0: number;
    sequence: number;
    sequence2: number;
    trail: number;
    /** Stable randoms for operators that give each particle its own timing. */
    rand: number[];
    dead: boolean;
}

export interface ControlPoint {
    pos: Vec3;
    fwd: Vec3;
    left: Vec3;
    up: Vec3;
    vel: Vec3;
    /** Position at the start of the step, for velocity and for lock-to-control-point. */
    last: Vec3;
}

/** What a simulation needs from the game. */
export interface ParticleEnv {
    /** A ray through the world: where it first hits, with the surface normal. */
    trace?(from: Vec3, to: Vec3): { end: Vec3; normal: Vec3 } | null;
    /** The player's origin, for operators that follow them. */
    playerPos?(): Vec3 | null;
    /** Looks up another system definition by name (for children). */
    find(name: string): ParticleDef | undefined;
    /** Called as new systems (children) come to life, so the renderer can draw them. */
    spawned?(sys: ParticleSystem): void;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
    const l = len(a) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
};
/** SimpleSpline-style ease used by the fade operators (bias 0.5 is symmetric smoothstep). */
const ease = (t: number) => t * t * (3 - 2 * t);

function hash(n: number) {
    let h = (n | 0) * 374761393;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
/** Smooth value noise in 0..1. */
function noise(x: number, y: number, z: number) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const f = (t: number) => t * t * (3 - 2 * t);
    const fx = f(x - xi), fy = f(y - yi), fz = f(z - zi);
    const h = (a: number, b: number, c: number) => hash(a * 73856093 ^ b * 19349663 ^ c * 83492791);
    let v = 0;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
        v += h(xi + i, yi + j, zi + k) * (i ? fx : 1 - fx) * (j ? fy : 1 - fy) * (k ? fz : 1 - fz);
    }
    return v;
}

function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

class Params {
    constructor(private a: Map<string, PcfValue>) {}
    n(key: string, d = 0): number {
        const v = this.a.get(key);
        return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d;
    }
    b(key: string, d = false): boolean {
        const v = this.a.get(key);
        return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : d;
    }
    v(key: string, d: Vec3 = [0, 0, 0]): Vec3 {
        const v = this.a.get(key);
        return Array.isArray(v) && v.length >= 3 && typeof v[0] === 'number' ? [v[0] as number, v[1] as number, v[2] as number] : d;
    }
    s(key: string, d = ''): string {
        const v = this.a.get(key);
        return typeof v === 'string' ? v : d;
    }
}

type Init = (s: ParticleSystem, p: Particle) => void;
type Operate = (s: ParticleSystem, dt: number, fade: number) => void;
type Force = (s: ParticleSystem, p: Particle, accel: Vec3) => void;
type Constrain = (s: ParticleSystem, p: Particle, dt: number, pass: number) => void;

const DEFAULT_CP = (): ControlPoint => ({
    pos: [0, 0, 0], fwd: [1, 0, 0], left: [0, 1, 0], up: [0, 0, 1], vel: [0, 0, 0], last: [0, 0, 0],
});

export class ParticleSystem {
    readonly name: string;
    age = 0;
    /** The particles, oldest first. */
    particles: Particle[] = [];
    children: { sys: ParticleSystem | null; delay: number; def: string }[] = [];
    cps: ControlPoint[];
    sheet: Sheet | null = null;
    stopped = false;
    /** Fully finished: nothing alive and nothing more will be emitted. */
    done = false;
    parent: ParticleSystem | null = null;
    readonly maxParticles: number;
    readonly rand: () => number;
    private nextId = 0;
    private emitters: { p: Params; acc: number; fired: boolean }[];
    private inits: { p: Params; run: Init; op: PcfOperator }[];
    private ops: { p: Params; run: Operate }[];
    private forces: Force[] = [];
    private constraints: Constrain[] = [];
    private gravity: Vec3 = [0, 0, 0];
    private drag = 0;
    private passes = 3;
    private tick = 0;
    private defaults: { radius: number; color: Vec3; alpha: number; rotation: number; rotationSpeed: number; sequence: number; sequence2: number };

    constructor(readonly def: ParticleDef, private env: ParticleEnv, cps?: ControlPoint[], seed = Math.random() * 1e9) {
        this.name = def.name;
        this.rand = rng(seed);
        this.cps = cps ?? [];
        const a = new Params(def.attrs);
        this.maxParticles = Math.max(1, a.n('max_particles', 1000));
        const c = def.attrs.get('color');
        this.defaults = {
            radius: a.n('radius', 5),
            color: Array.isArray(c) ? [(c[0] as number) / 255, (c[1] as number) / 255, (c[2] as number) / 255] : [1, 1, 1],
            alpha: Array.isArray(c) ? (c[3] as number) / 255 : 1,
            rotation: a.n('rotation'),
            rotationSpeed: a.n('rotation_speed'),
            sequence: a.n('sequence_number'),
            sequence2: a.n('sequence_number 1'),
        };
        this.emitters = def.emitters.map((e) => ({ p: new Params(e.attrs), acc: 0, fired: false }));
        this.children = def.children.map((c) => ({ sys: null, delay: c.delay, def: c.system }));
        this.inits = def.initializers.flatMap((op) => {
            const run = this.makeInit(op);
            return run ? [{ p: new Params(op.attrs), run, op }] : [];
        });
        this.ops = def.operators.flatMap((op) => {
            const run = this.makeOperator(op);
            return run ? [{ p: new Params(op.attrs), run }] : [];
        });
        for (const f of def.forces) {
            const run = this.makeForce(f);
            if (run) this.forces.push(run);
        }
        for (const k of def.constraints) {
            const run = this.makeConstraint(k);
            if (run) this.constraints.push(run);
        }
        const mb = def.operators.find((o) => o.fn.toLowerCase() === 'movement basic');
        if (mb) {
            const m = new Params(mb.attrs);
            this.gravity = m.v('gravity');
            this.drag = m.n('drag');
            this.passes = m.n('max constraint passes', 3);
        }
        // Emission starts when the system does; "initial_particles" appear at once.
        for (let i = a.n('initial_particles'); i > 0; i--) this.emit();
    }

    /** Control point `i`, made on first use. */
    cp(i: number): ControlPoint {
        while (this.cps.length <= i) this.cps.push(DEFAULT_CP());
        return this.cps[i];
    }

    setControlPoint(i: number, pos: Vec3, fwd?: Vec3, up?: Vec3) {
        const c = this.cp(i);
        c.pos = [...pos];
        if (fwd && up) {
            c.fwd = norm(fwd);
            c.up = norm(up);
            c.left = norm(cross(c.up, c.fwd));
            c.up = cross(c.fwd, c.left);
        }
    }

    /** Removes the system and everything alive in it at once. */
    kill() {
        this.particles = [];
        this.stopped = true;
        this.done = true;
        for (const c of this.children) c.sys?.kill();
    }

    /** Stops emitting; what's alive finishes. */
    stop() {
        this.stopped = true;
        for (const c of this.children) c.sys?.stop();
    }

    /** Moves a vector from a control point's local frame (x forward, y left, z up) into the world. */
    toWorld(cp: ControlPoint, v: Vec3): Vec3 {
        return [
            cp.fwd[0] * v[0] + cp.left[0] * v[1] + cp.up[0] * v[2],
            cp.fwd[1] * v[0] + cp.left[1] * v[1] + cp.up[1] * v[2],
            cp.fwd[2] * v[0] + cp.left[2] * v[1] + cp.up[2] * v[2],
        ];
    }

    private randIn(lo: number, hi: number, exp = 1) {
        const r = this.rand();
        return lerp(lo, hi, exp === 1 ? r : Math.pow(r, exp));
    }

    private unitVec(): Vec3 {
        const z = this.rand() * 2 - 1, a = this.rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
        return [r * Math.cos(a), r * Math.sin(a), z];
    }

    private emit(): Particle | null {
        if (this.particles.length >= this.maxParticles) return null;
        const d = this.defaults;
        const cp0 = this.cp(0);
        const id = this.nextId++;
        const p: Particle = {
            id, pos: [...cp0.pos], vel: [0, 0, 0], age: 0, life: 1, created: this.age,
            radius: d.radius, radius0: d.radius, rotation: d.rotation, rotationSpeed: d.rotationSpeed, yaw: 0,
            color: [...d.color], color0: [...d.color], alpha: d.alpha, alpha0: d.alpha,
            sequence: d.sequence, sequence2: d.sequence2, trail: 0.1,
            rand: [this.rand(), this.rand(), this.rand(), this.rand(), this.rand(), this.rand()], dead: false,
        };
        for (const i of this.inits) {
            const f = this.fadeOf(i.p);
            if (f <= 0 || (f < 1 && this.rand() > f)) continue;
            i.run(this, p);
        }
        p.radius0 = p.radius;
        p.alpha0 = p.alpha;
        p.color0 = [...p.color];
        this.particles.push(p);
        return p;
    }

    /** An operator's strength at this moment: its fade-in and fade-out windows, in system seconds. */
    private fadeOf(a: Params): number {
        const t = this.age;
        let s = 1;
        const inStart = a.n('operator start fadein'), inEnd = a.n('operator end fadein');
        const outStart = a.n('operator start fadeout'), outEnd = a.n('operator end fadeout');
        if (inEnd > inStart) s *= clamp01((t - inStart) / (inEnd - inStart));
        if (outEnd > outStart) s *= 1 - clamp01((t - outStart) / (outEnd - outStart));
        return s;
    }

    step(dt: number) {
        if (this.done) return;
        dt = Math.min(dt, 0.1);
        this.tick++;
        for (const c of this.cps) c.last = [...c.pos];
        this.age += dt;

        // Children come to life after their delay and share these control points.
        for (const c of this.children) {
            if (c.sys || this.age < c.delay || this.stopped) continue;
            const def = this.env.find(c.def);
            if (!def) { c.sys = null; c.delay = Infinity; continue; }
            c.sys = new ParticleSystem(def, this.env, this.cps);
            c.sys.parent = this;
            this.env.spawned?.(c.sys);
        }

        if (!this.stopped) this.runEmitters(dt);
        // Operators work from each particle's initial values, so reset what they scale or tint.
        for (const p of this.particles) {
            // Every particle ages with the system; Lifespan Decay and Alpha Fade and Decay kill them.
            p.age += dt;
            p.radius = p.radius0;
            p.alpha = p.alpha0;
            p.color = [...p.color0];
        }
        for (const o of this.ops) o.run(this, dt, this.fadeOf(o.p));
        this.particles = this.particles.filter((p) => !p.dead);

        for (const c of this.cps) {
            c.vel = dt > 0 ? scale(sub(c.pos, c.last), 1 / dt) : [0, 0, 0];
        }
        for (const c of this.children) c.sys?.step(dt);
        if (this.stopped || this.emittersDone()) {
            if (!this.particles.length && this.children.every((c) => !c.sys || c.sys.done)) this.done = true;
        }
    }

    private emittersDone() {
        return this.emitters.every((e, i) => {
            const fn = this.def.emitters[i].fn.toLowerCase();
            if (fn === 'emit_instantaneously') return e.fired;
            const dur = e.p.n('emission_duration');
            return dur > 0 && this.age > e.p.n('emission_start_time') + dur;
        });
    }

    private runEmitters(dt: number) {
        this.def.emitters.forEach((def, i) => {
            const e = this.emitters[i];
            const start = e.p.n('emission_start_time');
            if (this.age < start) return;
            const fade = this.fadeOf(e.p);
            if (def.fn.toLowerCase() === 'emit_instantaneously') {
                if (e.fired) return;
                e.fired = true;
                const n = e.p.n('num_to_emit', 100);
                for (let k = 0; k < n; k++) this.emit();
            } else {
                const dur = e.p.n('emission_duration');
                if (dur > 0 && this.age > start + dur) return;
                e.acc += e.p.n('emission_rate', 100) * dt * fade;
                for (; e.acc >= 1; e.acc--) this.emit();
            }
        });
    }

    // --- initializers ---------------------------------------------------------------------------

    private makeInit(op: PcfOperator): Init | null {
        const a = new Params(op.attrs);
        const rnd = (lo: number, hi: number, exp = 1) => this.randIn(lo, hi, exp);
        switch (op.fn.toLowerCase()) {
            case 'lifetime random':
                return (_s, p) => { p.life = Math.max(0.001, rnd(a.n('lifetime_min', 1), a.n('lifetime_max', 1), a.n('lifetime_random_exponent', 1))); };
            case 'radius random':
                return (_s, p) => { p.radius = rnd(a.n('radius_min', 1), a.n('radius_max', 1), a.n('radius_random_exponent', 1)); };
            case 'alpha random':
                return (_s, p) => { p.alpha = rnd(a.n('alpha_min', 255), a.n('alpha_max', 255), a.n('alpha_random_exponent', 1)) / 255; };
            case 'color random':
                return (_s, p) => {
                    const c1 = a.v('color1', [255, 255, 255]), c2 = a.v('color2', [255, 255, 255]);
                    const t = this.rand();
                    p.color = [lerp(c1[0], c2[0], t) / 255, lerp(c1[1], c2[1], t) / 255, lerp(c1[2], c2[2], t) / 255];
                };
            case 'rotation random':
                return (_s, p) => { p.rotation = a.n('rotation_initial') + rnd(a.n('rotation_offset_min'), a.n('rotation_offset_max'), a.n('rotation_random_exponent', 1)); };
            case 'rotation yaw random':
                return (_s, p) => { p.yaw = a.n('yaw_initial') + rnd(a.n('yaw_offset_min'), a.n('yaw_offset_max'), a.n('yaw_random_exponent', 1)); };
            case 'rotation yaw flip random':
                return (_s, p) => { if (this.rand() < a.n('Flip Percentage', 0.5)) p.yaw += 180; };
            case 'sequence random':
                return (_s, p) => { p.sequence = Math.floor(rnd(a.n('sequence_min'), a.n('sequence_max') + 0.999)); };
            case 'sequence two random':
                return (_s, p) => {
                    p.sequence = Math.floor(rnd(a.n('sequence_min'), a.n('sequence_max') + 0.999));
                    p.sequence2 = p.sequence;
                };
            case 'trail length random':
                return (_s, p) => { p.trail = rnd(a.n('length_min'), a.n('length_max'), a.n('length_random_exponent', 1)); };
            case 'lifetime pre-age noise':
                return (_s, p) => { p.age = this.rand() * (a.n('start age maximum') - a.n('start age minimum')) + a.n('start age minimum'); };
            case 'lifetime from sequence':
                return (s, p) => {
                    const seq = s.sheet?.sequences.get(p.sequence);
                    p.life = seq ? seq.frames.length / Math.max(1, a.n('Frames Per Second', 30)) : 1;
                };
            case 'position within sphere random':
                return (s, p) => {
                    const cp = s.cp(a.n('control_point_number'));
                    const dir = this.unitVec();
                    const dist = rnd(a.n('distance_min'), a.n('distance_max'));
                    const bias = a.v('distance_bias', [1, 1, 1]), abs = a.v('distance_bias_absolute_value');
                    // The bias flattens or stretches the direction, which is then put back at the full distance:
                    // a bias of [1, 1, 0] makes a ring of that radius, not a filled disc.
                    const biased: Vec3 = [dir[0] * bias[0], dir[1] * bias[1], dir[2] * bias[2]];
                    const reach = len(biased) || 1;
                    let off: Vec3 = scale(biased, dist / reach);
                    for (let k = 0; k < 3; k++) if (abs[k]) off[k] = Math.abs(off[k]);
                    if (a.b('bias in local system')) off = s.toWorld(cp, off);
                    p.pos = add(cp.pos, off);
                    const speed = rnd(a.n('speed_min'), a.n('speed_max'), a.n('speed_random_exponent', 1));
                    let vel = scale(norm(off.every((x) => x === 0) ? dir : off), speed);
                    const lo = a.v('speed_in_local_coordinate_system_min'), hi = a.v('speed_in_local_coordinate_system_max');
                    vel = add(vel, s.toWorld(cp, [rnd(lo[0], hi[0]), rnd(lo[1], hi[1]), rnd(lo[2], hi[2])]));
                    p.vel = vel;
                };
            case 'position within box random':
                return (s, p) => {
                    const cp = s.cp(a.n('control point number'));
                    const lo = a.v('min'), hi = a.v('max');
                    p.pos = add(cp.pos, s.toWorld(cp, [rnd(lo[0], hi[0]), rnd(lo[1], hi[1]), rnd(lo[2], hi[2])]));
                };
            case 'position modify offset random':
                return (s, p) => {
                    const cp = s.cp(a.n('control_point_number'));
                    const lo = a.v('offset min'), hi = a.v('offset max');
                    let off: Vec3 = [rnd(lo[0], hi[0]), rnd(lo[1], hi[1]), rnd(lo[2], hi[2])];
                    if (a.b('offset proportional to radius 0/1')) off = scale(off, p.radius);
                    p.pos = add(p.pos, a.b('offset in local space 0/1') ? s.toWorld(cp, off) : off);
                };
            case 'position modify warp random':
                return (s, p) => {
                    const cp = s.cp(a.n('control point number'));
                    const lo = a.v('warp min', [1, 1, 1]), hi = a.v('warp max', [1, 1, 1]);
                    const w: Vec3 = [rnd(lo[0], hi[0]), rnd(lo[1], hi[1]), rnd(lo[2], hi[2])];
                    const rel = sub(p.pos, cp.pos);
                    // In local space the warp scales along the control point's own axes.
                    const local: Vec3 = a.b('local coordinate space', true)
                        ? [dot(rel, cp.fwd), dot(rel, cp.left), dot(rel, cp.up)]
                        : rel;
                    const warped: Vec3 = [local[0] * w[0], local[1] * w[1], local[2] * w[2]];
                    p.pos = add(cp.pos, a.b('local coordinate space', true) ? s.toWorld(cp, warped) : warped);
                };
            case 'position along path sequential': {
                let counter = 0;
                return (s, p) => {
                    const c0 = s.cp(a.n('start control point number')), c1 = s.cp(a.n('end control point number', 1));
                    const n = Math.max(2, a.n('particles to map from start to end', 50));
                    const loop = a.b('restart behavior (0 = bounce, 1 = loop )');
                    let k = counter++ % (loop ? n : (n - 1) * 2);
                    if (!loop && k >= n) k = (n - 1) * 2 - k;
                    const t = k / (n - 1);
                    const base = add(scale(c0.pos, 1 - t), scale(c1.pos, t));
                    const bulge = scale(c0.up, a.n('bulge') * Math.sin(Math.PI * t));
                    const jitter = scale(this.unitVec(), a.n('maximum distance') * this.rand());
                    p.pos = add(add(base, bulge), jitter);
                };
            }
            case 'position in cp hierarchy':
                return (s, p) => {
                    const c0 = s.cp(a.n('start control point number')), c1 = s.cp(a.n('end control point number', 1));
                    const t = this.rand();
                    const jitter = scale(this.unitVec(), a.n('maximum distance') * this.rand());
                    p.pos = add(add(scale(c0.pos, 1 - t), scale(c1.pos, t)), jitter);
                };
            case 'position on model random':
                return (s, p) => {
                    // No hitboxes here: a point around the control point stands in for the model.
                    const cp = s.cp(a.n('control_point_number', 1));
                    p.pos = add(cp.pos, add(scale(this.unitVec(), 12), [0, 0, 24 * this.rand()]));
                    p.vel = scale(a.v('direction bias'), 1);
                };
            case 'velocity noise':
                return (s, p) => {
                    const lo = a.v('output minimum'), hi = a.v('output maximum');
                    const ts = a.n('Time Noise Coordinate Scale'), ps = a.n('Spatial Noise Coordinate Scale');
                    const n = (o: number) => noise(s.age * ts + o, p.pos[0] * ps + o * 7, p.pos[1] * ps + p.pos[2] * ps);
                    const v: Vec3 = [lerp(lo[0], hi[0], n(0)), lerp(lo[1], hi[1], n(11)), lerp(lo[2], hi[2], n(23))];
                    p.vel = add(p.vel, a.b('Apply Velocity in Local Space (0/1)') ? s.toWorld(s.cp(a.n('Control Point Number')), v) : v);
                };
            case 'velocity inherit from control point':
                return (s, p) => { p.vel = add(p.vel, scale(s.cp(a.n('control point number')).vel, a.n('velocity scale', 1))); };
            case 'velocity repulse from world': {
                const repulseCache = new Map<string, Vec3>();
                let lastTick = -1;
                return (_s, p) => {
                    if (this.tick !== lastTick) {
                        repulseCache.clear();
                        lastTick = this.tick;
                    }
                    // Pushes away from a nearby surface, found with short rays along each axis.
                    const trace = this.env.trace;
                    if (!trace) return;
                    const reach = a.n('Trace Length', 16);
                    // Hundreds appear in one spot at once: share the answer between neighbours instead of
                    // casting six rays each (3000 world traces in a frame).
                    const key = Math.round(p.pos[0] / 6) + ',' + Math.round(p.pos[1] / 6) + ',' + Math.round(p.pos[2] / 6);
                    let push = repulseCache.get(key);
                    if (!push) {
                        push = [0, 0, 0];
                        for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as Vec3[]) {
                            const hit = trace(p.pos, add(p.pos, scale(d, reach)));
                            if (hit) for (let k = 0; k < 3; k++) push[k] -= d[k];
                        }
                        repulseCache.set(key, push);
                    }
                    const lo = a.v('minimum velocity'), hi = a.v('maximum velocity', [1, 1, 1]);
                    p.vel = add(p.vel, [push[0] * rnd(lo[0], hi[0]), push[1] * rnd(lo[1], hi[1]), push[2] * rnd(lo[2], hi[2])]);
                };
            }
            case 'remap initial scalar':
                return (s, p) => {
                    const t = clamp01((p.created - a.n('input minimum')) / ((a.n('input maximum') - a.n('input minimum')) || 1));
                    const input = a.n('input field', 8) === 8 ? t : t;
                    const out = lerp(a.n('output minimum'), a.n('output maximum'), input);
                    s.setField(p, a.n('output field', 7), out, a.b('output is scalar of initial random range'));
                };
            case 'remap scalar to vector':
                return (s, p) => {
                    const t = clamp01((p.created - a.n('input minimum')) / ((a.n('input maximum') - a.n('input minimum')) || 1));
                    const lo = a.v('output minimum'), hi = a.v('output maximum');
                    let v: Vec3 = [lerp(lo[0], hi[0], t), lerp(lo[1], hi[1], t), lerp(lo[2], hi[2], t)];
                    if (a.b('use local system', true)) v = s.toWorld(s.cp(a.n('control_point_number')), v);
                    if (a.n('output field') === 0) p.pos = add(p.pos, v);
                    else p.vel = add(p.vel, v);
                };
            case 'remap noise to scalar':
                return (s, p) => {
                    const ts = a.n('time noise coordinate scale'), ps = a.n('spatial noise coordinate scale');
                    let n = noise(s.age * ts + a.n('time coordinate offset'), p.pos[0] * ps, p.pos[1] * ps + p.pos[2] * ps);
                    if (a.b('absolute value')) n = Math.abs(n * 2 - 1);
                    s.setField(p, a.n('output field', 4), lerp(a.n('output minimum'), a.n('output maximum'), n), false);
                };
            default:
                return null;
        }
    }

    /** Sets a particle attribute by Source field id; `multiply` scales its initial value instead. */
    setField(p: Particle, field: number, value: number, multiply: boolean) {
        switch (field) {
            case 1: p.life = multiply ? p.life * value : value; break;
            case 3: p.radius = multiply ? p.radius0 * value : value; break;
            case 4: p.rotation = multiply ? p.rotation * value : value; break;
            case 5: p.rotationSpeed = multiply ? p.rotationSpeed * value : value; break;
            case 7: p.alpha = multiply ? p.alpha0 * value : value; break;
            case 10: p.trail = multiply ? p.trail * value : value; break;
            case 12: p.yaw = value; break;
            default: break;
        }
    }

    // --- operators ------------------------------------------------------------------------------

    private each(f: (p: Particle) => void) {
        for (const p of this.particles) if (!p.dead) f(p);
    }

    private makeOperator(op: PcfOperator): Operate | null {
        const a = new Params(op.attrs);
        switch (op.fn.toLowerCase()) {
            case 'movement basic':
                return (s, dt) => s.move(dt);
            case 'lifespan decay':
                return (s) => s.each((p) => { if (p.age >= p.life) p.dead = true; });
            case 'radius scale':
                return (s) => s.each((p) => {
                    const t = clamp01(((p.age / p.life) - a.n('start_time')) / ((a.n('end_time', 1) - a.n('start_time')) || 1));
                    p.radius = p.radius0 * lerp(a.n('radius_start_scale', 1), a.n('radius_end_scale', 1), a.b('ease_in_and_out', true) ? ease(t) : t);
                });
            case 'alpha fade out random':
                return (s, _dt, fade) => s.each((p) => {
                    const dur = lerp(a.n('fade out time min', 0.1), a.n('fade out time max', 0.1), p.rand[0]);
                    const frac = a.b('proportional 0/1') ? dur : dur / p.life;
                    const t = p.age / p.life;
                    if (t > 1 - frac) p.alpha *= 1 - (a.b('ease in and out', true) ? ease : (x: number) => x)(clamp01((t - (1 - frac)) / (frac || 1))) * fade;
                });
            case 'alpha fade in random':
                return (s, _dt, fade) => s.each((p) => {
                    const dur = lerp(a.n('fade in time min', 0.3), a.n('fade in time max', 0.5), p.rand[1]);
                    const frac = a.b('proportional 0/1', true) ? dur : dur / p.life;
                    const t = p.age / p.life;
                    if (t < frac) p.alpha *= lerp(1, ease(clamp01(t / (frac || 1))), fade);
                });
            case 'alpha fade and decay':
                return (s) => s.each((p) => {
                    const t = p.age / p.life;
                    const inS = a.n('start_fade_in_time'), inE = a.n('end_fade_in_time');
                    const outS = a.n('start_fade_out_time', 0.5), outE = a.n('end_fade_out_time', 1);
                    let k = 1;
                    if (t < inE) k = lerp(a.n('start_alpha', 1), 1, clamp01((t - inS) / ((inE - inS) || 1)));
                    if (t > outS) k = lerp(1, a.n('end_alpha'), clamp01((t - outS) / ((outE - outS) || 1)));
                    p.alpha = p.alpha0 * k;
                    // "Decay": once faded out the particle is done, whatever its lifetime.
                    if (t >= outE && a.n('end_alpha') <= 0) p.dead = true;
                });
            case 'color fade':
                return (s) => s.each((p) => {
                    const t = clamp01((p.age / p.life - a.n('fade_start_time')) / ((a.n('fade_end_time', 1) - a.n('fade_start_time')) || 1));
                    const target = a.v('color_fade', [255, 255, 255]);
                    const k = a.b('ease_in_and_out', true) ? ease(t) : t;
                    p.color = [lerp(p.color0[0], target[0] / 255, k), lerp(p.color0[1], target[1] / 255, k), lerp(p.color0[2], target[2] / 255, k)];
                });
            case 'rotation spin roll':
                return (s, dt) => s.each((p) => {
                    const stop = a.n('spin_stop_time');
                    const k = stop > 0 ? 1 - clamp01(p.age / (p.life * stop)) : 1;
                    const rate = lerp(a.n('spin_rate_min'), a.n('spin_rate_degrees'), k);
                    p.rotation += rate * dt;
                });
            case 'oscillate scalar':
                return (s, dt) => s.each((p) => {
                    const t = p.age / p.life;
                    if (t < a.n('start time min') || t > a.n('end time min', 1)) return;
                    const rate = lerp(a.n('oscillation rate min'), a.n('oscillation rate max'), p.rand[2]);
                    const freq = lerp(a.n('oscillation frequency min'), a.n('oscillation frequency max'), p.rand[3]);
                    let osc = Math.sin((p.age * freq + a.n('oscillation start phase', 0.5)) * Math.PI * 2);
                    if (a.b('absolute oscillation')) osc = Math.abs(osc);
                    const field = a.n('oscillation field', 7);
                    const d = rate * osc * a.n('oscillation multiplier', 2);
                    if (field === 7) p.alpha += d;
                    else if (field === 3) p.radius += d;
                    else if (field === 4) p.rotation += d * dt;
                });
            case 'oscillate vector':
                return (s, dt) => s.each((p) => {
                    const t = p.age / p.life;
                    if (t < a.n('start time min') || t > a.n('end time min', 1)) return;
                    const lo = a.v('oscillation rate min'), hi = a.v('oscillation rate max');
                    const fl = a.v('oscillation frequency min'), fh = a.v('oscillation frequency max');
                    const out: Vec3 = [0, 0, 0];
                    for (let k = 0; k < 3; k++) {
                        const rate = lerp(lo[k], hi[k], p.rand[k]);
                        const freq = lerp(fl[k], fh[k], p.rand[(k + 3) % 6]);
                        let osc = Math.sin((p.age * freq + a.n('oscillation start phase', 0.5)) * Math.PI * 2);
                        if (a.b('absolute oscillation')) osc = Math.abs(osc);
                        out[k] = rate * osc * a.n('oscillation multiplier', 2);
                    }
                    if (a.n('oscillation field') === 6) p.color = [p.color[0] + out[0], p.color[1] + out[1], p.color[2] + out[2]];
                    else p.pos = add(p.pos, scale(out, dt));
                });
            case 'movement lock to control point':
                return (s, _dt, fade) => s.each((p) => {
                    const cp = s.cp(a.n('control_point_number'));
                    const move = sub(cp.pos, cp.last);
                    const t = p.age / p.life;
                    const fo0 = a.n('start_fadeout_min', 1);
                    const lock = t < fo0 ? 1 : 1 - clamp01((t - fo0) / ((a.n('end_fadeout_min', 1) - fo0) || 1));
                    p.pos = add(p.pos, scale(move, lock * fade));
                });
            case 'movement lock to bone':
                return (s) => s.each((p) => {
                    const cp = s.cp(a.n('control_point_number'));
                    const t = p.age / p.life;
                    const lock = 1 - clamp01((t - a.n('lifetime fade start', 0.7)) / ((a.n('lifetime fade end', 0.75) - a.n('lifetime fade start', 0.7)) || 1));
                    p.pos = add(p.pos, scale(sub(cp.pos, cp.last), lock));
                });
            case 'movement dampen relative to control point':
                return (s, dt, fade) => s.each((p) => {
                    const cp = s.cp(a.n('control_point_number'));
                    const d = len(sub(p.pos, cp.pos));
                    const range = a.n('falloff range', 5);
                    const k = d < range ? 1 - d / range : 0;
                    const damp = Math.max(0, 1 - a.n('dampen scale') * 60 * dt * k * fade);
                    p.vel = scale(p.vel, damp);
                });
            case 'cull random':
                return (s) => s.each((p) => {
                    const t = s.age;
                    if (t < a.n('Cull Start Time') || t > a.n('Cull End Time', 0.1)) return;
                    // Decided once per particle, from its own random.
                    if (p.rand[4] < a.n('Cull Percentage', 0.9) && p.age === 0) p.dead = true;
                });
            case 'cull when crossing plane':
                return (s) => s.each((p) => {
                    const cp = s.cp(a.n('Control Point for point on plane'));
                    const n = a.v('Plane Normal', [0, 0, 1]);
                    if (dot(sub(p.pos, cp.pos), n) < a.n('Cull plane offset')) p.dead = true;
                });
            case 'noise vector':
                return (s) => s.each((p) => {
                    const sc = a.n('noise coordinate scale', 0.05);
                    const lo = a.v('output minimum'), hi = a.v('output maximum');
                    const n = (o: number) => noise(p.pos[0] * sc + o, p.pos[1] * sc, p.pos[2] * sc);
                    const v: Vec3 = [lerp(lo[0], hi[0], n(0)), lerp(lo[1], hi[1], n(17)), lerp(lo[2], hi[2], n(31))];
                    if (a.n('output field', 6) === 6) p.color = v;
                    else p.pos = v;
                });
            case 'set control point positions':
                return (s) => {
                    const parent = s.cp(a.n('Control Point to offset positions from'));
                    for (const w of ['First', 'Second', 'Third', 'Fourth']) {
                        const idx = a.n(`${w} Control Point Number`, -1);
                        if (idx < 0) continue;
                        const loc = a.v(`${w} Control Point Location`);
                        const pos = a.b('Set positions in world space') ? loc : add(parent.pos, s.toWorld(parent, loc));
                        s.cp(idx).pos = pos;
                    }
                };
            case 'set control point to player':
                return (s) => {
                    const pp = this.env.playerPos?.();
                    if (pp) s.cp(a.n('Control Point Number', 3)).pos = add(pp, a.v('Control Point Offset'));
                };
            case 'set child control points from particle positions':
                return (s) => {
                    const first = a.n('First control point to set', 1), num = a.n('# of control points to set', 1);
                    const from = a.n('first particle to copy');
                    for (const c of s.children) {
                        if (!c.sys) continue;
                        for (let k = 0; k < num; k++) {
                            const p = s.particles[from + k];
                            if (p) c.sys.cp(first + k).pos = [...p.pos];
                        }
                    }
                };
            case 'remap distance to control point to scalar':
                return (s) => s.each((p) => {
                    const cp = s.cp(a.n('control point', 1));
                    const d = len(sub(p.pos, cp.pos));
                    const t = clamp01((d - a.n('distance minimum')) / ((a.n('distance maximum', 1) - a.n('distance minimum')) || 1));
                    s.setField(p, a.n('output field', 7), lerp(a.n('output minimum'), a.n('output maximum', 1), t), a.b('output is scalar of initial random range', true));
                });
            case 'remap distance between two control points to scalar':
                return (s) => {
                    const d = len(sub(s.cp(a.n('starting control point', 2)).pos, s.cp(a.n('ending control point', 3)).pos));
                    const t = clamp01((d - a.n('distance minimum')) / ((a.n('distance maximum', 1) - a.n('distance minimum')) || 1));
                    const v = lerp(a.n('output minimum'), a.n('output maximum', 1), t);
                    s.each((p) => s.setField(p, a.n('output field', 7), v, a.b('output is scalar of initial random range', true)));
                };
            default:
                return null;
        }
    }

    /** "Movement Basic": forces, gravity and drag, then position and constraints. */
    private move(dt: number) {
        for (const p of this.particles) {
            if (p.dead) continue;
            const accel: Vec3 = [...this.gravity];
            for (const f of this.forces) f(this, p, accel);
            p.vel = add(p.vel, scale(accel, dt));
            // Keep a bad parameter combination from flinging a particle off to infinity.
            const speed = len(p.vel);
            if (!(speed < 20000)) p.vel = speed > 0 && Number.isFinite(speed) ? scale(p.vel, 20000 / speed) : [0, 0, 0];
            // Drag is the fraction of speed lost each 1/60 s tick, as in the game's per-frame step.
            if (this.drag > 0) p.vel = scale(p.vel, Math.pow(Math.max(0, 1 - this.drag), dt * 60));
            const from: Vec3 = [...p.pos];
            p.pos = add(p.pos, scale(p.vel, dt));
            for (let i = 0; i < this.passes; i++) for (const c of this.constraints) c(this, p, dt, i);
            // Constraints move the particle; its velocity follows.
            if (dt > 0) p.vel = scale(sub(p.pos, from), 1 / dt);
            p.rotation += p.rotationSpeed * dt;
        }
    }

    private makeForce(op: PcfOperator): Force | null {
        const a = new Params(op.attrs);
        switch (op.fn.toLowerCase()) {
            case 'random force':
                return (s, _p, acc) => {
                    const lo = a.v('min force'), hi = a.v('max force');
                    for (let k = 0; k < 3; k++) acc[k] += lerp(lo[k], hi[k], s.rand());
                };
            case 'twist around axis':
                return (s, p, acc) => {
                    let axis = a.v('twist axis', [0, 0, 1]);
                    const cp = s.cp(0);
                    if (a.b('object local space axis 0/1')) axis = s.toWorld(cp, axis);
                    const tang = norm(cross(norm(axis), sub(p.pos, cp.pos)));
                    const f = a.n('amount of force', 15);
                    acc[0] += tang[0] * f; acc[1] += tang[1] * f; acc[2] += tang[2] * f;
                };
            case 'pull towards control point':
                return (s, p, acc) => {
                    const cp = s.cp(a.n('control point number'));
                    const d = sub(cp.pos, p.pos);
                    const dist = len(d) || 1;
                    const power = a.n('falloff power');
                    const f = a.n('amount of force', 200) / Math.pow(Math.max(dist, 1), power);
                    acc[0] += (d[0] / dist) * f; acc[1] += (d[1] / dist) * f; acc[2] += (d[2] / dist) * f;
                };
            default:
                return null;
        }
    }

    private makeConstraint(op: PcfOperator): Constrain | null {
        const a = new Params(op.attrs);
        switch (op.fn.toLowerCase()) {
            case 'collision via traces':
                return (_s, p, _dt, pass) => {
                    // A world trace is the dear part of a step: once per particle, and not for ones at rest.
                    const trace = this.env.trace;
                    if (!trace || pass > 0 || len(p.vel) < 1) return;
                    // Big clouds take turns: each particle is traced every k-th step, over the ground it covered since.
                    const k = Math.max(1, Math.ceil(this.particles.length / 40));
                    if ((p.id + this.tick) % k) return;
                    const from = sub(p.pos, scale(p.vel, k / 60));
                    const hit = trace(from, p.pos);
                    if (!hit) return;
                    if (a.b('kill particle on collision')) { p.dead = true; return; }
                    const vn = dot(p.vel, hit.normal);
                    const bounce = a.n('amount of bounce'), slide = a.n('amount of slide');
                    const normalPart = scale(hit.normal, vn);
                    const tangent = sub(p.vel, normalPart);
                    // Slide is the share of the sideways speed kept (0 sticks where it landed, 1 is frictionless).
                    p.vel = add(scale(tangent, slide), scale(normalPart, -bounce));
                    p.pos = add(hit.end, scale(hit.normal, 0.1 + p.radius * a.n('radius scale', 1) * 0.05));
                };
            case 'prevent passing through a plane':
                return (s, p) => {
                    const cp = s.cp(a.n('control point number'));
                    const n = a.b('global normal') ? a.v('plane normal', [0, 0, -1]) : s.toWorld(cp, a.v('plane normal', [0, 0, -1]));
                    const origin = a.b('global origin') ? a.v('plane point') : add(cp.pos, s.toWorld(cp, a.v('plane point')));
                    const d = dot(sub(p.pos, origin), n);
                    if (d < 0) p.pos = sub(p.pos, scale(n, d));
                };
            case 'constrain distance to control point':
                return (s, p) => {
                    const cp = s.cp(a.n('control point number'));
                    const center = a.b('global center point') ? a.v('offset of center') : add(cp.pos, s.toWorld(cp, a.v('offset of center')));
                    const d = sub(p.pos, center);
                    const l = len(d);
                    const max = a.n('maximum distance', 100), min = a.n('minimum distance');
                    if (l > max) p.pos = add(center, scale(d, max / l));
                    else if (l < min && l > 0) p.pos = add(center, scale(d, min / l));
                };
            case 'constrain distance to path between two control points':
                return (s, p) => {
                    const c0 = s.cp(a.n('start control point number')), c1 = s.cp(a.n('end control point number', 1));
                    const ab = sub(c1.pos, c0.pos);
                    const t = clamp01(dot(sub(p.pos, c0.pos), ab) / (dot(ab, ab) || 1));
                    const near = add(c0.pos, scale(ab, t));
                    const d = sub(p.pos, near);
                    const l = len(d);
                    const max = a.n('maximum distance');
                    if (max >= 0 && l > max && l > 0) p.pos = add(near, scale(d, max / l));
                };
            default:
                return null;
        }
    }
}
