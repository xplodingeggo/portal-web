// Turns BSP faces into triangle lists grouped by material, with texture UVs,
// lightmap atlas UVs and (for displacements) a blend alpha per vertex.
import { BspFile, SurfFlags, type Face } from './bsp';
import { buildLightmapAtlas, type LightmapAtlas } from './lightmap';
import { parseEntities, parseVec3, type Entity } from './entities';
import { buildOverlays } from './overlays';

export interface MaterialBatch {
    material: string; // lowercase, without "materials/" or ".vmt"
    positions: Float32Array;
    uvs: Float32Array;
    lightmapUVs: Float32Array;
    alphas: Float32Array;
    faceCount: number;
    /** Set for overlay (decal) batches: draw on top of the world, in this order. */
    overlayOrder?: number;
    /** Set for brush entity batches: index into WorldMesh.entities. Positions are then relative to the entity origin. */
    entityIndex?: number;
}

export interface WorldMesh {
    batches: MaterialBatch[];
    lightmap: LightmapAtlas;
    entities: Entity[];
}

/** Brush entity classes that draw their geometry (triggers and volumes don't). */
const VISIBLE_BRUSH_CLASSES = /^func_(brush|wall|wall_toggle|illusionary|detail|door|door_rotating|movelinear|rotating|tracktrain|train|button|breakable|breakable_surf|physbox|physbox_multiplayer|lod|reflective_glass|water_analog|conveyor|guntarget)$/;

const SKIP_FLAGS = SurfFlags.Sky | SurfFlags.Sky2D | SurfFlags.NoDraw | SurfFlags.Trigger | SurfFlags.Hint | SurfFlags.Skip;

class Builder {
    constructor(readonly material: string, readonly entity?: number) {}
    positions: number[] = [];
    uvs: number[] = [];
    lightmapUVs: number[] = [];
    alphas: number[] = [];
    faceCount = 0;
}

export function buildWorldMesh(bsp: BspFile): WorldMesh {
    const entities = parseEntities(bsp.entitiesText);

    // World is model 0; visible brush entities reference "*N" and get their own batches,
    // in entity-local coordinates, so map logic can move or hide them.
    const instances: { model: number; origin: [number, number, number]; entity?: number }[] = [{ model: 0, origin: [0, 0, 0] }];
    entities.forEach((e, index) => {
        const m = /^\*(\d+)$/.exec(e.model ?? '');
        if (!m || !VISIBLE_BRUSH_CLASSES.test(e.classname ?? '')) return;
        if (e.rendermode === '10') return;
        instances.push({ model: Number(m[1]), origin: parseVec3(e.origin), entity: index });
    });

    const drawable = (i: number) => {
        const f = bsp.faces[i];
        if (f.texInfo < 0) return false;
        const ti = bsp.texInfos[f.texInfo];
        if (ti.flags & SKIP_FLAGS) return false;
        return !bsp.texDatas[ti.texData].name.toLowerCase().startsWith('tools/');
    };

    const faceSet = new Set<number>();
    for (const inst of instances) {
        const model = bsp.models[inst.model];
        if (!model) continue;
        for (let i = model.firstFace; i < model.firstFace + model.numFaces; i++) if (drawable(i)) faceSet.add(i);
    }
    const lightmap = buildLightmapAtlas(bsp, [...faceSet]);

    const builders = new Map<string, Builder>();
    const faceOrigins = new Map<number, Vec3>();
    for (const inst of instances) {
        const model = bsp.models[inst.model];
        if (!model) continue;
        for (let i = model.firstFace; i < model.firstFace + model.numFaces; i++) {
            if (!faceSet.has(i)) continue;
            faceOrigins.set(i, inst.origin);
            const face = bsp.faces[i];
            const name = bsp.texDatas[bsp.texInfos[face.texInfo].texData].name.toLowerCase();
            const key = `${inst.entity ?? ''}|${name}`;
            let b = builders.get(key);
            if (!b) builders.set(key, (b = new Builder(name, inst.entity)));
            const origin: Vec3 = inst.entity === undefined ? inst.origin : [0, 0, 0];
            if (face.dispInfo >= 0) emitDisplacement(bsp, face, i, lightmap, origin, b);
            else emitFace(bsp, face, i, lightmap, origin, b);
            b.faceCount++;
        }
    }

    const batches: MaterialBatch[] = [];
    for (const b of builders.values()) {
        batches.push({
            material: b.material,
            entityIndex: b.entity,
            positions: new Float32Array(b.positions),
            uvs: new Float32Array(b.uvs),
            lightmapUVs: new Float32Array(b.lightmapUVs),
            alphas: new Float32Array(b.alphas),
            faceCount: b.faceCount,
        });
    }
    batches.push(...buildOverlays(bsp, lightmap, faceOrigins));
    return { batches, lightmap, entities };
}

export type Vec3 = [number, number, number];

/** Computes texture and lightmap UVs for a model-space point on a face. */
export function surfaceUV(bsp: BspFile, face: Face, faceIndex: number, lm: LightmapAtlas, p: Vec3) {
    const ti = bsp.texInfos[face.texInfo];
    const td = bsp.texDatas[ti.texData];
    const tv = ti.textureVecs;
    const lv = ti.lightmapVecs;
    const u = (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2] + tv[3]) / td.width;
    const v = (tv[4] * p[0] + tv[5] * p[1] + tv[6] * p[2] + tv[7]) / td.height;
    const rect = lm.rects.get(faceIndex);
    if (!rect) return [u, v, lm.white.u, lm.white.v];
    const ls = lv[0] * p[0] + lv[1] * p[1] + lv[2] * p[2] + lv[3] - face.lightmapMins[0];
    const lt = lv[4] * p[0] + lv[5] * p[1] + lv[6] * p[2] + lv[7] - face.lightmapMins[1];
    return [u, v, (rect.x + ls + 0.5) / lm.width, (rect.y + lt + 0.5) / lm.height];
}

function emitFace(bsp: BspFile, face: Face, faceIndex: number, lm: LightmapAtlas, origin: Vec3, b: Builder) {
    const idx = bsp.faceVertexIndices(face);
    const verts = idx.map((vi): Vec3 => [bsp.vertices[vi * 3], bsp.vertices[vi * 3 + 1], bsp.vertices[vi * 3 + 2]]);
    const push = (p: Vec3) => {
        // UVs come from model-local positions; the instance origin only moves the result.
        const [u, v, lu, lv] = surfaceUV(bsp, face, faceIndex, lm, p);
        b.positions.push(p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]);
        b.uvs.push(u, v);
        b.lightmapUVs.push(lu, lv);
        b.alphas.push(1);
    };
    // Source winds front faces clockwise; emit a reversed fan for counter-clockwise front faces.
    for (let i = 1; i < verts.length - 1; i++) {
        push(verts[0]);
        push(verts[i + 1]);
        push(verts[i]);
    }
}

function emitDisplacement(bsp: BspFile, face: Face, faceIndex: number, lm: LightmapAtlas, origin: Vec3, b: Builder) {
    const disp = bsp.dispInfos[face.dispInfo];
    const idx = bsp.faceVertexIndices(face);
    if (idx.length !== 4) return;
    let corners = idx.map((vi): Vec3 => [bsp.vertices[vi * 3], bsp.vertices[vi * 3 + 1], bsp.vertices[vi * 3 + 2]]);

    // The displacement grid starts at the corner nearest its recorded start position.
    let best = 0;
    let bestDist = Infinity;
    corners.forEach((c, i) => {
        const d = (c[0] - disp.startPosition[0]) ** 2 + (c[1] - disp.startPosition[1]) ** 2 + (c[2] - disp.startPosition[2]) ** 2;
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    });
    corners = [...corners.slice(best), ...corners.slice(0, best)];

    const n = (1 << disp.power) + 1;
    const lerp = (a: Vec3, c: Vec3, t: number): Vec3 => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
    const rect = lm.rects.get(faceIndex);

    const grid: { pos: Vec3; uv: number[]; alpha: number }[] = [];
    for (let y = 0; y < n; y++) {
        const ty = y / (n - 1);
        const left = lerp(corners[0], corners[1], ty);
        const right = lerp(corners[3], corners[2], ty);
        for (let x = 0; x < n; x++) {
            const tx = x / (n - 1);
            const base = lerp(left, right, tx);
            const dv = (disp.dispVertStart + y * n + x) * 5;
            const dist = bsp.dispVerts[dv + 3];
            const pos: Vec3 = [
                base[0] + bsp.dispVerts[dv] * dist,
                base[1] + bsp.dispVerts[dv + 1] * dist,
                base[2] + bsp.dispVerts[dv + 2] * dist,
            ];
            const [u, v] = surfaceUV(bsp, face, faceIndex, lm, base);
            const uv = rect
                ? [u, v, (rect.x + tx * face.lightmapSize[0] + 0.5) / lm.width, (rect.y + ty * face.lightmapSize[1] + 0.5) / lm.height]
                : [u, v, lm.white.u, lm.white.v];
            grid.push({ pos, uv, alpha: bsp.dispVerts[dv + 4] / 255 });
        }
    }

    const push = (g: (typeof grid)[number]) => {
        b.positions.push(g.pos[0] + origin[0], g.pos[1] + origin[1], g.pos[2] + origin[2]);
        b.uvs.push(g.uv[0], g.uv[1]);
        b.lightmapUVs.push(g.uv[2], g.uv[3]);
        b.alphas.push(g.alpha);
    };
    for (let y = 0; y < n - 1; y++) {
        for (let x = 0; x < n - 1; x++) {
            const a = grid[y * n + x];
            const c = grid[y * n + x + 1];
            const d = grid[(y + 1) * n + x];
            const e = grid[(y + 1) * n + x + 1];
            push(a), push(d), push(c);
            push(c), push(d), push(e);
        }
    }
}
