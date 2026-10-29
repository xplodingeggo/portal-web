// Systems for the map's old-style effect entities (env_steam, env_spark, env_explosion, ...), which
// the game drew with its legacy particle code rather than .pcf files. Each is built from the same
// operators the game files use; the numbers follow the SDK's client effects.
import { makeDef, op } from './build';
import type { ParticleDef } from './pcf';

const SMOKE = 'particle/particle_smokegrenade';
const GLOW = 'sprites/light_glow03';

const fade = (inFrac: number, outFrac: number) => [
    op('Alpha Fade In Random', { 'fade in time min': inFrac, 'fade in time max': inFrac, 'proportional 0/1': true }),
    op('Alpha Fade Out Random', { 'fade out time min': outFrac, 'fade out time max': outFrac, 'proportional 0/1': true, 'ease in and out': true }),
];

export interface JetOpts {
    speed: number;
    spread: number;
    rate: number;
    length: number;
    startSize: number;
    endSize: number;
    roll: number;
    /** 0..1 peak opacity. */
    alpha: number;
    /** Radius of the disc the particles start in (env_smokestack). */
    baseSpread?: number;
    color?: [number, number, number];
}

/** env_steam / env_smokestack: puffs thrown along control point 0's forward, growing as they go. */
export function jetDef(name: string, o: JetOpts): ParticleDef {
    const life = Math.max(0.2, o.length / Math.max(1, o.speed));
    const c = o.color ?? [255, 255, 255];
    return makeDef(name, {
        material: SMOKE,
        radius: o.startSize,
        maxParticles: Math.ceil(o.rate * life) + 8,
        emitters: [op('emit_continuously', { emission_rate: o.rate })],
        initializers: [
            op('Lifetime Random', { lifetime_min: life, lifetime_max: life }),
            op('Radius Random', { radius_min: o.startSize, radius_max: o.startSize }),
            op('Alpha Random', { alpha_min: o.alpha * 255, alpha_max: o.alpha * 255 }),
            op('Color Random', { color1: [c[0] * 0.88, c[1] * 0.88, c[2] * 0.88], color2: c }),
            op('Rotation Random', { rotation_offset_min: 0, rotation_offset_max: 360 }),
            op('Position Within Sphere Random', {
                control_point_number: 0,
                distance_min: 0,
                distance_max: o.baseSpread ?? 0,
                distance_bias: [1, 1, 0],
                'bias in local system': true,
                speed_in_local_coordinate_system_min: [o.speed, -o.spread, -o.spread],
                speed_in_local_coordinate_system_max: [o.speed, o.spread, o.spread],
            }),
        ],
        operators: [
            op('Movement Basic'),
            op('Lifespan Decay'),
            op('Radius Scale', { radius_start_scale: 1, radius_end_scale: o.endSize / Math.max(0.1, o.startSize), ease_in_and_out: false }),
            op('Rotation Spin Roll', { spin_rate_degrees: o.roll * 8, spin_rate_min: o.roll * 8 }),
            ...fade(0.2, 0.6),
        ],
    });
}

/** A short flash of light: one soft sprite that swells and fades. */
export function flashDef(name: string, radius: number, life: number, color: [number, number, number], grow = 1.5): ParticleDef {
    return makeDef(name, {
        material: GLOW,
        additive: true,
        radius,
        maxParticles: 4,
        emitters: [op('emit_instantaneously', { num_to_emit: 1 })],
        initializers: [
            op('Lifetime Random', { lifetime_min: life, lifetime_max: life }),
            op('Radius Random', { radius_min: radius, radius_max: radius }),
            op('Color Random', { color1: color, color2: color }),
        ],
        operators: [
            op('Lifespan Decay'),
            op('Radius Scale', { radius_start_scale: 0.6, radius_end_scale: grow }),
            op('Alpha Fade Out Random', { 'fade out time min': 1, 'fade out time max': 1, 'proportional 0/1': true, 'ease in and out': false }),
        ],
    });
}

/** env_spark / the sparks of an explosion: bright streaks that fall and bounce. */
export function sparkDef(name: string, magnitude: number, trail: number, directional: boolean): ParticleDef {
    const n = 6 + Math.round(magnitude * 6);
    return makeDef(name, {
        material: 'effects/spark',
        additive: true,
        radius: 1,
        maxParticles: n + 8,
        emitters: [op('emit_instantaneously', { num_to_emit: n })],
        initializers: [
            op('Lifetime Random', { lifetime_min: 0.35, lifetime_max: 0.9 }),
            op('Radius Random', { radius_min: 0.5, radius_max: 1.1 }),
            op('Color Random', { color1: [255, 170, 80], color2: [255, 245, 190] }),
            op('Trail Length Random', { length_min: 0.03 * (1 + trail), length_max: 0.06 * (1 + trail) }),
            directional
                ? op('Position Within Sphere Random', { control_point_number: 0, distance_min: 0, distance_max: 0, speed_in_local_coordinate_system_min: [60, -35, -35], speed_in_local_coordinate_system_max: [170, 35, 35] })
                : op('Position Within Sphere Random', { control_point_number: 0, distance_min: 0, distance_max: 0, speed_min: 50, speed_max: 160, speed_in_local_coordinate_system_min: [0, 0, 30], speed_in_local_coordinate_system_max: [0, 0, 90] }),
        ],
        operators: [
            op('Movement Basic', { gravity: [0, 0, -520], drag: 0.01 }),
            op('Lifespan Decay'),
            op('Alpha Fade Out Random', { 'fade out time min': 0.4, 'fade out time max': 0.4, 'proportional 0/1': true, 'ease in and out': false }),
        ],
        constraints: [op('collision via traces', { 'amount of bounce': 0.45, 'amount of slide': 0.15, 'radius scale': 1 })],
        renderers: [op('render_sprite_trail', { 'min length': 2, 'max length': 36 })],
    });
}

/** env_explosion's fireball: hot sprites thrown outward that cool and fade. */
export function fireballDef(name: string, magnitude: number): ParticleDef {
    const r = Math.max(12, magnitude * 0.5);
    return makeDef(name, {
        material: 'effects/fire_cloud1',
        additive: true,
        radius: r,
        maxParticles: 40,
        emitters: [op('emit_instantaneously', { num_to_emit: 18 })],
        initializers: [
            op('Lifetime Random', { lifetime_min: 0.4, lifetime_max: 0.85 }),
            op('Radius Random', { radius_min: r * 0.6, radius_max: r * 1.1 }),
            op('Color Random', { color1: [255, 150, 60], color2: [255, 230, 150] }),
            op('Rotation Random', { rotation_offset_min: 0, rotation_offset_max: 360 }),
            op('Position Within Sphere Random', { control_point_number: 0, distance_min: 0, distance_max: r * 0.4, speed_min: 0, speed_max: magnitude * 0.9 }),
        ],
        operators: [
            op('Movement Basic', { drag: 0.12 }),
            op('Lifespan Decay'),
            op('Radius Scale', { radius_start_scale: 0.7, radius_end_scale: 1.8 }),
            op('Color Fade', { color_fade: [90, 40, 20], fade_start_time: 0.2, fade_end_time: 1 }),
            op('Alpha Fade Out Random', { 'fade out time min': 0.6, 'fade out time max': 0.6, 'proportional 0/1': true }),
        ],
    });
}

/** The smoke that hangs after an explosion (and the haze of func_smokevolume). */
export function smokeDef(name: string, radius: number, count: number, life: number, rise: number, color: [number, number, number] = [150, 150, 150]): ParticleDef {
    return makeDef(name, {
        material: SMOKE,
        radius,
        maxParticles: count + 8,
        emitters: [op('emit_instantaneously', { num_to_emit: count })],
        initializers: [
            op('Lifetime Random', { lifetime_min: life * 0.7, lifetime_max: life }),
            op('Radius Random', { radius_min: radius * 0.7, radius_max: radius * 1.2 }),
            op('Alpha Random', { alpha_min: 120, alpha_max: 190 }),
            op('Color Random', { color1: color, color2: [color[0] * 0.7, color[1] * 0.7, color[2] * 0.7] }),
            op('Rotation Random', { rotation_offset_min: 0, rotation_offset_max: 360 }),
            op('Position Within Sphere Random', { control_point_number: 0, distance_min: 0, distance_max: radius * 0.6, speed_min: 5, speed_max: radius * 0.8, speed_in_local_coordinate_system_min: [0, 0, rise * 0.5], speed_in_local_coordinate_system_max: [0, 0, rise] }),
        ],
        operators: [
            op('Movement Basic', { drag: 0.04 }),
            op('Lifespan Decay'),
            op('Radius Scale', { radius_start_scale: 0.8, radius_end_scale: 1.8 }),
            ...fade(0.1, 0.6),
        ],
    });
}

/** func_smokevolume: slow haze filling a box (given by half-extents around control point 0). */
export function smokeVolumeDef(name: string, half: [number, number, number], drawWidth: number, rate: number, color: [number, number, number]): ParticleDef {
    const life = 5;
    return makeDef(name, {
        material: SMOKE,
        radius: drawWidth / 2,
        maxParticles: Math.ceil(rate * life) + 8,
        emitters: [op('emit_continuously', { emission_rate: rate })],
        initializers: [
            op('Lifetime Random', { lifetime_min: life * 0.8, lifetime_max: life }),
            op('Radius Random', { radius_min: drawWidth * 0.4, radius_max: drawWidth * 0.6 }),
            op('Alpha Random', { alpha_min: 70, alpha_max: 110 }),
            op('Color Random', { color1: color, color2: [color[0] * 0.85, color[1] * 0.85, color[2] * 0.85] }),
            op('Rotation Random', { rotation_offset_min: 0, rotation_offset_max: 360 }),
            op('Position Within Box Random', { 'control point number': 0, min: [-half[0], -half[1], -half[2]], max: half }),
        ],
        operators: [op('Movement Basic'), op('Lifespan Decay'), ...fade(0.3, 0.4)],
    });
}
