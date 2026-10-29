// Map logic: the entity input/output system. Entities fire named outputs; each
// output is wired (in the map) to inputs on target entities, optionally delayed,
// with a parameter and a limit on how many times it fires.
import * as THREE from 'three';
import type { BspFile } from '../bsp/bsp';
import { parseVec3 } from '../bsp/entities';
import type { CollisionModel, CollisionWorld, Vec3 } from '../physics/collision';
import type { Player } from '../physics/player';
import type { PhysicsWorld } from '../physics/rigid';
import type { PlayOptions, SoundHandle, SoundSystem } from '../audio/sound';
import type { CameraController } from '../render/noclip';
import { vectorAngles, type PortalSystem } from '../render/portals';
import type { PropHandle, PropInstance, PropRenderer } from '../render/props';
import type { ParticleManager } from '../render/particles';
import type { FxLayer } from '../render/fxlayer';
import type { TextureCache } from '../render/textures';
import type { MaterialDef } from '../material/vmt';
import type { PlacementEnv } from './portalPlacement';

export interface Connection {
    output: string; // lowercase
    target: string;
    input: string;
    param: string;
    delay: number;
    /** Remaining times this connection may fire; -1 = unlimited. */
    times: number;
}

/** A world-geometry material owned by a brush entity, for texture-frame changes. */
export interface BrushMaterial {
    name: string;
    def: MaterialDef | null;
    material: THREE.ShaderMaterial;
}

/** Everything map logic is allowed to touch. */
import type { SceneLibrary } from './scenes';
import type { PlayerHealth } from './health';

export interface GameContext {
    bsp: BspFile;
    collision: CollisionWorld;
    physics: PhysicsWorld;
    /** Absent when running headless. */
    sound?: SoundSystem;
    /** Compiled choreographed scenes (GLaDOS's voice lines); absent when none are loaded. */
    scenes?: SceneLibrary;
    /** Portal placement's view of the world (made on first use if not given). */
    placement?: PlacementEnv;
    /** Particle effects by name; absent when running headless. */
    particles?: ParticleManager;
    fx?: FxLayer;
    /** Visual effects; absent when running headless. */
    effects?: {
        blast(color: 0 | 1, from: Vec3, to: Vec3, duration: number, byPlayer?: boolean): void;
        /** Blends the brightness scale to `scale` over `duration` seconds. */
        tonemap?(scale: number, duration: number): void;
        /** env_shake. */
        shake?(s: { name: string; amplitude: number; frequency: number; duration: number; radius: number; origin: Vec3; global: boolean }): void;
        stopShake?(name: string): void;
        /** logic_autosave and trigger_autosave. */
        autosave?(): void;
        /** env_hudhint: a line of help text; null hides it. */
        hint?(text: string | null): void;
        fade?(fade: { color: Vec3; alpha: number; duration: number; hold: number; fadeFrom: boolean; stayOut: boolean }): void;
    };
    /** The player's health; absent when running headless. */
    health?: PlayerHealth;
    /** Ambient soundscapes; env_soundscape reports to it. */
    soundscapes?: { report(name: string, dist: number): void };
    /** The player picked up a portal gun that can fire these portals. */
    givePortalgun?: (canFire: [boolean, boolean]) => void;
    player: Player;
    view: CameraController;
    portals: PortalSystem;
    props: PropRenderer;
    textures: TextureCache;
    scene: THREE.Scene;
    brushGroups: Map<number, THREE.Group>;
    brushMaterials: Map<number, BrushMaterial[]>;
    propHandles: Map<number, PropHandle>;
    propInstances: Map<number, PropInstance>;
    log: (msg: string) => void;
}

export class GameEntity {
    readonly classname: string;
    readonly name: string; // lowercase targetname
    readonly kv: Record<string, string> = {};
    readonly connections: Connection[] = [];
    origin: Vec3;
    readonly spawnOrigin: Vec3;
    angles: Vec3;
    readonly spawnAngles: Vec3;
    parent: GameEntity | null = null;
    readonly children: GameEntity[] = [];
    /** Where this entity is relative to its parent, from when it was attached. */
    private localToParent: THREE.Matrix4 | null = null;
    /** The render group's rotation at spawn. */
    private baseRotation: THREE.Quaternion | null = null;
    removed = false;
    collision: CollisionModel | null = null;

    constructor(
        readonly game: Game,
        readonly index: number,
        readonly pairs: [string, string][],
    ) {
        for (const [k, v] of pairs) {
            const key = k.toLowerCase();
            const c = key.startsWith('on') || key === 'outvalue' ? parseConnection(key, v) : null;
            if (c) this.connections.push(c);
            else if (!(key in this.kv)) this.kv[key] = v;
        }
        this.classname = (this.kv.classname ?? '').toLowerCase();
        this.name = (this.kv.targetname ?? '').toLowerCase();
        this.origin = parseVec3(this.kv.origin);
        this.spawnOrigin = [...this.origin];
        this.angles = parseVec3(this.kv.angles);
        this.spawnAngles = [...this.angles];
    }

    get ctx(): GameContext {
        return this.game.ctx;
    }

    flag(bit: number): boolean {
        return ((Number(this.kv.spawnflags) || 0) & bit) !== 0;
    }

    /** Called once all entities exist. */
    spawn() {}

    /** Called every frame. */
    think(_dt: number) {}

    /** CBaseEntity::EmitSound: a soundscript entry (or WAV) from this entity, following it. */
    emitSound(name: string | undefined, opts: PlayOptions = {}): SoundHandle | null {
        if (!name) return null;
        return this.ctx.sound?.play(name, { position: () => this.soundOrigin(), ...opts }) ?? null;
    }

    /** Where this entity's sounds come from: its brush model's center, else its origin. */
    soundOrigin(): Vec3 {
        const b = this.brushBounds();
        return b ? [(b.mins[0] + b.maxs[0]) / 2, (b.mins[1] + b.maxs[1]) / 2, (b.mins[2] + b.maxs[2]) / 2] : this.origin;
    }

    /** Whether the entity is moving now (portals can't be placed on moving surfaces). */
    isMoving(): boolean {
        return false;
    }

    /** The player walked into this entity's collision with `velocity`, against a surface facing `normal`. */
    pushedByPlayer(_normal: Vec3, _velocity: Vec3) {}

    /** State a global entity takes to the next map, beyond its position (see Game.saveGlobals). */
    saveTransition(): string[] {
        return [];
    }

    restoreTransition(_fields: string[]) {}

    /** Extra state a subclass keeps outside plain fields (a physics body); must be JSON-safe. */
    saveExtra(): unknown {
        return null;
    }

    restoreExtra(_extra: unknown) {}

    /** Quick/manual saves: this entity's plain-data fields, where it is, and its connection counters. */
    saveState(): EntityState {
        const fields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(this)) {
            if (STATE_SKIP.has(k)) continue;
            const p = plain(v, 0);
            if (p !== undefined) fields[k] = p;
        }
        return {
            index: this.index,
            classname: this.classname,
            origin: [...this.origin],
            angles: [...this.angles],
            removed: this.removed,
            fields,
            times: this.connections.map((c) => c.times),
            extra: this.saveExtra(),
        };
    }

    restoreState(st: EntityState) {
        const self = this as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(st.fields)) {
            if (!(k in self) || STATE_SKIP.has(k)) continue;
            const cur = self[k];
            // Only plain data of the same shape goes back; anything else is rebuilt by the entity itself.
            if (typeof cur === typeof v && Array.isArray(cur) === Array.isArray(v) && (cur === null) === (v === null)) self[k] = clone(v);
        }
        st.times.forEach((t, i) => {
            if (this.connections[i]) this.connections[i].times = t;
        });
        this.setTransform(st.origin as Vec3, st.angles as Vec3);
        if (st.removed && !this.removed) this.remove();
        else if (!st.removed && this.removed) {
            this.removed = false;
            this.setVisible(true);
        }
        this.restoreExtra(st.extra);
    }

    /** Handles an input; returns false if this entity doesn't know it. */
    input(name: string, _param: string, _activator: GameEntity | null, _caller: GameEntity | null): boolean {
        if (name === 'kill') {
            this.remove();
            return true;
        }
        if (name.startsWith('fireuser')) {
            this.fire(`onuser${name.slice(8)}`, _activator);
            return true;
        }
        if (name === 'setparent') {
            this.setParent(this.game.find(_param, _activator, _caller)[0] ?? null);
            return true;
        }
        if (name === 'clearparent') {
            this.setParent(null);
            return true;
        }
        return false;
    }

    /** Fires every connection on an output. `value` fills connections with no parameter of their own. */
    fire(output: string, activator: GameEntity | null, value?: string) {
        for (const c of this.connections) {
            if (c.output !== output || c.times === 0) continue;
            if (c.times > 0) c.times--;
            this.game.schedule(c.delay, c.target, c.input, c.param !== '' ? c.param : value ?? '', activator, this);
        }
    }

    remove() {
        this.removed = true;
        this.setVisible(false);
        if (this.collision) this.collision.solid = false;
    }

    /** World transform from origin and angles. */
    worldMatrix(): THREE.Matrix4 {
        const a = this.angles;
        return new THREE.Matrix4()
            .makeRotationFromEuler(new THREE.Euler(a[2] * DEG, a[0] * DEG, a[1] * DEG, 'ZYX'))
            .setPosition(this.origin[0], this.origin[1], this.origin[2]);
    }

    /**
     * Attaches to a parent (SetParent), keeping where it is now; children then move and turn with
     * their parent. Null detaches (ClearParent).
     */
    setParent(p: GameEntity | null) {
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = p && p !== this ? p : null;
        this.localToParent = null;
        if (!this.parent) return;
        this.parent.children.push(this);
        this.localToParent = this.parent.worldMatrix().invert().multiply(this.worldMatrix());
    }

    /** Moves the entity, its rendered geometry, its collision and its children. */
    setOrigin(o: Vec3) {
        this.setTransform(o, this.angles);
    }

    /**
     * Moves and turns the entity: its geometry, its collision (translation only: brush collision
     * doesn't turn) and its children, which keep their place relative to it.
     */
    setTransform(o: Vec3, a: Vec3, fromParent = false) {
        const delta: Vec3 = [o[0] - this.origin[0], o[1] - this.origin[1], o[2] - this.origin[2]];
        this.origin = [...o];
        this.angles = [...a];
        const group = this.ctx.brushGroups.get(this.index) ?? this.ctx.propHandles.get(this.index)?.group;
        if (group) {
            group.position.set(o[0], o[1], o[2]);
            // Geometry was built turned to the spawn angles: turn by the change since then.
            this.baseRotation ??= group.quaternion.clone();
            const now = new THREE.Quaternion().setFromEuler(new THREE.Euler(a[2] * DEG, a[0] * DEG, a[1] * DEG, 'ZYX'));
            const spawn = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.spawnAngles[2] * DEG, this.spawnAngles[0] * DEG, this.spawnAngles[1] * DEG, 'ZYX'));
            group.quaternion.copy(now.multiply(spawn.invert()).multiply(this.baseRotation));
        }
        if (this.collision) {
            for (let i = 0; i < 3; i++) this.collision.origin[i] += delta[i];
        }
        const world = this.worldMatrix();
        for (const c of this.children) {
            if (!c.localToParent) continue;
            const m = world.clone().multiply(c.localToParent);
            const f = new THREE.Vector3().setFromMatrixColumn(m, 0), u = new THREE.Vector3().setFromMatrixColumn(m, 2);
            const p = new THREE.Vector3().setFromMatrixPosition(m);
            c.setTransform([p.x, p.y, p.z], vectorAngles([f.x, f.y, f.z], [u.x, u.y, u.z]), true);
        }
        // Moved on its own (a rotating door turning on a moving lift): its place on the parent changed.
        if (!fromParent && this.parent) this.localToParent = this.parent.worldMatrix().invert().multiply(world);
    }

    setVisible(visible: boolean) {
        const group = this.ctx.brushGroups.get(this.index) ?? this.ctx.propHandles.get(this.index)?.group;
        if (group) group.visible = visible;
    }

    /** World-space bounds of this entity's brush model ("*N"), if it has one. */
    brushBounds(): { mins: Vec3; maxs: Vec3 } | null {
        const m = /^\*(\d+)$/.exec(this.kv.model ?? '');
        const model = m ? this.ctx.bsp.models[Number(m[1])] : undefined;
        if (!model) return null;
        return {
            mins: [model.mins[0] + this.origin[0], model.mins[1] + this.origin[1], model.mins[2] + this.origin[2]],
            maxs: [model.maxs[0] + this.origin[0], model.maxs[1] + this.origin[1], model.maxs[2] + this.origin[2]],
        };
    }

    brushModelIndex(): number | null {
        const m = /^\*(\d+)$/.exec(this.kv.model ?? '');
        return m ? Number(m[1]) : null;
    }
}


export interface EntityState {
    index: number;
    classname: string;
    origin: number[];
    angles: number[];
    removed: boolean;
    fields: Record<string, unknown>;
    times: number[];
    extra: unknown;
}

export interface GameState {
    time: number;
    seq: number;
    playerGun: [boolean, boolean] | null;
    queue: { time: number; seq: number; target: string; input: string; param: string; activator: number | null; caller: number | null }[];
    entities: EntityState[];
}

/** Fields that are identity, wiring or things rebuilt on load rather than state. */
const STATE_SKIP = new Set(['game', 'index', 'pairs', 'kv', 'connections', 'classname', 'name', 'origin', 'angles', 'spawnOrigin', 'spawnAngles', 'parent', 'children', 'removed', 'collision']);

/** JSON-safe copy of plain data (numbers, strings, booleans, and arrays/objects of them), else undefined. */
function plain(v: unknown, depth: number): unknown {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (depth > 3) return undefined;
    if (Array.isArray(v)) {
        if (v.length > 256) return undefined;
        const out = v.map((x) => plain(x, depth + 1));
        return out.some((x) => x === undefined) ? undefined : out;
    }
    if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as object)) {
            const p = plain(x, depth + 1);
            if (p === undefined) return undefined;
            out[k] = p;
        }
        return out;
    }
    return undefined;
}

const clone = <T>(v: T): T => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

/** Parses "target,input,param,delay,times" (the separator is ',' or ESC in newer maps). */
const DEG = Math.PI / 180;

function parseConnection(output: string, value: string): Connection | null {
    const parts = value.split(value.includes('\x1b') ? '\x1b' : ',');
    if (parts.length < 5) return null;
    return {
        output,
        target: parts[0].trim().toLowerCase(),
        input: parts[1].trim().toLowerCase(),
        param: parts[2],
        delay: Number(parts[3]) || 0,
        times: Number(parts[4]) || -1,
    };
}

interface QueuedEvent {
    time: number;
    seq: number;
    target: string;
    input: string;
    param: string;
    activator: GameEntity | null;
    caller: GameEntity | null;
}

export type EntityFactory = (game: Game, index: number, pairs: [string, string][]) => GameEntity;
export type FactoryLookup = (classname: string, pairs: [string, string][]) => EntityFactory | undefined;

export class Game {
    time = 0;
    /** How the map was loaded (gpGlobals->eLoadType): logic_auto fires OnNewGame or OnMapTransition. */
    loadType: 'newgame' | 'transition' = 'newgame';
    /** The player's portal gun, if they have one: which portals it can fire. */
    playerGun: [boolean, boolean] | null = null;
    readonly entities: GameEntity[] = [];
    /** Stand-in entity for the player, used as activator and for "!player". */
    readonly playerEntity: GameEntity;
    /** Set while a point_viewcontrol has the player's view; the player is frozen meanwhile. */
    viewControl: { origin: Vec3; forward: Vec3; up: Vec3 } | null = null;
    private queue: QueuedEvent[] = [];
    private timers: { time: number; fn: () => void }[] = [];
    private seq = 0;
    private unknownInputs = new Set<string>();
    private nextIndex: number;

    constructor(
        readonly ctx: GameContext,
        pairs: [string, string][][],
        private factory: FactoryLookup,
    ) {
        pairs.forEach((p, index) => this.entities.push(this.instantiate(index, p)));
        this.nextIndex = pairs.length;
        this.playerEntity = new GameEntity(this, -1, [['classname', 'player']]);

        // Hierarchy: children follow their parent as it moves and turns.
        for (const e of this.entities) {
            const pn = e.kv.parentname?.toLowerCase().split(',')[0];
            if (!pn) continue;
            const parent = this.find(pn, null, null)[0];
            if (parent && parent !== e) {
                e.setParent(parent);
            }
        }
        for (const e of this.entities) e.spawn();

        // The player's body in the physics world, and shoving props by walking into them.
        ctx.physics.playerBox = () => (ctx.view.mode === 'noclip' ? null : { origin: ctx.player.origin, mins: ctx.player.mins, maxs: ctx.player.maxs });
        ctx.player.onTouch = (model, normal, velocity) => {
            this.entities.find((e) => e.collision === model && !e.removed)?.pushedByPlayer(normal, velocity);
        };
    }

    /**
     * Level transition: entities with a globalname (the elevator the player rides) go to the next
     * map, which has entities of the same globalname, keeping their place relative to the landmark
     * and their state, as Source's save/restore of global entities does. Serialised for the URL.
     */
    saveGlobals(landmark: Vec3): string {
        return this.entities
            .filter((e) => e.kv.globalname && !e.removed)
            .map((e) => [e.kv.globalname, ...[0, 1, 2].map((i) => (e.origin[i] - landmark[i]).toFixed(2)), ...e.saveTransition()].map(encodeURIComponent).join(','))
            .join(';');
    }

    restoreGlobals(landmark: Vec3, saved: string) {
        const byName = new Map(saved.split(';').filter(Boolean).map((s) => {
            const f = s.split(',').map(decodeURIComponent);
            return [f[0].toLowerCase(), f.slice(1)] as const;
        }));
        const restored = this.entities.filter((e) => byName.has((e.kv.globalname ?? '').toLowerCase()));
        for (const e of restored) {
            // Children ride along with a restored parent.
            if (e.parent && restored.includes(e.parent)) continue;
            const f = byName.get(e.kv.globalname.toLowerCase())!;
            e.setOrigin([landmark[0] + Number(f[0]), landmark[1] + Number(f[1]), landmark[2] + Number(f[2])]);
        }
        for (const e of restored) e.restoreTransition(byName.get(e.kv.globalname.toLowerCase())!.slice(3));
    }

    /**
     * Everything a save needs from map logic: the clock, pending events and each entity's plain
     * state. Timers that hold closures (a portal blast in flight) are not kept.
     */
    snapshot(): GameState {
        const idx = (e: GameEntity | null) => (e && e.index >= 0 ? e.index : null);
        return {
            time: this.time,
            seq: this.seq,
            playerGun: this.playerGun ? [...this.playerGun] : null,
            queue: this.queue.map((q) => ({ time: q.time, seq: q.seq, target: q.target, input: q.input, param: q.param, activator: idx(q.activator), caller: idx(q.caller) })),
            entities: this.entities.map((e) => e.saveState()),
        };
    }

    restore(st: GameState) {
        this.time = st.time;
        this.seq = st.seq;
        const byIndex = new Map(this.entities.map((e) => [e.index, e]));
        const at = (i: number | null) => (i === null ? null : byIndex.get(i) ?? null);
        for (const es of st.entities) {
            const e = byIndex.get(es.index);
            if (!e || e.classname !== es.classname) continue;
            try {
                e.restoreState(es);
            } catch (err) {
                this.ctx.log(`load: ${es.classname} #${es.index}: ${(err as Error).message}`);
            }
        }
        this.queue = st.queue.map((q) => ({ ...q, activator: at(q.activator) ?? this.playerEntity, caller: at(q.caller) }));
        this.timers = [];
        this.tickCache.clear();
    }

    /** Queues an input on a target after a delay. */
    schedule(delay: number, target: string, input: string, param: string, activator: GameEntity | null, caller: GameEntity | null) {
        this.queue.push({ time: this.time + delay, seq: this.seq++, target, input, param, activator, caller });
    }

    /** Runs `fn` after `delay` seconds of game time. */
    after(delay: number, fn: () => void) {
        this.timers.push({ time: this.time + delay, fn });
    }

    /** Drops queued events that `caller` sent (logic_relay CancelPending). */
    cancelPending(caller: GameEntity) {
        this.queue = this.queue.filter((e) => e.caller !== caller);
    }

    /** Entities matching a target name: exact, "prefix*", !self/!activator/!caller/!player, or a classname. */
    find(target: string, activator: GameEntity | null, caller: GameEntity | null): GameEntity[] {
        const t = target.toLowerCase();
        if (t === '!self' || t === '!caller') return caller ? [caller] : [];
        if (t === '!activator') return activator ? [activator] : [];
        if (t === '!player' || t === 'player') return [this.playerEntity];
        const live = this.entities.filter((e) => !e.removed);
        const byName = t.endsWith('*')
            ? live.filter((e) => e.name.startsWith(t.slice(0, -1)))
            : live.filter((e) => e.name === t);
        return byName.length ? byName : live.filter((e) => e.classname === t);
    }

    private tickCache = new Map<string, unknown>();

    /** Something computed once per tick and shared (every trigger asks who could be touching it). */
    perTick<T>(key: string, make: () => T): T {
        if (!this.tickCache.has(key)) this.tickCache.set(key, make());
        return this.tickCache.get(key) as T;
    }

    tick(dt: number) {
        this.tickCache.clear();
        this.time += dt;
        // Events queued with no delay while processing run in the same tick.
        for (let guard = 0; guard < 10000; guard++) {
            let best = -1;
            for (let i = 0; i < this.queue.length; i++) {
                const q = this.queue[i];
                if (q.time > this.time) continue;
                if (best < 0 || q.time < this.queue[best].time || (q.time === this.queue[best].time && q.seq < this.queue[best].seq)) best = i;
            }
            if (best < 0) break;
            const ev = this.queue.splice(best, 1)[0];
            for (const e of this.find(ev.target, ev.activator, ev.caller)) {
                if (!e.input(ev.input, ev.param, ev.activator, ev.caller)) {
                    const key = `${e.classname}.${ev.input}`;
                    if (!this.unknownInputs.has(key)) {
                        this.unknownInputs.add(key);
                        this.ctx.log(`unhandled input ${key}`);
                    }
                }
            }
        }
        // Game-time callbacks (a portal blast landing).
        const due = this.timers.filter((t) => t.time <= this.time);
        if (due.length) {
            this.timers = this.timers.filter((t) => t.time > this.time);
            for (const t of due) t.fn();
        }
        const p0 = performance.now();
        this.ctx.physics.step(dt);
        const p1 = performance.now();
        for (const e of this.entities) if (!e.removed) e.think(dt);
        this.perf.physics += p1 - p0;
        this.perf.think += performance.now() - p1;
    }

    /** CPU milliseconds spent since the last reset, for the stats line. */
    readonly perf = { physics: 0, think: 0 };

    private instantiate(index: number, p: [string, string][]): GameEntity {
        const cls = (p.find(([k]) => k.toLowerCase() === 'classname')?.[1] ?? '').toLowerCase();
        const make = this.factory(cls, p);
        return make ? make(this, index, p) : new GameEntity(this, index, p);
    }

    /** Creates an entity from keyvalues at runtime (console ent_create, prop_physics_create). Props get their model built first. */
    async createEntity(kv: Record<string, string>): Promise<GameEntity> {
        const index = this.nextIndex++;
        const inst = this.ctx.props.propFor(kv, index);
        if (inst) {
            this.ctx.propInstances.set(index, inst);
            const handle = await this.ctx.props.build(inst);
            if (handle) {
                this.ctx.scene.add(handle.group);
                this.ctx.propHandles.set(index, handle);
            }
        }
        const e = this.instantiate(index, Object.entries(kv));
        this.entities.push(e);
        e.spawn();
        return e;
    }

    /** The next free entity index. */
    allocIndex(): number {
        return this.nextIndex++;
    }

    /** Spawns a prop entity that isn't in the map (env_shooter's gibs): its model and the entity. */
    async spawnProp(index: number, pairs: [string, string][], inst: PropInstance): Promise<GameEntity> {
        this.ctx.propInstances.set(index, inst);
        const handle = await this.ctx.props.build(inst);
        if (handle) {
            this.ctx.scene.add(handle.group);
            this.ctx.propHandles.set(index, handle);
        }
        const e = this.instantiate(index, pairs);
        this.entities.push(e);
        e.spawn();
        return e;
    }

    /** Spawns a copy of an entity at a new origin (env_entity_maker), including its model. */
    async spawnCopy(src: GameEntity, origin: Vec3): Promise<GameEntity> {
        const index = this.nextIndex++;
        const pairs = src.pairs.map(([k, v]): [string, string] => [k, k.toLowerCase() === 'origin' ? origin.join(' ') : v]);
        const inst = this.ctx.propInstances.get(src.index);
        if (inst) {
            const copy = { ...inst, origin: [...origin] as Vec3, entityIndex: index };
            this.ctx.propInstances.set(index, copy);
            const handle = await this.ctx.props.build(copy);
            if (handle) {
                this.ctx.scene.add(handle.group);
                this.ctx.propHandles.set(index, handle);
            }
        }
        const e = this.instantiate(index, pairs);
        this.entities.push(e);
        e.spawn();
        return e;
    }
}
