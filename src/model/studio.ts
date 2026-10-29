// Combines .mdl + .vvd + .dx90.vtx into LOD 0 meshes, skinned to the first
// frame of a sequence (and re-skinnable for animation). Each mesh's vertices are emitted in strip-group order,
// which is also the order of per-vertex static prop lighting in .vhv files.
import type * as THREE from 'three';
import type { GameFS } from '../fs/gamefs';
import { parseMdl, type Mdl } from './mdl';
import { computePose, findSequence, isIdentityPose } from './pose';
import { parseVtx, type Vtx } from './vtx';
import { parseVvd, type Vvd } from './vvd';

export interface StudioMesh {
    bodyPart: number;
    model: number;
    skinRef: number;
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint16Array | Uint32Array;
    /** Source VVD vertex per mesh vertex, for re-skinning. */
    vertexIds: Uint32Array;
}

export interface StudioModel {
    path: string;
    mdl: Mdl;
    vvd: Vvd;
    meshes: StudioMesh[];
    /** Vertex counts in .vhv order (body part, model, LOD, mesh), for matching static prop lighting. */
    vhvLayout: { lod: number; vertexCount: number; meshIndex: number }[];
}

/** @param sequence sequence label to pose from (frame 0); defaults to sequence 0 */
export async function loadStudioModel(fs: GameFS, path: string, sequence?: string): Promise<StudioModel | null> {
    const base = path.toLowerCase().replace(/\.mdl$/, '');
    const [mdlBuf, vvdBuf, vtxBuf] = await Promise.all([
        fs.read(`${base}.mdl`),
        fs.read(`${base}.vvd`),
        fs.read(`${base}.dx90.vtx`).then((b) => b ?? fs.read(`${base}.vtx`)),
    ]);
    if (!mdlBuf || !vvdBuf || !vtxBuf) return null;
    const mdl = parseMdl(mdlBuf);
    const model = buildStudioModel(`${base}.mdl`, mdl, parseVvd(vvdBuf), parseVtx(vtxBuf));
    if (mdl.bones.length) {
        const pose = computePose(mdl, findSequence(mdl, sequence), 0);
        if (!isIdentityPose(pose)) for (const m of model.meshes) skinMesh(model, m, pose, m.positions, m.normals);
    }
    return model;
}

/** Linear blend skinning of a mesh's vertices to a pose, written into the given arrays. */
export function skinMesh(model: StudioModel, mesh: StudioMesh, matrices: THREE.Matrix4[], positions: Float32Array, normals: Float32Array) {
    const vvd = model.vvd;
    for (let o = 0; o < mesh.vertexIds.length; o++) {
        const i = mesh.vertexIds[o];
        const [px, py, pz] = vvd.positions.subarray(i * 3, i * 3 + 3);
        const [nx, ny, nz] = vvd.normals.subarray(i * 3, i * 3 + 3);
        let x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
        let total = 0;
        for (let k = 0; k < 3; k++) {
            const w = vvd.boneWeights[i * 3 + k];
            const m = matrices[vvd.boneIds[i * 3 + k]];
            if (w <= 0 || !m) continue;
            const e = m.elements; // column-major
            x += w * (e[0] * px + e[4] * py + e[8] * pz + e[12]);
            y += w * (e[1] * px + e[5] * py + e[9] * pz + e[13]);
            z += w * (e[2] * px + e[6] * py + e[10] * pz + e[14]);
            a += w * (e[0] * nx + e[4] * ny + e[8] * nz);
            b += w * (e[1] * nx + e[5] * ny + e[9] * nz);
            c += w * (e[2] * nx + e[6] * ny + e[10] * nz);
            total += w;
        }
        if (total === 0) {
            positions.set([px, py, pz], o * 3);
            normals.set([nx, ny, nz], o * 3);
        } else {
            positions.set([x / total, y / total, z / total], o * 3);
            normals.set([a / total, b / total, c / total], o * 3);
        }
    }
}

function buildStudioModel(path: string, mdl: Mdl, vvd: Vvd, vtx: Vtx): StudioModel {
    const meshes: StudioMesh[] = [];
    const vhvLayout: StudioModel['vhvLayout'] = [];

    mdl.bodyParts.forEach((bp, b) => {
        bp.models.forEach((model, m) => {
            const vtxModel = vtx.bodyParts[b]?.models[m];
            if (!vtxModel) return;
            vtxModel.lods.forEach((lod, l) => {
                lod.meshes.forEach((groups, k) => {
                    const mesh = model.meshes[k];
                    const vertexCount = groups.reduce((n, g) => n + g.meshVertexIds.length, 0);
                    if (l > 0 || !mesh) {
                        vhvLayout.push({ lod: l, vertexCount, meshIndex: -1 });
                        return;
                    }
                    const positions = new Float32Array(vertexCount * 3);
                    const normals = new Float32Array(vertexCount * 3);
                    const uvs = new Float32Array(vertexCount * 2);
                    const vertexIds = new Uint32Array(vertexCount);
                    const indices: number[] = [];
                    let out = 0;
                    for (const g of groups) {
                        const groupBase = out;
                        for (const id of g.meshVertexIds) {
                            const src = model.vertexIndex + mesh.vertexOffset + id;
                            positions.set(vvd.positions.subarray(src * 3, src * 3 + 3), out * 3);
                            normals.set(vvd.normals.subarray(src * 3, src * 3 + 3), out * 3);
                            uvs.set(vvd.uvs.subarray(src * 2, src * 2 + 2), out * 2);
                            vertexIds[out] = src;
                            out++;
                        }
                        // Source front faces are clockwise; flip to counter-clockwise.
                        for (let i = 0; i + 2 < g.indices.length; i += 3) {
                            indices.push(groupBase + g.indices[i], groupBase + g.indices[i + 2], groupBase + g.indices[i + 1]);
                        }
                    }
                    vhvLayout.push({ lod: 0, vertexCount, meshIndex: meshes.length });
                    meshes.push({
                        bodyPart: b,
                        model: m,
                        skinRef: mesh.material,
                        positions,
                        normals,
                        uvs,
                        indices: vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
                        vertexIds,
                    });
                });
            });
        });
    });
    return { path, mdl, vvd, meshes, vhvLayout };
}

/** Material path candidates for a mesh's skin reference, in search order. */
export function meshMaterialCandidates(mdl: Mdl, skin: number, skinRef: number): string[] {
    const family = mdl.skinFamilies[skin] ?? mdl.skinFamilies[0];
    const tex = mdl.textures[family?.[skinRef] ?? skinRef];
    if (tex === undefined) return [];
    const dirs = mdl.textureDirs.length ? mdl.textureDirs : [''];
    return dirs.map((d) => d + tex);
}

/** Which model of each body part is visible for a given body group value. */
export function bodyGroupModel(mdl: Mdl, bodyPart: number, body: number): number {
    const bp = mdl.bodyParts[bodyPart];
    if (!bp || bp.models.length === 0) return 0;
    return Math.floor(body / Math.max(1, bp.base)) % bp.models.length;
}

/**
 * Per-vertex static prop lighting (.vhv), returned per StudioMesh index as
 * linear RGB, or null when the file doesn't match the model.
 */
export function parseVhv(buf: Uint8Array, model: StudioModel): Map<number, Float32Array> | null {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (v.getInt32(0, true) !== 2) return null;
    const vertexSize = v.getUint32(12, true);
    const numMeshes = v.getInt32(20, true);
    if (numMeshes !== model.vhvLayout.length || vertexSize !== 4) return null;

    const out = new Map<number, Float32Array>();
    for (let i = 0; i < numMeshes; i++) {
        const h = 40 + i * 28;
        const lod = v.getUint32(h, true);
        const count = v.getUint32(h + 4, true);
        const offset = v.getUint32(h + 8, true);
        const layout = model.vhvLayout[i];
        if (layout.lod !== lod || layout.vertexCount !== count) return null;
        if (layout.meshIndex < 0) continue;
        const colors = new Float32Array(count * 3);
        for (let k = 0; k < count; k++) {
            // Stored as BGRA bytes holding gamma-space light at half intensity (2x overbright).
            const o = offset + k * 4;
            colors[k * 3] = vertexLightToLinear(buf[o + 2]);
            colors[k * 3 + 1] = vertexLightToLinear(buf[o + 1]);
            colors[k * 3 + 2] = vertexLightToLinear(buf[o]);
        }
        out.set(layout.meshIndex, colors);
    }
    return out;
}

/**
 * VHV bytes are gamma-encoded BGRA. The scale back to lightmap units was fitted on
 * testchmb_a_00: geometric mean of (nearby lightmap luxels / decoded vertex light)
 * over its 53 static props. The gamma decode fit better than a linear one.
 */
const VHV_SCALE = 3.26;

function vertexLightToLinear(b: number): number {
    return Math.pow(b / 255, 2.2) * VHV_SCALE;
}
