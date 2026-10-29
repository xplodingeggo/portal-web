// Entity classes for map logic. Behaviour follows the documented semantics of
// Source's logic and brush entities (Valve Developer Community), simplified
// where this engine has no equivalent (sounds, scripted scenes, NPCs).
import * as THREE from 'three';
import { parseVec3 } from '../bsp/entities';
import { Contents, hullBrush, type CollisionBrush, type CollisionModel, type Vec3 } from '../physics/collision';
import type { PhysicsController, RigidBody } from '../physics/rigid';
import type { SoundHandle } from '../audio/sound';
import { MAX_EXIT_SPEED, PORTAL_HALF_HEIGHT, PORTAL_HALF_WIDTH, type Portal } from '../render/portals';
import { firePortal } from './portalgun';
import type { Scene } from './scenes';
import { PlacedBy } from './portalPlacement';
import type { ParticleEffect } from '../render/particles';
import { attachmentMatrix, findSequence, sequenceTiming } from '../model/pose';
import { GameEntity, type EntityFactory, type Game } from './game';
import { FX_CLASSES } from './fxents';

type Bounds = { mins: Vec3; maxs: Vec3 };

const overlaps = (a: Bounds, b: Bounds) =>
    a.mins[0] <= b.maxs[0] && a.maxs[0] >= b.mins[0] && a.mins[1] <= b.maxs[1] && a.maxs[1] >= b.mins[1] && a.mins[2] <= b.maxs[2] && a.maxs[2] >= b.mins[2];

/** Source angles (pitch, yaw) to a direction vector. */
export function angleVector(a: Vec3): Vec3 {
    const p = (a[0] * Math.PI) / 180;
    const y = (a[1] * Math.PI) / 180;
    return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
}

/** Things that can stand in a trigger: the player body and physics boxes. */
export function touchBounds(e: GameEntity): Bounds | null {
    if (e.index === -1) {
        const p = e.ctx.player;
        const mins = p.mins, maxs = p.maxs;
        return {
            mins: [p.origin[0] + mins[0], p.origin[1] + mins[1], p.origin[2] + mins[2]],
            maxs: [p.origin[0] + maxs[0], p.origin[1] + maxs[1], p.origin[2] + maxs[2]],
        };
    }
    if (e instanceof EnergyBall) {
        const b = e.launcher.ball;
        const r = e.launcher.ballRadius();
        return b && { mins: [b.pos[0] - r, b.pos[1] - r, b.pos[2] - r], maxs: [b.pos[0] + r, b.pos[1] + r, b.pos[2] + r] };
    }
    return e instanceof PhysProp ? e.bounds() : null;
}

// ---------------------------------------------------------------- logic

class LogicAuto extends GameEntity {
    spawn() {
        // Global states (e.g. "is_console") are never set here.
        if (this.kv.globalstate) return;
        this.game.schedule(0, '!self', 'mapspawn', '', null, this);
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name !== 'mapspawn') return super.input(name, param, a, c);
        // CLogicAuto::Think: how the map was loaded, then OnMapSpawn either way.
        this.fire(this.game.loadType === 'transition' ? 'onmaptransition' : 'onnewgame', null);
        this.fire('onmapspawn', null);
        if (this.flag(1)) this.remove();
        return true;
    }
}

class LogicRelay extends GameEntity {
    enabled = true;
    spawn() {
        this.enabled = this.kv.startdisabled !== '1';
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'trigger':
                if (!this.enabled) return true;
                this.fire('ontrigger', a);
                if (this.flag(1)) this.remove(); // only trigger once
                return true;
            case 'enable':
                this.enabled = true;
                return true;
            case 'disable':
                this.enabled = false;
                return true;
            case 'toggle':
                this.enabled = !this.enabled;
                return true;
            case 'cancelpending':
                this.game.cancelPending(this);
                return true;
            case 'enablerefire':
                return true;
        }
        return super.input(name, param, a, c);
    }
}

class LogicTimer extends GameEntity {
    enabled = false;
    next = 0;
    spawn() {
        this.enabled = this.kv.startdisabled !== '1';
        this.reset();
    }
    interval() {
        if (this.kv.userandomtime === '1') {
            const lo = Number(this.kv.lowerrandombound) || 0;
            const hi = Number(this.kv.upperrandombound) || lo;
            return lo + Math.random() * (hi - lo);
        }
        return Math.max(0.01, Number(this.kv.refiretime) || 1);
    }
    reset() {
        this.next = this.game.time + this.interval();
    }
    think() {
        if (!this.enabled || this.game.time < this.next) return;
        this.fire('ontimer', this);
        this.reset();
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'enable':
                if (!this.enabled) this.reset();
                this.enabled = true;
                return true;
            case 'disable':
                this.enabled = false;
                return true;
            case 'toggle':
                return this.input(this.enabled ? 'disable' : 'enable', param, a, c);
            case 'refiretime':
                this.kv.refiretime = param;
                this.reset();
                return true;
            case 'resettimer':
                this.reset();
                return true;
            case 'firetimer':
                this.fire('ontimer', this);
                this.reset();
                return true;
            case 'addtotimer':
                this.next += Number(param) || 0;
                return true;
        }
        return super.input(name, param, a, c);
    }
}

class MathCounter extends GameEntity {
    value = 0;
    min = 0;
    max = 0;
    enabled = true;
    spawn() {
        this.value = Number(this.kv.startvalue) || 0;
        this.min = Number(this.kv.min) || 0;
        this.max = Number(this.kv.max) || 0;
        this.enabled = this.kv.startdisabled !== '1';
    }
    set(v: number, a: GameEntity | null, fireOut = true) {
        if (this.min !== 0 || this.max !== 0) {
            if (v >= this.max) {
                v = this.max;
                this.value = v;
                if (fireOut) this.fire('outvalue', a, String(v));
                this.fire('onhitmax', a);
                return;
            }
            if (v <= this.min) {
                v = this.min;
                this.value = v;
                if (fireOut) this.fire('outvalue', a, String(v));
                this.fire('onhitmin', a);
                return;
            }
        }
        this.value = v;
        if (fireOut) this.fire('outvalue', a, String(v));
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        const n = Number(param) || 0;
        const ops: Record<string, () => void> = {
            add: () => this.set(this.value + n, a),
            subtract: () => this.set(this.value - n, a),
            multiply: () => this.set(this.value * n, a),
            divide: () => n !== 0 && this.set(this.value / n, a),
            setvalue: () => this.set(n, a),
            setvaluenofire: () => this.set(n, a, false),
            getvalue: () => this.fire('ongetvalue', a, String(this.value)),
            sethitmax: () => (this.max = n),
            sethitmin: () => (this.min = n),
            enable: () => (this.enabled = true),
            disable: () => (this.enabled = false),
        };
        const op = ops[name];
        if (!op) return super.input(name, param, a, c);
        if (this.enabled || name === 'enable') op();
        return true;
    }
}

class LogicCase extends GameEntity {
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'invalue') {
            for (let i = 1; i <= 16; i++) {
                const v = this.kv[`case${String(i).padStart(2, '0')}`];
                if (v === undefined) continue;
                const same = v.trim().toLowerCase() === param.trim().toLowerCase() || (v.trim() !== '' && Number(v) === Number(param));
                if (same) {
                    this.fire(`oncase${String(i).padStart(2, '0')}`, a);
                    return true;
                }
            }
            this.fire('ondefault', a, param);
            return true;
        }
        if (name === 'pickrandom' || name === 'pickrandomshuffle') {
            const cases = Array.from({ length: 16 }, (_, i) => String(i + 1).padStart(2, '0')).filter((k) => this.kv[`case${k}`] !== undefined);
            const k = cases[Math.floor(Math.random() * cases.length)];
            if (k) this.fire(`oncase${k}`, a);
            return true;
        }
        return super.input(name, param, a, c);
    }
}

// ---------------------------------------------------------------- camera and fades

/**
 * point_viewcontrol (triggers.cpp's CTriggerCamera): takes over the player's view, here from a
 * parent model's attachment point (the intro's bed animation) while the player stays frozen.
 */
class PointViewControl extends GameEntity {
    private enabled = false;
    private attachment = '';
    private until = 0;
    spawn() {
        // The attachment named in the map: "SetParentAttachment" re-sends it as the input's parameter.
        this.attachment = this.kv.parentattachment ?? '';
    }
    private parentProp(): PropDynamic | null {
        const p = this.kv.parentname ? this.game.find(this.kv.parentname, null, this)[0] : null;
        return p instanceof PropDynamic ? p : null;
    }
    pose() {
        const m = this.attachment ? this.parentProp()?.attachmentWorld(this.attachment) : null;
        if (!m) {
            const f = angleVector(this.angles);
            const u = angleVector([this.angles[0] - 90, this.angles[1], this.angles[2]]);
            this.game.viewControl = { origin: [...this.origin] as Vec3, forward: f, up: u };
            return;
        }
        const col = (i: number) => new THREE.Vector3().setFromMatrixColumn(m, i);
        const f = col(0), u = col(2), o = col(3);
        this.game.viewControl = { origin: [o.x, o.y, o.z], forward: [f.x, f.y, f.z], up: [u.x, u.y, u.z] };
    }
    private disable() {
        this.enabled = false;
        if (this.game.viewControl) this.game.viewControl = null;
    }
    think(_dt: number) {
        if (!this.enabled) return;
        if (!this.flag(8) && this.game.time >= this.until) this.disable();
        else this.pose();
    }
    remove() {
        this.disable();
        super.remove();
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'enable':
                this.enabled = true;
                this.until = this.game.time + (Number(this.kv.wait) || 0);
                this.pose();
                return true;
            case 'disable':
                this.disable();
                return true;
            case 'setparentattachment':
                if (param) this.attachment = param;
                return true;
        }
        return super.input(name, param, a, c);
    }
}

/**
 * env_tonemap_controller: only the brightness scale is used (BlendTonemapScale "scale duration").
 * Auto-exposure limits and bloom have no counterpart in the renderer.
 */
class EnvTonemapController extends GameEntity {
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'blendtonemapscale': {
                const [scale, duration] = param.split(/\s+/).map(Number);
                this.ctx.effects?.tonemap?.(scale || 1, duration || 0);
                return true;
            }
            case 'settonemapscale':
                this.ctx.effects?.tonemap?.(Number(param) || 1, 0);
                return true;
            case 'setbloomscale':
            case 'setautoexposuremin':
            case 'setautoexposuremax':
            case 'setbloomscaleraw':
            case 'setbloomexponent':
            case 'useDefaultAutoExposure':
            case 'usedefaultautoexposure':
            case 'usedefaultbloomscale':
                return true;
        }
        return super.input(name, param, a, c);
    }
}

/**
 * info_particle_system: a particle effect from the game's .pcf files. Control point 0 is the entity
 * (position and facing); "cpointN" names the entity control point N follows.
 */
class InfoParticleSystem extends GameEntity {
    private fx: ParticleEffect | null = null;
    private starting = false;
    private wantStop = false;
    private targets = new Map<number, GameEntity | null>();
    spawn() {
        if (this.kv.start_active === '1') void this.start();
    }
    private async start() {
        const pm = this.ctx.particles;
        if (!pm || this.fx || this.starting) return;
        this.starting = true;
        this.wantStop = false;
        const [f, u] = this.frame();
        const fx = await pm.spawn(this.kv.effect_name ?? '', [...this.origin], f, u);
        this.starting = false;
        if (!fx) return;
        if (this.wantStop || this.removed) {
            fx.kill();
            return;
        }
        this.fx = fx;
        for (let i = 1; i <= 63; i++) {
            const name = this.kv['cpoint' + i];
            if (!name) continue;
            fx.bind(i, () => {
                if (!this.targets.has(i)) this.targets.set(i, this.game.find(name, null, this)[0] ?? null);
                const e = this.targets.get(i);
                return e && !e.removed ? [...e.origin] : null;
            });
        }
    }
    private frame(): [Vec3, Vec3] {
        return [angleVector(this.angles), angleVector([this.angles[0] - 90, this.angles[1], this.angles[2]])];
    }
    think(_dt: number) {
        if (!this.fx) return;
        if (this.fx.done) {
            this.fx = null;
            return;
        }
        const [f, u] = this.frame();
        this.fx.setControlPoint(0, this.origin, f, u);
    }
    private stop(immediately: boolean) {
        this.wantStop = true;
        if (immediately) this.fx?.kill();
        else this.fx?.stop();
        this.fx = null;
    }
    remove() {
        this.stop(true);
        super.remove();
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'start': void this.start(); return true;
            case 'stop': this.stop(false); return true;
            case 'destroyimmediately': this.stop(true); return true;
            default: return super.input(name, param, a, c);
        }
    }
}

/** env_fade: a full-screen colour fade. Spawnflags: 1 fade from the colour, 2 modulate, 8 stay out. */
class EnvFade extends GameEntity {
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'fade') {
            const [r, g, b] = (this.kv.rendercolor ?? '0 0 0').split(/\s+/).map(Number);
            this.ctx.effects?.fade?.({
                color: [r, g, b],
                alpha: (Number(this.kv.renderamt ?? 255) || 0) / 255,
                duration: Number(this.kv.duration) || 0,
                hold: Number(this.kv.holdtime) || 0,
                fadeFrom: this.flag(1),
                stayOut: this.flag(8),
            });
            this.fire('onbegin', null);
            return true;
        }
        return super.input(name, param, a, c);
    }
}

// ---------------------------------------------------------------- scenes

/**
 * logic_choreographed_scene: plays a compiled .vcd. Only the actor-independent parts matter here:
 * the speak events (GLaDOS is heard everywhere), FIRETRIGGER events (OnTrigger1..16) and the end of
 * the scene (OnCompletion). Time is scene time: Pause holds it, Resume continues it.
 */
/** Who is speaking now and who waits for them, per actor: one voice at a time, as in Source. */
const actorSlots = new WeakMap<Game, Map<string, { current: LogicChoreographedScene | null; waiting: LogicChoreographedScene[] }>>();

class LogicChoreographedScene extends GameEntity {
    private handles: SoundHandle[] = [];
    playing = false;
    private paused = false;
    private time = 0;
    private next = 0;
    private scene: Scene | null = null;
    private slot() {
        let all = actorSlots.get(this.game);
        if (!all) actorSlots.set(this.game, (all = new Map()));
        const key = (this.kv.target1 ?? '').toLowerCase();
        let s = all.get(key);
        if (!s) all.set(key, (s = { current: null, waiting: [] }));
        return s;
    }
    /**
     * "If an actor is already talking" (busyactor): 0 talk over them, 1 wait for them to finish
     * (the default), 2 cut them off, 3 give up.
     */
    private request() {
        const s = this.slot();
        const cur = s.current;
        if (cur && cur !== this && cur.playing) {
            const mode = Number(this.kv.busyactor ?? 1);
            if (mode === 1) {
                if (!s.waiting.includes(this)) s.waiting.push(this);
                return;
            }
            if (mode === 3) {
                this.fire('oncanceled', null);
                return;
            }
            if (mode === 2) cur.stop(true);
        }
        this.start();
    }
    /** The actor is free: the next scene in line starts. */
    private release() {
        const s = this.slot();
        if (s.current !== this) return;
        s.current = null;
        s.waiting.shift()?.request();
    }
    private start() {
        // Restarting: drop the old run's voice without freeing the actor to someone else.
        for (const h of this.handles) h.stop(0.05);
        this.handles = [];
        this.slot().current = this;
        const file = this.kv.scenefile;
        this.scene = file ? this.ctx.scenes?.get(file) ?? null : null;
        this.playing = true;
        this.paused = false;
        this.time = 0;
        this.next = 0;
        this.fire('onstart', null);
        // A scene we cannot read still completes, so what waits on it carries on.
        if (!this.scene) this.finish();
    }
    stop(cancelled: boolean) {
        const queued = this.slot().waiting.indexOf(this);
        if (queued >= 0) {
            this.slot().waiting.splice(queued, 1);
            if (cancelled) this.fire('oncanceled', null);
        }
        if (!this.playing) return;
        this.playing = false;
        for (const h of this.handles) h.stop(0.05);
        this.handles = [];
        if (cancelled) this.fire('oncanceled', null);
        this.release();
    }
    private finish() {
        this.playing = false;
        this.handles = [];
        this.fire('oncompletion', null);
        this.release();
    }
    think(dt: number) {
        if (!this.playing || this.paused || !this.scene) return;
        this.time += dt;
        const { events, duration } = this.scene;
        while (this.next < events.length && events[this.next].start <= this.time) {
            const e = events[this.next++];
            if (e.type === 'speak') {
                const h = this.ctx.sound?.play(e.param, {});
                if (h) this.handles.push(h);
            } else {
                const n = Number(e.param);
                if (n >= 1 && n <= 16) this.fire(`ontrigger${n}`, null);
            }
        }
        if (this.time >= duration) this.finish();
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'start':
            case 'interjectresponse':
                this.request();
                return true;
            case 'pause':
                this.paused = true;
                for (const h of this.handles) h.setVolume(0, 0.05);
                return true;
            case 'resume':
                this.paused = false;
                for (const h of this.handles) h.setVolume(1, 0.05);
                return true;
            case 'cancel':
            case 'canceltonextinterrupt':
                this.stop(true);
                return true;
        }
        return super.input(name, param, a, c);
    }
}

// ---------------------------------------------------------------- sound

/**
 * ambient_generic (sound.cpp's CAmbientGeneric): a soundscript or WAV, looped if the WAV loops and
 * spawnflag 32 is off, heard everywhere (flag 1) or falling off from its radius.
 */
class AmbientGeneric extends GameEntity {
    private handle: SoundHandle | null = null;
    /** m_fActive: only a looping sound stays active. */
    private active = false;
    private volume = 1;
    private pitch = 100;
    private source: GameEntity | null = null;
    spawn() {
        this.volume = Math.max(0, Math.min(10, Number(this.kv.health ?? 10))) / 10;
        this.pitch = Number(this.kv.pitch) || 100;
        this.source = this.kv.sourceentityname ? this.game.find(this.kv.sourceentityname, null, this)[0] ?? null : null;
        // A looping sound not flagged "start silent" plays from the start.
        if (!this.flag(16) && this.looping) this.game.schedule(0, '!self', 'playsound', '', null, this);
    }
    private get looping() {
        return !this.flag(32);
    }
    /** ComputeSoundlevel: 40 dB at the reference distance (36 units), louder for bigger radii. */
    private get soundlevel() {
        const radius = Number(this.kv.radius) || 0;
        if (this.flag(1) || radius <= 0) return 0;
        return Math.floor(40 + 20 * Math.log10(radius / 36));
    }
    private start() {
        this.handle?.stop();
        const everywhere = this.flag(1);
        const at = () => (this.source ?? this).origin;
        this.handle = this.ctx.sound?.play(this.kv.message ?? '', {
            position: everywhere ? undefined : at,
            volume: this.volume,
            pitch: this.pitch,
            soundlevel: this.soundlevel,
            loop: this.looping ? undefined : false,
        }) ?? null;
    }
    private toggle() {
        if (this.active) {
            this.active = false;
            this.handle?.stop(0.05);
            this.handle = null;
            return;
        }
        if (this.looping) this.active = true;
        this.start();
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'playsound':
                if (!this.active) this.toggle();
                return true;
            case 'stopsound':
                if (this.active) this.toggle();
                else this.handle?.stop(0.05);
                return true;
            case 'togglesound':
                this.toggle();
                return true;
            case 'volume':
                this.volume = Math.max(0, Math.min(10, Number(param) || 0)) / 10;
                this.handle?.setVolume(this.volume / Math.max(0.0001, Number(this.kv.health ?? 10) / 10));
                return true;
            case 'pitch':
                this.pitch = Number(param) || 100;
                this.handle?.setPitch(this.pitch);
                return true;
            case 'fadein':
                if (!this.active) this.toggle();
                return true;
            case 'fadeout':
                if (this.active) {
                    this.active = false;
                    this.handle?.stop(Number(param) || 0);
                    this.handle = null;
                }
                return true;
        }
        return super.input(name, param, a, c);
    }
    remove() {
        this.handle?.stop();
        super.remove();
    }
}

// ---------------------------------------------------------------- triggers

class Trigger extends GameEntity {
    enabled = true;
    touching = new Set<GameEntity>();
    nextTrigger = 0;
    spawn() {
        this.enabled = this.kv.startdisabled !== '1';
    }
    /** Whether `e` may activate this trigger (spawnflags and filter entity). */
    passes(e: GameEntity): boolean {
        const isPlayer = e.index === -1;
        // 1 = clients, 8 = physics objects, 64 = everything.
        if (isPlayer && !this.flag(1) && !this.flag(64)) return false;
        if (!isPlayer && !this.flag(8) && !this.flag(64)) return false;
        const filter = this.kv.filtername ? this.game.find(this.kv.filtername, null, this)[0] : undefined;
        if (filter && 'passes' in filter && typeof filter.passes === 'function') return (filter as unknown as { passes(e: GameEntity): boolean }).passes(e);
        return true;
    }
    candidates(): GameEntity[] {
        return this.game.perTick('touchers', () => [
            this.game.playerEntity,
            ...this.game.entities.filter((e) => e instanceof PhysProp && !e.removed),
            ...this.game.entities.flatMap((e) => (e instanceof EnergyBallLauncher && e.ball && e.ballEntity ? [e.ballEntity] : [])),
        ]);
    }
    think() {
        if (!this.enabled) return;
        const bounds = this.brushBounds();
        if (!bounds) return;
        for (const e of this.candidates()) {
            const b = touchBounds(e);
            const inside = !!b && overlaps(bounds, b) && this.passes(e);
            if (inside && !this.touching.has(e)) {
                this.touching.add(e);
                this.startTouch(e);
            } else if (!inside && this.touching.has(e)) {
                this.touching.delete(e);
                this.endTouch(e);
            } else if (inside) {
                this.stayTouch(e);
            }
        }
    }
    startTouch(e: GameEntity) {
        if (this.touching.size === 1) this.fire('onstarttouchall', e);
        this.fire('onstarttouch', e);
        this.tryTrigger(e);
    }
    stayTouch(e: GameEntity) {
        this.tryTrigger(e);
    }
    endTouch(e: GameEntity) {
        this.fire('onendtouch', e);
        if (this.touching.size === 0) this.fire('onendtouchall', e);
    }
    tryTrigger(e: GameEntity) {
        if (this.game.time < this.nextTrigger) return;
        // trigger_multiple waits `wait` seconds between OnTrigger fires.
        this.nextTrigger = this.game.time + Math.max(0.01, Number(this.kv.wait) || 0.2);
        this.fire('ontrigger', e);
        this.onTriggered(e);
    }
    onTriggered(_e: GameEntity) {}
    setEnabled(on: boolean) {
        if (!on && this.enabled) {
            for (const e of [...this.touching]) {
                this.touching.delete(e);
                this.endTouch(e);
            }
        }
        this.enabled = on;
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'enable') this.setEnabled(true);
        else if (name === 'disable') this.setEnabled(false);
        else if (name === 'toggle') this.setEnabled(!this.enabled);
        else return super.input(name, param, a, c);
        return true;
    }
}

class TriggerOnce extends Trigger {
    stayTouch() {}
    onTriggered() {
        this.remove();
    }
}

class TriggerTeleport extends Trigger {
    onTriggered(e: GameEntity) {
        if (e.index !== -1) return;
        const dest = this.game.find(this.kv.target ?? '', e, this)[0];
        if (!dest) return;
        this.ctx.player.teleport(dest.origin);
        this.ctx.view.yaw = dest.angles[1];
        this.ctx.view.pitch = dest.angles[0];
    }
}

/**
 * trigger_hurt: hurts whoever stands in it every half second (Source's HURT_INTERVAL), `damage` a
 * second, never more than `damagecap` in one hit. This is the toxic goo and the death pits.
 */
class TriggerHurt extends Trigger {
    private nextHurt = 0;
    startTouch(e: GameEntity) {
        this.nextHurt = 0;
        super.startTouch(e);
    }
    tryTrigger(e: GameEntity) {
        if (e.index !== -1 || this.game.time < this.nextHurt) return;
        this.nextHurt = this.game.time + 0.5;
        let dmg = (Number(this.kv.damage) || 0) * 0.5;
        const cap = Number(this.kv.damagecap) || 0;
        if (cap > 0) dmg = Math.min(dmg, cap);
        this.ctx.health?.hurt(dmg);
        this.fire('onhurtplayer', e);
        this.fire('onhurt', e);
    }
}

/** A launcher's ball as map logic sees it: the activator of a catcher's OnTrigger. Killing it ends the ball. */
class EnergyBall extends GameEntity {
    constructor(game: Game, readonly launcher: EnergyBallLauncher) {
        super(game, -2, [['classname', 'prop_energy_ball']]);
    }
    remove() {
        this.launcher.catchBall();
    }
}

/** Shared soft glow for energy balls. */
let ballTexture: THREE.CanvasTexture | null = null;
function ballGlow(): THREE.CanvasTexture {
    if (ballTexture) return ballTexture;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,235,1)');
    grad.addColorStop(0.3, 'rgba(255,225,120,.9)');
    grad.addColorStop(1, 'rgba(255,160,40,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return (ballTexture = new THREE.CanvasTexture(c));
}

/**
 * point_energy_ball_launcher: shoots a ball along its angles that bounces off the world at constant
 * speed and kills the player on touch. It lives BallLifetime seconds, then the next one launches after
 * ballrespawntime. Balls go through portals; a trigger with filter_combineball_type (the catcher) takes them.
 */
class EnergyBallLauncher extends GameEntity {
    enabled = true;
    ball: { pos: Vec3; vel: Vec3; age: number } | null = null;
    respawnAt = -1;
    ballEntity: EnergyBall | null = null;
    /** When the launcher's door has had time to open and the ball goes out; -1 when not opening. */
    launchAt = -1;
    private loop: SoundHandle | null = null;
    private sprite: THREE.Sprite | null = null;
    spawn() {
        this.enabled = this.kv.startdisabled !== '1';
        // 4096: only launches on the LaunchBall input
        if (this.enabled && !this.flag(4096)) this.respawnAt = 0.5;
    }
    ballRadius() {
        return Number(this.kv.ballradius) || 12;
    }
    /** A catcher took the ball. */
    catchBall() {
        if (this.ball) {
            const at = this.ball.pos;
            this.ctx.sound?.play('EnergyBall.KillImpact', { position: () => at });
            this.endBall();
        }
    }
    /** The door model that the map closes after each ball (its OnPostSpawnBall -> SetAnimation). */
    private doorProp(): GameEntity | null {
        const c = this.connections.find((x) => x.output === 'onpostspawnball' && x.input === 'setanimation');
        return (c && this.game.find(c.target, null, this)[0]) || null;
    }
    /** Opens the door, then the ball leaves a moment later. */
    begin() {
        if (this.ball || this.launchAt >= 0) return;
        this.respawnAt = -1;
        const door = this.doorProp();
        if (door) door.input('setanimation', 'open', null, this);
        this.launchAt = this.game.time + (door ? 1 : 0);
    }
    launch() {
        this.launchAt = -1;
        this.emitSound('EnergyBall.Launch');
        const speed = Number(this.kv.maxspeed) || Number(this.kv.minspeed) || 200;
        const d = angleVector(this.angles);
        this.ball = { pos: [...this.origin], vel: [d[0] * speed, d[1] * speed, d[2] * speed], age: 0 };
        this.respawnAt = -1;
        this.loop = this.emitSound('EnergyBall.AmbientLoop', { loop: true, position: () => this.ball?.pos ?? this.origin });
        this.fire('onpostspawnball', null);
    }
    private endBall() {
        this.ball = null;
        this.ballEntity = null;
        this.loop?.stop(0.2);
        this.loop = null;
        if (this.sprite) {
            this.sprite.removeFromParent();
            this.sprite.material.dispose();
            this.sprite = null;
        }
        const wait = Number(this.kv.ballrespawntime);
        if (this.enabled && wait > 0 && !this.flag(4096)) this.respawnAt = this.game.time + wait;
    }
    think(dt: number) {
        if (!this.ball && this.respawnAt >= 0 && this.enabled && this.game.time >= this.respawnAt) this.begin();
        if (this.launchAt >= 0 && this.game.time >= this.launchAt) {
            if (this.enabled) this.launch();
            else this.launchAt = -1;
        }
        const b = this.ball;
        if (!b) return;
        if (!this.sprite) {
            const r = this.ballRadius();
            this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: ballGlow(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
            this.sprite.scale.setScalar(r * 4);
            this.ctx.scene.add(this.sprite);
        }
        this.ballEntity ??= new EnergyBall(this.game, this);
        b.age += dt;
        if (b.age > (Number(this.kv.balllifetime) || 8)) return this.endBall();
        const r = this.ballRadius();
        const speed = Math.hypot(...b.vel);
        let left = dt;
        for (let i = 0; i < 4 && left > 1e-5; i++) {
            const dir: Vec3 = [b.vel[0] / speed, b.vel[1] / speed, b.vel[2] / speed];
            // A portal in the way: the hull would stop a ball's radius short of the wall the portal is in,
            // so look that much further ahead, and come out in front of the exit moving the same way through it.
            const reach: Vec3 = [b.pos[0] + dir[0] * (speed * left + r), b.pos[1] + dir[1] * (speed * left + r), b.pos[2] + dir[2] * (speed * left + r)];
            const through = this.ctx.portals.crossing(b.pos, reach);
            if (through) {
                const a = new THREE.Vector3(...b.pos).applyMatrix4(through.from.inverse);
                const dl = new THREE.Vector3(...dir).transformDirection(through.from.inverse);
                const dist = -dl.x > 1e-4 ? a.x / -dl.x : 0;
                const out = new THREE.Vector3(b.pos[0] + dir[0] * (dist + r + 1), b.pos[1] + dir[1] * (dist + r + 1), b.pos[2] + dir[2] * (dist + r + 1)).applyMatrix4(through.matrix);
                const v = new THREE.Vector3(...b.vel).applyMatrix3(new THREE.Matrix3().setFromMatrix4(through.matrix));
                b.pos = [out.x, out.y, out.z];
                b.vel = [v.x, v.y, v.z];
                b.age = Math.min(b.age, (Number(this.kv.balllifetime) || 8) - (Number(this.kv.minlifeafterportal) || 5));
                break;
            }
            const to: Vec3 = [b.pos[0] + b.vel[0] * left, b.pos[1] + b.vel[1] * left, b.pos[2] + b.vel[2] * left];
            const t = this.ctx.collision.trace(b.pos, to, [-r, -r, -r], [r, r, r]);
            if (t.fraction >= 1 || t.startSolid) {
                b.pos = to;
                break;
            }
            const n = t.normal;
            const dot = b.vel[0] * n[0] + b.vel[1] * n[1] + b.vel[2] * n[2];
            b.vel = [b.vel[0] - 2 * dot * n[0], b.vel[1] - 2 * dot * n[1], b.vel[2] - 2 * dot * n[2]];
            const k = speed / (Math.hypot(...b.vel) || 1);
            b.vel = [b.vel[0] * k, b.vel[1] * k, b.vel[2] * k];
            b.pos = [t.end[0] + n[0] * 0.1, t.end[1] + n[1] * 0.1, t.end[2] + n[2] * 0.1];
            const at = b.pos;
            this.ctx.sound?.play('EnergyBall.Impact', { position: () => at });
            left *= 1 - t.fraction;
        }
        this.sprite.position.set(b.pos[0], b.pos[1], b.pos[2]);
        // The player is a box 32 wide and 72 tall.
        const p = this.ctx.player.origin;
        const dx = Math.max(Math.abs(b.pos[0] - p[0]) - 16, 0);
        const dy = Math.max(Math.abs(b.pos[1] - p[1]) - 16, 0);
        const dz = Math.max(p[2] - b.pos[2], b.pos[2] - (p[2] + 72), 0);
        if (Math.hypot(dx, dy, dz) < r && this.ctx.health && !this.ctx.health.dead) {
            this.emitSound('EnergyBall.Explosion', { position: () => b.pos });
            this.ctx.health.hurt(100);
        }
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'launchball': if (this.enabled) this.begin(); return true;
            case 'enable': this.enabled = true; return true;
            case 'disable': this.enabled = false; return true;
            case 'toggle': this.enabled = !this.enabled; return true;
        }
        return super.input(name, param, a, c);
    }
    remove() {
        this.loop?.stop();
        this.sprite?.removeFromParent();
        super.remove();
    }
}

/**
 * npc_rocket_turret: once it has the player in sight it beeps through a lock-on, then fires a slow
 * rocket that steers toward them. The rocket goes through portals, explodes on the world or the
 * player, and a rocket that lands on the turret destroys it. Drawn as a model; the rocket is a glow.
 */
class RocketTurret extends GameEntity {
    enabled = true;
    dead = false;
    seen = 0;
    cooldown = 0;
    rocket: { pos: Vec3; vel: Vec3; age: number } | null = null;
    private sprite: THREE.Sprite | null = null;
    private beep: SoundHandle | null = null;
    private flight: SoundHandle | null = null;
    spawn() {
        this.enabled = this.kv.startdisabled !== '1';
    }
    private eye(): Vec3 {
        return [this.origin[0], this.origin[1], this.origin[2] + 16];
    }
    private sees(): boolean {
        const p = this.ctx.player.origin;
        const eye = this.eye();
        const target: Vec3 = [p[0], p[1], p[2] + 40];
        const dist = Math.hypot(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
        if (dist > 3000) return false;
        const t = this.ctx.collision.trace(eye, target, [0, 0, 0], [0, 0, 0]);
        return !t.startSolid && t.fraction > 0.97;
    }
    private explode(at: Vec3) {
        this.ctx.sound?.play('BaseGrenade.Explode', { position: () => at });
        const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: ballGlow(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
        flash.position.set(at[0], at[1], at[2]);
        flash.scale.setScalar(300);
        this.ctx.scene.add(flash);
        setTimeout(() => { flash.removeFromParent(); flash.material.dispose(); }, 250);
        const p = this.ctx.player.origin;
        const d = Math.hypot(at[0] - p[0], at[1] - p[1], at[2] - (p[2] + 36));
        if (d < 200 && this.ctx.health) this.ctx.health.hurt(d < 80 ? 100 : 100 * (1 - (d - 80) / 120));
        this.endRocket();
    }
    private endRocket() {
        this.rocket = null;
        this.flight?.stop(0.1);
        this.flight = null;
        this.sprite?.removeFromParent();
        this.sprite?.material.dispose();
        this.sprite = null;
    }
    private destroy() {
        this.dead = true;
        this.enabled = false;
        this.beep?.stop();
        this.beep = null;
        this.fire('ondeath', null);
        this.explode([...this.origin]);
    }
    think(dt: number) {
        if (this.dead) return;
        if (this.rocket) return this.flyRocket(dt);
        const health = this.ctx.health;
        if (!this.enabled || !health || health.dead) return this.relax();
        this.cooldown = Math.max(0, this.cooldown - dt);
        if (this.cooldown > 0 || !this.sees()) return this.relax();
        if (this.seen === 0) this.beep = this.emitSound('NPC_RocketTurret.LockingBeep', { loop: true });
        this.seen += dt;
        if (this.seen > 2.5) this.shoot();
    }
    private relax() {
        this.seen = 0;
        this.beep?.stop(0.1);
        this.beep = null;
    }
    private shoot() {
        this.relax();
        this.emitSound('NPC_FloorTurret.RocketFire');
        const eye = this.eye();
        const p = this.ctx.player.origin;
        const d: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] + 40 - eye[2]];
        const l = Math.hypot(...d) || 1;
        this.rocket = { pos: eye, vel: [(d[0] / l) * 220, (d[1] / l) * 220, (d[2] / l) * 220], age: 0 };
        this.flight = this.emitSound('NPC_FloorTurret.RocketFlyLoop', { loop: true, position: () => this.rocket?.pos ?? this.origin });
        this.cooldown = 4;
    }
    private flyRocket(dt: number) {
        const r = this.rocket!;
        if (!this.sprite) {
            this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: ballGlow(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: 0xff7040 }));
            this.sprite.scale.setScalar(40);
            this.ctx.scene.add(this.sprite);
        }
        r.age += dt;
        if (r.age > 12) return this.endRocket();
        const speed = 220;
        // steer toward the player
        const p = this.ctx.player.origin;
        const want: Vec3 = [p[0] - r.pos[0], p[1] - r.pos[1], p[2] + 40 - r.pos[2]];
        const wl = Math.hypot(...want) || 1;
        const turn = Math.min(1, 1.6 * dt);
        const v: Vec3 = [r.vel[0] / speed + (want[0] / wl - r.vel[0] / speed) * turn, r.vel[1] / speed + (want[1] / wl - r.vel[1] / speed) * turn, r.vel[2] / speed + (want[2] / wl - r.vel[2] / speed) * turn];
        const vl = Math.hypot(...v) || 1;
        r.vel = [(v[0] / vl) * speed, (v[1] / vl) * speed, (v[2] / vl) * speed];
        const dir: Vec3 = [r.vel[0] / speed, r.vel[1] / speed, r.vel[2] / speed];
        const next: Vec3 = [r.pos[0] + r.vel[0] * dt, r.pos[1] + r.vel[1] * dt, r.pos[2] + r.vel[2] * dt];
        const reach: Vec3 = [next[0] + dir[0] * 8, next[1] + dir[1] * 8, next[2] + dir[2] * 8];
        const through = this.ctx.portals.crossing(r.pos, reach);
        if (through) {
            const a = new THREE.Vector3(...r.pos).applyMatrix4(through.from.inverse);
            const dl = new THREE.Vector3(...dir).transformDirection(through.from.inverse);
            const dist = -dl.x > 1e-4 ? a.x / -dl.x : 0;
            const out = new THREE.Vector3(r.pos[0] + dir[0] * (dist + 12), r.pos[1] + dir[1] * (dist + 12), r.pos[2] + dir[2] * (dist + 12)).applyMatrix4(through.matrix);
            const nv = new THREE.Vector3(...r.vel).applyMatrix3(new THREE.Matrix3().setFromMatrix4(through.matrix));
            r.pos = [out.x, out.y, out.z];
            r.vel = [nv.x, nv.y, nv.z];
        } else {
            const t = this.ctx.collision.trace(r.pos, next, [-4, -4, -4], [4, 4, 4]);
            if (t.fraction < 1 && !t.startSolid) return this.explode(t.end);
            r.pos = next;
        }
        this.sprite.position.set(r.pos[0], r.pos[1], r.pos[2]);
        const dp = Math.hypot(r.pos[0] - p[0], r.pos[1] - p[1], r.pos[2] - (p[2] + 36));
        if (dp < 40) return this.explode(r.pos);
        // a rocket sent back into its turret destroys it
        if (r.age > 0.6 && Math.hypot(r.pos[0] - this.origin[0], r.pos[1] - this.origin[1], r.pos[2] - this.origin[2]) < 48) {
            this.endRocket();
            this.destroy();
        }
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'enable': this.enabled = !this.dead; return true;
            case 'disable': this.enabled = false; this.relax(); return true;
            case 'kill': this.relax(); this.endRocket(); break;
        }
        return super.input(name, param, a, c);
    }
    remove() {
        this.relax();
        this.endRocket();
        super.remove();
    }
}

/** env_shake: shakes the player's view; strength falls off with distance unless "global" (spawnflag 1). */
class EnvShake extends GameEntity {
    amplitude = 0;
    frequency = 0;
    radius = 0;
    spawn() {
        this.amplitude = Number(this.kv.amplitude) || 4;
        this.frequency = Number(this.kv.frequency) || 2.5;
        this.radius = Number(this.kv.radius) || 500;
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'startshake':
                this.ctx.effects?.shake?.({
                    name: this.name || String(this.index), amplitude: this.amplitude, frequency: this.frequency,
                    duration: Number(this.kv.duration) || 1, radius: this.radius, origin: [...this.origin], global: this.flag(1),
                });
                return true;
            case 'stopshake': this.ctx.effects?.stopShake?.(this.name || String(this.index)); return true;
            case 'amplitude': this.amplitude = Number(param) || 0; return true;
            case 'frequency': this.frequency = Number(param) || 0; return true;
            case 'radius': this.radius = Number(param) || 0; return true;
        }
        return super.input(name, param, a, c);
    }
}

/**
 * trigger_push: pushes what stands in it along pushdir. The player gets `speed` extra velocity while
 * inside (Source's base velocity, so it doesn't build up); physics objects are accelerated at `speed`.
 */
class TriggerPush extends Trigger {
    private dt = 0;
    private lastTime = 0;
    think() {
        this.dt = Math.min(0.1, this.game.time - this.lastTime);
        this.lastTime = this.game.time;
        super.think();
    }
    startTouch(e: GameEntity) {
        super.startTouch(e);
        this.push(e);
    }
    stayTouch(e: GameEntity) {
        super.stayTouch(e);
        this.push(e);
    }
    private push(e: GameEntity) {
        const speed = Number(this.kv.speed) || 100;
        const d = angleVector(parseVec3(this.kv.pushdir));
        if (e.index === -1) {
            const b = this.ctx.player.baseVelocity;
            for (let i = 0; i < 3; i++) b[i] += d[i] * speed;
        } else if (e instanceof PhysProp && e.rigid) {
            const v = e.rigid.body.linvel();
            e.rigid.body.setLinvel({ x: v.x + d[0] * speed * this.dt, y: v.y + d[1] * speed * this.dt, z: v.z + d[2] * speed * this.dt }, true);
        }
    }
}

/**
 * func_portal_detector: reports portals that open inside its volume. Portal1/Portal2 are the blue and
 * orange portal, "linked" one that has its partner open too, "both linked" blue and orange together.
 */
class PortalDetector extends GameEntity {
    enabled = true;
    inside = { p1: false, p2: false, linked: false, both: false };
    spawn() {
        this.enabled = this.kv.startdisabled !== '1';
    }
    think() {
        const now = { p1: false, p2: false, linked: false, both: false };
        const b = this.enabled && this.brushBounds();
        if (b) {
            let l1 = false, l2 = false;
            for (const p of this.ctx.portals.portals) {
                if (!p.active) continue;
                // The portal's own extent (its oval's bounding box, turned to the wall), not just its centre.
                const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
                for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
                    const v = new THREE.Vector3(0, sy * PORTAL_HALF_WIDTH, sz * PORTAL_HALF_HEIGHT).applyMatrix4(p.matrix);
                    for (let i = 0; i < 3; i++) {
                        lo[i] = Math.min(lo[i], v.getComponent(i));
                        hi[i] = Math.max(hi[i], v.getComponent(i));
                    }
                }
                if ([0, 1, 2].some((i) => hi[i] < b.mins[i] - 2 || lo[i] > b.maxs[i] + 2)) continue;
                if (p.color === 0) now.p1 = true;
                else now.p2 = true;
                if (this.ctx.portals.partner(p)) {
                    now.linked = true;
                    if (p.color === 0) l1 = true;
                    else l2 = true;
                }
            }
            now.both = l1 && l2;
        }
        const names: [keyof typeof now, string][] = [['p1', 'portal1'], ['p2', 'portal2'], ['linked', 'linkedportal'], ['both', 'bothlinkedportals']];
        for (const [k, n] of names) {
            if (now[k] === this.inside[k]) continue;
            this.fire(`on${now[k] ? 'start' : 'end'}touch${n}`, null);
        }
        this.inside = now;
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'enable') this.enabled = true;
        else if (name === 'disable') this.enabled = false;
        else if (name === 'toggle') this.enabled = !this.enabled;
        else return super.input(name, param, a, c);
        return true;
    }
}

/** filter_activator_class: lets through entities of one classname (Negated flips it). */
class FilterActivatorClass extends GameEntity {
    passes(e: GameEntity): boolean {
        const match = e.classname === (this.kv.filterclass ?? '').toLowerCase();
        return this.kv.negated === '1' ? !match : match;
    }
}

/**
 * func_rotating: spins about its yaw axis (roll with spawnflag 4, pitch with 8) at maxspeed degrees a
 * second. Spawnflags: 1 starts spinning, 2 backwards, 16 speeds up and slows down gradually, 64 not
 * solid. Its collision doesn't turn.
 */
class FuncRotating extends GameEntity {
    /** Current signed speed in degrees a second and the one it is heading for. */
    rate = 0;
    goal = 0;
    spawn() {
        const model = this.brushModelIndex();
        if (model !== null && !this.flag(64)) this.collision = this.ctx.collision.addBrushModel(model, this.origin);
        if (this.flag(1)) this.rate = this.goal = this.fullSpeed();
    }
    private fullSpeed() {
        return (Number(this.kv.maxspeed) || 100) * (this.flag(2) ? -1 : 1);
    }
    think(dt: number) {
        if (this.rate !== this.goal) {
            const accel = this.flag(16) ? Math.max(5, Math.abs(Number(this.kv.maxspeed) || 100) / 4) : Infinity;
            const step = accel * dt;
            this.rate = Math.abs(this.goal - this.rate) <= step ? this.goal : this.rate + Math.sign(this.goal - this.rate) * step;
        }
        if (!this.rate) return;
        const a: Vec3 = [...this.angles];
        a[this.flag(4) ? 2 : this.flag(8) ? 0 : 1] += this.rate * dt;
        this.setTransform(this.origin, a);
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'start': this.goal = this.fullSpeed(); return true;
            case 'stop': this.goal = 0; return true;
            case 'toggle': this.goal = this.goal ? 0 : this.fullSpeed(); return true;
            case 'reverse': this.kv.spawnflags = String((Number(this.kv.spawnflags) || 0) ^ 2); if (this.goal) this.goal = -this.goal; this.rate = -this.rate; return true;
            case 'setspeed': this.goal = this.fullSpeed() * Math.max(0, Math.min(1, Number(param) || 0)); return true;
        }
        return super.input(name, param, a, c);
    }
}

/**
 * prop_door_rotating: a door model that swings `distance` degrees about the vertical line `axis`
 * (two points) and back. Drawn only: its collision is not made, as before it was an entity here.
 */
class PropDoorRotating extends GameEntity {
    swing = 0;
    target = 0;
    closeAt = -1;
    private pivot: Vec3 = [0, 0, 0];
    spawn() {
        const p = (this.kv.axis ?? '').split(',')[0].trim().split(/\s+/).map(Number);
        this.pivot = p.length === 3 && p.every(Number.isFinite) ? (p as Vec3) : [...this.origin];
        if (this.flag(1)) this.swing = this.target = Number(this.kv.distance) || 90;
        this.place();
    }
    private place() {
        const r = (this.swing * Math.PI) / 180;
        const dx = this.spawnOrigin[0] - this.pivot[0], dy = this.spawnOrigin[1] - this.pivot[1];
        const o: Vec3 = [this.pivot[0] + dx * Math.cos(r) - dy * Math.sin(r), this.pivot[1] + dx * Math.sin(r) + dy * Math.cos(r), this.origin[2]];
        this.setTransform(o, [this.spawnAngles[0], this.spawnAngles[1] + this.swing, this.spawnAngles[2]]);
    }
    private go(open: boolean, a: GameEntity | null) {
        const t = open ? Number(this.kv.distance) || 90 : 0;
        if (t === this.target) return;
        this.target = t;
        this.closeAt = -1;
        this.emitSound(open ? this.kv.soundopenoverride || this.kv.soundmoveoverride : this.kv.soundmoveoverride);
        this.fire(open ? 'onopen' : 'onclose', a);
    }
    think(dt: number) {
        if (this.closeAt >= 0 && this.game.time >= this.closeAt) this.go(false, null);
        if (this.swing === this.target) return;
        const step = (Number(this.kv.speed) || 100) * dt;
        this.swing = Math.abs(this.target - this.swing) <= step ? this.target : this.swing + Math.sign(this.target - this.swing) * step;
        this.place();
        if (this.swing === this.target) {
            this.emitSound(this.target ? this.kv.soundopenoverride : this.kv.soundcloseoverride);
            this.fire(this.target ? 'onfullyopen' : 'onfullyclosed', null);
            const wait = Number(this.kv.returndelay);
            if (this.target && wait > 0) this.closeAt = this.game.time + wait;
        }
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'open': this.go(true, a); return true;
            case 'close': this.go(false, a); return true;
            case 'toggle': this.go(!this.target, a); return true;
            case 'lock': case 'unlock': return true;
        }
        return super.input(name, param, a, c);
    }
}

/** trigger_gravity: scales the player's gravity while they stand in it. */
class TriggerGravity extends Trigger {
    startTouch(e: GameEntity) {
        if (e.index === -1) this.ctx.player.gravityScale = Number(this.kv.gravity) || 1;
        super.startTouch(e);
    }
    endTouch(e: GameEntity) {
        if (e.index === -1) this.ctx.player.gravityScale = 1;
        super.endTouch(e);
    }
}

/** trigger_remove: deletes the props and energy balls that enter it. */
class TriggerRemove extends Trigger {
    startTouch(e: GameEntity) {
        super.startTouch(e);
        if (e.index !== -1 && !e.removed) {
            this.fire('onremove', e);
            e.remove();
        }
    }
}

/** logic_compare: compares its input value with CompareValue and fires the matching output. */
class LogicCompare extends GameEntity {
    value = NaN;
    compare = 0;
    spawn() {
        this.compare = Number(this.kv.comparevalue) || 0;
        if (this.kv.initialvalue !== undefined) this.value = Number(this.kv.initialvalue);
    }
    private run(a: GameEntity | null) {
        const v = this.value;
        if (Number.isNaN(v)) return;
        this.fire('outvalue', a, String(v));
        this.fire(v < this.compare ? 'onlessthan' : v > this.compare ? 'ongreaterthan' : 'onequalto', a);
        if (v !== this.compare) this.fire('onnotequalto', a);
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'setvalue': this.value = Number(param); return true;
            case 'setvaluecompare': this.value = Number(param); this.run(a); return true;
            case 'setcomparevalue': this.compare = Number(param); return true;
            case 'compare': this.run(a); return true;
        }
        return super.input(name, param, a, c);
    }
}

/** logic_autosave: the game's own checkpoints. SaveDangerous only saves with enough health. */
class LogicAutosave extends GameEntity {
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'save' || name === 'savedangerous') {
            const h = this.ctx.health;
            if (name === 'savedangerous' && h && h.health < (Number(param) || 0) * 10 + 30) return true;
            this.ctx.effects?.autosave?.();
            return true;
        }
        return super.input(name, param, a, c);
    }
}

/** trigger_autosave: saves when the player walks in, once. */
class TriggerAutosave extends Trigger {
    tryTrigger() {}
    startTouch(e: GameEntity) {
        super.startTouch(e);
        if (e.index !== -1) return;
        this.ctx.effects?.autosave?.();
        this.remove();
    }
}

/** env_hudhint: a line of help text on screen (the game's hint_* strings). */
class EnvHudHint extends GameEntity {
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'showhudhint') this.ctx.effects?.hint?.(this.kv.message ?? '');
        else if (name === 'hidehudhint') this.ctx.effects?.hint?.(null);
        else return super.input(name, param, a, c);
        return true;
    }
}

/**
 * env_soundscape: while the player is inside its radius (and can see it) the named soundscape plays;
 * the nearest one wins. Enable and Disable switch it.
 */
class EnvSoundscape extends GameEntity {
    enabled = true;
    spawn() {
        this.enabled = this.kv.startdisabled !== '1';
    }
    think() {
        if (!this.enabled || !this.kv.soundscape) return;
        const p = this.ctx.player;
        const eye: Vec3 = [p.origin[0], p.origin[1], p.origin[2] + 56];
        const dist = Math.hypot(eye[0] - this.origin[0], eye[1] - this.origin[1], eye[2] - this.origin[2]);
        if (dist > (Number(this.kv.radius) || 0)) return;
        const t = this.ctx.collision.trace(eye, this.origin, [0, 0, 0], [0, 0, 0]);
        if (t.fraction < 1 && !t.startSolid && dist - dist * t.fraction > 64) return;
        this.ctx.soundscapes?.report(this.kv.soundscape, dist);
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'enable') this.enabled = true;
        else if (name === 'disable') this.enabled = false;
        else if (name === 'togglepause' || name === 'toggleenabled') this.enabled = !this.enabled;
        else return super.input(name, param, a, c);
        return true;
    }
}

/**
 * keyframe_rope and move_rope: a cable from this entity to the one named in NextKey, hanging by
 * `Slack`, drawn as a dark tube. They are fixed where they were at spawn.
 */
class RopeSegment extends GameEntity {
    private mesh: THREE.Mesh | null = null;
    spawn() {
        const next = this.kv.nextkey && this.game.find(this.kv.nextkey, null, this)[0];
        if (!next) return;
        const a = new THREE.Vector3(...this.origin), b = new THREE.Vector3(...next.origin);
        const len = a.distanceTo(b);
        if (len < 1) return;
        // A parabola with the rope's extra length: sag = sqrt(3 * L * slack / 8).
        const sag = Math.sqrt((3 * len * Math.max(0, Number(this.kv.slack) || 0)) / 8);
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 12; i++) {
            const t = i / 12;
            pts.push(a.clone().lerp(b, t).add(new THREE.Vector3(0, 0, -sag * 4 * t * (1 - t))));
        }
        const radius = Math.max(0.6, (Number(this.kv.width) || 2) * 0.5);
        this.mesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, radius, 4, false), new THREE.MeshBasicMaterial({ color: 0x24282c }));
        this.ctx.scene.add(this.mesh);
    }
    remove() {
        this.mesh?.removeFromParent();
        this.mesh?.geometry.dispose();
        super.remove();
    }
}

/**
 * npc_security_camera: sweeps left and right until the player is in view, then follows them with a
 * turning head (the model's LR_Rot1 and UD_Rot1 bones). Fires OnFoundPlayer / OnLostPlayer. The
 * Ragdoll input (what the portal detectors send) rips it off the wall: it drops and stays down.
 */
class SecurityCamera extends GameEntity {
    enabled = true;
    yaw = 0;
    pitch = 0;
    sees = false;
    fallen = false;
    fall: { vel: Vec3; spin: number; age: number } | null = null;
    private shown: [number, number] = [NaN, NaN];
    private clock = Math.random() * 6;
    spawn() {
        // spawnflag 32: starts active; without it the camera waits for Enable
        this.enabled = this.flag(32);
    }
    head(): Vec3 {
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.angles[2] * DEG, this.angles[0] * DEG, this.angles[1] * DEG, 'ZYX'));
        const v = new THREE.Vector3(22, 0, -12).applyQuaternion(q);
        return [this.origin[0] + v.x, this.origin[1] + v.y, this.origin[2] + v.z];
    }
    think(dt: number) {
        if (this.fall) return this.drop(dt);
        if (this.fallen) return;
        this.clock += dt;
        let wantYaw = 40 * Math.sin(this.clock * 0.6);
        let wantPitch = -12;
        let speed = 35;
        let seen = false;
        const health = this.ctx.health;
        if (this.enabled && health && !health.dead) {
            const head = this.head();
            const p = this.ctx.player.origin;
            const target: Vec3 = [p[0], p[1], p[2] + 52];
            const d = new THREE.Vector3(target[0] - head[0], target[1] - head[1], target[2] - head[2]);
            const dist = d.length();
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.angles[2] * DEG, this.angles[0] * DEG, this.angles[1] * DEG, 'ZYX'));
            d.applyQuaternion(q.invert());
            const yawT = (Math.atan2(d.y, d.x) * 180) / Math.PI;
            const pitchT = (Math.atan2(d.z, Math.hypot(d.x, d.y)) * 180) / Math.PI;
            if (dist < 1600 && Math.abs(yawT) < 85 && pitchT > -70 && pitchT < 50) {
                const t = this.ctx.collision.trace(head, target, [0, 0, 0], [0, 0, 0]);
                if (t.fraction > 0.97 && !t.startSolid) {
                    seen = true;
                    wantYaw = yawT;
                    wantPitch = pitchT;
                    speed = 140;
                }
            }
        }
        if (seen !== this.sees) {
            this.sees = seen;
            this.fire(seen ? 'onfoundplayer' : 'onlostplayer', seen ? this.game.playerEntity : null);
            if (seen) this.emitSound('NPC_SecurityCamera.Alert');
        }
        const step = speed * dt;
        this.yaw += Math.max(-step, Math.min(step, wantYaw - this.yaw));
        this.pitch += Math.max(-step, Math.min(step, wantPitch - this.pitch));
        this.pose();
    }
    pose() {
        if (Math.abs(this.yaw - this.shown[0]) < 0.25 && Math.abs(this.pitch - this.shown[1]) < 0.25) return;
        const h = this.ctx.propHandles.get(this.index);
        if (!h) return;
        this.shown = [this.yaw, this.pitch];
        // the head's bones: bone 2 turns about its local Y (model up), bone 3 about its local X
        const yaw = new THREE.Matrix4().makeRotationY(this.yaw * DEG);
        const pitch = new THREE.Matrix4().makeRotationX(-this.pitch * DEG);
        this.ctx.props.setPose(h, 0, 0, true, (bone) => (bone === 2 ? yaw : bone === 3 ? pitch : null));
    }
    private drop(dt: number) {
        const f = this.fall!;
        f.vel[2] -= 600 * dt;
        f.age += dt;
        const to: Vec3 = [this.origin[0] + f.vel[0] * dt, this.origin[1] + f.vel[1] * dt, this.origin[2] + f.vel[2] * dt];
        const t = this.ctx.collision.trace(this.origin, to, [-6, -6, -6], [6, 6, 6]);
        // It hangs with its mount inside the wall: until it has come clear, fall through the wall it
        // was on rather than landing in it.
        if (t.startSolid && f.age < 1.5) {
            this.setTransform(to, [this.angles[0], this.angles[1], this.angles[2] + f.spin * dt]);
            return;
        }
        if (t.fraction < 1) {
            this.setTransform(t.end, this.angles);
            if (t.normal[2] > 0.7 && f.vel[2] < 0) {
                this.fall = null;
                this.fallen = true;
                this.emitSound('NPC_SecurityCamera.Die');
                return;
            }
            // a wall or ceiling: lose some speed along it and keep dropping
            const vn = f.vel[0] * t.normal[0] + f.vel[1] * t.normal[1] + f.vel[2] * t.normal[2];
            for (let i = 0; i < 3; i++) f.vel[i] -= t.normal[i] * vn * 1.3;
            return;
        }
        this.setTransform(to, [this.angles[0], this.angles[1], this.angles[2] + f.spin * dt]);
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'enable': this.enabled = true; return true;
            case 'disable': this.enabled = false; return true;
            case 'toggle': this.enabled = !this.enabled; return true;
            case 'ragdoll':
                if (!this.fall && !this.fallen) {
                    this.enabled = false;
                    // out of the wall, along the way the camera faces
                    const out = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(this.angles[2] * DEG, this.angles[0] * DEG, this.angles[1] * DEG, 'ZYX')));
                    this.fall = { vel: [out.x * 90 + Math.random() * 20 - 10, out.y * 90 + Math.random() * 20 - 10, 20], spin: 120 + Math.random() * 120, age: 0 };
                    if (this.sees) this.fire('onlostplayer', null);
                    this.sees = false;
                }
                return true;
        }
        return super.input(name, param, a, c);
    }
}

/**
 * func_rot_button: a button that turns `distance` degrees when pressed (E, or the Press input). It
 * stays turned when `wait` is -1, else comes back after that long; spawnflag 32 makes it a toggle.
 * Spawnflags: 1 not solid, 2 reverse, 64 about roll, 128 about pitch, 256 and 1024 can be used by E.
 */
class FuncRotButton extends GameEntity {
    angle1: Vec3 = [0, 0, 0];
    angle2: Vec3 = [0, 0, 0];
    target = 0;
    moving = false;
    locked = false;
    returnAt = -1;
    spawn() {
        const model = this.brushModelIndex();
        if (model !== null && !this.flag(1)) this.collision = this.ctx.collision.addBrushModel(model, this.origin);
        const axis: Vec3 = this.flag(64) ? [0, 0, 1] : this.flag(128) ? [1, 0, 0] : [0, 1, 0];
        const dist = (Number(this.kv.distance) || 90) * (this.flag(2) ? -1 : 1);
        this.angle1 = [...this.angles];
        this.angle2 = [0, 1, 2].map((i) => this.angles[i] + axis[i] * dist) as Vec3;
        this.locked = this.kv.startdisabled === '1';
    }
    usableByPlayer() {
        return this.flag(1024) || this.flag(256);
    }
    press(a: GameEntity | null) {
        if (this.locked) {
            this.fire('onuselocked', a);
            return;
        }
        if (this.moving) return;
        if (this.target === 1) {
            if (!this.flag(32)) return;
            this.target = 0;
        } else {
            this.target = 1;
        }
        this.moving = true;
        this.returnAt = -1;
        this.fire('onpressed', a);
    }
    think(dt: number) {
        if (this.returnAt >= 0 && this.game.time >= this.returnAt) {
            this.returnAt = -1;
            this.target = 0;
            this.moving = true;
        }
        if (!this.moving) return;
        const goal = this.target ? this.angle2 : this.angle1;
        const d = [0, 1, 2].map((i) => goal[i] - this.angles[i]);
        const len = Math.hypot(d[0], d[1], d[2]);
        const step = (Number(this.kv.speed) || 40) * dt;
        if (len <= step) {
            this.setTransform(this.origin, goal);
            this.moving = false;
            this.fire(this.target ? 'onin' : 'onout', null);
            const wait = Number(this.kv.wait);
            if (this.target && wait > 0 && !this.flag(32)) this.returnAt = this.game.time + wait;
        } else {
            this.setTransform(this.origin, [0, 1, 2].map((i) => this.angles[i] + (d[i] / len) * step) as Vec3);
        }
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'press': case 'use': this.press(a); return true;
            case 'lock': this.locked = true; return true;
            case 'unlock': this.locked = false; return true;
        }
        return super.input(name, param, a, c);
    }
}

/** Fires once the player inside has looked at the target long enough. */
class TriggerLook extends Trigger {
    lookStart = -1;
    startTouch() {}
    tryTrigger() {}
    stayTouch(e: GameEntity) {
        if (e.index !== -1) return;
        const target = this.game.find(this.kv.target ?? '', e, this)[0];
        if (!target) return;
        const eye = this.ctx.player.eye();
        const dir = [target.origin[0] - eye[0], target.origin[1] - eye[1], target.origin[2] - eye[2]];
        const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
        const look = angleVector([this.ctx.view.pitch, this.ctx.view.yaw, 0]);
        const dot = (dir[0] * look[0] + dir[1] * look[1] + dir[2] * look[2]) / len;
        if (dot < (Number(this.kv.fieldofview) || 0.9)) {
            this.lookStart = -1;
            return;
        }
        if (this.lookStart < 0) this.lookStart = this.game.time;
        if (this.game.time - this.lookStart >= (Number(this.kv.looktime) || 0.5)) {
            this.fire('ontrigger', e);
            this.remove();
        }
    }
}

/** Fizzles portals the player carries through and dissolves boxes. */
class TriggerPortalCleanser extends Trigger {
    passes(e: GameEntity) {
        return e.index === -1 || e instanceof PhysProp;
    }
    startTouch(e: GameEntity) {
        super.startTouch(e);
        if (e instanceof PhysProp) {
            e.remove();
            this.fire('ondissolvebox', e);
        } else if (this.ctx.portals.fizzleGunPortals()) {
            this.fire('onfizzle', e);
        }
    }
}

class TriggerChangeLevel extends Trigger {
    onTriggered(e: GameEntity) {
        if (e.index === -1 && !this.flag(2)) this.changeLevel();
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'changelevel') {
            this.changeLevel();
            return true;
        }
        return super.input(name, param, a, c);
    }
    changeLevel() {
        const map = this.kv.map;
        if (!map) return;
        // Carry the player's position relative to the landmark into the next map.
        const lm = this.game.find(this.kv.landmark ?? '', null, this).find((e) => e.classname === 'info_landmark');
        const params = new URLSearchParams({ map });
        if (lm) {
            const p = this.ctx.player.origin;
            params.set('landmark', this.kv.landmark!);
            params.set('offset', [p[0] - lm.origin[0], p[1] - lm.origin[1], p[2] - lm.origin[2]].map((v) => v.toFixed(2)).join(','));
            params.set('ang', `${this.ctx.view.pitch.toFixed(1)},${this.ctx.view.yaw.toFixed(1)}`);
            // The elevator and anything else global comes along, where it is now.
            params.set('globals', this.game.saveGlobals(lm.origin));
        }
        // So does the player's portal gun.
        const gun = this.game.playerGun;
        if (gun) params.set('gun', gun.map((c) => (c ? '1' : '0')).join(','));
        this.ctx.log(`changelevel ${map}`);
        location.search = params.toString();
    }
}

class FilterName extends GameEntity {
    passes(e: GameEntity): boolean {
        const match = e.name === (this.kv.filtername ?? '').toLowerCase();
        const negated = this.kv.negated === '1' || this.kv.negated?.toLowerCase().startsWith('filter out');
        return negated ? !match : match;
    }
}

/** filter_combineball_type: lets energy balls through (the catchers use it), nothing else. */
class FilterBallType extends GameEntity {
    passes(e: GameEntity): boolean {
        const match = e instanceof EnergyBall;
        return this.kv.negated?.toLowerCase().startsWith('disallow') ? !match : match;
    }
}

// ---------------------------------------------------------------- brush entities

/** func_brush and friends: visible, optionally solid, toggled by map logic. */
class FuncBrush extends GameEntity {
    enabled = true;
    spawn() {
        const model = this.brushModelIndex();
        const solidity = this.kv.solidity ?? '0'; // 0 = toggle with visibility, 1 = never, 2 = always
        if (model !== null && solidity !== '1') this.collision = this.ctx.collision.addBrushModel(model, this.origin);
        this.setEnabled(this.kv.startdisabled !== '1');
    }
    setEnabled(on: boolean) {
        this.enabled = on;
        this.setVisible(on);
        if (this.collision) this.collision.solid = on || this.kv.solidity === '2';
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'enable' || name === 'turnon') this.setEnabled(true);
        else if (name === 'disable' || name === 'turnoff') this.setEnabled(false);
        else if (name === 'toggle') this.setEnabled(!this.enabled);
        else return super.input(name, param, a, c);
        return true;
    }
}

class FuncDoor extends GameEntity {
    pos1: Vec3 = [0, 0, 0];
    pos2: Vec3 = [0, 0, 0];
    /** Where the door is heading: 0 = closed (pos1), 1 = open (pos2). */
    target = 0;
    moving = false;
    closeAt = -1;
    spawn() {
        const model = this.brushModelIndex();
        if (model !== null) this.collision = this.ctx.collision.addBrushModel(model, this.origin);
        // The toilet's flush handle is a door over the bowl: the player can use it, but props must
        // be able to fall into the bowl without it, so it stays out of the rigid-body world.
        if (this.collision && this.connections.some((c) => c.target === 'relay_toiletflush')) this.collision.rigid = true;
        const m = model !== null ? this.ctx.bsp.models[model] : undefined;
        const size = m ? [m.maxs[0] - m.mins[0], m.maxs[1] - m.mins[1], m.maxs[2] - m.mins[2]] : [0, 0, 0];
        const dir = angleVector(parseVec3(this.kv.movedir));
        const lip = Number(this.kv.lip) || 0;
        const dist = Math.abs(dir[0] * (size[0] - 2)) + Math.abs(dir[1] * (size[1] - 2)) + Math.abs(dir[2] * (size[2] - 2)) - lip;
        this.pos1 = [...this.origin];
        this.pos2 = [this.origin[0] + dir[0] * dist, this.origin[1] + dir[1] * dist, this.origin[2] + dir[2] * dist];
        // Spawnflag 1: starts open.
        if (this.flag(1)) {
            this.target = 1;
            this.setOrigin(this.pos2);
        }
    }
    isMoving() {
        return this.moving;
    }
    private moveSound: SoundHandle | null = null;
    /** CBaseDoor's sounds: noise1 while moving and noise2 on arrival; closing may use its own pair. */
    private startMoveSound() {
        this.moveSound?.stop(0.1);
        const closing = this.target === 0 && this.kv.startclosesound;
        this.moveSound = this.emitSound(closing ? this.kv.startclosesound : this.kv.noise1);
    }
    private arriveSound() {
        this.moveSound?.stop(0.1);
        this.moveSound = null;
        this.emitSound(this.target === 0 && this.kv.closesound ? this.kv.closesound : this.kv.noise2);
    }
    open(a: GameEntity | null) {
        if (this.target === 1) return;
        this.target = 1;
        this.moving = true;
        this.startMoveSound();
        this.fire('onopen', a);
    }
    close(a: GameEntity | null) {
        if (this.target === 0) return;
        this.target = 0;
        this.moving = true;
        this.closeAt = -1;
        this.startMoveSound();
        this.fire('onclose', a);
    }
    think(dt: number) {
        if (this.closeAt >= 0 && this.game.time >= this.closeAt) this.close(null);
        if (!this.moving) return;
        const goal = this.target ? this.pos2 : this.pos1;
        const d = [goal[0] - this.origin[0], goal[1] - this.origin[1], goal[2] - this.origin[2]];
        const len = Math.hypot(d[0], d[1], d[2]);
        const step = (Number(this.kv.speed) || 100) * dt;
        if (len <= step) {
            this.moveTo(goal);
            this.moving = false;
            this.arriveSound();
            this.fire(this.target ? 'onfullyopen' : 'onfullyclosed', null);
            const wait = Number(this.kv.wait);
            if (this.target === 1 && wait > 0) this.closeAt = this.game.time + wait;
        } else {
            this.moveTo([this.origin[0] + (d[0] / len) * step, this.origin[1] + (d[1] / len) * step, this.origin[2] + (d[2] / len) * step]);
        }
    }
    /** Moves the door, carrying anything standing on it and pushing the player out of its way. */
    moveTo(o: Vec3) {
        const from: Vec3 = [...this.origin];
        const delta: Vec3 = [o[0] - from[0], o[1] - from[1], o[2] - from[2]];
        carryRiders(this, delta);
        this.setOrigin(o);
        // Blocked (the player can't be pushed clear): stay put and try again next frame.
        if (!pushPlayer(this, delta)) this.setOrigin(from);
    }
    use(a: GameEntity | null) {
        if (this.target === 1) this.close(a);
        else this.open(a);
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'open':
                this.open(a);
                return true;
            case 'close':
                this.close(a);
                return true;
            case 'toggle':
                this.use(a);
                return true;
            case 'setspeed':
                this.kv.speed = param;
                return true;
            case 'lock':
            case 'unlock':
                return true;
        }
        return super.input(name, param, a, c);
    }
}

/** func_movelinear: slides `movedistance` along `movedir`. Spawnflag 8: not solid. */
class FuncMoveLinear extends FuncDoor {
    spawn() {
        const model = this.brushModelIndex();
        if (model !== null && !this.flag(8)) this.collision = this.ctx.collision.addBrushModel(model, this.origin);
        const dir = angleVector(parseVec3(this.kv.movedir));
        const dist = Number(this.kv.movedistance) || 100;
        this.pos1 = [...this.origin];
        this.pos2 = [this.origin[0] + dir[0] * dist, this.origin[1] + dir[1] * dist, this.origin[2] + dir[2] * dist];
        const f = Math.max(0, Math.min(1, Number(this.kv.startposition) || 0));
        if (f > 0) {
            this.setOrigin([0, 1, 2].map((i) => this.pos1[i] + (this.pos2[i] - this.pos1[i]) * f) as Vec3);
            this.target = f >= 1 ? 1 : 0;
        }
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'setposition') {
            this.target = (Number(param) || 0) >= 0.5 ? 1 : 0;
            this.moving = true;
            return true;
        }
        return super.input(name, param, a, c);
    }
}

/**
 * func_door_rotating (CRotDoor): turns `distance` degrees about its yaw axis (or roll/pitch by
 * spawnflag) and back, carrying its children round with it. Its collision doesn't turn.
 */
class FuncDoorRotating extends GameEntity {
    angle1: Vec3 = [0, 0, 0];
    angle2: Vec3 = [0, 0, 0];
    target = 0;
    moving = false;
    closeAt = -1;
    private moveSound: SoundHandle | null = null;
    spawn() {
        const model = this.brushModelIndex();
        // Spawnflag 8: passable (not solid at all).
        if (model !== null && !this.flag(8)) this.collision = this.ctx.collision.addBrushModel(model, this.origin);
        const axis: Vec3 = this.flag(64) ? [0, 0, 1] : this.flag(128) ? [1, 0, 0] : [0, 1, 0];
        const sign = this.flag(2) ? -1 : 1; // rotate backwards
        const dist = Number(this.kv.distance) || 90;
        this.angle1 = [...this.angles];
        this.angle2 = [0, 1, 2].map((i) => this.angles[i] + axis[i] * dist * sign) as Vec3;
        // Spawnflag 1 (obsolete "starts open"): open is the closed position.
        if (this.flag(1)) [this.angle1, this.angle2] = [this.angle2, this.angle1];
        if (this.flag(1)) this.setTransform(this.origin, this.angle1);
    }
    isMoving() {
        return this.moving;
    }
    private go(target: number, a: GameEntity | null) {
        if (this.target === target && (this.moving || target === 0)) return;
        this.target = target;
        this.moving = true;
        this.closeAt = -1;
        this.moveSound?.stop(0.1);
        this.moveSound = this.emitSound(target === 0 && this.kv.startclosesound ? this.kv.startclosesound : this.kv.noise1);
        this.fire(target ? 'onopen' : 'onclose', a);
    }
    think(dt: number) {
        if (this.closeAt >= 0 && this.game.time >= this.closeAt) this.go(0, null);
        if (!this.moving) return;
        const goal = this.target ? this.angle2 : this.angle1;
        const d = [0, 1, 2].map((i) => goal[i] - this.angles[i]);
        const len = Math.hypot(d[0], d[1], d[2]);
        const step = (Number(this.kv.speed) || 100) * dt;
        if (len <= step) {
            this.setTransform(this.origin, goal);
            this.moving = false;
            this.moveSound?.stop(0.1);
            this.moveSound = null;
            this.emitSound(this.target === 0 && this.kv.closesound ? this.kv.closesound : this.kv.noise2);
            this.fire(this.target ? 'onfullyopen' : 'onfullyclosed', null);
            const wait = Number(this.kv.wait);
            if (this.target === 1 && wait > 0) this.closeAt = this.game.time + wait;
        } else {
            this.setTransform(this.origin, [0, 1, 2].map((i) => this.angles[i] + (d[i] / len) * step) as Vec3);
        }
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'open':
                this.go(1, a);
                return true;
            case 'close':
                this.go(0, a);
                return true;
            case 'toggle':
                this.go(this.target ? 0 : 1, a);
                return true;
            case 'setspeed':
                this.kv.speed = param;
                return true;
            case 'lock':
            case 'unlock':
                return true;
        }
        return super.input(name, param, a, c);
    }
}

/**
 * weapon_portalgun lying in the world (on a pedestal): the player picks it up by walking into it
 * (CBaseCombatWeapon's trigger bounds, bloated 36 units), and map logic can make it fire.
 */
class WeaponPortalgun extends GameEntity {
    /** Bounds of w_portalgun.mdl around its origin, roughly, plus UseTriggerBounds' 36. */
    private static readonly REACH: Vec3 = [16 + 36, 16 + 36, 8 + 36];
    canFire(): [boolean, boolean] {
        return [this.kv.canfireportal1 !== '0', this.kv.canfireportal2 !== '0'];
    }
    think() {
        const p = this.ctx.player;
        const r = WeaponPortalgun.REACH;
        const near = [0, 1, 2].every((i) => p.origin[i] + p.maxs[i] >= this.origin[i] - r[i] && p.origin[i] + p.mins[i] <= this.origin[i] + r[i]);
        if (!near || this.ctx.view.mode === 'noclip') return;
        this.ctx.givePortalgun?.(this.canFire());
        this.fire('onplayerpickup', this.game.playerEntity);
        this.setParent(null);
        this.remove();
    }
    /**
     * The muzzle attachment of w_portalgun.mdl, which sits 21 units down the model's -Z axis and
     * points along it (the model isn't built along its forward axis), turned by the entity's angles.
     */
    private muzzle(): { pos: Vec3; dir: Vec3 } {
        const a = this.angles;
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(a[2] * DEG, a[0] * DEG, a[1] * DEG, 'ZYX'));
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
        const pos = dir.clone().multiplyScalar(21).add(new THREE.Vector3(...this.origin));
        return { pos: [pos.x, pos.y, pos.z], dir: [dir.x, dir.y, dir.z] };
    }
    /** FirePortal1/2 from a gun nobody holds: from its muzzle along where it points. */
    private shoot(color: 0 | 1, dir?: Vec3) {
        const m = this.muzzle();
        let f = dir ?? m.dir;
        const len = Math.hypot(f[0], f[1], f[2]) || 1;
        f = [f[0] / len, f[1] / len, f[2] / len];
        this.emitSound(color ? 'Weapon_Portalgun.fire_red_npc' : 'Weapon_Portalgun.fire_blue_npc');
        firePortal(this.game, color, m.pos, f, m.pos, PlacedBy.Pedestal);
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'fireportal1':
            case 'fireportal2':
                this.shoot(name === 'fireportal2' ? 1 : 0);
                return true;
            case 'fireportaldirection1':
            case 'fireportaldirection2':
                this.shoot(name === 'fireportaldirection2' ? 1 : 0, parseVec3(param));
                return true;
            case 'chargeportal1':
            case 'chargeportal2': {
                // The charge-up glow at the muzzle, following the gun.
                const n = name === 'chargeportal2' ? 2 : 1;
                const m = this.muzzle();
                const up = new THREE.Vector3(0, 0, 1);
                if (Math.abs(m.dir[2]) > 0.99) up.set(1, 0, 0);
                const right = new THREE.Vector3(...m.dir).cross(up).normalize();
                const upv = right.clone().cross(new THREE.Vector3(...m.dir)).normalize();
                void this.ctx.particles?.spawn(`portal_${n}_charge`, m.pos, m.dir, [upv.x, upv.y, upv.z]).then((fx) => fx?.bind(0, () => this.muzzle().pos));
                return true;
            }
        }
        return super.input(name, param, a, c);
    }
}

/**
 * Moves the player along with a platform they're standing on, as far as nothing else is in the
 * way (SV_PushMove traces riders): someone half on a sinking button stays on the ledge beside it.
 */
function carryRiders(e: GameEntity, delta: Vec3) {
    const { player, collision } = e.ctx;
    const models = [e.collision, ...e.children.map((c) => c.collision)].filter((m): m is CollisionModel => !!m);
    if (!player.groundModel || !models.includes(player.groundModel)) return;
    const solid = models.map((m) => m.solid);
    for (const m of models) m.solid = false;
    const to: Vec3 = [player.origin[0] + delta[0], player.origin[1] + delta[1], player.origin[2] + delta[2]];
    const tr = collision.trace(player.origin, to, player.mins, player.maxs);
    models.forEach((m, i) => (m.solid = solid[i]));
    if (!tr.startSolid) player.origin = tr.end;
}

/**
 * A MOVETYPE_PUSH mover just moved by `delta` (SV_PushMove): if that put it into the player,
 * pushes them along by the same amount. Returns false if the player can't be cleared, in which
 * case the mover is blocked.
 */
function pushPlayer(e: GameEntity, delta: Vec3): boolean {
    const { player, collision } = e.ctx;
    const models = [e.collision, ...e.children.map((c) => c.collision)].filter((m): m is CollisionModel => !!m && m.solid);
    if (!models.length) return true;
    const inside = (p: Vec3) => collision.trace(p, p, player.mins, player.maxs).startSolid;
    if (!inside(player.origin)) return true;
    // Already stuck in something else: not this mover's doing.
    for (const m of models) m.solid = false;
    const elsewhere = inside(player.origin);
    for (const m of models) m.solid = true;
    if (elsewhere) return true;
    const pushed: Vec3 = [player.origin[0] + delta[0], player.origin[1] + delta[1], player.origin[2] + delta[2]];
    if (inside(pushed)) return false;
    player.origin = pushed;
    return true;
}

/** func_tracktrain following path_track corners; used for elevators. */
class FuncTrackTrain extends GameEntity {
    path: GameEntity | null = null;
    speed = 0;
    spawn() {
        const model = this.brushModelIndex();
        if (model !== null) this.collision = this.ctx.collision.addBrushModel(model, this.origin);
        this.path = this.game.find(this.kv.target ?? '', null, this)[0] ?? null;
    }
    isMoving() {
        return this.speed !== 0;
    }
    private moveSound: SoundHandle | null = null;
    /** CFuncTrackTrain's StartSound and looping MoveSound while it runs, StopSound when it stops. */
    private setSpeed(speed: number) {
        const was = this.speed !== 0, now = speed !== 0;
        this.speed = speed;
        if (now && !was) {
            this.emitSound(this.kv.startsound);
            this.moveSound = this.emitSound(this.kv.movesound, { loop: true });
        } else if (!now && was) {
            this.moveSound?.stop(0.2);
            this.moveSound = null;
            this.emitSound(this.kv.stopsound);
        }
    }
    saveTransition() {
        return [String(this.speed), this.path?.name ?? ''];
    }
    restoreTransition([speed, path]: string[]) {
        this.speed = Number(speed) || 0;
        const p = path ? this.game.find(path, null, this)[0] : undefined;
        if (p) this.path = p;
    }
    think(dt: number) {
        if (this.speed === 0 || !this.path) return;
        const goal = this.path.origin;
        const d = [goal[0] - this.origin[0], goal[1] - this.origin[1], goal[2] - this.origin[2]];
        const len = Math.hypot(d[0], d[1], d[2]);
        const step = Math.abs(this.speed) * dt;
        const next = len <= step ? goal : ([this.origin[0] + (d[0] / len) * step, this.origin[1] + (d[1] / len) * step, this.origin[2] + (d[2] / len) * step] as Vec3);
        carryRiders(this, [next[0] - this.origin[0], next[1] - this.origin[1], next[2] - this.origin[2]]);
        this.setOrigin(next);
        if (len <= step) {
            const passed = this.path;
            passed.fire('onpass', this);
            const nextPath = passed.kv.target ? this.game.find(passed.kv.target, null, passed)[0] : undefined;
            if (nextPath) this.path = nextPath;
            else this.setSpeed(0);
        }
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'startforward':
            case 'resume':
                this.setSpeed(Number(this.kv.startspeed) || 64);
                return true;
            case 'stop':
                this.setSpeed(0);
                return true;
            case 'setspeed':
                this.setSpeed((Number(param) || 0) * (Number(this.kv.startspeed) || 64));
                return true;
        }
        return super.input(name, param, a, c);
    }
}

// ---------------------------------------------------------------- props

class PropDynamic extends GameEntity {
    sequence = 0;
    animStart = 0;
    animating = false;
    frame = 0;
    /** Game time at which a closing animation ends and the closed hull starts colliding. */
    solidAt = -1;
    spawn() {
        const inst = this.ctx.propInstances.get(this.index);
        if (inst?.solid && this.kv.startdisabled !== '1') this.attachCollision();
        if (this.kv.startdisabled === '1') this.setVisible(false);
    }
    async attachCollision() {
        const inst = this.ctx.propInstances.get(this.index);
        if (!inst) return;
        const hulls = await this.ctx.props.collisionHulls(inst);
        if (!hulls.length || this.removed) return;
        this.collision = this.ctx.collision.addHullModel(hulls);
        // Hulls are built at the spawn position; follow any movement since.
        for (let i = 0; i < 3; i++) this.collision.origin[i] = this.origin[i] - this.spawnOrigin[i];
    }
    handle() {
        return this.ctx.propHandles.get(this.index);
    }
    think(_dt: number) {
        if (this.solidAt >= 0 && this.game.time >= this.solidAt) {
            this.solidAt = -1;
            if (this.collision) this.collision.solid = true;
        }
        const h = this.handle();
        if (!this.animating || !h) return;
        const t = sequenceTiming(h.model.mdl, this.sequence);
        let frame = (this.game.time - this.animStart) * t.fps;
        if (frame >= t.frames - 1) {
            if (t.looping) frame %= Math.max(1, t.frames - 1);
            else {
                frame = t.frames - 1;
                this.animating = false;
                this.fire('onanimationdone', this);
            }
        }
        this.frame = frame;
        this.ctx.props.setPose(h, this.sequence, frame);
    }
    /** World transform of a named attachment point at the current frame, or null without a model or attachment. */
    attachmentWorld(name: string): THREE.Matrix4 | null {
        const h = this.handle();
        const local = h ? attachmentMatrix(h.model.mdl, this.sequence, this.frame, name) : null;
        return local ? this.worldMatrix().multiply(local) : null;
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        const h = this.handle();
        switch (name) {
            case 'skin':
                if (h) void this.ctx.props.setSkin(h, Number(param) || 0);
                return true;
            case 'setanimation': {
                // Collision hulls don't animate. Openings (dropper cover, doors) stop colliding
                // at once; closings collide again once the animation has played, since in the
                // game the hull swings shut with it and whatever was passing gets clear first.
                const opening = /open/i.test(param), closing = /clos/i.test(param);
                if (this.collision && opening) this.collision.solid = false;
                this.solidAt = -1;
                this.fire('onanimationbegun', this);
                let duration = 1; // without a model to time (headless), assume a second
                if (h) {
                    this.sequence = findSequence(h.model.mdl, param);
                    this.animStart = this.game.time;
                    this.animating = true;
                    const t = sequenceTiming(h.model.mdl, this.sequence);
                    duration = t.fps > 0 ? Math.max(0, t.frames - 1) / t.fps : 0;
                }
                if (this.collision && closing) this.solidAt = this.game.time + duration;
                return true;
            }
            case 'setdefaultanimation':
            case 'setplaybackrate':
                return true;
            case 'disablecollision':
                this.solidAt = -1;
                if (this.collision) this.collision.solid = false;
                return true;
            case 'enablecollision':
                this.solidAt = -1;
                if (this.collision) this.collision.solid = true;
                return true;
            case 'turnoff':
            case 'disable':
                this.setVisible(false);
                return true;
            case 'turnon':
            case 'enable':
                this.setVisible(true);
                return true;
        }
        return super.input(name, param, a, c);
    }
}

/** Source's player mass (kg), for how hard walking into a prop shoves it. */
const PLAYER_MASS = 85;
/** CGrabController's shadow limits: speed (in/s) and turn rate (deg/s). */
const GRAB_MAX_SPEED = 1000;
const GRAB_MAX_ANGULAR = 360 * 10;
/** A carried object that lags this far (inches) behind where it should be is dropped. */
const GRAB_MAX_ERROR = 12;
/** On release, ClampPhysicsVelocity(hl2_normspeed * 1.5, 2 * 360). */
const DROP_MAX_SPEED = 190 * 1.5;
const DROP_MAX_ANGULAR = 2 * 360;
/** prop_portal.cpp exit velocities for things other than the player. */
const MIN_FLOOR_EXIT_SPEED = 50;
const MIN_FLOOR_TO_FLOOR_EXIT_SPEED = 225;

const DEG = Math.PI / 180;
const MASK_SOLID_BRUSHONLY = Contents.Solid | Contents.Moveable | Contents.Window | Contents.Grate;

/**
 * A physics prop (prop_physics; the weighted storage cube is one): a rigid body built from the
 * model's .phy hulls and mass. It tumbles, stacks, gets pushed, rides through portals, and the
 * player carries it with a port of CGrabController.
 */
export class PhysProp extends PropDynamic implements PhysicsController {
    rigid: RigidBody | null = null;
    held = false;
    ready = false;
    /** World bounds of the hulls as they're turned now. */
    center: Vec3 = [0, 0, 0];
    half: Vec3 = [0, 0, 0];
    /** Hulls relative to the body's origin, spawn rotation baked in. */
    private hulls: { points: Vec3[]; triangles: [number, number, number][] }[] = [];
    /** The hulls as brushes in the body's own frame. */
    private local: CollisionBrush[] | null = null;
    protected spawnRotation = new THREE.Quaternion();
    private mass = 0;
    private prevCom: Vec3 | null = null;
    /**
     * CPortal_Player's held-object portal: while carried with a portal between the player and the
     * object, the portal on the player's side, which the hold point is mapped through.
     */
    heldPortal: Portal | null = null;
    /** Grab state: orientation relative to the player's yaw, last target, and lag. */
    private grabRotation = new THREE.Quaternion();
    private grabTarget: Vec3 | null = null;
    private grabError = 0;

    spawn() {
        void this.init();
    }

    async init() {
        const inst = this.ctx.propInstances.get(this.index);
        if (!inst) return;
        const [hulls, mass] = await Promise.all([this.ctx.props.collisionHulls(inst), this.ctx.props.physicsMass(inst)]);
        if (!hulls.length || this.removed) return;
        this.unstickSpawn(hulls);
        const o = this.origin;
        this.hulls = hulls.map((h) => ({ triangles: h.triangles, points: h.points.map((p): Vec3 => [p[0] - o[0], p[1] - o[1], p[2] - o[2]]) }));
        this.local = null;
        const a = this.angles;
        this.spawnRotation.setFromEuler(new THREE.Euler(a[2] * DEG, a[0] * DEG, a[1] * DEG, 'ZYX'));
        this.mass = mass ?? 20;
        this.rigid = this.ctx.physics.addBody(this.hulls.map((h) => h.points), o, this.mass);
        if (!this.rigid) return;
        this.collision = this.ctx.collision.addHullModel(hulls);
        this.collision.rigid = true;
        // Spawnflags: 1 start asleep, 8 motion disabled.
        if (this.flag(8)) this.ctx.physics.setMotionEnabled(this.rigid, false);
        else if (this.flag(1)) this.rigid.body.sleep();
        this.ctx.physics.addController(this);
        this.sync(true);
        this.ready = true;
    }

    saveExtra(): unknown {
        const b = this.rigid?.body;
        if (!b) return null;
        return { t: b.translation(), r: b.rotation(), v: b.linvel(), w: b.angvel() };
    }

    restoreExtra(x: unknown) {
        const b = this.rigid?.body;
        const s = x as { t: { x: number; y: number; z: number }; r: { x: number; y: number; z: number; w: number }; v: { x: number; y: number; z: number }; w: { x: number; y: number; z: number } } | null;
        if (!b || !s) return;
        b.setTranslation(s.t, true);
        b.setRotation(s.r, true);
        b.setLinvel(s.v, true);
        b.setAngvel(s.w, true);
        this.held = false;
        this.heldPortal = null;
        this.sync(true);
    }

    bounds(): Bounds | null {
        if (!this.ready) return null;
        const c = this.center, h = this.half;
        return { mins: [c[0] - h[0], c[1] - h[1], c[2] - h[2]], maxs: [c[0] + h[0], c[1] + h[1], c[2] + h[2]] };
    }

    /**
     * Spawned partly inside a wall (the dropper's template sits off its shaft's center), a body
     * would be thrown spinning out of it. Like VPhysics' gentler penetration recovery, slide it
     * straight out first: the nearest spot, within 48 units, where its hulls clear the world.
     */
    private unstickSpawn(hulls: { points: Vec3[]; triangles: [number, number, number][] }[]) {
        const o: Vec3 = [...this.origin];
        // Each hull's bounds (shrunk half a unit) as a box against the world.
        const boxes = hulls.map((h) => {
            const b = hullBrush(h.points, h.triangles);
            return { center: b.mins.map((v, i) => (v + b.maxs[i]) / 2), half: b.mins.map((v, i) => Math.max(0, (b.maxs[i] - v) / 2 - 0.5)) };
        });
        const blocked = (d: Vec3) => boxes.some(({ center: c, half: h }) => {
            const p: Vec3 = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
            return this.ctx.collision.trace(p, p, [-h[0], -h[1], -h[2]], [h[0], h[1], h[2]], MASK_SOLID_BRUSHONLY).startSolid;
        });
        if (!blocked([0, 0, 0])) return;
        for (let r = 2; r <= 48; r += 2) {
            for (let k = 0; k < 16; k++) {
                const a = (k / 16) * Math.PI * 2;
                for (const dz of [0, r / 2, -r / 2]) {
                    const d: Vec3 = [Math.cos(a) * r, Math.sin(a) * r, dz];
                    if (blocked(d)) continue;
                    for (const h of hulls) for (const p of h.points) for (let i = 0; i < 3; i++) p[i] += d[i];
                    this.origin = [o[0] + d[0], o[1] + d[1], o[2] + d[2]];
                    return;
                }
            }
        }
    }

    protected rotation(): THREE.Quaternion {
        const q = this.rigid!.body.rotation();
        return new THREE.Quaternion(q.x, q.y, q.z, q.w);
    }

    /** The body's center of mass in world space. */
    private com(): Vec3 {
        const t = this.rigid!.body.translation();
        const c = this.rigid!.body.localCom();
        const v = new THREE.Vector3(c.x, c.y, c.z).applyQuaternion(this.rotation());
        return [t.x + v.x, t.y + v.y, t.z + v.z];
    }

    /** Follows the body: entity origin, the model's transform, hulls for player traces, bounds. */
    private sync(force = false) {
        const r = this.rigid!;
        if (!force && r.body.isSleeping()) return;
        const t = r.body.translation();
        const rot = this.rotation();
        this.origin = [t.x, t.y, t.z];
        const h = this.handle();
        if (h) {
            h.group.position.set(t.x, t.y, t.z);
            h.group.quaternion.copy(rot).multiply(this.spawnRotation);
        }
        // The hulls are convex bodies that only move rigidly, so their planes are built once (local to
        // the body) and carried along: turning a normal and shifting a distance, not rebuilding them.
        this.local ??= this.hulls.map((hull) => hullBrush(hull.points, hull.triangles));
        const m = new THREE.Matrix4().makeRotationFromQuaternion(rot).elements;
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        this.collision!.brushes = this.local.map((lb) => {
            const n = lb.normals.length / 3;
            const normals = new Float32Array(lb.normals.length);
            const dists = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const x = lb.normals[i * 3], y = lb.normals[i * 3 + 1], z = lb.normals[i * 3 + 2];
                const wx = m[0] * x + m[4] * y + m[8] * z, wy = m[1] * x + m[5] * y + m[9] * z, wz = m[2] * x + m[6] * y + m[10] * z;
                normals[i * 3] = wx;
                normals[i * 3 + 1] = wy;
                normals[i * 3 + 2] = wz;
                dists[i] = lb.dists[i] + wx * t.x + wy * t.y + wz * t.z;
            }
            const bmin: Vec3 = [Infinity, Infinity, Infinity], bmax: Vec3 = [-Infinity, -Infinity, -Infinity];
            const points = (lb.points ?? []).map((p): Vec3 => {
                const w: Vec3 = [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + t.x, m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + t.y, m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + t.z];
                for (let a = 0; a < 3; a++) {
                    bmin[a] = Math.min(bmin[a], w[a]);
                    bmax[a] = Math.max(bmax[a], w[a]);
                    lo[a] = Math.min(lo[a], w[a]);
                    hi[a] = Math.max(hi[a], w[a]);
                }
                return w;
            });
            return { contents: lb.contents, normals, dists, mins: bmin, maxs: bmax, points };
        });
        this.collision!.origin = [0, 0, 0];
        this.center = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2) as Vec3;
        this.half = [0, 1, 2].map((a) => (hi[a] - lo[a]) / 2) as Vec3;
    }

    /** Teleports the body (map logic moving it, or a parent), keeping how it's turned. */
    setTransform(o: Vec3, a: Vec3, fromParent = false) {
        if (!this.rigid) return super.setTransform(o, a, fromParent);
        this.rigid.body.setTranslation({ x: o[0], y: o[1], z: o[2] }, true);
        this.prevCom = null;
        this.sync(true);
    }

    think(dt: number) {
        super.think(dt);
        if (!this.ready) return;
        this.sync();
        this.relight();
        // Fell out of the world.
        if (this.center[2] < -16384) {
            this.fire('onoutofworld', this);
            this.remove();
        }
    }

    beforeTick(dt: number) {
        if (this.held) this.grab(dt);
    }

    afterTick() {
        // Through a portal: the center of mass crossed an open, linked portal's oval.
        const com = this.com();
        const through = this.prevCom && this.ctx.portals.crossing(this.prevCom, com);
        this.prevCom = com;
        if (through) this.teleportThrough(through.matrix, through.from, through.to);
    }

    /**
     * The player carrying this went through a portal (entering `from`, leaving `to`): the object,
     * left on the other side, is now held through `to`; or, if it was held through a portal, it
     * isn't any more (prop_portal.cpp's ToggleHeldObjectOnOppositeSideOfPortal).
     */
    playerTeleported(_from: Portal, to: Portal) {
        if (this.held) this.heldPortal = this.heldPortal ? null : to;
    }

    /** CProp_Portal::TeleportTouchingEntity for a physics object. */
    private teleportThrough(m: THREE.Matrix4, fromPortal: Portal, toPortal: Portal) {
        const from = fromPortal.matrix, to = toPortal.matrix;
        const body = this.rigid!.body;
        const turn = new THREE.Quaternion().setFromRotationMatrix(m);
        const rot = turn.clone().multiply(this.rotation());
        const com = new THREE.Vector3(...this.com()).applyMatrix4(m);
        const lc = body.localCom();
        const t = com.clone().sub(new THREE.Vector3(lc.x, lc.y, lc.z).applyQuaternion(rot));
        const lv = body.linvel(), av = body.angvel();
        const v = new THREE.Vector3(lv.x, lv.y, lv.z).applyQuaternion(turn);
        const w = new THREE.Vector3(av.x, av.y, av.z).applyQuaternion(turn);
        // Floor exits always throw things up a little, harder from floor to floor; nothing leaves faster than the max.
        const exitUp = new THREE.Vector3().setFromMatrixColumn(to, 0).z;
        const entryUp = new THREE.Vector3().setFromMatrixColumn(from, 0).z;
        if (exitUp > 0.7071) v.z = Math.max(v.z, entryUp > 0.7071 ? MIN_FLOOR_TO_FLOOR_EXIT_SPEED : MIN_FLOOR_EXIT_SPEED);
        if (v.length() > MAX_EXIT_SPEED) v.setLength(MAX_EXIT_SPEED);
        body.setTranslation({ x: t.x, y: t.y, z: t.z }, true);
        body.setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w }, true);
        body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
        body.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
        this.prevCom = [com.x, com.y, com.z];
        // Carried through: now held through the portal it went into (or back on the player's side).
        if (this.held) this.heldPortal = this.heldPortal ? null : fromPortal;
        this.sync(true);
    }

    /**
     * CGrabController::UpdateObject and Simulate: holds the object in front of the player's
     * eye, out of walls and the player's body, turned with the player, by setting the body's
     * velocity to arrive this tick (capped like VPhysics' shadow controller).
     */
    private grab(dt: number) {
        const body = this.rigid!.body;
        const player = this.ctx.player;
        const view = this.ctx.view;
        const t = body.translation();

        const pitch = Math.max(-75, Math.min(75, view.pitch));
        const forward = new THREE.Vector3(...angleVector([pitch, view.yaw, 0]));
        const start = new THREE.Vector3(...player.eye());
        const portals = this.ctx.portals;
        const fwd: Vec3 = [forward.x, forward.y, forward.z];
        const eye: Vec3 = [start.x, start.y, start.z];

        // ComputeError: how far the object lags its target; too far and it's dropped. Held through
        // a portal the player isn't looking through, the error grows fast.
        if (this.grabTarget) {
            let error = Math.hypot(this.grabTarget[0] - t.x, this.grabTarget[1] - t.y, this.grabTarget[2] - t.z);
            if (error / dt > GRAB_MAX_SPEED) error *= 0.5;
            const k = Math.min(1, dt);
            this.grabError = (1 - k) * this.grabError + error * k;
            if (this.heldPortal && portals.rayHitsPortal(this.heldPortal, eye, fwd, 256) < 0) this.grabError *= 2.5;
        }
        if (this.grabError > GRAB_MAX_ERROR || player.groundModel === this.collision) {
            this.drop();
            return;
        }

        // How far the object reaches toward the player: Portal's CollideGetExtent along -forward, its length.
        const rot = this.rotation();
        const v = new THREE.Vector3();
        let best = -Infinity, extent = 0;
        for (const h of this.hulls) for (const p of h.points) {
            v.set(p[0], p[1], p[2]).applyQuaternion(rot);
            const d = -v.dot(forward);
            if (d > best) {
                best = d;
                extent = v.length();
            }
        }
        const playerRadius = Math.hypot(player.maxs[0], player.maxs[1]);
        const radius = playerRadius + extent;
        const distance = 24 + radius * 2;
        const far = start.clone().addScaledVector(forward, distance);
        const tr = this.ctx.collision.trace([start.x, start.y, start.z], [far.x, far.y, far.z], [0, 0, 0], [0, 0, 0], MASK_SOLID_BRUSHONLY);
        const end = start.clone().addScaledVector(forward, tr.fraction < 0.5 ? radius * 0.5 : distance - radius);
        // Keep a radius away from the player's body.
        const zLo = player.origin[2] + player.mins[2], zHi = player.origin[2] + player.maxs[2];
        const nearest = new THREE.Vector3(player.origin[0], player.origin[1], Math.max(zLo, Math.min(zHi, end.z)));
        const delta = end.clone().sub(nearest);
        if (delta.length() > 0 && delta.length() < radius) end.copy(nearest).addScaledVector(delta.normalize(), radius);

        // Orientation follows the player's yaw; the object's center goes to the target point.
        let targetRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), view.yaw * DEG).multiply(this.grabRotation);
        const lc = body.localCom();
        const offset = new THREE.Vector3(lc.x, lc.y, lc.z).applyQuaternion(targetRot);
        let target = end.clone().sub(offset);

        // Held through a portal: the hold point, mapped to the far side.
        if (this.heldPortal) {
            const exit = portals.partner(this.heldPortal);
            if (!exit) {
                // The portal closed or lost its partner.
                this.drop();
                return;
            }
            const looking = portals.rayHitsPortal(this.heldPortal, eye, fwd, 1024) >= 0;
            if (!looking && start.distanceTo(new THREE.Vector3(...this.heldPortal.origin)) > distance - radius) {
                // Looking away and walking off: pull the object back through, from just behind the exit.
                const exitForward = new THREE.Vector3().setFromMatrixColumn(exit.matrix, 0);
                target = new THREE.Vector3(...exit.origin).addScaledVector(exitForward, -(1 + offset.length()));
                targetRot = new THREE.Quaternion().setFromRotationMatrix(exit.matrix);
            } else {
                const m = portals.transform(this.heldPortal, exit);
                target.applyMatrix4(m);
                targetRot = new THREE.Quaternion().setFromRotationMatrix(m).multiply(targetRot);
            }
        }
        this.grabTarget = [target.x, target.y, target.z];

        const vel = target.clone().sub(new THREE.Vector3(t.x, t.y, t.z)).divideScalar(dt);
        if (vel.length() > GRAB_MAX_SPEED) vel.setLength(GRAB_MAX_SPEED);
        const err = targetRot.clone().multiply(rot.clone().invert());
        if (err.w < 0) err.set(-err.x, -err.y, -err.z, -err.w);
        const angle = 2 * Math.acos(Math.min(1, err.w));
        const s = Math.sqrt(1 - err.w * err.w);
        const angVel = s > 1e-6 ? new THREE.Vector3(err.x / s, err.y / s, err.z / s).multiplyScalar(angle / dt) : new THREE.Vector3();
        if (angVel.length() > GRAB_MAX_ANGULAR * DEG) angVel.setLength(GRAB_MAX_ANGULAR * DEG);
        body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
        body.setAngvel({ x: angVel.x, y: angVel.y, z: angVel.z }, true);
    }

    /** Walking into the prop shoves it along, as hard as the player's mass allows. */
    pushedByPlayer(normal: Vec3, velocity: Vec3) {
        if (!this.rigid || this.held) return;
        // Push horizontally, away from the surface the player ran into.
        const dir = new THREE.Vector3(-normal[0], -normal[1], 0);
        if (dir.lengthSq() < 1e-6) return;
        dir.normalize();
        const into = velocity[0] * dir.x + velocity[1] * dir.y;
        if (into <= 0) return;
        const lv = this.rigid.body.linvel();
        const current = lv.x * dir.x + lv.y * dir.y;
        const goal = into * Math.min(1, PLAYER_MASS / Math.max(1, this.mass));
        if (current >= goal) return;
        const impulse = dir.multiplyScalar((goal - current) * this.rigid.body.mass());
        this.rigid.body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
    }

    private litAt: Vec3 | null = null;
    /** Moving props take the light where they are (the dropper tube is lit red). */
    private relight() {
        const h = this.handle();
        const c = this.center;
        if (!h || (this.litAt && Math.hypot(c[0] - this.litAt[0], c[1] - this.litAt[1], c[2] - this.litAt[2]) < 4)) return;
        this.litAt = [...c];
        this.ctx.props.relight(h);
    }

    pickUp() {
        if (!this.rigid) return;
        this.held = true;
        this.heldPortal = null;
        // Remember how it's turned relative to the player (TransformAnglesToPlayerSpace, yaw only).
        this.grabRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -this.ctx.view.yaw * DEG).multiply(this.rotation());
        this.grabTarget = null;
        this.grabError = 0;
        if (this.collision) this.collision.solid = false;
        this.ctx.physics.setHeld(this.rigid, true);
        this.fire('onplayerpickup', this.game.playerEntity);
    }

    drop() {
        this.held = false;
        this.heldPortal = null;
        if (this.collision) this.collision.solid = true;
        if (this.rigid) {
            this.ctx.physics.setHeld(this.rigid, false);
            // ClampPhysicsVelocity on release, so a carried object can't be flung by swinging the view.
            const body = this.rigid.body;
            const lv = body.linvel(), av = body.angvel();
            const v = new THREE.Vector3(lv.x, lv.y, lv.z), w = new THREE.Vector3(av.x, av.y, av.z);
            if (v.length() > DROP_MAX_SPEED) v.setLength(DROP_MAX_SPEED);
            if (w.length() > DROP_MAX_ANGULAR * DEG) w.setLength(DROP_MAX_ANGULAR * DEG);
            body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
            body.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
        }
        this.fire('onphysgundrop', this.game.playerEntity);
    }

    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        const r = this.rigid;
        switch (name) {
            case 'enablemotion':
                if (r) this.ctx.physics.setMotionEnabled(r, true);
                return true;
            case 'disablemotion':
                if (r) this.ctx.physics.setMotionEnabled(r, false);
                return true;
            case 'wake':
                r?.body.wakeUp();
                return true;
            case 'sleep':
                r?.body.sleep();
                return true;
        }
        return super.input(name, param, a, c);
    }

    remove() {
        this.held = false;
        if (this.rigid) {
            this.ctx.physics.removeController(this);
            this.ctx.physics.removeBody(this.rigid);
            this.rigid = null;
        }
        if (this.collision) this.ctx.collision.removeModel(this.collision);
        this.ready = false;
        super.remove();
    }
}

// ---------------------------------------------------------------- materials

/** Sets the texture frame of every material on a brush entity. */
async function setBrushFrame(e: GameEntity, frame: number, materialName?: string) {
    for (const bm of e.ctx.brushMaterials.get(e.index) ?? []) {
        if (materialName && bm.name !== materialName.toLowerCase()) continue;
        const base = bm.def?.params.$basetexture;
        if (!base) continue;
        const count = await e.ctx.textures.frameCount(base);
        const tex = await e.ctx.textures.get(base, ((Math.round(frame) % count) + count) % count);
        if (tex) bm.material.uniforms.baseTexture.value = tex;
    }
}

class EnvTextureToggle extends GameEntity {
    frame = 0;
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'settextureindex') this.frame = Number(param) || 0;
        else if (name === 'incrementtextureindex') this.frame++;
        else return super.input(name, param, a, c);
        for (const t of this.game.find(this.kv.target ?? '', a, this)) void setBrushFrame(t, this.frame);
        return true;
    }
}

/** Drives a material variable ($frame only) on its parent's materials. */
class MaterialModifyControl extends GameEntity {
    lerp: { from: number; to: number; start: number; duration: number; loop: boolean } | null = null;
    apply(frame: number) {
        if (this.parent && (this.kv.materialvar ?? '').toLowerCase() === '$frame') void setBrushFrame(this.parent, frame, this.kv.materialname);
    }
    think() {
        if (!this.lerp) return;
        const l = this.lerp;
        let t = (this.game.time - l.start) / l.duration;
        if (t >= 1) {
            if (l.loop) t %= 1;
            else {
                t = 1;
                this.lerp = null;
            }
        }
        this.apply(Math.floor(l.from + (l.to - l.from) * t));
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'setmaterialvar') {
            this.lerp = null;
            this.apply(Number(param) || 0);
            return true;
        }
        if (name === 'startfloatlerp') {
            const [from, to, duration, loop] = param.trim().split(/\s+/).map(Number);
            this.lerp = { from: from || 0, to: to || 0, start: this.game.time, duration: duration || 1, loop: !!loop };
            return true;
        }
        if (name === 'startanimsequence' || name === 'setmaterialvartoggle') return true;
        return super.input(name, param, a, c);
    }
}

// ---------------------------------------------------------------- templates

class PointTemplate extends GameEntity {
    private list: GameEntity[] = [];
    /**
     * The map's own template entities, captured at load (mapentities.cpp). Looked up later by
     * name, copies spawned with preserved names would be templated too and multiply.
     */
    spawn() {
        for (let i = 1; i <= 16; i++) {
            const name = this.kv[`template${String(i).padStart(2, '0')}`];
            if (name) this.list.push(...this.game.find(name, null, this));
        }
    }
    templates(): GameEntity[] {
        return this.list;
    }
}

/** Spawns copies of a point_template's entities at its own position. */
class EnvEntityMaker extends GameEntity {
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name !== 'forcespawn') return super.input(name, param, a, c);
        const tpl = this.game.find(this.kv.entitytemplate ?? '', null, this)[0];
        if (!(tpl instanceof PointTemplate)) return true;
        for (const src of tpl.templates()) {
            const offset: Vec3 = [src.spawnOrigin[0] - tpl.origin[0], src.spawnOrigin[1] - tpl.origin[1], src.spawnOrigin[2] - tpl.origin[2]];
            const origin: Vec3 = [this.origin[0] + offset[0], this.origin[1] + offset[1], this.origin[2] + offset[2]];
            void this.game.spawnCopy(src, origin);
        }
        this.fire('onentityspawned', this);
        return true;
    }
}

// ---------------------------------------------------------------- portals

class PropPortal extends GameEntity {
    spawn() {
        const blue = (this.kv.portaltwo ?? '0') === '0';
        this.ctx.portals.addMapPortal(this, blue ? 0 : 1, Number(this.kv.linkagegroupid) || 0);
        if (this.kv.activated === '1') this.ctx.portals.setActivatedState(this, true);
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'setactivatedstate':
                this.ctx.portals.setActivatedState(this, param.trim() === '1');
                return true;
            case 'fizzle':
                this.ctx.portals.fizzle(this);
                return true;
            case 'newlocation': {
                const v = param.trim().split(/\s+/).map(Number);
                this.origin = [v[0] || 0, v[1] || 0, v[2] || 0];
                this.angles = [v[3] || 0, v[4] || 0, v[5] || 0];
                this.ctx.portals.move(this, this.origin, this.angles);
                this.ctx.portals.setActive(this, true);
                return true;
            }
        }
        return super.input(name, param, a, c);
    }
}

/** func_noportal_volume and func_portal_bumper: brush volumes portal placement steers around. */
export class PortalPlacementVolume extends GameEntity {
    active = true;
    spawn() {
        // Spawnflag 1: start inactive (placement only honours this for no-portal volumes).
        if (this.flag(1)) this.active = false;
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'activate') this.active = true;
        else if (name === 'deactivate') this.active = false;
        else if (name === 'toggle') this.active = !this.active;
        else return super.input(name, param, a, c);
        return true;
    }
}

/** func_portal_orientation: portals placed inside face a fixed way (or their partner's). */
export class PortalOrientationVolume extends GameEntity {
    enabled = true;
    spawn() {
        this.enabled = this.kv.startdisabled !== '1';
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'enable') this.enabled = true;
        else if (name === 'disable') this.enabled = false;
        else return super.input(name, param, a, c);
        return true;
    }
}

// ---------------------------------------------------------------- registry

const make = (cls: new (g: Game, i: number, p: [string, string][]) => GameEntity): EntityFactory => (g, i, p) => new cls(g, i, p);

/**
 * npc_portal_turret_floor: a physics prop with a gun, so it can be pushed over, carried (E) and
 * dropped like a cube. Standing and not carried, it watches the cone in front of it and, once it
 * has had the player in sight for a moment, fires bursts that mostly miss. Tipped over or held it
 * is harmless. No deploy or retract animation.
 */
class FloorTurret extends PhysProp {
    enabled = true;
    seen = 0;
    lost = 0;
    nextShot = 0;
    spawn() {
        // 64: start inactive, 256: out of ammo
        this.enabled = !this.flag(64) && !this.flag(256);
        super.spawn();
    }
    /** Which way the turret faces and which way is up on it, as it sits now. */
    pose(): { forward: THREE.Vector3; up: THREE.Vector3 } {
        const q = this.rigid ? this.rotation().multiply(this.spawnRotation) : this.spawnRotation;
        return { forward: new THREE.Vector3(1, 0, 0).applyQuaternion(q), up: new THREE.Vector3(0, 0, 1).applyQuaternion(q) };
    }
    think(dt: number) {
        super.think(dt);
        if (!this.ready || !this.enabled || !this.ctx.health || this.ctx.health.dead) return;
        const { up } = this.pose();
        if (this.held || up.z < 0.8 || this.removed) {
            this.seen = 0;
            return;
        }
        if (this.canSee()) {
            this.seen += dt;
            this.lost = 0;
            if (this.seen > 0.7 && this.game.time >= this.nextShot) {
                this.nextShot = this.game.time + 0.1;
                this.emitSound('NPC_FloorTurret.ShotSounds');
                if (Math.random() < 0.35) this.ctx.health.hurt(4);
            }
        } else if ((this.lost += dt) > 1.5) {
            this.seen = 0;
        }
    }
    canSee(): boolean {
        const p = this.ctx.player;
        const eye: Vec3 = [this.origin[0], this.origin[1], this.origin[2] + 36];
        const target: Vec3 = [p.origin[0], p.origin[1], p.origin[2] + 40];
        const d: Vec3 = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
        const dist = Math.hypot(...d);
        if (dist > 1300 || dist < 1) return false;
        const f = this.pose().forward;
        const fl = Math.hypot(f.x, f.y) || 1;
        if ((d[0] * f.x + d[1] * f.y) / (dist * fl) < Math.cos((60 * Math.PI) / 180)) return false;
        // Start the look just outside the turret's own body, which is solid now.
        const out = Math.max(this.half[0], this.half[1], this.half[2]) + 2;
        const start: Vec3 = [eye[0] + (d[0] / dist) * out, eye[1] + (d[1] / dist) * out, eye[2] + (d[2] / dist) * out];
        const t = this.ctx.collision.trace(start, target, [0, 0, 0], [0, 0, 0]);
        return !t.startSolid && t.fraction > 0.97;
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'enable': this.enabled = true; return true;
            case 'disable': this.enabled = false; this.seen = 0; return true;
            case 'toggle': this.enabled = !this.enabled; this.seen = 0; return true;
            case 'selfdestruct': this.enabled = false; return true;
        }
        return super.input(name, param, a, c);
    }
}

export const ENTITY_CLASSES: Record<string, EntityFactory> = {
    logic_auto: make(LogicAuto),
    logic_relay: make(LogicRelay),
    logic_timer: make(LogicTimer),
    math_counter: make(MathCounter),
    logic_case: make(LogicCase),
    trigger_once: make(TriggerOnce),
    trigger_multiple: make(Trigger),
    trigger_teleport: make(TriggerTeleport),
    trigger_hurt: make(TriggerHurt),
    trigger_gravity: make(TriggerGravity),
    trigger_remove: make(TriggerRemove),
    trigger_autosave: make(TriggerAutosave),
    logic_autosave: make(LogicAutosave),
    logic_compare: make(LogicCompare),
    filter_activator_class: make(FilterActivatorClass),
    func_rotating: make(FuncRotating),
    func_rot_button: make(FuncRotButton),
    npc_security_camera: make(SecurityCamera),
    func_movelinear: make(FuncMoveLinear),
    prop_door_rotating: make(PropDoorRotating),
    env_hudhint: make(EnvHudHint),
    env_soundscape: make(EnvSoundscape),
    keyframe_rope: make(RopeSegment),
    move_rope: make(RopeSegment),
    trigger_push: make(TriggerPush),
    env_shake: make(EnvShake),
    func_portal_detector: make(PortalDetector),
    npc_portal_turret_floor: make(FloorTurret),
    npc_rocket_turret: make(RocketTurret),
    point_energy_ball_launcher: make(EnergyBallLauncher),
    trigger_look: make(TriggerLook),
    trigger_portal_cleanser: make(TriggerPortalCleanser),
    trigger_changelevel: make(TriggerChangeLevel),
    filter_activator_name: make(FilterName),
    filter_combineball_type: make(FilterBallType),
    func_brush: make(FuncBrush),
    func_wall: make(FuncBrush),
    func_wall_toggle: make(FuncBrush),
    func_illusionary: make(FuncBrush),
    func_door: make(FuncDoor),
    func_door_rotating: make(FuncDoorRotating),
    weapon_portalgun: make(WeaponPortalgun),
    func_tracktrain: make(FuncTrackTrain),
    prop_dynamic: make(PropDynamic),
    prop_dynamic_override: make(PropDynamic),
    prop_physics: make(PhysProp),
    prop_physics_override: make(PhysProp),
    prop_physics_multiplayer: make(PhysProp),
    prop_physics_respawnable: make(PhysProp),
    env_texturetoggle: make(EnvTextureToggle),
    material_modify_control: make(MaterialModifyControl),
    point_template: make(PointTemplate),
    env_entity_maker: make(EnvEntityMaker),
    prop_portal: make(PropPortal),
    ambient_generic: make(AmbientGeneric),
    logic_choreographed_scene: make(LogicChoreographedScene),
    point_viewcontrol: make(PointViewControl),
    info_particle_system: make(InfoParticleSystem),
    env_fade: make(EnvFade),
    env_tonemap_controller: make(EnvTonemapController),
    logic_scene_list_manager: make(GameEntity),
    func_noportal_volume: make(PortalPlacementVolume),
    func_portal_bumper: make(PortalPlacementVolume),
    func_portal_orientation: make(PortalOrientationVolume),
    ...FX_CLASSES,
};

export function entityFactory(cls: string): EntityFactory | undefined {
    return ENTITY_CLASSES[cls];
}
