// Player physics against testchmb_a_00 (skipped without the game install).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BspFile } from '../src/bsp/bsp';
import { parseEntities, parseVec3 } from '../src/bsp/entities';
import { parseStaticProps } from '../src/bsp/props';
import { GameFS } from '../src/fs/gamefs';
import type { ByteSource } from '../src/fs/source';
import { parsePhy } from '../src/model/phy';
import { CollisionWorld, type Vec3 } from '../src/physics/collision';
import { Player, type PlayerInput } from '../src/physics/player';

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

function run(p: Player, seconds: number, input: PlayerInput, onTick?: () => void) {
    for (let t = 0; t < seconds; t += 1 / 66) {
        p.update(1 / 66, input);
        onTick?.();
    }
}

describe.skipIf(!haveGame)('player physics', () => {
    let world: CollisionWorld;
    let spawn: Vec3;

    beforeAll(async () => {
        const gfs = new GameFS(new DiskSource());
        await gfs.mount(['portal/maps/testchmb_a_00.bsp']);
        const bsp = new BspFile((await gfs.read('maps/testchmb_a_00.bsp'))!);
        const entities = parseEntities(bsp.entitiesText);
        world = new CollisionWorld(bsp, entities);
        // Static prop hulls (no rotation needed for this check beyond yaw).
        for (const sp of parseStaticProps(bsp)) {
            if (!sp.solid) continue;
            const phy = await gfs.read(sp.model.replace(/\.mdl$/, '.phy'));
            if (!phy) continue;
            const yaw = (sp.angles[1] * Math.PI) / 180;
            for (const h of parsePhy(phy)) {
                const pts = h.points.map((p): Vec3 => [
                    sp.origin[0] + p[0] * Math.cos(yaw) - p[1] * Math.sin(yaw),
                    sp.origin[1] + p[0] * Math.sin(yaw) + p[1] * Math.cos(yaw),
                    sp.origin[2] + p[2],
                ]);
                world.addHull(pts, h.triangles);
            }
        }
        spawn = parseVec3(entities.find((e) => e.classname === 'info_player_start')!.origin);
    });

    it('lands on the floor and stays there', () => {
        const p = new Player(world, [spawn[0], spawn[1], spawn[2] + 40]);
        run(p, 2, idle);
        expect(p.onGround).toBe(true);
        expect(Math.abs(p.origin[2] - 160)).toBeLessThan(2); // vault floor height
        expect(Math.hypot(...p.velocity)).toBeLessThan(1);
    });

    it('is stopped by the vault walls', () => {
        const p = new Player(world, spawn);
        for (const yaw of [0, 90, 180, 270]) {
            p.teleport(spawn);
            run(p, 4, { ...idle, forward: 1, yaw });
            // The relaxation vault is about 320 units across; you can't leave it on foot.
            expect(Math.hypot(p.origin[0] - spawn[0], p.origin[1] - spawn[1])).toBeLessThan(260);
            expect(p.onGround).toBe(true);
        }
    });

    it('walks at max speed and jumps about 45 units high', () => {
        // Open floor of the first test room (button room), facing its far wall.
        const p = new Player(world, [-640, -1000, 140]);
        run(p, 0.5, idle);
        let topSpeed = 0;
        run(p, 0.6, { ...idle, forward: 1, yaw: 180 }, () => (topSpeed = Math.max(topSpeed, Math.hypot(p.velocity[0], p.velocity[1]))));
        expect(topSpeed).toBeGreaterThan(170);
        expect(topSpeed).toBeLessThan(180);

        p.teleport(spawn);
        run(p, 0.5, idle);
        const floor = p.origin[2];
        let peak = floor;
        run(p, 1, { ...idle, jump: true }, () => (peak = Math.max(peak, p.origin[2])));
        expect(peak - floor).toBeGreaterThan(43);
        expect(peak - floor).toBeLessThan(47);
        expect(p.onGround).toBe(true);
    });

    it('collides with prop hulls', () => {
        // A box hull dropped in the player's path must stop them.
        const c: Vec3 = [spawn[0] - 60, spawn[1], 160];
        const pts: Vec3[] = [];
        for (const x of [-10, 10]) for (const y of [-40, 40]) for (const z of [0, 80]) pts.push([c[0] + x, c[1] + y, c[2] + z]);
        const tris: [number, number, number][] = [
            [0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
            [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3],
        ];
        world.addHull(pts, tris);
        const p = new Player(world, spawn);
        run(p, 2, { ...idle, forward: 1, yaw: 180 });
        expect(p.origin[0]).toBeGreaterThan(c[0] + 10 + 16 - 1);
    });
});
