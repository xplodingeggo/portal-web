import * as THREE from 'three';
import { BspFile } from './bsp/bsp';
import { parseEntityPairs, parseVec3 } from './bsp/entities';
import { buildWorldMesh } from './bsp/mesh';
import { GameFS } from './fs/gamefs';
import { changeSource, chooseSource } from './ui/launcher';
import { PauseMenu } from './ui/pausemenu';
import { binds, keyName } from './ui/keybinds';
import { ScreenShake } from './render/shake';
import { Soundscapes } from './audio/soundscape';
import { HealthOverlay, PlayerHealth } from './game/health';
import { apply as applySave, capture as captureSave, QUICK_ID, saves as saveStore, type SaveGame } from './game/savegame';
import { angleVector, ENTITY_CLASSES, entityFactory, PhysProp } from './game/classes';
import { Game, type GameEntity, type BrushMaterial, type GameContext } from './game/game';
import { placementEnv, placementFailure } from './game/placementEnv';
import { PlacedBy, traceFirePortal } from './game/portalPlacement';
import { firePortal } from './game/portalgun';
import { SoundSystem, type SoundHandle } from './audio/sound';
import { FadeOverlay, TonemapScale } from './render/fade';
import { SceneLibrary } from './game/scenes';
import { BlastEffects } from './render/blast';
import { Hud } from './render/hud';
import { ViewModel } from './render/viewmodel';
import { teleportPlayer } from './game/teleport';
import { loadMaterial, type MaterialDef } from './material/vmt';
import { CollisionWorld, type Vec3 } from './physics/collision';
import { Player } from './physics/player';
import { initPhysics, PhysicsWorld } from './physics/rigid';
import { CameraController } from './render/noclip';
import { PortalSystem } from './render/portals';
import { ParticleManager } from './render/particles';
import { FxLayer } from './render/fxlayer';
import { PARTICLE_TEST_MAP, particleTestMap } from './game/fxtestmap';
import { PropRenderer, type PropHandle, type PropInstance } from './render/props';
import { checkerTexture, lightmapTexture, TextureCache } from './render/textures';
import { createWorldMaterial } from './render/worldMaterial';
import { registerGameCommands } from './ui/commands';
import { DevConsole } from './ui/console';

const status = document.getElementById('status')!;
const stats = document.getElementById('stats')!;
const missingEl = document.getElementById('missing')!;
const noticeEl = document.getElementById('notice')!;
const setStatus = (s: string) => (status.textContent = s);

async function main() {
    const { source, index } = await chooseSource();
    const params = new URLSearchParams(location.search);
    const mapName = (params.get('map') ?? 'testchmb_a_00').toLowerCase();

    const saved = (k: string) => {
        try { return localStorage.getItem(k); } catch { return null; }
    };
    const save = (k: string, v: string) => {
        try { localStorage.setItem(k, v); } catch { /* private window */ }
    };
    const antialias = saved('r_antialias') !== '0';
    const renderer = new THREE.WebGLRenderer({ antialias });
    renderer.setPixelRatio(Number(saved('r_pixelratio')) || window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101014);
    // Source's 75 degree horizontal FOV at 4:3 is about 59 degrees vertical.
    const camera = new THREE.PerspectiveCamera(59, window.innerWidth / window.innerHeight, 2, 40000);

    setStatus('Mounting game files…');
    const fs = new GameFS(source);
    await fs.mount(index);

    setStatus(`Loading maps/${mapName}.bsp…`);
    const testMap = mapName === PARTICLE_TEST_MAP ? particleTestMap() : null;
    const bspBytes = await fs.read(`maps/${testMap ? testMap.base : mapName}.bsp`);
    if (!bspBytes) throw new Error(`maps/${mapName}.bsp not found in the game install`);
    const bsp = new BspFile(bspBytes);
    if (testMap) bsp.entitiesText = testMap.entities(bsp.entitiesText);
    fs.setPakfile(bsp.pakfile);

    setStatus('Building world geometry…');
    const world = buildWorldMesh(bsp);
    const lightmap = lightmapTexture(world.lightmap.width, world.lightmap.height, world.lightmap.data);
    const textures = new TextureCache(fs, renderer);
    const checker = checkerTexture();
    const exposure = { value: 1 };
    /** [ ] keys; the map's tonemap controller scales it on top. */
    let userExposure = 1;
    const missingMaterials: string[] = [];

    // Brush entities get their own group so map logic can move or hide them.
    const brushGroups = new Map<number, THREE.Group>();
    const brushMaterials = new Map<number, BrushMaterial[]>();
    const materialDefs = new Map<string, MaterialDef | null>();
    const groupFor = (entityIndex: number) => {
        let g = brushGroups.get(entityIndex);
        if (!g) {
            g = new THREE.Group();
            g.position.set(...parseVec3(world.entities[entityIndex].origin));
            brushGroups.set(entityIndex, g);
            scene.add(g);
        }
        return g;
    };

    const hide = params.get('hide'); // debug: hide world materials containing this
    let done = 0;
    await Promise.all(
        world.batches.filter((b) => !hide || !b.material.includes(hide)).map(async (batch) => {
            const def = await loadMaterial(fs, batch.material);
            materialDefs.set(batch.material, def);
            if (!def) missingMaterials.push(batch.material);
            else if (!def.params.$basetexture && def.shader !== 'refract') missingMaterials.push(`${batch.material} (${def.shader}, no $basetexture)`);
            const material = await createWorldMaterial(def, textures, lightmap, checker, exposure);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(batch.positions, 3));
            geom.setAttribute('uv', new THREE.BufferAttribute(batch.uvs, 2));
            geom.setAttribute('lmUv', new THREE.BufferAttribute(batch.lightmapUVs, 2));
            geom.setAttribute('blendAlpha', new THREE.BufferAttribute(batch.alphas, 1));
            const mesh = new THREE.Mesh(geom, material);
            mesh.name = batch.material;
            if (batch.overlayOrder !== undefined) {
                // Decals blend by alpha and sit on top of the opaque world, before other translucents.
                material.transparent = true;
                material.depthWrite = false;
                material.polygonOffset = true;
                material.polygonOffsetFactor = -1;
                material.polygonOffsetUnits = -4;
                mesh.renderOrder = 0.5 + batch.overlayOrder * 0.1;
            } else if (material.transparent) mesh.renderOrder = 1;
            if (batch.entityIndex !== undefined) {
                groupFor(batch.entityIndex).add(mesh);
                const list = brushMaterials.get(batch.entityIndex) ?? [];
                list.push({ name: batch.material, def, material });
                brushMaterials.set(batch.entityIndex, list);
            } else {
                scene.add(mesh);
            }
            setStatus(`Loading materials ${++done}/${world.batches.length}…`);
        }),
    );

    // Brush entities without map logic of their own collide in their spawn state.
    const collision = new CollisionWorld(bsp, world.entities.filter((e) => !ENTITY_CLASSES[e.classname]));
    const propRenderer = new PropRenderer(fs, bsp, textures, checker, exposure);
    const filter = params.get('props'); // debug: substring filter, "none" hides all
    const props = propRenderer.collect(world.entities).filter((p) => !filter || p.model.includes(filter));
    const propHandles = new Map<number, PropHandle>();
    const propInstances = new Map<number, PropInstance>();
    let propsDone = 0;
    await Promise.all(
        props.map(async (p) => {
            const handle = await propRenderer.build(p).catch((e) => {
                console.warn(`${p.model}: ${(e as Error).message}`);
                propRenderer.missingModels.add(p.model);
                return null;
            });
            if (handle) scene.add(handle.group);
            if (p.entityIndex !== undefined) {
                // Prop entities get collision from map logic, which can move or disable it.
                propInstances.set(p.entityIndex, p);
                if (handle) propHandles.set(p.entityIndex, handle);
            } else {
                const hulls = await propRenderer.collisionHulls(p).catch(() => []);
                if (hulls.length) collision.addHullModel(hulls);
            }
            setStatus(`Loading props ${++propsDone}/${props.length}…`);
        }),
    );

    // Spawn: the map's player start, or carried over from the previous map's landmark.
    let spawn: Vec3 = [0, 0, 0];
    let spawnYaw = 0;
    const start = world.entities.find((e) => e.classname === 'info_player_start');
    if (start) {
        spawn = parseVec3(start.origin);
        spawnYaw = parseVec3(start.angles)[1];
    }
    const landmark = params.get('landmark');
    const lm = landmark && world.entities.find((e) => e.classname === 'info_landmark' && e.targetname === landmark);
    if (lm) {
        const o = parseVec3(lm.origin);
        const off = parseVec3((params.get('offset') ?? '').replace(/,/g, ' '));
        spawn = [o[0] + off[0], o[1] + off[1], o[2] + off[2]];
    }

    const player = new Player(collision, spawn);
    const controller = new CameraController(camera, renderer.domElement, player);
    controller.yaw = spawnYaw;
    // ?pos=x,y,z&ang=pitch,yaw starts in noclip at that spot (handy for screenshots).
    if (params.get('pos')) {
        controller.mode = 'noclip';
        controller.position = parseVec3(params.get('pos')!.replace(/,/g, ' '));
    }
    if (params.get('ang')) [controller.pitch, controller.yaw] = parseVec3(params.get('ang')!.replace(/,/g, ' '));

    const portals = new PortalSystem(scene, renderer, collision);
    player.funnelPortals = () => portals.funnelPortals();
    const resize = () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        portals.setSize(size.x, size.y);
    };
    window.addEventListener('resize', resize);
    resize();

    await initPhysics();
    const physics = new PhysicsWorld(collision);
    setStatus('Loading sounds and the portal gun…');
    const sound = new SoundSystem(fs);
    const viewmodel = new ViewModel(propRenderer, 'models/weapons/v_portalgun.mdl');
    const hud = new Hud();
    const scenes = new SceneLibrary(fs);
    const soundscapes = new Soundscapes(fs, sound);
    await Promise.all([sound.load(), viewmodel.load(), hud.load(textures), scenes.load(), soundscapes.load()]);
    hud.visible = true;
    hud.setSize(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', () => hud.setSize(window.innerWidth, window.innerHeight));
    portals.sound = sound;
    portals.warmUp(camera);
    // Audio may only start from a user gesture: the click that captures the mouse.
    renderer.domElement.addEventListener('click', () => sound.unlock());
    const blasts = new BlastEffects(scene);
    const particles = new ParticleManager(fs, textures, scene);
    const fxLayer = new FxLayer(fs, textures, scene);
    portals.particles = particles;
    particles.trace = (a, b) => {
        const t = collision.trace(a, b, [0, 0, 0], [0, 0, 0]);
        return t.fraction < 1 && !t.startSolid ? { end: t.end, normal: t.normal } : null;
    };
    particles.playerPos = () => player.origin;
    const health = new PlayerHealth();
    const ctx: GameContext = {
        health,
        soundscapes,
        bsp, collision, physics, sound, scenes, particles, fx: fxLayer, player, view: controller, portals, props: propRenderer, textures, scene,
        brushGroups, brushMaterials, propHandles, propInstances,
        log: (m) => console.info(`[logic] ${m}`),
    };
    const game = new Game(ctx, parseEntityPairs(bsp.entitiesText), entityFactory);
    // Arriving by level transition: put the global entities (the elevator) where they were relative
    // to the landmark, then the player in them.
    if (lm) {
        game.loadType = 'transition';
        if (params.get('globals') !== null && controller.mode === 'walk') {
            game.restoreGlobals(parseVec3(lm.origin), params.get('globals')!);
            player.teleport(spawn);
        }
    }

    // A level started fresh (level select, first visit) begins in the elevator that brought the player
    // in, as the game does when you arrive through a transition. That elevator is the one the map
    // sends its "stop" to on OnMapTransition; the trigger that sets it moving is under the player's
    // feet, so the ride starts on its own. Escape maps start where the map puts the player.
    if (!lm && !params.get('pos') && !params.get('loadsave') && !/^escape_/.test(mapName)) {
        const target = (c: { target: string }, from: GameEntity) => game.find(c.target, null, from)[0];
        const stops = game.entities
            .filter((e) => e.classname === 'logic_auto')
            .flatMap((e) => e.connections.filter((c) => c.output === 'onmaptransition').map((c) => target(c, e)))
            .filter((r): r is GameEntity => !!r && r.classname === 'logic_relay');
        const train = stops
            .flatMap((r) => r.connections.filter((c) => c.input === 'stop').map((c) => target(c, r)))
            .find((t) => t?.classname === 'func_tracktrain');
        const go = train && game.entities.find((e) => e.classname === 'trigger_once' && e.connections.some((c) => c.input === 'startforward' && target(c, e) === train));
        const b = go?.brushBounds();
        if (b) {
            const at: Vec3 = [(b.mins[0] + b.maxs[0]) / 2, (b.mins[1] + b.maxs[1]) / 2, b.mins[2] + 1];
            player.teleport(at);
            // face into the room the elevator opens onto
            controller.yaw = (Math.atan2(spawn[1] - at[1], spawn[0] - at[0]) * 180) / Math.PI;
            controller.pitch = 0;
            controller.syncCamera();
        }
    }

    // E: pick up / drop boxes, or use doors flagged "use opens".
    let held: PhysProp | null = null;
    let holdSound: SoundHandle | null = null;
    /** Carrying stopped (let go, or the grab controller dropped it): close the gun's prongs. */
    const released = () => {
        held = null;
        holdSound?.stop(0.2);
        holdSound = null;
        if (game.playerGun) viewmodel.play('ACT_VM_RELEASE');
    };
    const use = () => {
        if (held && !held.held) released();
        if (held) {
            held.drop();
            released();
            return;
        }
        const eye = player.eye();
        const dir = angleVector([controller.pitch, controller.yaw, 0]);
        let best: { e: PhysProp; t: number } | null = null;
        for (const e of game.entities) {
            if (!(e instanceof PhysProp) || e.removed) continue;
            const b = e.bounds();
            const t = b && rayBox(eye, dir, b.mins, b.maxs);
            if (t !== null && t !== undefined && t < 96 && (!best || t < best.t)) best = { e, t };
        }
        if (best) {
            held = best.e;
            held.pickUp();
            // The gun's prongs open around the carried object, humming.
            if (game.playerGun) {
                viewmodel.play('ACT_VM_PICKUP');
                holdSound = sound.play('Weapon_Portalgun.HoldSound', { loop: true });
            }
            return;
        }
        for (const e of game.entities) {
            if (e.classname === 'prop_door_rotating' && !e.flag(32768) && !e.flag(2048)) {
                const o = e.origin;
                const d = Math.hypot(o[0] - eye[0], o[1] - eye[1], (o[2] + 48) - eye[2]);
                if (d < 110) e.input('toggle', '', game.playerEntity, null);
                continue;
            }
            if (e.classname === 'func_rot_button' && (e as unknown as { usableByPlayer(): boolean }).usableByPlayer()) {
                const b = e.brushBounds();
                const t = b && rayBox(eye, dir, b.mins, b.maxs);
                if (t !== null && t !== undefined && t < 96) e.input('press', '', game.playerEntity, null);
                continue;
            }
            if (e.classname !== 'func_door' || !e.flag(256)) continue;
            const b = e.brushBounds();
            const t = b && rayBox(eye, dir, b.mins, b.maxs);
            if (t !== null && t !== undefined && t < 96) e.input('toggle', '', game.playerEntity, null);
        }
    };

    // Portal gun: picked up in the map (or G, a debug toggle that fires both); left click blue, right click orange.
    const placement = placementEnv(game, portals, bsp, materialDefs);
    ctx.placement = placement;
    const fader = new FadeOverlay(document.body);
    const shaker = new ScreenShake();
    const tonemap = new TonemapScale();
    ctx.effects = {
        blast: (color, from, to, duration, byPlayer = true) => {
            // The shot is a particle stream when the game's effect is there, else a plain glow.
            const name = `portal_${color + 1}_projectile_stream${byPlayer ? '' : '_pedestal'}`;
            if (particles.has(name)) void particles.fly(name, from, to, duration);
            else blasts.fire(color, from, to, duration);
        },
        shake: (sh) => shaker.start(sh), stopShake: (n) => shaker.stop(n),
        autosave: () => autosave(),
        hint: (token) => showHint(token),
        fade: (f) => fader.start(f), tonemap: (scale, duration) => tonemap.blend(scale, duration) };
    const setGun = (canFire: [boolean, boolean] | null) => {
        game.playerGun = canFire;
        viewmodel.setEquipped(!!canFire);
        if (canFire) sound.play('Weapon_Portalgun.powerup');
    };
    ctx.givePortalgun = (canFire) => setGun(canFire);
    // Carried over a level change ("1,0": can fire blue only), or ?gun=1 for both.
    const gunParam = params.get('gun');
    if (gunParam) setGun(gunParam === '1' ? [true, true] : (gunParam.split(',').map((v) => v === '1') as [boolean, boolean]));
    /** 0 none, 1 blue, 2 orange: the HUD marks the last colour fired. */
    let lastFired: 0 | 1 | 2 = 0;
    let nextAttack = 0;
    /**
     * CWeaponPortalgun::PrimaryAttack/SecondaryAttack: sound, animation and the blast, which opens
     * the portal (or fizzles) when it lands. `instant` skips the flight (debug shots on load).
     */
    const shoot = (color: 0 | 1, pitch = controller.pitch, yaw = controller.yaw, instant = false) => {
        if (!instant && (game.time < nextAttack || !game.playerGun?.[color])) return;
        nextAttack = game.time + 0.35; // a little under the fire animation, which can be cut short
        const eye = controller.eye();
        lastFired = (color + 1) as 1 | 2;
        sound.play(color ? 'Weapon_Portalgun.fire_red' : 'Weapon_Portalgun.fire_blue');
        viewmodel.play('ACT_VM_PRIMARYATTACK');
        const r = firePortal(game, color, eye, angleVector([pitch, yaw, 0]), viewmodel.muzzle(eye, [pitch, yaw, 0]), PlacedBy.Player, instant);
        if (r.success < 0.5) notice(placementFailure(r.success));
    };
    // Where each portal would land, for the crosshair: re-checked a few times a second.
    const placeable: [boolean, boolean] = [false, false];
    let placeCheckAt = 0;
    const checkPlaceable = () => {
        const dir = angleVector([controller.pitch, controller.yaw, 0]);
        for (const color of [0, 1] as const) {
            const current = portals.findPortal(color, 0);
            placeable[color] = traceFirePortal(placement, current?.key ?? null, controller.eye(), dir).success >= 0.5;
        }
    };
    let noticeUntil = 0;
    const notice = (msg: string) => {
        noticeEl.textContent = msg;
        noticeUntil = performance.now() + 2500;
    };

    // ---- pause, fullscreen, hidden text, saves ----
    let paused = false;
    let everLocked = false;
    const hideText = (hidden: boolean) => {
        document.body.classList.toggle('hidetext', hidden);
        save('portal-web.showtext', hidden ? '0' : '1');
    };
    // Hidden until the player turns it on (F3), which is remembered.
    hideText(saved('portal-web.showtext') !== '1');
    const toggleFullscreen = () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => notice('Fullscreen was blocked by the browser'));
    };

    /** A small screenshot of the next frame, for the save list. */
    let wantThumb: ((t: string | null) => void) | null = null;
    const thumbnail = () => new Promise<string | null>((resolve) => {
        wantThumb = resolve;
        setTimeout(() => wantThumb === resolve && resolve(null), 1000);
    });
    const deps = { mapName, game, player, view: controller, portals, get health() { return health.health; } };
    const doSave = async (id: string, name: string) => {
        const thumb = await thumbnail();
        await saveStore.put(captureSave(deps, id, name, thumb));
    };
    /** Loads a save: straight in if it is this map, else by reloading into its map. */
    const doLoad = async (id: string) => {
        const s = await saveStore.get(id);
        if (!s) throw new Error('That save is gone.');
        if (s.map !== mapName) {
            const p = new URLSearchParams({ map: s.map, loadsave: id });
            location.search = p.toString();
            return;
        }
        restoreSave(s);
        if (paused) resume();
        notice('Loaded');
    };
    const restoreSave = (s: SaveGame) => {
        if (held) released();
        applySave(deps, s);
        health.reset();
        health.health = s.health ?? health.max;
        overlay.death(false);
        game.playerGun = s.game.playerGun;
        viewmodel.setEquipped(!!s.game.playerGun);
        nextAttack = 0;
    };
    const AUTOSAVE_ID = 'autosave';
    const autosave = () => {
        if (health.dead) return;
        void doSave(AUTOSAVE_ID, 'Autosave').then(() => notice('Checkpoint'), () => {});
    };
    // The game's on-screen hints (env_hudhint); wording is a paraphrase, with the player's own keys.
    const hintEl = document.createElement('div');
    hintEl.className = 'hud';
    Object.assign(hintEl.style, { position: 'fixed', left: '50%', bottom: '18%', transform: 'translateX(-50%)', padding: '8px 16px', background: 'rgba(0,0,0,.55)', color: '#ffe9a8', font: '15px ui-monospace, Consolas, monospace', borderRadius: '4px', display: 'none', zIndex: '3', pointerEvents: 'none' });
    document.body.append(hintEl);
    let hintTimer = 0;
    const showHint = (token: string | null) => {
        clearTimeout(hintTimer);
        const key = (a: string) => binds.codes(a).map(keyName)[0] ?? '?';
        const text: Record<string, string> = {
            hint_jump: `Press ${key('jump')} to jump`,
            hint_duck: `Press ${key('duck')} to crouch`,
            hint_move_ctrls: `Use ${key('forward')} ${key('left')} ${key('back')} ${key('right')} to move`,
            hint_use_items: `Press ${key('use')} to pick things up`,
            hint_drop_items: `Press ${key('use')} again to put it down`,
            hint_use_switches: `Press ${key('use')} to use switches`,
            hint_get_portal_1: 'Pick up the portal gun',
            hint_get_portal_2: 'Pick up the portal gun upgrade',
        };
        const t = token ? text[token.toLowerCase()] : null;
        hintEl.textContent = t ?? '';
        hintEl.style.display = t ? '' : 'none';
        if (t) hintTimer = window.setTimeout(() => (hintEl.style.display = 'none'), 6000);
    };
    const quickSave = () => {
        if (health.dead) return;
        void doSave(QUICK_ID, 'Quick save').then(() => notice('Quick saved'), (e) => notice(`Save failed: ${(e as Error).message}`));
    };
    const quickLoad = () => {
        doLoad(QUICK_ID).catch(() => notice('No quick save yet'));
    };

    // Health: a red flash on a hit, and at zero the screen goes dark and the quick save (else the level) comes back.
    const overlay = new HealthOverlay(document.body);
    let god = false;
    health.invulnerable = () => god || controller.mode === 'noclip';
    health.onHurt = (amount) => overlay.hit(amount);
    health.onDeath = () => {
        if (held) released();
        overlay.death(true);
        setTimeout(async () => {
            // the newer of the quick save and the map's own checkpoint, for this level; else start it over
            const found = (await Promise.all([QUICK_ID, AUTOSAVE_ID].map((id) => saveStore.get(id).catch(() => undefined)))).filter((s): s is SaveGame => !!s && s.map === mapName);
            const newest = found.sort((a, b) => b.created - a.created)[0];
            if (newest) doLoad(newest.id).catch(() => location.reload());
            else location.reload();
        }, 2200);
    };

    // The game's own levels (portal/maps), in play order, named like the game's chapters.
    const levelList = index
        .filter((f) => /^portal\/maps\/[^/]+\.bsp$/.test(f))
        .map((f) => f.slice('portal/maps/'.length, -4))
        .filter((n) => !/^(background|credits|styleguide|demo)/.test(n) && !n.startsWith('devtest'))
        .sort((a, b) => Number(a.startsWith('escape')) - Number(b.startsWith('escape')) || a.localeCompare(b, undefined, { numeric: true }))
        .map((name) => {
            const m = /^testchmb_a_(\d+)(_advanced)?$/.exec(name) ?? /^escape_(\d+)$/.exec(name);
            const label = m ? (name.startsWith('escape') ? `Escape ${m[1]}` : `Test Chamber ${m[1]}${m[2] ? ' (advanced)' : ''}`) : name;
            return { name, label };
        });
    const pauseMenu = new PauseMenu({
        resume: () => resume(),
        listSaves: () => saveStore.list(),
        save: (name, overwriteId) => doSave(overwriteId ?? `save-${Date.now()}`, name),
        load: (id) => doLoad(id),
        remove: (id) => saveStore.delete(id),
        debugText: () => [status.textContent, `health ${Math.ceil(health.health)} / ${health.max}${health.dead ? ' (dead)' : ''}`, stats.textContent, missingEl.textContent].filter(Boolean).join('\n\n'),
        hudHidden: () => document.body.classList.contains('hidetext'),
        toggleHud: () => hideText(!document.body.classList.contains('hidetext')),
        toggleFullscreen,
        sensitivity: { get: () => controller.sensitivity, set: (v) => { controller.sensitivity = v; save('portal-web.sensitivity', String(v)); } },
        volume: { get: () => sound.volume, set: (v) => { sound.volume = v; } },
        changeSource,
        currentMap: mapName,
        levels: () => levelList,
        loadLevel: (name) => {
            location.search = new URLSearchParams({ map: name }).toString();
        },
    });
    const sens = Number(saved('portal-web.sensitivity'));
    if (sens > 0) controller.sensitivity = sens;

    const setPaused = (p: boolean) => {
        if (p === paused) return;
        paused = p;
        controller.frozen = p;
        sound.setPaused(p);
        window.dispatchEvent(new Event('blur')); // drops held movement keys
        if (p) pauseMenu.open();
        else pauseMenu.close();
    };
    const resume = () => {
        setPaused(false);
        renderer.domElement.requestPointerLock();
    };
    // Losing the mouse (Esc) is how the pause menu opens, as in Source. The console does its own thing.
    document.addEventListener('pointerlockchange', () => {
        if (document.pointerLockElement === renderer.domElement) {
            everLocked = true;
            setPaused(false);
        } else if (everLocked && !devConsole.isOpen) setPaused(true);
    });

    window.addEventListener('keydown', (e) => {
        const t = e.target as HTMLElement;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        const is = (a: string) => binds.matches(a, e.code);
        if (is('fullscreen') && !e.repeat) {
            e.preventDefault();
            toggleFullscreen();
        }
        if (is('hud') && !e.repeat) {
            e.preventDefault();
            hideText(!document.body.classList.contains('hidetext'));
        }
        if (is('pause') && !e.repeat) {
            if (paused) resume();
            else {
                document.exitPointerLock();
                setPaused(true);
            }
        }
        if (paused) return;
        if (is('exposureDown')) userExposure /= 1.25;
        if (is('exposureUp')) userExposure *= 1.25;
        if (is('use') && !e.repeat && !health.dead) use();
        if (is('gun') && !e.repeat) setGun(game.playerGun ? null : [true, true]);
        if (is('quicksave') && !e.repeat) quickSave();
        if (is('quickload') && !e.repeat) quickLoad();
    });
    renderer.domElement.addEventListener('mousedown', (e) => {
        if (document.pointerLockElement !== renderer.domElement || !game.playerGun || health.dead) return;
        if (e.button === 0) shoot(0);
        if (e.button === 2) shoot(1);
    });
    renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    const missing = [
        ...missingMaterials.map((m) => `material: ${m}`),
        ...[...propRenderer.missingModels].map((m) => `model: ${m}`),
        ...[...propRenderer.missingMaterials].map((m) => `model material: ${m}`),
        ...[...textures.missing].map((t) => `texture: ${t}`),
    ];
    missingEl.textContent = missing.length ? `Missing (${missing.length}):\n` + missing.join('\n') : '';
    const faceCount = world.batches.reduce((n, b) => n + b.faceCount, 0);
    const k = (a: string) => binds.codes(a).map(keyName).join('/');
    setStatus(`${mapName} — click to look · ${k('forward')}${k('left')}${k('back')}${k('right')} move · ${k('jump')} jump · ${k('duck')} crouch · ${k('use')} use/carry · Esc pause menu (saves, settings) · ${k('quicksave')} quick save · ${k('quickload')} quick load · ${k('hud')} hide text · ${k('fullscreen')} fullscreen`);

    // Exposed for debugging from the console and automated screenshots.
    Object.assign(window, { portalWeb: { scene, camera, controller, player, collision, bsp, world, exposure, game, portals, renderer, health, soundscapes } });

    // debug: &fire=target,input[,param];... sends inputs at start, like the console's ent_fire.
    for (const cmd of (params.get('fire') ?? '').split(';').filter(Boolean)) {
        const [target, input, param = ''] = cmd.split(',');
        game.schedule(0, target.toLowerCase(), (input ?? '').toLowerCase(), param, game.playerEntity, null);
    }
    const fixedT = Number(params.get('t')) || 0; // debug: fast-forward map logic by this many seconds
    for (let t = 0; t < fixedT; t += 1 / 30) game.tick(1 / 30);

    // debug: &shoot=color,pitch,yaw;... fires the portal gun from the start view on the first frame.
    let pendingShots = (params.get('shoot') ?? '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));

    // Developer console (` or P): Source-style commands and cvars.
    let timeScale = 1;
    const devConsole = new DevConsole();
    devConsole.onToggle = (open) => {
        if (open) {
            document.exitPointerLock();
            window.dispatchEvent(new Event('blur')); // drops held movement keys
        }
    };
    let modelNames: string[] | undefined;
    const mapNames = [PARTICLE_TEST_MAP, ...index.filter((f) => /\/maps\/[^/]+\.bsp$/i.test(f)).map((f) => f.replace(/^.*\/maps\//i, '').replace(/\.bsp$/i, '').toLowerCase())];
    if (testMap) for (const l of ["Particle test map: noclip, then look around. Rows run away from the start, nearest first.", ...testMap.labels]) devConsole.print(l, "dim");
    registerGameCommands(devConsole, {
        game, player, controller, camera, hud, mapName, giveGun: setGun, toggleGod: () => (god = !god),
        setTimeScale: (s) => (timeScale = s), getTimeScale: () => timeScale,
        setGravity: (g) => (physics.world.gravity = { x: 0, y: 0, z: -g }),
        setVolume: (v) => (sound.volume = v), getVolume: () => sound.volume,
        setPixelRatio: (r) => {
            renderer.setPixelRatio(r);
            save('r_pixelratio', String(r));
            resize();
        },
        getPixelRatio: () => renderer.getPixelRatio(),
        setAntialias: (on) => save('r_antialias', on ? '1' : '0'),
        getAntialias: () => antialias,
        maps: () => mapNames,
        models: () => (modelNames ??= fs.list('models/', '.mdl').map((f) => f.slice(7, -4)).sort()),
        aim: () => {
            const eye = controller.eye();
            const dir = angleVector([controller.pitch, controller.yaw, 0]);
            const tr = collision.trace(eye, [eye[0] + dir[0] * 8192, eye[1] + dir[1] * 8192, eye[2] + dir[2] * 8192], [0, 0, 0], [0, 0, 0]);
            return tr.fraction < 1 ? { pos: tr.end, normal: tr.normal } : null;
        },
    });
    devConsole.print('Portal (browser remake) — type help, cmdlist or cvarlist. sv_cheats 1 enables cheat commands.', 'dim');

    // Arriving from another map's load (or quick load): apply the save once physics props exist.
    const loadId = params.get('loadsave');
    if (loadId) {
        const s = await saveStore.get(loadId);
        if (s && s.map === mapName) {
            const props = () => game.entities.filter((e): e is PhysProp => e instanceof PhysProp);
            for (let i = 0; i < 60 && !props().every((p) => p.ready || p.removed); i++) await new Promise((r) => setTimeout(r, 100));
            restoreSave(s);
        }
    }

    let sceneCalls = 0, sceneTris = 0;
    let last = performance.now();
    let frames = 0;
    let fpsTime = last;
    // CPU milliseconds per phase, averaged over each stats window (GPU time doesn't show here).
    const cost = { logic: 0, fx: 0, portals: 0, draw: 0, scene: 0, model: 0 };
    renderer.setAnimationLoop((now) => {
        const t0 = performance.now();
        const dt = paused ? 0 : Math.min(0.1, (now - last) / 1000) * timeScale;
        last = now;

        const center = (): Vec3 => [player.origin[0], player.origin[1], player.origin[2] + player.maxs[2] / 2];
        const before = center();
        controller.override = game.viewControl;
        controller.frozen = paused || health.dead;
        if (!paused) controller.update(dt);
        if (!paused) health.update(dt);
        overlay.update(dt, health.health / health.max);
        fader.update(dt);
        exposure.value = userExposure * tonemap.update(dt);
        if (controller.mode === 'walk' && !paused) {
            const through = portals.crossing(before, center());
            if (through) {
                teleportPlayer(game, through.matrix, through.from, through.to);
                controller.syncCamera();
            }
        }
        if (!paused) game.tick(dt);
        // Riding a lift, the tick just carried the player: put the view where they are now, or it trails the lift by a step and jitters.
        if (!paused && !controller.override && controller.mode === 'walk') controller.syncCamera();
        if (!paused) soundscapes.update(dt, controller.eye());
        if (pendingShots.length) {
            scene.updateMatrixWorld();
            for (const [color, pitch, yaw] of pendingShots) shoot(color ? 1 : 0, pitch, yaw, true);
            pendingShots = [];
        }
        if (held && !held.held) released();
        blasts.update(dt);

        // The listener is the eye.
        const eye = controller.eye();
        const view = game.viewControl?.forward ?? angleVector([controller.pitch, controller.yaw, 0]);
        const up = game.viewControl?.up ?? angleVector([controller.pitch - 90, controller.yaw, 0]);
        sound.setListener(eye, view, up);

        const t1 = performance.now();
        shaker.update(dt);
        shaker.apply(camera, eye);
        particles.update(dt, camera);
        fxLayer.update(dt, camera);
        const t2 = performance.now();
        portals.render(camera, dt);
        const t3 = performance.now();
        renderer.render(scene, camera);
        sceneCalls = renderer.info.render.calls;
        sceneTris = renderer.info.render.triangles;
        shaker.restore(camera);
        const t3b = performance.now();
        viewmodel.update(dt, eye, [controller.pitch, controller.yaw, 0], controller.mode === 'walk' ? Math.hypot(player.velocity[0], player.velocity[1]) : 0);
        viewmodel.render(renderer, camera);
        if (game.playerGun && now > placeCheckAt) {
            placeCheckAt = now + 100;
            checkPlaceable();
        }
        hud.update(dt, { canFire: game.playerGun ?? [false, false], placeable, lastFired, holding: !!held });
        hud.render(renderer);
        if (wantThumb) {
            const done = wantThumb;
            wantThumb = null;
            done(snapshotCanvas(renderer.domElement));
        }
        const t4 = performance.now();
        cost.scene += t3b - t3;
        cost.model += t4 - t3b;
        cost.logic += t1 - t0;
        cost.fx += t2 - t1;
        cost.portals += t3 - t2;
        cost.draw += t4 - t3;

        if (noticeUntil && now > noticeUntil) {
            noticeEl.textContent = '';
            noticeUntil = 0;
        }
        frames++;
        if (now - fpsTime > 500) {
            const fps = (frames * 1000) / (now - fpsTime);
            const ms = (v: number) => (v / Math.max(1, frames)).toFixed(1);
            const costs = `logic ${ms(cost.logic)} (physics ${ms(game.perf.physics)}, think ${ms(game.perf.think)}) · fx ${ms(cost.fx)} · portals ${ms(cost.portals)} · scene ${ms(cost.scene)} · viewmodel+hud ${ms(cost.model)} ms`;
            cost.logic = cost.fx = cost.portals = cost.draw = cost.scene = cost.model = 0;
            game.perf.physics = game.perf.think = 0;
            frames = 0;
            fpsTime = now;
            const [x, y, z] = controller.eye().map((c) => c.toFixed(0));
            const speed = Math.hypot(player.velocity[0], player.velocity[1]).toFixed(0);
            stats.textContent =
                `${fps.toFixed(0)} fps · ${costs} · ${sceneCalls} draws · ${sceneTris} tris · ${faceCount} faces · ` +
                `${world.batches.length} materials · ${props.length} props · pos ${x} ${y} ${z} · ` +
                `${controller.mode}${controller.mode === 'walk' ? ` ${speed} u/s` : ''}${game.playerGun ? ' · portal gun' : ''} · ` +
                `t ${game.time.toFixed(0)}s · exposure ${exposure.value.toFixed(2)}`;
        }
    });

}

/** Shrinks the visible game canvas to a small JPEG; call right after rendering. */
function snapshotCanvas(canvas: HTMLCanvasElement): string | null {
    try {
        const out = document.createElement('canvas');
        out.width = 192;
        out.height = Math.round((192 * canvas.height) / canvas.width) || 108;
        out.getContext('2d')!.drawImage(canvas, 0, 0, out.width, out.height);
        return out.toDataURL('image/jpeg', 0.7);
    } catch {
        return null;
    }
}

/** Distance along a ray to an axis-aligned box, or null. */
function rayBox(o: Vec3, d: Vec3, mins: Vec3, maxs: Vec3): number | null {
    let tmin = 0, tmax = Infinity;
    for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-9) {
            if (o[a] < mins[a] || o[a] > maxs[a]) return null;
            continue;
        }
        let t1 = (mins[a] - o[a]) / d[a], t2 = (maxs[a] - o[a]) / d[a];
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) return null;
    }
    return tmin;
}

main().catch((e) => {
    console.error(e);
    setStatus(`Error: ${(e as Error).message}`);
});
