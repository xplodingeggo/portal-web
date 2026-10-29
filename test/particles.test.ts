// Particle definitions from the game's .pcf files: parsing and simulating every system
// (skipped without the game install).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameFS } from '../src/fs/gamefs';
import type { ByteSource } from '../src/fs/source';
import { parsePcf, type ParticleDef } from '../src/particles/pcf';
import { parseSheet } from '../src/particles/sheet';
import { ParticleSystem } from '../src/particles/system';
import { fireballDef, flashDef, jetDef, smokeDef, smokeVolumeDef, sparkDef } from '../src/particles/envfx';

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

describe.skipIf(!haveGame)('particles', () => {
    const load = async () => {
        const gfs = new GameFS(new DiskSource());
        await gfs.mount([]);
        const defs = new Map<string, ParticleDef>();
        for (const f of gfs.list('particles/', '.pcf')) {
            if (f.includes('_dx80')) continue;
            for (const [n, d] of parsePcf((await gfs.read(f))!)) defs.set(n, d);
        }
        return { gfs, defs };
    };

    it('parses the game systems, with their operators and children', async () => {
        const { defs } = await load();
        expect(defs.size).toBeGreaterThan(300);
        const stream = defs.get('portal_1_projectile_stream')!;
        expect(stream.attrs.get('material')).toBe('effects\\energyball.vmt');
        expect(stream.children.length).toBeGreaterThan(3);
        expect(defs.get('portal_1_edge')!.renderers[0].fn).toBe('render_sprite_trail');
    });

    it('runs every system without non-finite particles', async () => {
        const { defs } = await load();
        const env = { find: (n: string) => defs.get(n) };
        for (const [name, def] of defs) {
            const s = new ParticleSystem(def, env, undefined, 1);
            s.setControlPoint(0, [0, 0, 0]);
            for (let i = 0; i < 60; i++) s.step(1 / 60);
            for (const p of s.particles) {
                expect(Number.isFinite(p.pos[0] + p.pos[1] + p.pos[2] + p.alpha + p.radius), name).toBe(true);
            }
        }
    });

    it('emits and ends a one-shot effect', async () => {
        const { defs } = await load();
        const s = new ParticleSystem(defs.get('portal_1_close')!, { find: (n) => defs.get(n) }, undefined, 1);
        s.step(1 / 60);
        expect(s.particles.length + s.children.length).toBeGreaterThan(0);
        for (let i = 0; i < 600 && !s.done; i++) s.step(1 / 30);
        expect(s.done).toBe(true);
    });

    it('reads sprite sheets from particle textures', async () => {
        const { gfs } = await load();
        const sheet = parseSheet((await gfs.read('materials/particle/smoke1/smoke1.vtf'))!)!;
        expect(sheet.sequences.size).toBeGreaterThan(1);
        const [u0, v0, u1, v1] = sheet.sequences.get(0)!.frames[0].rect;
        expect(u1).toBeGreaterThan(u0);
        expect(v1).toBeGreaterThan(v0);
    });

    it('runs the code-built effect systems', () => {
        const defs = [
            jetDef('steam', { speed: 120, spread: 15, rate: 26, length: 80, startSize: 10, endSize: 25, roll: 8, alpha: 0.5 }),
            sparkDef('spark', 2, 2, false),
            sparkDef('spark_dir', 3, 1, true),
            fireballDef('fire', 100),
            smokeDef('smoke', 40, 10, 2.5, 30),
            flashDef('flash', 30, 0.3, [255, 200, 100]),
            smokeVolumeDef('volume', [100, 100, 50], 80, 10, [255, 255, 255]),
        ];
        for (const def of defs) {
            const s = new ParticleSystem(def, { find: () => undefined }, undefined, 3);
            s.setControlPoint(0, [10, 20, 30], [1, 0, 0], [0, 0, 1]);
            let seen = 0;
            for (let i = 0; i < 180; i++) {
                s.step(1 / 60);
                seen = Math.max(seen, s.particles.length);
                for (const p of s.particles) expect(Number.isFinite(p.pos[0] + p.pos[1] + p.pos[2] + p.alpha + p.radius), def.name).toBe(true);
            }
            expect(seen, def.name).toBeGreaterThan(0);
        }
        // A jet's puffs travel along the control point's forward and grow.
        const s = new ParticleSystem(defs[0], { find: () => undefined }, undefined, 3);
        s.setControlPoint(0, [0, 0, 0], [0, 0, 1], [1, 0, 0]);
        for (let i = 0; i < 30; i++) s.step(1 / 60);
        const top = s.particles.reduce((a, p) => (p.pos[2] > a.pos[2] ? p : a));
        expect(top.pos[2]).toBeGreaterThan(30);
        expect(top.radius).toBeGreaterThan(10);
    });
});
