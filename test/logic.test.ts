// Map logic in testchmb_a_00, run headless (skipped without the game install).
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { BspFile } from '../src/bsp/bsp';
import { parseEntities, parseEntityPairs, parseVec3 } from '../src/bsp/entities';
import { GameFS } from '../src/fs/gamefs';
import type { ByteSource } from '../src/fs/source';
import { angleVector, ENTITY_CLASSES, entityFactory, PhysProp } from '../src/game/classes';
import { placementEnv } from '../src/game/placementEnv';
import { angleVectors, traceFirePortal } from '../src/game/portalPlacement';
import { teleportPlayer } from '../src/game/teleport';
import { Game, type GameContext, type GameEntity } from '../src/game/game';
import { CollisionWorld, type Vec3 } from '../src/physics/collision';
import { Player, type PlayerInput } from '../src/physics/player';
import { initPhysics, PhysicsWorld } from '../src/physics/rigid';
import type { CameraController } from '../src/render/noclip';
import { PortalSystem } from '../src/render/portals';
import { PropRenderer, type PropInstance } from '../src/render/props';

const GAME_DIR = process.env.GAME_DIR ?? 'E:\\SteamLibrary\\steamapps\\common\\Portal';
const haveGame = fs.existsSync(path.join(GAME_DIR, 'portal', 'portal_pak_dir.vpk'));

class DiskSource implements ByteSource {
    async read(p: string, offset?: number, length?: number) {
        const full = path.join(GAME_DIR, p);
        if (!fs.existsSync(full)) return null;
        if (offset === undefined || length === undefined) return new Uint8Array(fs.readFileSync(full));
        const fd = fs.openSync(full, 'r');
        try {
            const buf = new Uint8Array(length);
            fs.readSync(fd, buf, 0, length, offset);
            return buf;
        } finally {
            fs.closeSync(fd);
        }
    }
}

const idle: PlayerInput = { forward: 0, side: 0, jump: false, duck: false, yaw: 0 };
const wait = () => new Promise((r) => setTimeout(r, 0));

// The vault tests simulate over a minute of game time.
describe.skipIf(!haveGame)('testchmb_a_00 map logic', { timeout: 20000 }, () => {
    let game: Game;
    let player: Player;
    let portals: PortalSystem;
    let collision: CollisionWorld;
    let physics: PhysicsWorld;
    const named = (n: string) => game.entities.find((e) => e.name === n)!;

    /** Advances logic and physics together, like the main loop. */
    async function run(seconds: number, input: PlayerInput = idle) {
        for (let t = 0; t < seconds; t += 1 / 33) {
            const center = (): Vec3 => [player.origin[0], player.origin[1], player.origin[2] + player.maxs[2] / 2];
            const before = center();
            player.update(1 / 33, { ...input, pitch: game.ctx.view.pitch });
            const through = portals.crossing(before, center());
            if (through) {
                teleportPlayer(game, through.matrix, through.from, through.to);
                if (input !== idle) input = { ...input, yaw: game.ctx.view.yaw };
            }
            game.tick(1 / 33);
            // Yield now and then like real frames do, so async model/collision loads finish.
            if (Math.round(t * 33) % 8 === 0) await wait();
        }
        await wait();
    }

    beforeEach(async () => {
        const gfs = new GameFS(new DiskSource());
        await gfs.mount(['portal/maps/testchmb_a_00.bsp']);
        const bsp = new BspFile((await gfs.read('maps/testchmb_a_00.bsp'))!);
        gfs.setPakfile(bsp.pakfile);
        const entities = parseEntities(bsp.entitiesText);
        collision = new CollisionWorld(bsp, entities.filter((e) => !ENTITY_CLASSES[e.classname]));
        const props = new PropRenderer(gfs, bsp, null as never, null as never, { value: 1 });
        props.build = async () => null; // no rendering in tests
        const propInstances = new Map<number, PropInstance>();
        for (const p of props.collect(entities)) {
            if (p.entityIndex !== undefined) propInstances.set(p.entityIndex, p);
            else {
                const hulls = await props.collisionHulls(p);
                if (hulls.length) collision.addHullModel(hulls);
            }
        }
        player = new Player(collision, parseVec3(entities.find((e) => e.classname === 'info_player_start')!.origin));
        const view = { yaw: 0, pitch: 0 } as unknown as CameraController; // logic only reads the view angles
        portals = new PortalSystem(new THREE.Scene(), null as never, collision);
        await initPhysics();
        physics = new PhysicsWorld(collision);
        const ctx: GameContext = {
            bsp, collision, physics, player, view, portals, props, textures: null as never, scene: new THREE.Scene(),
            brushGroups: new Map(), brushMaterials: new Map(), propHandles: new Map(), propInstances,
            log: () => {},
        };
        game = new Game(ctx, parseEntityPairs(bsp.entitiesText), entityFactory);
        await run(0.1);
    });

    it('opens the relaxation vault portal pair after 66.5 seconds', async () => {
        const active = () => portals.portals.filter((p) => p.active).length;
        await run(60);
        expect(portals.portals.find((p) => p.active && portals.partner(p))).toBeUndefined();
        await run(8);
        expect(active()).toBeGreaterThanOrEqual(2);
        const red = portals.portals.find((p) => p.key === named('portal_red_0'))!;
        expect(red.active).toBe(true);
        expect(portals.partner(red)?.key).toBe(named('portal_blue_0'));
    });

    it('walks out of the vault through the portal', async () => {
        await run(68);
        // portal_red_0 is in the vault wall facing +Y; walk into it.
        const red = named('portal_red_0').origin;
        player.teleport([red[0], red[1] + 40, 160]);
        await run(2, { ...idle, forward: 1, yaw: -90 });
        // Out of portal_blue_0 (facing +X) and still walking on, the view turned with the portal.
        const blue = named('portal_blue_0').origin;
        expect(player.origin[0]).toBeGreaterThan(blue[0] + 16);
        expect(Math.hypot(player.origin[0] - blue[0], player.origin[1] - blue[1])).toBeLessThan(300);
        expect(collision.trace(player.origin, player.origin, player.mins, player.maxs).startSolid).toBe(false);
    });

    it('climbs out of the floor when it ends up a little inside it (CheckStuck)', async () => {
        // Bypass teleport's own unstick: as if a prop's collision had loaded around the player.
        player.origin = [-640, -900, 126];
        const stuck = () => collision.trace(player.origin, player.origin, player.mins, player.maxs).startSolid;
        expect(stuck()).toBe(true);
        await run(0.1);
        expect(stuck()).toBe(false);
        expect(player.origin[2]).toBeGreaterThanOrEqual(128);
        expect(player.origin[2]).toBeLessThan(140);
    });

    it('snaps a map portal onto its wall when the mapper angles face along it', () => {
        // portal_blue_2 is "0 270 0" in the map, but sits on a wall facing +X.
        const e = named('portal_blue_2');
        portals.setActivatedState(e, true);
        const p = portals.portals.find((q) => q.key === e)!;
        expect(p.angles[1]).toBeCloseTo(0, 3);
        expect(new THREE.Vector3().setFromMatrixColumn(p.matrix, 0).x).toBeCloseTo(1, 3);
    });

    describe('portal gun placement (portal_placement.cpp)', () => {
        const fire = (pitch: number, yaw: number, color: 0 | 1 = 0) => {
            const env = placementEnv(game, portals, game.ctx.bsp);
            const r = traceFirePortal(env, portals.findPortal(color, 0)?.key ?? null, player.eye(), angleVector([pitch, yaw, 0]));
            if (r.success >= 0.5) portals.placeGunPortal(color, r.origin, r.angles);
            return { ...r, forward: angleVectors(r.angles).forward };
        };
        beforeEach(() => player.teleport([-544, -800, 129])); // the box room, floor at z 128

        it('puts a wall portal where the shot lands, facing back at the shooter', () => {
            const r = fire(0, 0);
            expect(r.success).toBeGreaterThanOrEqual(0.5);
            expect(r.origin[0]).toBeCloseTo(-384, 0);
            expect(r.forward[0]).toBeCloseTo(-1, 3);
        });

        it('bumps a low wall shot up so the portal sits on the floor', () => {
            const r = fire(15, 0); // lands about 150 up: the portal would poke 32 into the floor
            expect(r.success).toBeGreaterThanOrEqual(0.5);
            expect(r.origin[2]).toBeCloseTo(128 + 54, 0);
        });

        it('lays floor portals flat, facing up', () => {
            const r = fire(70, -90);
            expect(r.success).toBeGreaterThanOrEqual(0.5);
            expect(r.forward[2]).toBeCloseTo(1, 3);
            expect(r.origin[2]).toBeCloseTo(128, 0);
        });

        it('slides a second portal off the first when the shot half overlaps it', () => {
            player.teleport([-544, -880, 129]);
            const blue = fire(0, 0, 0);
            player.teleport([-544, -850, 129]);
            const orange = fire(0, 0, 1);
            expect(orange.success).toBeGreaterThanOrEqual(0.5);
            expect(Math.abs(orange.origin[1] - blue.origin[1])).toBeGreaterThanOrEqual(64);
        });

        it('fizzles a shot right on top of the other portal (the slide would be too far)', () => {
            player.teleport([-544, -880, 129]);
            fire(0, 0, 0);
            const orange = fire(0, 0, 1);
            expect(orange.success).toBeLessThan(0.5);
            expect(portals.findPortal(1, 0)?.active ?? false).toBe(false);
        });
    });

    it('floor button opens the exit doors while stood on, and the doors block when closed', async () => {
        const door = named('exit_door_left_a00');
        const closed = [...door.origin];
        // The closed door blocks a walk from the button room into the exit corridor.
        player.teleport([-800, -864, 130]);
        await run(2, { ...idle, forward: 1, yaw: 180 });
        expect(player.origin[0]).toBeGreaterThan(-912 + 16);

        const button = named('floor_button_trigger_player_a00') as GameEntity;
        const b = button.brushBounds()!;
        player.teleport([(b.mins[0] + b.maxs[0]) / 2, (b.mins[1] + b.maxs[1]) / 2, b.maxs[2] + 2]);
        await run(2);
        expect(Math.hypot(door.origin[0] - closed[0], door.origin[1] - closed[1])).toBeGreaterThan(20);
        expect(named('floor_button_door_a00').origin[2]).toBeLessThan(named('floor_button_door_a00').spawnOrigin[2] - 1);

        player.teleport([-700, -864, 130]);
        await run(2);
        expect(Math.hypot(door.origin[0] - closed[0], door.origin[1] - closed[1])).toBeLessThan(1);
    });

    it('the closing first door waits for a player standing in the doorway instead of trapping them', async () => {
        player.teleport([-500, -728, 129]); // in the doorway, already inside the close trigger
        await run(1.5);
        const stuck = () => collision.trace(player.origin, player.origin, player.mins, player.maxs).startSolid;
        expect(stuck()).toBe(false);
        await run(1, { ...idle, forward: 1, yaw: -90 });
        expect(stuck()).toBe(false);
        expect(player.origin[1]).toBeLessThan(-760);
        await run(1);
        expect(named('door_left_a00').origin[0]).toBeCloseTo(named('door_left_a00').spawnOrigin[0], 0);
    });

    it('drops exactly one new cube per drop, and it reaches the floor', async () => {
        const boxes = () => game.entities.filter((e): e is PhysProp => e instanceof PhysProp && !e.removed);
        await run(1); // the intro fills both box makers
        const before = boxes().length;
        player.teleport([-544, -800, 130]);
        await run(8);
        // The dropped box lands; the dropper refills with one copy, not a copy of every box.
        expect(boxes().length).toBe(before + 1);
        expect(boxes().filter((b) => b.ready && b.center[2] < 160 && Math.hypot(b.center[0] + 830, b.center[1] + 1054) < 64)).toHaveLength(1);
    });

    describe('rigid-body physics', () => {
        // The cube left in the dropper by the template, moved into the box room (floor at z 128).
        const cube = () => named('box') as PhysProp;
        const settle = async (at: Vec3) => {
            await run(0.2); // its hulls load asynchronously
            cube().setOrigin(at);
            await run(1.5);
        };

        it('lands and rests flat on the floor', async () => {
            await settle([-640, -900, 260]);
            expect(cube().center[2]).toBeGreaterThan(140);
            expect(cube().center[2]).toBeLessThan(160);
            expect(cube().rigid!.body.isSleeping() || Math.hypot(...Object.values(cube().rigid!.body.linvel())) < 1).toBe(true);
        });

        it('gets shoved along when the player walks into it', async () => {
            await settle([-640, -900, 150]);
            const x0 = cube().center[0];
            player.teleport([-560, -900, 129]);
            await run(1.5, { ...idle, forward: 1, yaw: 180 });
            expect(cube().center[0]).toBeLessThan(x0 - 20);
        });

        it('stays held when the player carries it through a portal', async () => {
            await run(2); // the intro closes portal_blue_0/portal_red_0, which the gun reuses
            const env = placementEnv(game, portals, game.ctx.bsp);
            player.teleport([-544, -900, 129]);
            // East wall, facing west, aimed low so it sits on the floor and can be walked into.
            const blue = traceFirePortal(env, null, player.eye(), angleVector([15, 0, 0]));
            portals.placeGunPortal(0, blue.origin, blue.angles);
            const orange = traceFirePortal(env, null, player.eye(), angleVector([0, -90, 0])); // south wall, facing north
            portals.placeGunPortal(1, orange.origin, orange.angles);
            expect(blue.success >= 0.5 && orange.success >= 0.5).toBe(true);

            await settle([-600, -900, 150]);
            player.teleport([-660, -900, 129]);
            const view = game.ctx.view;
            view.yaw = 0;
            view.pitch = 20;
            cube().pickUp();
            await run(0.5, { ...idle, yaw: 0 });
            // Walk east into the blue portal and out of the orange one.
            let crossed = false;
            for (let t = 0; t < 3 && !crossed; t += 0.05) {
                const before: Vec3 = [...player.origin];
                await run(0.05, { ...idle, forward: 1, yaw: view.yaw });
                crossed = Math.hypot(player.origin[0] - before[0], player.origin[1] - before[1]) > 100;
            }
            expect(crossed, 'went through').toBe(true);
            await run(1.5, { ...idle, yaw: view.yaw });
            expect(cube().held, 'still carrying it').toBe(true);
            const c = cube().center, e = player.eye();
            expect(Math.hypot(c[0] - e[0], c[1] - e[1]), 'brought it along').toBeLessThan(140);
        });

        it('falls into a floor portal and is thrown out of the wall portal', async () => {
            // The gun's portals are the map's portal_blue_0/portal_red_0, which the intro closes early on.
            await run(2);
            const env = placementEnv(game, portals, game.ctx.bsp);
            player.teleport([-640, -900, 129]);
            const blue = traceFirePortal(env, null, player.eye(), angleVector([89, 0, 0]));
            portals.placeGunPortal(0, blue.origin, blue.angles);
            // (Not from the doorway: its trigger fizzles portal_blue_0, which the gun's blue portal is.)
            player.teleport([-544, -900, 129]);
            const orange = traceFirePortal(env, null, player.eye(), angleVector([0, 0, 0]));
            portals.placeGunPortal(1, orange.origin, orange.angles);
            player.teleport([-500, -1050, 129]); // out of the way

            await run(0.2);
            cube().setOrigin([blue.origin[0], blue.origin[1], 300]);
            let nearest = Infinity;
            for (let t = 0; t < 2; t += 0.05) {
                await run(0.05);
                const c = cube().center;
                nearest = Math.min(nearest, Math.hypot(c[0] - orange.origin[0], c[1] - orange.origin[1], c[2] - orange.origin[2]));
            }
            expect(nearest, 'came out of the orange portal').toBeLessThan(48);
            // Thrown out into the room, not left inside the wall or under the floor.
            expect(cube().center[0]).toBeLessThan(orange.origin[0] - 30);
            expect(cube().center[2]).toBeGreaterThan(120);
        });
    });

    it('drops the cube, which can be carried onto the button to hold the doors open', async () => {
        // Entering the button room closes the door behind and drops a box after 2 s.
        player.teleport([-544, -800, 130]);
        await run(6);
        const boxes = () => game.entities.filter((e): e is PhysProp => e instanceof PhysProp && !e.removed && e.ready);
        const landed = boxes().find((bx) => bx.name === 'box' && bx.center[2] < 200);
        expect(landed, 'a box reached the floor').toBeDefined();

        // Walk up to the cube, look down at it and pick it up.
        const view = game.ctx.view;
        const face = (x: number, y: number) => (view.yaw = (Math.atan2(y - player.origin[1], x - player.origin[0]) * 180) / Math.PI);
        player.teleport([landed!.center[0] + 64, landed!.center[1], 129]);
        face(landed!.center[0], landed!.center[1]);
        view.pitch = 30;
        landed!.pickUp();
        await run(0.5, { ...idle, yaw: view.yaw });
        expect(landed!.held, 'still holding it').toBe(true);

        // Carry it to the button, then hold it over the button and let go.
        const button = named('floor_button_trigger_box_a00').brushBounds()!;
        const bx = (button.mins[0] + button.maxs[0]) / 2, by = (button.mins[1] + button.maxs[1]) / 2;
        view.pitch = 20;
        for (let t = 0; t < 6 && Math.hypot(landed!.center[0] - bx, landed!.center[1] - by) > 8; t += 0.1) {
            const near = Math.hypot(player.origin[0] - bx, player.origin[1] - by) < 70;
            await run(0.1, { ...idle, forward: near ? 0 : 1, yaw: face(bx, by) });
        }
        expect(landed!.held, 'carried it all the way').toBe(true);
        landed!.drop();
        await run(3);
        const door = named('exit_door_left_a00');
        expect(Math.hypot(door.origin[0] - door.spawnOrigin[0], door.origin[1] - door.spawnOrigin[1])).toBeGreaterThan(20);
    });
});
