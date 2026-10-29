// Static props (game lump "sprp") and the per-leaf ambient light cubes used to
// light anything that isn't lightmapped.
import type { BspFile } from './bsp';

type Vec3 = [number, number, number];

export enum StaticPropFlags {
    Fades = 0x1,
    UseLightingOrigin = 0x2,
    NoPerVertexLighting = 0x40,
}

export interface StaticProp {
    index: number;
    model: string;
    origin: Vec3;
    angles: Vec3; // pitch, yaw, roll
    skin: number;
    /** 0 = not solid, 2 = bounding box, 6 = VPhysics (.phy). */
    solid: number;
    flags: number;
    lightingOrigin: Vec3;
}

export function parseStaticProps(bsp: BspFile): StaticProp[] {
    const lump = bsp.gameLumps.get('sprp');
    if (!lump) return [];
    const { data, version } = lump;
    if (version < 4) throw new Error(`static prop lump v${version} not supported`);
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const dec = new TextDecoder();

    let p = 0;
    const dictCount = v.getInt32(p, true);
    p += 4;
    const names: string[] = [];
    for (let i = 0; i < dictCount; i++, p += 128) {
        const raw = data.subarray(p, p + 128);
        const end = raw.indexOf(0);
        names.push(dec.decode(raw.subarray(0, end < 0 ? 128 : end)).toLowerCase());
    }
    const leafCount = v.getInt32(p, true);
    p += 4 + leafCount * 2;
    const count = v.getInt32(p, true);
    p += 4;
    if (count === 0) return [];
    // Later versions append fields; the shared prefix is identical, so step by the actual size.
    const stride = (data.length - p) / count;

    const vec = (o: number): Vec3 => [v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true)];
    const props: StaticProp[] = [];
    for (let i = 0; i < count; i++, p += stride) {
        props.push({
            index: i,
            origin: vec(p),
            angles: vec(p + 12),
            model: names[v.getUint16(p + 24, true)],
            solid: v.getUint8(p + 30),
            flags: v.getUint8(p + 31),
            skin: v.getInt32(p + 32, true),
            lightingOrigin: vec(p + 44),
        });
    }
    return props;
}

/**
 * Leaf ambient cubes decode (as ColorRGBExp32) far below lightmap units. This scale was
 * fitted on testchmb_a_00 as the geometric mean of (nearby lightmap luxels / cube average)
 * at its 53 static prop positions.
 */
const AMBIENT_SCALE = 564;

/** Ambient light cube at a point, in lightmap units: inverse-distance blend of the samples in its leaf. */
export function sampleAmbientCube(bsp: BspFile, p: Vec3): Float32Array {
    const out = new Float32Array(18);
    const leaf = bsp.leaves[bsp.findLeaf(p)];
    if (!leaf || leaf.ambientCount === 0) return out.fill(0.25);
    let total = 0;
    for (let i = 0; i < leaf.ambientCount; i++) {
        const s = bsp.ambientSamples[leaf.ambientFirst + i];
        let d2 = 0;
        for (let k = 0; k < 3; k++) {
            const pos = leaf.mins[k] + s.pos[k] * (leaf.maxs[k] - leaf.mins[k]);
            d2 += (pos - p[k]) ** 2;
        }
        const w = 1 / (d2 + 1);
        total += w;
        for (let k = 0; k < 18; k++) out[k] += s.cube[k] * w;
    }
    for (let k = 0; k < 18; k++) out[k] *= AMBIENT_SCALE / total;
    return out;
}
