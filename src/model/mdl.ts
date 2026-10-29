// Studio model header (.mdl), version 44-48. Layouts follow the public
// Source SDK 2013 header studio.h. Reads materials, skins, the bodypart/model/mesh
// tree, bones, and the animation/sequence tables needed to pose a model.
export interface MdlBone {
    name: string;
    parent: number;
    pos: [number, number, number];
    quat: [number, number, number, number]; // x, y, z, w
    rot: [number, number, number]; // radian euler, same pose as quat
    posScale: [number, number, number];
    rotScale: [number, number, number];
    /** 3x4 row-major matrix from model space into this bone's space. */
    poseToBone: Float32Array;
}

export interface MdlAnim {
    name: string;
    flags: number;
    numFrames: number;
    fps: number;
    animBlock: number;
    /** Absolute offset of the first mstudioanim_t, when animBlock is 0. */
    dataOffset: number;
}

export interface MdlSequence {
    label: string;
    /** Activity name ("ACT_VM_PRIMARYATTACK"), or "" if none. */
    activity: string;
    flags: number; // 1 = looping
    /** Local animation indices; the first is the unblended pose. */
    anims: number[];
}

export interface MdlMesh {
    material: number; // skin reference
    vertexOffset: number; // into the model's vertices
    numVertices: number;
}

export interface MdlModel {
    name: string;
    vertexIndex: number; // first vertex in the VVD, as an index
    numVertices: number;
    meshes: MdlMesh[];
}

export interface MdlBodyPart {
    name: string;
    base: number;
    models: MdlModel[];
}

export interface MdlAttachment {
    name: string;
    bone: number;
    /** Row-major 3x4: attachment to bone. */
    local: Float32Array;
}

export interface Mdl {
    version: number;
    name: string;
    flags: number;
    illumPosition: [number, number, number];
    textures: string[];
    textureDirs: string[];
    /** skinFamilies[skin][skinRef] = texture index */
    skinFamilies: number[][];
    bodyParts: MdlBodyPart[];
    bones: MdlBone[];
    attachments: MdlAttachment[];
    anims: MdlAnim[];
    sequences: MdlSequence[];
    /** The whole file, for decoding animation data. */
    raw: Uint8Array;
}

const BONE_SIZE = 216;
const ANIMDESC_SIZE = 100;
const SEQDESC_SIZE = 212;
const MODEL_SIZE = 148;
const MESH_SIZE = 116;
const VERTEX_SIZE = 48;

export function parseMdl(buf: Uint8Array): Mdl {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (v.getUint32(0, true) !== 0x54534449) throw new Error('not a studio model'); // "IDST"
    const version = v.getInt32(4, true);
    if (version < 44 || version > 48) throw new Error(`unsupported MDL version ${version}`);

    const dec = new TextDecoder();
    const cstr = (o: number) => {
        let e = o;
        while (e < buf.length && buf[e] !== 0) e++;
        return dec.decode(buf.subarray(o, e));
    };
    const i32 = (o: number) => v.getInt32(o, true);

    const numTextures = i32(204);
    const textureIndex = i32(208);
    const textures: string[] = [];
    for (let i = 0; i < numTextures; i++) {
        const t = textureIndex + i * 64;
        textures.push(cstr(t + i32(t)).replace(/\\/g, '/').toLowerCase());
    }

    const textureDirs: string[] = [];
    for (let i = 0; i < i32(212); i++) {
        let d = cstr(i32(i32(216) + i * 4)).replace(/\\/g, '/').toLowerCase();
        if (d && !d.endsWith('/')) d += '/';
        textureDirs.push(d);
    }

    const numSkinRef = i32(220);
    const numFamilies = i32(224);
    const skinIndex = i32(228);
    const skinFamilies: number[][] = [];
    for (let f = 0; f < numFamilies; f++) {
        const fam: number[] = [];
        for (let r = 0; r < numSkinRef; r++) fam.push(v.getInt16(skinIndex + (f * numSkinRef + r) * 2, true));
        skinFamilies.push(fam);
    }

    const bodyParts: MdlBodyPart[] = [];
    for (let b = 0; b < i32(232); b++) {
        const bp = i32(236) + b * 16;
        const models: MdlModel[] = [];
        for (let m = 0; m < i32(bp + 4); m++) {
            const mo = bp + i32(bp + 12) + m * MODEL_SIZE;
            const meshes: MdlMesh[] = [];
            for (let k = 0; k < i32(mo + 72); k++) {
                const me = mo + i32(mo + 76) + k * MESH_SIZE;
                meshes.push({ material: i32(me), numVertices: i32(me + 8), vertexOffset: i32(me + 12) });
            }
            models.push({
                name: cstr(mo),
                numVertices: i32(mo + 80),
                vertexIndex: i32(mo + 84) / VERTEX_SIZE,
                meshes,
            });
        }
        bodyParts.push({ name: cstr(bp + i32(bp)), base: i32(bp + 8), models });
    }

    const f32 = (o: number) => v.getFloat32(o, true);
    const vec3 = (o: number): [number, number, number] => [f32(o), f32(o + 4), f32(o + 8)];

    const bones: MdlBone[] = [];
    for (let i = 0; i < i32(156); i++) {
        const b = i32(160) + i * BONE_SIZE;
        const poseToBone = new Float32Array(12);
        for (let k = 0; k < 12; k++) poseToBone[k] = f32(b + 96 + k * 4);
        bones.push({
            name: cstr(b + i32(b)),
            parent: i32(b + 4),
            pos: vec3(b + 32),
            quat: [f32(b + 44), f32(b + 48), f32(b + 52), f32(b + 56)],
            rot: vec3(b + 60),
            posScale: vec3(b + 72),
            rotScale: vec3(b + 84),
            poseToBone,
        });
    }

    const attachments: MdlAttachment[] = [];
    for (let i = 0; i < i32(240); i++) {
        const a = i32(244) + i * 92;
        const local = new Float32Array(12);
        for (let k = 0; k < 12; k++) local[k] = f32(a + 12 + k * 4);
        attachments.push({ name: cstr(a + i32(a)), bone: i32(a + 8), local });
    }

    const anims: MdlAnim[] = [];
    for (let i = 0; i < i32(180); i++) {
        const a = i32(184) + i * ANIMDESC_SIZE;
        anims.push({
            name: cstr(a + i32(a + 4)),
            flags: i32(a + 12),
            numFrames: i32(a + 16),
            fps: f32(a + 8),
            animBlock: i32(a + 52),
            dataOffset: a + i32(a + 56),
        });
    }

    const sequences: MdlSequence[] = [];
    for (let i = 0; i < i32(188); i++) {
        const s = i32(192) + i * SEQDESC_SIZE;
        const animIndex = s + i32(s + 60);
        const numBlends = Math.max(1, i32(s + 56));
        const seqAnims: number[] = [];
        for (let k = 0; k < numBlends; k++) seqAnims.push(v.getInt16(animIndex + k * 2, true));
        sequences.push({ label: cstr(s + i32(s + 4)), activity: cstr(s + i32(s + 8)), flags: i32(s + 12), anims: seqAnims });
    }

    return {
        version,
        name: cstr(12),
        flags: i32(152),
        illumPosition: [v.getFloat32(92, true), v.getFloat32(96, true), v.getFloat32(100, true)],
        textures,
        textureDirs,
        skinFamilies,
        bodyParts,
        bones,
        attachments,
        anims,
        sequences,
        raw: buf,
    };
}
