// The game's console commands and cvars, named after their Source equivalents where one exists.
import type * as THREE from 'three';
import type { Vec3 } from '../physics/collision';
import type { Game } from '../game/game';
import { PlayerTuning } from '../physics/player';
import type { Player } from '../physics/player';
import type { CameraController } from '../render/noclip';
import type { Hud } from '../render/hud';
import type { DevConsole } from './console';
import { ENTITY_CLASSES } from '../game/classes';

export interface ConsoleDeps {
    game: Game;
    player: Player;
    controller: CameraController;
    camera: THREE.PerspectiveCamera;
    hud: Hud;
    mapName: string;
    /** Toggles invulnerability; returns the new state. */
    toggleGod: () => boolean;
    giveGun: (canFire: [boolean, boolean] | null) => void;
    /** Applied to the time every frame step sees (host_timescale). */
    setTimeScale: (s: number) => void;
    getTimeScale: () => number;
    setGravity: (g: number) => void;
    setVolume: (v: number) => void;
    getVolume: () => number;
    /** Render resolution as a multiple of CSS pixels; applies at once. */
    setPixelRatio: (r: number) => void;
    getPixelRatio: () => number;
    /** Multisample antialiasing is fixed when the context is made, so this one waits for a reload. */
    setAntialias: (on: boolean) => void;
    getAntialias: () => boolean;
    maps: () => string[];
    /** Model names relative to models/, without .mdl. */
    models: () => string[];
    /** Where the view ray first hits the world. */
    aim: () => { pos: Vec3; normal: Vec3 } | null;
}

const num = (s: string, what: string) => {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`${what}: "${s}" is not a number`);
    return n;
};
const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function registerGameCommands(c: DevConsole, d: ConsoleDeps) {
    const { game, player, controller, camera } = d;

    // --- Cvars --------------------------------------------------------------------------------
    c.addCvar('sv_gravity', '600', 'World gravity.', () => String(PlayerTuning.gravity), (v) => {
        const g = num(v, 'sv_gravity');
        PlayerTuning.gravity = g;
        d.setGravity(g);
    }, true);
    c.addCvar('sv_maxspeed', '175', 'Maximum walking speed.', () => String(PlayerTuning.maxSpeed), (v) => {
        PlayerTuning.maxSpeed = num(v, 'sv_maxspeed');
    }, true);
    c.addCvar('sv_friction', '4', 'World friction.', () => String(PlayerTuning.friction), (v) => {
        PlayerTuning.friction = num(v, 'sv_friction');
    }, true);
    c.addCvar('sv_accelerate', '10', 'Ground acceleration.', () => String(PlayerTuning.accelerate), (v) => {
        PlayerTuning.accelerate = num(v, 'sv_accelerate');
    }, true);
    c.addCvar('host_timescale', '1', 'Prescale the clock by this amount.', () => fmt(d.getTimeScale()), (v) => {
        d.setTimeScale(Math.max(0.01, Math.min(20, num(v, 'host_timescale'))));
    }, true);
    c.addCvar('fov', '75', 'Horizontal field of view in degrees (at 4:3).', () => fmt(horizontalFov(camera)), (v) => {
        const h = Math.max(20, Math.min(140, num(v, 'fov')));
        // Source's fov is horizontal at 4:3; three.js wants vertical.
        camera.fov = (2 * Math.atan(Math.tan((h * Math.PI) / 360) * (3 / 4)) * 180) / Math.PI;
        camera.updateProjectionMatrix();
    });
    c.addCvar('sensitivity', '1', 'Mouse sensitivity.', () => fmt(controller.sensitivity / 0.1), (v) => {
        controller.sensitivity = 0.1 * Math.max(0.01, num(v, 'sensitivity'));
    });
    c.addCvar('volume', '0.7', 'Sound volume.', () => fmt(d.getVolume()), (v) => d.setVolume(Math.max(0, Math.min(1, num(v, 'volume')))));
    c.addCvar('r_pixelratio', fmt(d.getPixelRatio()), 'Render resolution scale (1 = one pixel per CSS pixel; lower is faster). Saved.', () => fmt(d.getPixelRatio()), (v) => {
        d.setPixelRatio(Math.max(0.25, Math.min(4, num(v, 'r_pixelratio'))));
    });
    c.addCvar('r_antialias', d.getAntialias() ? '1' : '0', 'Multisample antialiasing, 0 or 1. Saved; takes effect after a restart.', () => (d.getAntialias() ? '1' : '0'), (v) => {
        const on = Number(v) !== 0;
        if (on !== d.getAntialias()) c.print('r_antialias applies after the page is reloaded.', 'warn');
        d.setAntialias(on);
    });
    c.addCvar('cl_drawhud', '1', 'Draw the HUD.', () => (d.hud.visible ? '1' : '0'), (v) => (d.hud.visible = Number(v) !== 0));
    c.addCvar('noclip_speed', '400', 'Noclip fly speed in units per second.', () => String(controller.noclipSpeed), (v) => {
        controller.noclipSpeed = num(v, 'noclip_speed');
    });

    // --- Player ---------------------------------------------------------------------------------
    c.addCommand('noclip', 'Toggle. Player becomes non-solid and flies.', (_a, p) => {
        controller.toggleNoclip();
        p(`noclip ${controller.mode === 'noclip' ? 'ON' : 'OFF'}`);
    }, true);
    c.addCommand('god', 'Toggle. Take no damage.', (_a, p) => p(`god ${d.toggleGod() ? 'ON' : 'OFF'}`), true);
    c.addCommand('give', 'Give the player an item: give weapon_portalgun.', (a, p) => {
        const item = (a[0] ?? '').toLowerCase();
        if (item === 'weapon_portalgun') d.giveGun([true, true]);
        else p(`give: unknown item ${a[0] ?? ''}`, 'warn');
    }, true);
    c.addCommand('upgrade_portalgun', 'Give the portal gun both portal colours.', () => d.giveGun([true, true]), true);
    c.addCommand('impulse', 'Impulse 101 gives the player everything (the portal gun).', (a) => {
        if (a[0] === '101') d.giveGun([true, true]);
    }, true);
    c.addCommand('setpos', 'Move the player to x y [z].', (a, p) => {
        if (a.length < 2) return p('Usage: setpos x y [z]');
        const [x, y] = [num(a[0], 'x'), num(a[1], 'y')];
        const z = a[2] === undefined ? controller.eye()[2] - (controller.mode === 'walk' ? player.eyeHeight : 0) : num(a[2], 'z');
        if (controller.mode === 'walk') player.teleport([x, y, z]);
        else controller.position = [x, y, z];
    }, true);
    c.addCommand('setang', 'Set the view angles: setang pitch yaw [roll].', (a, p) => {
        if (a.length < 2) return p('Usage: setang pitch yaw [roll]');
        controller.pitch = Math.max(-89, Math.min(89, num(a[0], 'pitch')));
        controller.yaw = num(a[1], 'yaw');
    }, true);
    c.addCommand('getpos', 'Print the player position and view angles.', (_a, p) => {
        const o = controller.mode === 'walk' ? player.origin : controller.position;
        p(`setpos ${fmt(o[0])} ${fmt(o[1])} ${fmt(o[2])};setang ${fmt(controller.pitch)} ${fmt(controller.yaw)} 0`);
    });

    // --- Entities -------------------------------------------------------------------------------
    c.addCommand('ent_fire', 'Fire an input at entities: ent_fire <name|classname> <input> [parameter] [delay].', (a, p) => {
        if (a.length < 2) return p('Usage: ent_fire <target> <input> [parameter] [delay]');
        const [target, input, param = '', delay = '0'] = a;
        const n = game.entities.filter((e) => !e.removed && (e.name === target.toLowerCase() || e.classname === target.toLowerCase())).length;
        if (!n && target !== '!player') p(`ent_fire: no entities named or of class "${target}"`, 'warn');
        game.schedule(Number(delay) || 0, target.toLowerCase(), input.toLowerCase(), param, game.playerEntity, null);
    }, true);
    c.addCommand('ent_list', 'List entities, optionally those whose name or class contains the text.', (a, p) => {
        const f = (a[0] ?? '').toLowerCase();
        let n = 0;
        for (const e of game.entities) {
            if (e.removed || (f && !e.classname.includes(f) && !e.name.includes(f))) continue;
            if (++n <= 200) p(`${e.classname.padEnd(28)}${e.name}`);
        }
        p(`${n} entities${n > 200 ? ' (first 200 shown)' : ''}`);
    });

    // --- Creating things ------------------------------------------------------------------------
    /** Source drops new entities where the player looks, 12 units off the surface. */
    const spawnAt = async (kv: Record<string, string>, print: (m: string, cls?: 'warn' | 'error') => void) => {
        const hit = d.aim();
        const at: Vec3 = hit ? [hit.pos[0], hit.pos[1], hit.pos[2] + 12] : controller.eye();
        try {
            const e = await game.createEntity({ origin: at.map((v) => v.toFixed(3)).join(' '), ...kv });
            return e;
        } catch (err) {
            print(`${kv.classname}: ${(err as Error).message}`, 'error');
            return null;
        }
    };
    const modelPath = (arg: string) => `models/${arg.replace(/^models[\/]/i, '').replace(/\.mdl$/i, '')}.mdl`.toLowerCase();
    /** Model names starting with the typed text first, then those containing it. */
    const completeModel = (word: string, _prior: string[], limit = 2000) => {
        const all = d.models();
        const starts = all.filter((m) => m.startsWith(word));
        const has = all.filter((m) => !m.startsWith(word) && m.includes(word));
        return [...starts, ...has].slice(0, limit);
    };
    const yaw = () => `0 ${fmt(controller.yaw)} 0`;
    c.addCommand('ent_create', 'Creates an entity where you are looking: ent_create <classname> [key value ...].', async (a, p) => {
        const cls = (a[0] ?? '').toLowerCase();
        if (!cls) return p('Usage: ent_create <classname> [key value ...]');
        const kv: Record<string, string> = { classname: cls };
        for (let i = 1; i + 1 < a.length; i += 2) kv[a[i].toLowerCase()] = a[i + 1];
        if (!ENTITY_CLASSES[cls] && !kv.model) return p(`ent_create: no entity class "${cls}" (give it a model to make a prop)`, 'warn');
        await spawnAt(kv, p);
    }, true);
    c.addCommand('prop_physics_create', 'Creates a physics prop with a specific .mdl aimed away from where the player is looking. {.mdl name}', async (a, p) => {
        if (a.length !== 1) return p('Usage: prop_physics_create <model>   e.g. props/metal_box');
        await spawnAt({ classname: 'prop_physics', model: modelPath(a[0]), angles: yaw() }, p);
    }, true, completeModel);
    c.addCommand('prop_dynamic_create', 'Creates a dynamic prop with a specific .mdl aimed away from where the player is looking. {.mdl name}', async (a, p) => {
        if (a.length !== 1) return p('Usage: prop_dynamic_create <model>');
        await spawnAt({ classname: 'prop_dynamic', model: modelPath(a[0]), angles: yaw(), solid: '6' }, p);
    }, true, completeModel);
    c.addCommand('models', 'List the available models, optionally those containing the text: models [filter].', (a, p) => {
        const hits = completeModel((a[0] ?? '').toLowerCase(), [], Infinity);
        for (const m of hits.slice(0, 300)) p(m);
        p(`${hits.length} models${hits.length > 300 ? ' (first 300 shown, add a filter)' : ''}`);
    });
    c.addCommand('ent_create_portal_weight_box', 'Creates a weight box used in portal puzzles at the location the player is looking.', async (_a, p) => {
        await spawnAt({ classname: 'prop_physics', model: 'models/props/metal_box.mdl', targetname: 'box', angles: yaw() }, p);
    }, true);
    c.addCommand('ent_create_portal_metal_sphere', 'Creates a reflective metal sphere where the player is looking.', async (_a, p) => {
        await spawnAt({ classname: 'prop_physics', model: 'models/props/sphere.mdl', targetname: 'sphere', angles: yaw() }, p);
    }, true);
    const remove = (a: string[], p: (m: string, cls?: 'warn') => void) => {
        const f = (a[0] ?? '').toLowerCase();
        if (!f) return p('Usage: ent_remove <name|classname>');
        const hits = game.entities.filter((e) => !e.removed && (e.name === f || e.classname === f));
        for (const e of hits) e.input('kill', '', null, null);
        p(`Removed ${hits.length} entities`);
    };
    c.addCommand('ent_remove', 'Removes the given entities: ent_remove <name|classname>.', remove, true);
    c.addCommand('ent_remove_all', 'Removes all entities of the specified type: ent_remove_all <name|classname>.', remove, true);
    for (const name of ['ch_createjeep', 'ch_createjalopy', 'ch_createairboat']) {
        c.addCommand(name, 'Spawn a vehicle in front of the player (unavailable: needs Half-Life 2 content).', (_a, p) => {
            p(`${name}: vehicles aren't supported, and the Half-Life 2 vehicle models aren't in Portal's files.`, 'warn');
        }, true);
    }

    // --- Level ----------------------------------------------------------------------------------
    c.addCommand('map', 'Start playing on the specified map.', (a, p) => {
        const name = (a[0] ?? '').toLowerCase().replace(/\.bsp$/, '');
        if (!name) return p('Usage:  map <mapname>');
        if (!d.maps().includes(name)) return p(`map load failed: ${name} not found or invalid`, 'error');
        go(name);
    });
    c.addCommand('changelevel', 'Change server to the specified map.', (a) => c.exec(`map ${a.join(' ')}`));
    c.addCommand('restart', 'Restart the game on the same level.', () => go(d.mapName));
    c.addCommand('maps', 'Display a list of available maps.', (a, p) => {
        const f = (a[0] ?? '').toLowerCase();
        for (const m of d.maps().filter((m) => m.includes(f))) p(m);
    });
    c.addCommand('status', 'Display map and player information.', (_a, p) => {
        const o = controller.mode === 'walk' ? player.origin : controller.position;
        p(`map     : ${d.mapName}\norigin  : ${fmt(o[0])} ${fmt(o[1])} ${fmt(o[2])}\nangles  : ${fmt(controller.pitch)} ${fmt(controller.yaw)} 0`);
        p(`entities: ${game.entities.filter((e) => !e.removed).length}\ntime    : ${game.time.toFixed(2)}s`);
    });
    c.addCommand('version', 'Print version info string.', (_a, p) => p('Portal (browser remake)\nSource SDK 2013 behaviour, game files from the local install'));
    c.addCommand('quit', 'Exit the engine.', (_a, p) => p("Can't quit a browser tab; close it instead.", 'warn'));
    c.addCommand('exec', 'Execute a script file.', (_a, p) => p('exec: config files are not supported', 'warn'));
}

/** A one-line URL change keeps the user's other query params (debug flags) but drops spawn carry-over. */
function go(map: string) {
    const q = new URLSearchParams(location.search);
    q.set('map', map);
    for (const k of ['landmark', 'offset', 'pos', 'ang', 't']) q.delete(k);
    location.search = q.toString();
}

function horizontalFov(camera: THREE.PerspectiveCamera): number {
    return (2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) / (3 / 4)) * 180) / Math.PI;
}
