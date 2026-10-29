// A map for looking at the effect entities: `map particle_test` in the developer console. It is a
// stock map's empty room with its own entity list, so nothing here needs a BSP built for it.
import type { Vec3 } from '../physics/collision';

export const PARTICLE_TEST_MAP = 'particle_test';

/** The stock map whose room is used, and a floor point with 1100 units of clear space around it and 400 above. */
const BASE_MAP = 'testchmb_a_00';
const FLOOR: Vec3 = [-3984, 1264, 130];


const ent = (cls: string, origin: Vec3, kv: Record<string, string> = {}, outputs: [string, string][] = []): string => {
    const lines = [`"classname" "${cls}"`, `"origin" "${origin.join(' ')}"`];
    for (const [k, v] of Object.entries(kv)) lines.push(`"${k}" "${v}"`);
    for (const [k, v] of outputs) lines.push(`"${k}" "${v}"`);
    return `{\n${lines.join('\n')}\n}`;
};

/** Fires `input` on `target` every `seconds`. */
const every = (name: string, at: Vec3, seconds: number, target: string, input: string) =>
    ent('logic_timer', at, { targetname: name, refiretime: String(seconds), startdisabled: '0' }, [['OnTimer', `${target},${input},,0,-1`]]);

export interface ParticleTestMap {
    base: string;
    /** The entity lump: the base map's worldspawn plus the test entities. */
    entities(baseText: string): string;
    /** One line per row, nearest first, for the console. */
    labels: string[];
}

export function particleTestMap(): ParticleTestMap {
    const labels: string[] = [];
    const out: string[] = [];
    const at = (col: number, row: number, z = 0): Vec3 => [FLOOR[0] + (col - 3) * 170, FLOOR[1] + 260 + row * 230, FLOOR[2] + z];
    let timers = 0;
    const timer = (p: Vec3, seconds: number, target: string, input: string) => out.push(every(`t${timers++}`, p, seconds, target, input));

    // Row 0: jets and fires.
    labels.push('row 1: env_steam, env_steam (big), env_smokestack, env_fire tiny / small / medium / large');
    out.push(ent('env_steam', at(0, 0, 8), { targetname: 'steam1', angles: '-90 0 0', initialstate: '1', speed: '120', spreadspeed: '15', rate: '26', jetlength: '80', startsize: '10', endsize: '25', rollspeed: '8', renderamt: '255' }));
    out.push(ent('env_steam', at(1, 0, 8), { targetname: 'steam2', angles: '-90 0 0', initialstate: '1', speed: '150', spreadspeed: '25', rate: '30', jetlength: '200', startsize: '16', endsize: '50', rollspeed: '8', renderamt: '255' }));
    out.push(ent('env_smokestack', at(2, 0, 8), { targetname: 'stack', initialstate: '1', basespread: '20', speed: '30', spreadspeed: '15', rate: '20', jetlength: '180', startsize: '20', endsize: '30', rendercolor: '120 120 120', renderamt: '255' }));
    ['24', '48', '96', '192'].forEach((size, i) => out.push(ent('env_fire', at(3 + i, 0, 8), { targetname: `fire${i}`, firesize: size, spawnflags: '1', fireattack: '4', health: '30' })));

    // Row 1: sparks, explosions, splashes.
    labels.push('row 2: env_spark x3 (magnitude 1, 2, 5), env_spark (directional), env_explosion (big / small, repeat), env_splash');
    [1, 2, 5].forEach((m, i) => out.push(ent('env_spark', at(i, 1, 60), { magnitude: String(m), traillength: String(m), maxdelay: '1.2', spawnflags: '192' })));
    out.push(ent('env_spark', at(3, 1, 30), { angles: '-60 0 0', magnitude: '3', traillength: '2', maxdelay: '1', spawnflags: '576' }));
    out.push(ent('env_explosion', at(4, 1, 30), { targetname: 'boom1', imagnitude: '100', spawnflags: '1' }));
    timer(at(4, 1, 0), 4, 'boom1', 'Explode');
    out.push(ent('env_explosion', at(5, 1, 30), { targetname: 'boom2', imagnitude: '20', spawnflags: '1' }));
    timer(at(5, 1, 0), 3, 'boom2', 'Explode');
    out.push(ent('env_splash', at(6, 1, 4), { targetname: 'splash1', scale: '10', spawnflags: '3' }));
    timer(at(6, 1, 0), 3, 'splash1', 'Splash');

    // Row 2: physics, beams, glows.
    labels.push('row 3: env_shooter, env_physexplosion (shoves the box), env_beam (laser, lightning), point_spotlight, env_sprite glows');
    out.push(ent('env_shooter', at(0, 2, 20), { targetname: 'shooter', angles: '-80 0 0', shootmodel: 'models/gladdysdestruction/glados_junk_01_.mdl', m_igibs: '1', m_flvelocity: '450', m_flvariance: '40', m_flgiblife: '8', gibanglevelocity: '60', spawnflags: '4' }));
    timer(at(0, 2, 0), 2.5, 'shooter', 'Shoot');
    out.push(ent('prop_physics', at(1, 2, 30), { model: 'models/props/metal_box.mdl', targetname: 'box', angles: '0 0 0' }));
    out.push(ent('env_physexplosion', at(1, 2, 8), { targetname: 'push', magnitude: '60', radius: '120', spawnflags: '1' }));
    timer(at(1, 2, 0), 4, 'push', 'Explode');
    out.push(ent('info_target', at(2, 2, 120), { targetname: 'laser_a' }));
    out.push(ent('info_target', at(2, 2, 10), { targetname: 'laser_b' }));
    out.push(ent('env_beam', at(2, 2, 120), { texture: 'materials/Effects/laser1.vmt', lightningstart: 'laser_a', lightningend: 'laser_b', boltwidth: '4', texturescroll: '15', spawnflags: '1', renderamt: '255', rendercolor: '255 255 255', life: '0' }));
    out.push(ent('info_target', at(3, 2, 120), { targetname: 'bolt_a' }));
    out.push(ent('info_target', at(3, 2, 10), { targetname: 'bolt_b' }));
    out.push(ent('env_beam', at(3, 2, 120), { texture: 'materials/Effects/laser1.vmt', lightningstart: 'bolt_a', lightningend: 'bolt_b', boltwidth: '6', noiseamplitude: '10', texturescroll: '35', spawnflags: '1', renderamt: '255', rendercolor: '120 180 255', life: '0' }));
    out.push(ent('point_spotlight', at(4, 2, 220), { angles: '90 0 0', spotlightwidth: '80', spotlightlength: '260', rendercolor: '255 240 200', renderamt: '255', spawnflags: '1' }));
    out.push(ent('env_sprite', at(5, 2, 60), { model: 'materials/Sprites/light_glow03.vmt', scale: '0.75', rendermode: '9', rendercolor: '255 200 120', renderamt: '255', spawnflags: '1' }));
    out.push(ent('env_sprite', at(6, 2, 60), { model: 'sprites/glow01.vmt', scale: '1.5', rendermode: '5', rendercolor: '120 200 255', renderamt: '255', spawnflags: '1' }));

    // Row 3: the game's own particle systems, for comparison.
    labels.push('row 4: info_particle_system: fire_large_02, fire_medium_01, finale_sparks, Glados_Beam_Electricity, smoke_medium_01, water_splash_01, steam_train');
    ['fire_large_02', 'fire_medium_01', 'finale_sparks', 'Glados_Beam_Electricity', 'smoke_medium_01', 'water_splash_01', 'steam_train'].forEach((n, i) =>
        out.push(ent('info_particle_system', at(i, 3, 8), { effect_name: n, start_active: '1', angles: '-90 0 0' })));

    out.push(ent('info_player_start', [FLOOR[0], FLOOR[1], FLOOR[2] + 4], { angles: '0 90 0' }));

    return {
        base: BASE_MAP,
        labels,
        entities(baseText: string) {
            // The first entity of a map is worldspawn: keep it for the sky and lighting settings.
            const end = baseText.indexOf('}');
            const world = end >= 0 ? baseText.slice(0, end + 1) : '{\n"classname" "worldspawn"\n}';
            return [world, ...out].join('\n');
        },
    };
}

