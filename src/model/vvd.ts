// Studio vertex data (.vvd): positions, normals, UVs and bone weights for LOD 0,
// with the fixup table applied. Layout follows the public Source SDK 2013 headers.
export interface Vvd {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    /** Up to 3 weights per vertex. */
    boneWeights: Float32Array;
    boneIds: Uint8Array;
    count: number;
}

const VERTEX_SIZE = 48; // bone weights (16), position (12), normal (12), uv (8)

export function parseVvd(buf: Uint8Array): Vvd {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (v.getUint32(0, true) !== 0x56534449) throw new Error('not a VVD'); // "IDSV"
    const lod0Count = v.getInt32(16, true);
    const numFixups = v.getInt32(48, true);
    const fixupStart = v.getInt32(52, true);
    const dataStart = v.getInt32(56, true);

    // Fixups remap LOD vertices into a contiguous list; for LOD 0 every fixup applies.
    const order: number[] = [];
    if (numFixups > 0) {
        for (let i = 0; i < numFixups; i++) {
            const f = fixupStart + i * 12;
            const src = v.getInt32(f + 4, true);
            const n = v.getInt32(f + 8, true);
            for (let k = 0; k < n; k++) order.push(src + k);
        }
    } else {
        for (let i = 0; i < lod0Count; i++) order.push(i);
    }

    const count = order.length;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const boneWeights = new Float32Array(count * 3);
    const boneIds = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
        const o = dataStart + order[i] * VERTEX_SIZE;
        const numBones = buf[o + 15];
        for (let k = 0; k < 3; k++) {
            boneWeights[i * 3 + k] = k < numBones ? v.getFloat32(o + k * 4, true) : 0;
            boneIds[i * 3 + k] = buf[o + 12 + k];
            positions[i * 3 + k] = v.getFloat32(o + 16 + k * 4, true);
            normals[i * 3 + k] = v.getFloat32(o + 28 + k * 4, true);
        }
        uvs[i * 2] = v.getFloat32(o + 40, true);
        uvs[i * 2 + 1] = v.getFloat32(o + 44, true);
    }
    return { positions, normals, uvs, boneWeights, boneIds, count };
}
