// The map's old-style effect entities: env_steam, env_spark, env_explosion, env_splash, env_fire,
// env_smokestack, func_smokevolume, env_shooter, env_physexplosion, env_beam, env_sprite and
// point_spotlight. Behaviour follows the SDK's server and client code; the looks are made from the
// game's particle materials (src/particles/envfx.ts) or drawn by the fx layer.
import type { ParticleEffect } from '../render/particles';
import type { BeamHandle, SpriteHandle } from '../render/fxlayer';
import { spriteMaterialName } from '../render/fxlayer';
import { flashDef, fireballDef, jetDef, smokeDef, smokeVolumeDef, sparkDef } from '../particles/envfx';
import type { ParticleDef } from '../particles/pcf';
import type { Vec3 } from '../physics/collision';
import { GameEntity, type EntityFactory, type Game } from './game';
import { angleVector, PhysProp } from './classes';

const make = (cls: new (g: Game, i: number, p: [string, string][]) => GameEntity): EntityFactory => (g, i, p) => new cls(g, i, p);

const num = (s: string | undefined, d = 0) => {
    const n = Number(s);
    return s !== undefined && s !== '' && Number.isFinite(n) ? n : d;
};
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const upOf = (a: Vec3) => angleVector([a[0] - 90, a[1], a[2]]);

/** "r g b" 0-255 to 0-1. */
function renderColor(e: GameEntity): [number, number, number] {
    const c = (e.kv.rendercolor ?? '255 255 255').trim().split(/\s+/).map(Number);
    return [(c[0] ?? 255) / 255, (c[1] ?? 255) / 255, (c[2] ?? 255) / 255];
}

/** Effects further than this from the player aren't run. */
const RANGE = 3200;

function nearPlayer(e: GameEntity, range = RANGE): boolean {
    const p = e.ctx.particles?.playerPos?.();
    if (!p) return true;
    return Math.hypot(p[0] - e.origin[0], p[1] - e.origin[1], p[2] - e.origin[2]) < range;
}

/**
 * An effect that runs while the entity is on and the player is near: a system started and stopped
 * as that changes, following the entity.
 */
abstract class RunningEffect extends GameEntity {
    protected on = false;
    private fx: ParticleEffect | null = null;
    private near = true;

    /** The system to run, or a promise of one; null if there's nothing to draw. */
    protected abstract build(): ParticleDef | Promise<ParticleDef | null> | null;
    protected frame(): [Vec3, Vec3] {
        return [angleVector(this.angles), upOf(this.angles)];
    }

    private starting = false;
    private async start() {
        const pm = this.ctx.particles;
        if (!pm || this.fx || this.starting) return;
        this.starting = true;
        const def = await this.build();
        this.starting = false;
        if (!def || !this.on || this.removed || this.fx) return;
        const [f, u] = this.frame();
        this.fx = pm.spawnDef(def, [...this.origin], f, u);
    }

    private halt() {
        this.fx?.stop();
        this.fx = null;
    }

    think(_dt: number) {
        const want = this.on && !this.removed;
        // Hysteresis, so standing at the edge doesn't flicker it.
        this.near = nearPlayer(this, this.near ? RANGE * 1.15 : RANGE);
        if (want && this.near) {
            if (!this.fx) void this.start();
        } else if (this.fx) {
            this.halt();
        }
        if (this.fx) {
            if (this.fx.done) this.fx = null;
            else {
                const [f, u] = this.frame();
                this.fx.setControlPoint(0, this.origin, f, u);
            }
        }
    }

    protected setOn(on: boolean) {
        this.on = on;
    }

    remove() {
        this.on = false;
        this.fx?.kill();
        this.fx = null;
        super.remove();
    }

    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'turnon': this.setOn(true); return true;
            case 'turnoff': this.setOn(false); return true;
            case 'toggle': this.setOn(!this.on); return true;
            default: return super.input(name, param, a, c);
        }
    }
}

// ---------------------------------------------------------------- steam and smoke

/** env_steam: a jet of puffs (CSteamJet). */
class EnvSteam extends RunningEffect {
    spawn() {
        this.on = this.kv.initialstate === '1';
    }
    protected build() {
        const k = this.kv;
        return jetDef('env_steam', {
            speed: num(k.speed, 120),
            spread: num(k.spreadspeed, 15),
            rate: num(k.rate, 26),
            length: num(k.jetlength, 80),
            startSize: num(k.startsize, 10),
            endSize: num(k.endsize, 25),
            roll: num(k.rollspeed, 8),
            alpha: Math.min(1, num(k.renderamt, 255) / 255) * 0.5,
        });
    }
}

/** env_smokestack: smoke rising from a base (CSmokeStack). */
class EnvSmokeStack extends RunningEffect {
    spawn() {
        this.on = this.kv.initialstate === '1';
    }
    protected frame(): [Vec3, Vec3] {
        // The stack always points up, whatever its angles.
        return [[0, 0, 1], [1, 0, 0]];
    }
    protected build() {
        const k = this.kv;
        const c = renderColor(this);
        return jetDef('env_smokestack', {
            speed: num(k.speed, 30),
            spread: num(k.spreadspeed, 15),
            rate: num(k.rate, 20),
            length: num(k.jetlength, 180),
            startSize: num(k.startsize, 20),
            endSize: num(k.endsize, 30),
            roll: num(k.roll, 0),
            baseSpread: num(k.basespread, 20),
            alpha: Math.min(1, num(k.renderamt, 255) / 255) * 0.6,
            color: [c[0] * 255, c[1] * 255, c[2] * 255],
        });
    }
}

/** func_smokevolume: haze filling the brush's box (the smoke grenade volume). */
class FuncSmokeVolume extends RunningEffect {
    spawn() {
        this.on = true;
    }
    protected build() {
        const b = this.brushBounds();
        if (!b) return null;
        const half: Vec3 = [(b.maxs[0] - b.mins[0]) / 2, (b.maxs[1] - b.mins[1]) / 2, (b.maxs[2] - b.mins[2]) / 2];
        this.origin = [(b.maxs[0] + b.mins[0]) / 2, (b.maxs[1] + b.mins[1]) / 2, (b.maxs[2] + b.mins[2]) / 2];
        const spacing = Math.max(8, num(this.kv.particlespacingdistance, 32));
        const volume = half[0] * half[1] * half[2] * 8 / (spacing * spacing * spacing);
        const c1 = (this.kv.color1 ?? '255 255 255').trim().split(/\s+/).map(Number);
        return smokeVolumeDef('func_smokevolume', half, num(this.kv.particledrawwidth, 80), Math.min(40, Math.max(3, volume / 5)), [c1[0] ?? 255, c1[1] ?? 255, c1[2] ?? 255]);
    }
}

// ---------------------------------------------------------------- one-shot bursts

/** Anything that plays a burst: shared sound and spawn helpers. */
abstract class Burster extends GameEntity {
    protected burst(def: ParticleDef, at: Vec3 = this.origin, fwd?: Vec3, up?: Vec3): ParticleEffect | null {
        return this.ctx.particles?.spawnDef(def, [...at], fwd, up) ?? null;
    }
}

/** env_spark: sparks at the origin, once or repeatedly. */
class EnvSpark extends Burster {
    private running = false;
    private next = 0;
    private delay = 1;
    private elapsed = 0;
    spawn() {
        this.delay = num(this.kv.maxdelay, 0);
        if (this.delay <= 0) this.delay = 1;
        this.running = this.flag(64);
        this.next = 0.1 + Math.random() * 1.5;
    }
    private spark() {
        const magnitude = num(this.kv.magnitude, 1);
        const trail = num(this.kv.traillength, 1);
        const directional = this.flag(512);
        const f = angleVector(this.angles), u = upOf(this.angles);
        const def = sparkDef('env_spark', magnitude, trail, directional);
        if (nearPlayer(this)) {
            this.burst(def, this.origin, f, u);
            if (this.flag(128)) this.burst(flashDef('env_spark_glow', 6 + magnitude * 3, 0.15, [1 * 255, 0.8 * 255, 0.5 * 255]));
            if (!this.flag(256)) this.emitSound('DoSpark');
        }
    }
    think(dt: number) {
        if (!this.running || this.removed) return;
        this.elapsed += dt;
        if (this.elapsed < this.next) return;
        this.elapsed = 0;
        this.next = 0.1 + Math.random() * this.delay;
        this.spark();
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'startspark': this.running = true; this.next = 0; return true;
            case 'stopspark': this.running = false; return true;
            case 'togglespark': this.running = !this.running; this.next = 0; return true;
            case 'sparkonce': this.spark(); return true;
            default: return super.input(name, param, a, c);
        }
    }
}

/** env_explosion: fireball, smoke and sparks. */
class EnvExplosion extends Burster {
    private fired = false;
    private explode() {
        if (this.fired && !this.flag(2)) return;
        this.fired = true;
        const magnitude = Math.max(10, num(this.kv.imagnitude, 100));
        const pm = this.ctx.particles;
        if (!pm) return;
        const at = this.origin;
        const flags = Number(this.kv.spawnflags) || 0;
        if (!(flags & 4)) {
            this.burst(flashDef('explosion_flash', magnitude * 1.6, 0.35, [255, 220, 150], 1.6));
            this.burst(fireballDef('explosion_fire', magnitude), at);
        }
        if (!(flags & 8)) this.burst(smokeDef('explosion_smoke', magnitude * 0.5, 10, 2.8, 30), [at[0], at[1], at[2] + magnitude * 0.2]);
        if (!(flags & 32)) this.burst(sparkDef('explosion_sparks', magnitude / 25, 2, false), at);
        if (!(flags & 64)) this.emitSound('BaseGrenade.Explode');
        this.fire('onexplode', this);
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name === 'explode') {
            this.explode();
            return true;
        }
        return super.input(name, param, a, c);
    }
}

/** env_splash: a splash of water on the Splash input. */
class EnvSplash extends Burster {
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name !== 'splash') return super.input(name, param, a, c);
        const scale = num(this.kv.scale, 8);
        void (async () => {
            const pm = this.ctx.particles;
            if (!pm) return;
            const def = await pm.find(scale >= 6 ? 'water_splash_01' : 'water_splash_02');
            if (def) pm.spawnDef(def, [...this.origin], [0, 0, 1], [1, 0, 0]);
        })();
        return true;
    }
}

/** env_fire: a fire of the game's own env_fire_* systems; the size picks which. */
class EnvFire extends GameEntity {
    private fx: ParticleEffect[] = [];
    private lit = false;
    private nextBurn = 0;
    spawn() {
        if (this.flag(1)) void this.light();
    }
    /** Standing in a lit fire burns: about 10 a second, in a box the size of the flames. */
    think() {
        const health = this.ctx.health;
        if (!this.lit || !health || this.game.time < this.nextBurn) return;
        const size = num(this.kv.firesize, 64);
        const p = this.ctx.player.origin;
        if (Math.hypot(p[0] - this.origin[0], p[1] - this.origin[1]) > size * 0.4 + 16) return;
        if (p[2] > this.origin[2] + size || p[2] + 72 < this.origin[2]) return;
        this.nextBurn = this.game.time + 0.25;
        health.hurt(2.5 * (num(this.kv.damagescale, 1) || 1));
    }
    private async light() {
        const pm = this.ctx.particles;
        if (!pm || this.lit) return;
        this.lit = true;
        const size = num(this.kv.firesize, 64);
        const tier = size <= 24 ? 'tiny' : size <= 48 ? 'small' : size <= 96 ? 'medium' : 'large';
        const names = [`env_fire_${tier}`];
        if (!this.flag(4)) names.push(`env_fire_${tier}_smoke`);
        for (const n of names) {
            const fx = await pm.spawn(n, [...this.origin], [0, 0, 1], [1, 0, 0]);
            if (fx) this.fx.push(fx);
        }
        if (!this.lit) this.snuff();
    }
    private snuff() {
        this.lit = false;
        for (const f of this.fx) f.stop();
        this.fx = [];
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'startfire': void this.light(); return true;
            case 'extinguish': case 'extinguishtemporary': this.snuff(); return true;
            default: return super.input(name, param, a, c);
        }
    }
    remove() {
        this.snuff();
        super.remove();
    }
}

// ---------------------------------------------------------------- physics

/** env_physexplosion: shoves physics props away from the origin. */
class EnvPhysExplosion extends GameEntity {
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name !== 'explode') return super.input(name, param, a, c);
        const magnitude = num(this.kv.magnitude, 100);
        const radius = num(this.kv.radius, 0) || magnitude * 4;
        const only = this.kv.targetentityname ? new Set(this.game.find(this.kv.targetentityname, a, c)) : null;
        for (const e of this.game.entities) {
            if (e.removed || !(e instanceof PhysProp) || !e.rigid) continue;
            if (only && !only.has(e)) continue;
            const body = e.rigid.body;
            const t = body.translation();
            const d: Vec3 = [t.x - this.origin[0], t.y - this.origin[1], t.z - this.origin[2]];
            const dist = Math.hypot(...d);
            if (!only && dist > radius) continue;
            const falloff = only ? 1 : 1 - dist / radius;
            const n = dist > 1 ? d : [0, 0, 1];
            const l = Math.hypot(n[0], n[1], n[2]) || 1;
            // A change of speed, so heavy and light props fly alike; props get a lift too.
            const dv = magnitude * 9 * falloff;
            const m = body.mass();
            body.applyImpulse({ x: (n[0] / l) * dv * m, y: (n[1] / l) * dv * m, z: ((n[2] / l) * 0.7 + 0.5) * dv * m }, true);
            body.applyTorqueImpulse({ x: rand(-1, 1) * dv * m * 4, y: rand(-1, 1) * dv * m * 4, z: rand(-1, 1) * dv * m * 4 }, true);
        }
        return true;
    }
}

/** env_shooter: throws a model on the Shoot input. */
class EnvShooter extends GameEntity {
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        if (name !== 'shoot') return super.input(name, param, a, c);
        void this.shoot();
        return true;
    }
    private async shoot() {
        const model = this.kv.shootmodel;
        if (!model) return;
        const count = Math.max(1, num(this.kv.m_igibs, 1));
        for (let i = 0; i < count; i++) {
            const speed = num(this.kv.m_flvelocity, 200) + rand(-1, 1) * num(this.kv.m_flvariance, 0);
            const dir = angleVector(this.angles);
            const index = this.game.allocIndex();
            const g = (this.kv.gibangles ?? '0 0 0').trim().split(/\s+/).map(Number);
            const angles: Vec3 = [g[0] ?? 0, g[1] ?? 0, g[2] ?? 0];
            const pairs: [string, string][] = [
                ['classname', 'prop_physics'], ['model', model], ['origin', this.origin.join(' ')], ['angles', angles.join(' ')],
                ['spawnflags', '0'], ['skin', this.kv.skin ?? '0'],
            ];
            const inst = { model, origin: [...this.origin] as Vec3, angles, skin: num(this.kv.skin), body: 0, solid: true, entityIndex: index };
            const e = await this.game.spawnProp(index, pairs, inst);
            const life = num(this.kv.m_flgiblife, 10);
            // The model needs a moment to get its body; then it's thrown.
            for (let t = 0; t < 40 && e instanceof PhysProp && !e.rigid; t++) await new Promise((r) => setTimeout(r, 50));
            if (e instanceof PhysProp && e.rigid) {
                const spin = num(this.kv.gibanglevelocity, 0);
                e.rigid.body.setLinvel({ x: dir[0] * speed, y: dir[1] * speed, z: dir[2] * speed }, true);
                e.rigid.body.setAngvel({ x: rand(-spin, spin) * 0.0175, y: rand(-spin, spin) * 0.0175, z: rand(-spin, spin) * 0.0175 }, true);
            }
            if (life > 0) setTimeout(() => { if (!e.removed) e.remove(); }, life * 1000);
            this.fire('onshoot', this);
        }
    }
}

// ---------------------------------------------------------------- beams and sprites

/** env_sprite: a glow or halo. */
class EnvSprite extends GameEntity {
    private sprite: SpriteHandle | null = null;
    private shown = false;
    private last: Vec3 = [NaN, 0, 0];
    spawn() {
        const fx = this.ctx.fx;
        if (!fx || !this.kv.model) return;
        const mode = num(this.kv.rendermode, 0);
        const amt = num(this.kv.renderamt, 255) / 255;
        this.shown = this.flag(1);
        this.sprite = fx.sprite({
            material: spriteMaterialName(this.kv.model),
            pos: [...this.origin],
            scale: num(this.kv.scale, 1),
            color: renderColor(this),
            alpha: amt,
            renderMode: mode,
        });
        this.sprite.visible = this.shown;
        this.last = [...this.origin];
    }
    think(_dt: number) {
        if (!this.sprite) return;
        const o = this.origin;
        if (o[0] !== this.last[0] || o[1] !== this.last[1] || o[2] !== this.last[2]) {
            this.sprite.setPos(o);
            this.last = [...o];
        }
    }
    remove() {
        this.sprite?.remove();
        this.sprite = null;
        super.remove();
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'showsprite': this.shown = true; break;
            case 'hidesprite': this.shown = false; break;
            case 'togglesprite': this.shown = !this.shown; break;
            default: return super.input(name, param, a, c);
        }
        if (this.sprite) this.sprite.visible = this.shown;
        return true;
    }
}

/** env_beam: a laser or lightning between two entities. */
class EnvBeam extends GameEntity {
    private beam: BeamHandle | null = null;
    private on = false;
    private startTarget: GameEntity | null = null;
    private endTarget: GameEntity | null = null;
    private offTime = Infinity;
    spawn() {
        const fx = this.ctx.fx;
        if (!fx) return;
        const k = this.kv;
        const width = Math.max(1, num(k.boltwidth, 4));
        const c = renderColor(this);
        const noise = num(k.noiseamplitude, 0);
        this.beam = fx.beam({
            material: spriteMaterialName(k.texture ?? 'effects/laser1.vmt'),
            from: [...this.origin],
            to: [...this.origin],
            width,
            color: c,
            alpha: num(k.renderamt, 255) / 255,
            additive: true,
            tile: Math.max(32, width * 8),
            scroll: num(k.texturescroll, 0) / 10,
            noise,
        });
        this.beam.visible = false;
        this.on = this.flag(1);
        this.offTime = this.on && num(k.life, 0) > 0 ? num(k.life) : Infinity;
    }
    private point(name: string | undefined, cached: GameEntity | null): GameEntity | null {
        if (cached && !cached.removed) return cached;
        return name ? this.game.find(name, null, this)[0] ?? null : null;
    }
    think(dt: number) {
        const b = this.beam;
        if (!b) return;
        if (this.on && this.offTime !== Infinity) {
            this.offTime -= dt;
            if (this.offTime <= 0) this.on = false;
        }
        const want = this.on && nearPlayer(this, 5000);
        b.visible = want;
        if (!want) return;
        this.startTarget = this.point(this.kv.lightningstart, this.startTarget);
        this.endTarget = this.point(this.kv.lightningend, this.endTarget);
        b.from = [...(this.startTarget ?? this).origin];
        b.to = [...(this.endTarget ?? this).origin];
    }
    remove() {
        this.beam?.remove();
        this.beam = null;
        super.remove();
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        const life = num(this.kv.life, 0);
        switch (name) {
            case 'turnon': this.on = true; this.offTime = Infinity; return true;
            case 'turnoff': this.on = false; return true;
            case 'toggle': this.on = !this.on; this.offTime = Infinity; return true;
            case 'strikeonce': this.on = true; this.offTime = life > 0 ? life : 0.5; return true;
            default: return super.input(name, param, a, c);
        }
    }
}

/** point_spotlight: a cone of light with a halo where it starts and a glow where it lands. */
class PointSpotlight extends GameEntity {
    private beam: BeamHandle | null = null;
    private halo: SpriteHandle | null = null;
    private end: SpriteHandle | null = null;
    private on = false;
    private placed = '';
    spawn() {
        const fx = this.ctx.fx;
        if (!fx) return;
        const c = renderColor(this);
        const bright = (num(this.kv.renderamt, 255) / 255) * Math.min(1.5, num(this.kv.hdrcolorscale, 1));
        const width = num(this.kv.spotlightwidth, 50);
        this.beam = fx.beam({
            material: 'sprites/glow_test02.vmt',
            from: [...this.origin], to: [...this.origin],
            width: Math.max(4, width * 0.15), endWidth: width,
            color: c, alpha: 0.5 * bright, endAlpha: 0.1 * bright, additive: true,
        });
        this.halo = fx.sprite({ material: 'sprites/light_glow03.vmt', pos: [...this.origin], scale: 1, size: Math.max(16, width * 0.8), color: c, alpha: 0.7 * bright, renderMode: 5 });
        this.end = fx.sprite({ material: 'sprites/light_glow03.vmt', pos: [...this.origin], scale: 1, size: Math.max(24, width * 1.2), color: c, alpha: 0.25 * bright, renderMode: 5 });
        this.on = this.flag(1);
        this.apply();
    }
    private apply() {
        if (this.beam) this.beam.visible = this.on;
        if (this.halo) this.halo.visible = this.on;
        if (this.end) this.end.visible = this.on;
    }
    think(_dt: number) {
        if (!this.beam || !this.on) return;
        const key = this.origin.join(',') + '|' + this.angles.join(',');
        if (key === this.placed) return;
        this.placed = key;
        const dir = angleVector(this.angles);
        const length = num(this.kv.spotlightlength, 256);
        const to: Vec3 = [this.origin[0] + dir[0] * length, this.origin[1] + dir[1] * length, this.origin[2] + dir[2] * length];
        const hit = this.ctx.particles?.trace?.(this.origin, to) ?? null;
        const end = hit ? hit.end : to;
        this.beam.from = [...this.origin];
        this.beam.to = [...end];
        this.halo?.setPos(this.origin);
        // The glow lifts off the surface a little so it doesn't sink into it.
        this.end?.setPos(hit ? [end[0] + hit.normal[0] * 2, end[1] + hit.normal[1] * 2, end[2] + hit.normal[2] * 2] : end);
        if (this.end) this.end.visible = !!hit;
    }
    remove() {
        this.beam?.remove();
        this.halo?.remove();
        this.end?.remove();
        super.remove();
    }
    input(name: string, param: string, a: GameEntity | null, c: GameEntity | null): boolean {
        switch (name) {
            case 'lighton': this.on = true; this.placed = ''; this.apply(); return true;
            case 'lightoff': this.on = false; this.apply(); return true;
            default: return super.input(name, param, a, c);
        }
    }
}

export const FX_CLASSES: Record<string, EntityFactory> = {
    env_steam: make(EnvSteam),
    env_smokestack: make(EnvSmokeStack),
    func_smokevolume: make(FuncSmokeVolume),
    env_spark: make(EnvSpark),
    env_explosion: make(EnvExplosion),
    env_splash: make(EnvSplash),
    env_fire: make(EnvFire),
    env_physexplosion: make(EnvPhysExplosion),
    env_shooter: make(EnvShooter),
    env_sprite: make(EnvSprite),
    env_beam: make(EnvBeam),
    point_spotlight: make(PointSpotlight),
};
