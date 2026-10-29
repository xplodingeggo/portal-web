// Integration tests against the user's own Portal install (skipped if absent).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BspFile } from '../src/bsp/bsp';
import { buildWorldMesh } from '../src/bsp/mesh';
import { parseStaticProps } from '../src/bsp/props';
import { loadStudioModel, meshMaterialCandidates, parseVhv } from '../src/model/studio';
import { GameFS } from '../src/fs/gamefs';
import type { ByteSource } from '../src/fs/source';
import { loadMaterial } from '../src/material/vmt';
import { decodeDXT, parseVtf } from '../src/material/vtf';

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

describe.skipIf(!haveGame)('Portal game files', () => {
    let gfs: GameFS;
    let bsp: BspFile;

    beforeAll(async () => {
        gfs = new GameFS(new DiskSource());
        await gfs.mount(['portal/maps/testchmb_a_00.bsp']);
        bsp = new BspFile((await gfs.read('maps/testchmb_a_00.bsp'))!);
        gfs.setPakfile(bsp.pakfile);
    });

    it('resolves files through the VPKs', () => {
        expect(gfs.exists('materials/metal/metalwall048b.vmt')).toBe(true);
        expect(gfs.exists('materials/does/not/exist.vmt')).toBe(false);
    });

    it('parses the BSP', () => {
        expect(bsp.version).toBe(20);
        expect(bsp.faces.length).toBe(2694);
        expect(bsp.models.length).toBeGreaterThan(1);
        expect(bsp.texDatas.some((t) => t.name === 'CONCRETE/CONCRETE_MODULAR_FLOOR001A')).toBe(true);
    });

    it('builds a world mesh with a lightmap and a player start', () => {
        const world = buildWorldMesh(bsp);
        expect(world.batches.length).toBeGreaterThan(10);
        expect(world.batches.every((b) => b.positions.length === b.uvs.length * 1.5)).toBe(true);
        expect(world.lightmap.rects.size).toBeGreaterThan(100);
        const overlays = world.batches.filter((b) => b.overlayOrder !== undefined);
        expect(overlays.map((b) => b.material)).toContain('signage/signage_overlay_boxdispenser');
        expect(overlays.every((b) => b.positions.length > 0 && b.positions.length % 9 === 0)).toBe(true);
        expect(world.entities.some((e) => e.classname === 'info_player_start')).toBe(true);
    });

    it('resolves pakfile patch materials and every world material', async () => {
        const world = buildWorldMesh(bsp);
        const missing: string[] = [];
        for (const b of world.batches) {
            const def = await loadMaterial(gfs, b.material);
            if (!def) missing.push(b.material);
            else if (def.params.$basetexture && !gfs.exists(`materials/${def.params.$basetexture}.vtf`)) {
                missing.push(`${b.material} -> ${def.params.$basetexture}`);
            }
        }
        expect(missing).toEqual([]);
        const patched = world.batches.find((b) => b.material.startsWith('maps/testchmb_a_00/'));
        if (patched) expect((await loadMaterial(gfs, patched.material))!.params.$envmap).toMatch(/^maps\/testchmb_a_00\//);
    });

    it('loads every prop model, and static prop lighting lines up with the meshes', async () => {
        const statics = parseStaticProps(bsp);
        expect(statics.length).toBe(53);
        const failed: string[] = [];
        let vhvMatched = 0;
        for (const p of statics) {
            const model = await loadStudioModel(gfs, p.model);
            if (!model || model.meshes.length === 0) {
                failed.push(p.model);
                continue;
            }
            const vhv = await gfs.read(`sp_${p.index}.vhv`);
            if (vhv && parseVhv(vhv, model)) vhvMatched++;
            for (const m of model.meshes) {
                expect(m.positions.length / 3).toBe(m.normals.length / 3);
                expect(Math.max(...m.indices)).toBeLessThan(m.positions.length / 3);
            }
        }
        expect(failed).toEqual([]);
        expect(vhvMatched).toBe(53);

        const bed = await loadStudioModel(gfs, 'models/props/bed_body_reference.mdl');
        expect(bed!.mdl.textures.length).toBeGreaterThan(0);
        expect(meshMaterialCandidates(bed!.mdl, 0, bed!.meshes[0].skinRef).some((c) => gfs.exists(`materials/${c}.vmt`))).toBe(true);
    });

    it('decodes a world texture', async () => {
        const def = await loadMaterial(gfs, 'concrete/concrete_modular_floor001a');
        const vtf = parseVtf((await gfs.read(`materials/${def!.params.$basetexture}.vtf`))!);
        expect(vtf.width).toBeGreaterThan(0);
        expect(vtf.mips[0].width).toBe(vtf.width);
        const rgba = vtf.compressed ? decodeDXT(vtf.format, vtf.mips[0].data, vtf.width, vtf.height) : vtf.mips[0].data;
        expect(rgba.length).toBe(vtf.width * vtf.height * 4);
        // A real texture is not one flat color.
        expect(new Set(Array.from(rgba.subarray(0, 4096))).size).toBeGreaterThan(8);
    });
});
