// Optimized model strips (.dx90.vtx, version 7). Structs are byte-packed;
// every *Offset is relative to the start of the struct that holds it.
export interface VtxStripGroup {
    /** Per strip-group vertex: index into the owning MDL mesh's vertices. */
    meshVertexIds: Uint16Array;
    /** Triangle list into meshVertexIds (strips already expanded). */
    indices: Uint16Array;
}

/** bodyParts[b].models[m].lods[l].meshes[k] = strip groups */
export interface Vtx {
    bodyParts: { models: { lods: { meshes: VtxStripGroup[][] }[] }[] }[];
}

const STRIP_TRILIST = 1;
const STRIP_TRISTRIP = 2;

export function parseVtx(buf: Uint8Array): Vtx {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const version = v.getInt32(0, true);
    if (version !== 7) throw new Error(`unsupported VTX version ${version}`);
    const i32 = (o: number) => v.getInt32(o, true);

    const bodyParts: Vtx['bodyParts'] = [];
    const bpBase = i32(32);
    for (let b = 0; b < i32(28); b++) {
        const bp = bpBase + b * 8;
        const models: Vtx['bodyParts'][number]['models'] = [];
        for (let m = 0; m < i32(bp); m++) {
            const mo = bp + i32(bp + 4) + m * 8;
            const lods: { meshes: VtxStripGroup[][] }[] = [];
            for (let l = 0; l < i32(mo); l++) {
                const lo = mo + i32(mo + 4) + l * 12;
                const meshes: VtxStripGroup[][] = [];
                for (let k = 0; k < i32(lo); k++) {
                    const me = lo + i32(lo + 4) + k * 9;
                    const groups: VtxStripGroup[] = [];
                    for (let g = 0; g < i32(me); g++) groups.push(parseStripGroup(v, me + i32(me + 4) + g * 25));
                    meshes.push(groups);
                }
                lods.push({ meshes });
            }
            models.push({ lods });
        }
        bodyParts.push({ models });
    }
    return { bodyParts };
}

function parseStripGroup(v: DataView, sg: number): VtxStripGroup {
    const i32 = (o: number) => v.getInt32(o, true);
    const numVerts = i32(sg);
    const vertBase = sg + i32(sg + 4);
    const indexBase = sg + i32(sg + 12);
    const numStrips = i32(sg + 16);
    const stripBase = sg + i32(sg + 20);

    const meshVertexIds = new Uint16Array(numVerts);
    for (let i = 0; i < numVerts; i++) meshVertexIds[i] = v.getUint16(vertBase + i * 9 + 4, true);
    const raw = (i: number) => v.getUint16(indexBase + i * 2, true);

    const out: number[] = [];
    for (let s = 0; s < numStrips; s++) {
        const st = stripBase + s * 27;
        const n = i32(st);
        const first = i32(st + 4);
        const flags = v.getUint8(st + 18);
        if (flags & STRIP_TRISTRIP) {
            for (let i = 0; i + 2 < n; i++) {
                const a = raw(first + i), b = raw(first + i + 1), c = raw(first + i + 2);
                if (a === b || b === c || a === c) continue;
                if (i & 1) out.push(a, c, b);
                else out.push(a, b, c);
            }
        } else if (flags & STRIP_TRILIST || flags === 0) {
            for (let i = 0; i < n; i++) out.push(raw(first + i));
        }
    }
    return { meshVertexIds, indices: new Uint16Array(out) };
}
