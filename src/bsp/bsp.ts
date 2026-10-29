// VBSP (Source map) reader. Struct layouts follow the public Source SDK 2013
// header bspfile.h; only the lumps needed to draw the world are decoded.
import { Zip } from '../fs/zip';

export enum Lump {
    Entities = 0,
    Planes = 1,
    TexData = 2,
    Vertexes = 3,
    Nodes = 5,
    TexInfo = 6,
    Faces = 7,
    Lighting = 8,
    Leafs = 10,
    Edges = 12,
    LeafBrushes = 17,
    Brushes = 18,
    BrushSides = 19,
    SurfEdges = 13,
    Models = 14,
    DispInfo = 26,
    DispVerts = 33,
    GameLump = 35,
    PakFile = 40,
    TexDataStringData = 43,
    TexDataStringTable = 44,
    Overlays = 45,
    LeafAmbientIndexHDR = 51,
    LeafAmbientIndex = 52,
    LightingHDR = 53,
    LeafAmbientLightingHDR = 55,
    LeafAmbientLighting = 56,
    FacesHDR = 58,
}

export interface Leaf {
    mins: [number, number, number];
    maxs: [number, number, number];
    ambientCount: number;
    ambientFirst: number;
    firstLeafBrush: number;
    numLeafBrushes: number;
}

export interface Brush {
    contents: number;
    /** Plane index per side (bevel sides included; they matter for box traces). */
    planes: number[];
    /** Texinfo index per side (-1 for none), for surface flags and materials. */
    texInfos: number[];
}

/** Ambient light sample: six linear RGB colors (+X, -X, +Y, -Y, +Z, -Z) at a fractional leaf position. */
export interface AmbientSample {
    cube: Float32Array; // 18 floats
    pos: [number, number, number]; // 0-1 within the leaf bounds
}

export enum SurfFlags {
    Light = 0x1,
    Sky2D = 0x2,
    Sky = 0x4,
    Warp = 0x8,
    Trans = 0x10,
    Trigger = 0x40,
    NoDraw = 0x80,
    Hint = 0x100,
    Skip = 0x200,
    NoPortal = 0x20,
    NoLight = 0x400,
    BumpLight = 0x800,
}

export interface TexInfo {
    textureVecs: Float32Array; // [s.xyzw, t.xyzw]
    lightmapVecs: Float32Array; // [s.xyzw, t.xyzw]
    flags: number;
    texData: number;
}

export interface TexData {
    reflectivity: [number, number, number];
    name: string;
    width: number;
    height: number;
}

export interface Face {
    planeNum: number;
    side: number;
    firstEdge: number;
    numEdges: number;
    texInfo: number;
    dispInfo: number;
    styles: number[];
    lightOfs: number;
    lightmapMins: [number, number];
    lightmapSize: [number, number];
}

export interface Model {
    mins: [number, number, number];
    maxs: [number, number, number];
    origin: [number, number, number];
    firstFace: number;
    numFaces: number;
    headNode: number;
}

export interface DispInfo {
    startPosition: [number, number, number];
    dispVertStart: number;
    power: number;
    mapFace: number;
}

export class BspFile {
    readonly version: number;
    readonly vertices: Float32Array;
    readonly planeNormals: Float32Array;
    readonly edges: Uint16Array;
    readonly surfEdges: Int32Array;
    readonly texInfos: TexInfo[] = [];
    readonly texDatas: TexData[] = [];
    readonly faces: Face[] = [];
    readonly models: Model[] = [];
    readonly dispInfos: DispInfo[] = [];
    /** Per displacement vertex: offset vector xyz, distance, alpha. */
    readonly dispVerts: Float32Array;
    /** Raw ColorRGBExp32 samples addressed by Face.lightOfs. */
    readonly lighting: Uint8Array;
    /** The map's entity lump; a test map swaps in its own. */
    entitiesText: string;
    readonly pakfile: Zip | null;
    readonly planeDists: Float32Array;
    /** Per node: plane index, front child, back child (negative = -1 - leaf index). */
    readonly nodes: Int32Array;
    readonly leaves: Leaf[] = [];
    readonly brushes: Brush[] = [];
    leafBrushes = new Uint16Array(0);
    readonly ambientSamples: AmbientSample[] = [];
    /** Game lumps by four-character id (e.g. "sprp"), as absolute file slices. */
    readonly gameLumps = new Map<string, { version: number; data: Uint8Array }>();
    readonly usesHDR: boolean;

    private view: DataView;
    private lumps: { offset: number; length: number; version: number; fourCC: number }[] = [];

    constructor(private data: Uint8Array) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const v = this.view;
        if (new TextDecoder().decode(data.subarray(0, 4)) !== 'VBSP') throw new Error('not a VBSP file');
        this.version = v.getInt32(4, true);
        if (this.version < 19 || this.version > 21) throw new Error(`unsupported BSP version ${this.version}`);
        for (let i = 0; i < 64; i++) {
            const o = 8 + i * 16;
            this.lumps.push({
                offset: v.getInt32(o, true),
                length: v.getInt32(o + 4, true),
                version: v.getInt32(o + 8, true),
                fourCC: v.getInt32(o + 12, true),
            });
        }

        this.vertices = this.floats(Lump.Vertexes);
        this.edges = new Uint16Array(this.copy(Lump.Edges).buffer);
        this.surfEdges = new Int32Array(this.copy(Lump.SurfEdges).buffer);
        this.dispVerts = this.floats(Lump.DispVerts);

        const planes = this.lumpBytes(Lump.Planes);
        this.planeNormals = new Float32Array((planes.length / 20) * 3);
        this.planeDists = new Float32Array(planes.length / 20);
        for (let i = 0, o = this.lumpOffset(Lump.Planes); i < planes.length / 20; i++, o += 20) {
            for (let k = 0; k < 3; k++) this.planeNormals[i * 3 + k] = v.getFloat32(o + k * 4, true);
            this.planeDists[i] = v.getFloat32(o + 12, true);
        }

        const numNodes = this.lumps[Lump.Nodes].length / 32;
        this.nodes = new Int32Array(numNodes * 3);
        for (let i = 0, o = this.lumpOffset(Lump.Nodes); i < numNodes; i++, o += 32) {
            this.nodes[i * 3] = v.getInt32(o, true);
            this.nodes[i * 3 + 1] = v.getInt32(o + 4, true);
            this.nodes[i * 3 + 2] = v.getInt32(o + 8, true);
        }

        this.parseTexData();
        this.parseTexInfo();

        // LDR lighting pairs with the LDR face lump, HDR with the HDR one.
        const useHDR = this.lumps[Lump.Lighting].length === 0;
        this.usesHDR = useHDR;
        const faceLump = useHDR && this.lumps[Lump.FacesHDR].length > 0 ? Lump.FacesHDR : Lump.Faces;
        this.lighting = this.copy(useHDR ? Lump.LightingHDR : Lump.Lighting);
        this.parseFaces(faceLump);
        this.parseModels();
        this.parseDispInfo();
        this.parseLeaves(useHDR);
        this.parseGameLumps();
        this.parseBrushes();

        this.entitiesText = new TextDecoder().decode(this.lumpBytes(Lump.Entities)).replace(/\0+$/, '');
        const pak = this.lumpBytes(Lump.PakFile);
        this.pakfile = pak.length ? new Zip(pak) : null;
    }

    lumpBytes(i: Lump): Uint8Array {
        const l = this.lumps[i];
        if (l.fourCC !== 0) throw new Error(`lump ${i} is LZMA-compressed (not supported yet)`);
        return this.data.subarray(l.offset, l.offset + l.length);
    }

    private lumpOffset(i: Lump) {
        return this.lumps[i].offset;
    }

    /** Aligned copy, so typed arrays can view it. */
    private copy(i: Lump): Uint8Array {
        return this.lumpBytes(i).slice();
    }

    private floats(i: Lump): Float32Array {
        return new Float32Array(this.copy(i).buffer);
    }

    private parseTexData() {
        const v = this.view;
        const strData = this.lumpBytes(Lump.TexDataStringData);
        const strTable = this.lumpBytes(Lump.TexDataStringTable);
        const tableOfs = this.lumpOffset(Lump.TexDataStringTable);
        const dec = new TextDecoder();
        const nameAt = (id: number) => {
            const start = v.getInt32(tableOfs + id * 4, true);
            let end = start;
            while (end < strData.length && strData[end] !== 0) end++;
            return dec.decode(strData.subarray(start, end));
        };
        const n = this.lumps[Lump.TexData].length / 32;
        for (let i = 0, o = this.lumpOffset(Lump.TexData); i < n; i++, o += 32) {
            const id = v.getInt32(o + 12, true);
            this.texDatas.push({
                reflectivity: [v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true)],
                name: id * 4 < strTable.length ? nameAt(id) : '',
                width: v.getInt32(o + 16, true),
                height: v.getInt32(o + 20, true),
            });
        }
    }

    private parseTexInfo() {
        const v = this.view;
        const n = this.lumps[Lump.TexInfo].length / 72;
        for (let i = 0, o = this.lumpOffset(Lump.TexInfo); i < n; i++, o += 72) {
            const textureVecs = new Float32Array(8);
            const lightmapVecs = new Float32Array(8);
            for (let k = 0; k < 8; k++) {
                textureVecs[k] = v.getFloat32(o + k * 4, true);
                lightmapVecs[k] = v.getFloat32(o + 32 + k * 4, true);
            }
            this.texInfos.push({
                textureVecs,
                lightmapVecs,
                flags: v.getInt32(o + 64, true),
                texData: v.getInt32(o + 68, true),
            });
        }
    }

    private parseFaces(lump: Lump) {
        const v = this.view;
        const n = this.lumps[lump].length / 56;
        for (let i = 0, o = this.lumpOffset(lump); i < n; i++, o += 56) {
            this.faces.push({
                planeNum: v.getUint16(o, true),
                side: v.getUint8(o + 2),
                firstEdge: v.getInt32(o + 4, true),
                numEdges: v.getInt16(o + 8, true),
                texInfo: v.getInt16(o + 10, true),
                dispInfo: v.getInt16(o + 12, true),
                styles: [v.getUint8(o + 16), v.getUint8(o + 17), v.getUint8(o + 18), v.getUint8(o + 19)],
                lightOfs: v.getInt32(o + 20, true),
                lightmapMins: [v.getInt32(o + 28, true), v.getInt32(o + 32, true)],
                lightmapSize: [v.getInt32(o + 36, true), v.getInt32(o + 40, true)],
            });
        }
    }

    private parseModels() {
        const v = this.view;
        const vec = (o: number): [number, number, number] => [
            v.getFloat32(o, true),
            v.getFloat32(o + 4, true),
            v.getFloat32(o + 8, true),
        ];
        const n = this.lumps[Lump.Models].length / 48;
        for (let i = 0, o = this.lumpOffset(Lump.Models); i < n; i++, o += 48) {
            this.models.push({
                mins: vec(o),
                maxs: vec(o + 12),
                origin: vec(o + 24),
                headNode: v.getInt32(o + 36, true),
                firstFace: v.getInt32(o + 40, true),
                numFaces: v.getInt32(o + 44, true),
            });
        }
    }

    private parseDispInfo() {
        const v = this.view;
        const n = this.lumps[Lump.DispInfo].length / 176;
        for (let i = 0, o = this.lumpOffset(Lump.DispInfo); i < n; i++, o += 176) {
            this.dispInfos.push({
                startPosition: [v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true)],
                dispVertStart: v.getInt32(o + 12, true),
                power: v.getInt32(o + 20, true),
                mapFace: v.getUint16(o + 36, true),
            });
        }
    }

    private parseLeaves(useHDR: boolean) {
        const v = this.view;
        if (this.lumps[Lump.Leafs].version !== 1) return; // v0 leaves embed ambient data; not needed for Portal
        const indexLump = useHDR ? Lump.LeafAmbientIndexHDR : Lump.LeafAmbientIndex;
        const lightLump = useHDR ? Lump.LeafAmbientLightingHDR : Lump.LeafAmbientLighting;
        const indexOfs = this.lumpOffset(indexLump);
        const hasIndex = this.lumps[indexLump].length > 0;

        const n = this.lumps[Lump.Leafs].length / 32;
        for (let i = 0, o = this.lumpOffset(Lump.Leafs); i < n; i++, o += 32) {
            const s = (k: number) => v.getInt16(o + k, true);
            this.leaves.push({
                mins: [s(8), s(10), s(12)],
                maxs: [s(14), s(16), s(18)],
                firstLeafBrush: v.getUint16(o + 24, true),
                numLeafBrushes: v.getUint16(o + 26, true),
                ambientCount: hasIndex ? v.getUint16(indexOfs + i * 4, true) : 0,
                ambientFirst: hasIndex ? v.getUint16(indexOfs + i * 4 + 2, true) : 0,
            });
        }

        const light = this.lumpBytes(lightLump);
        for (let p = 0; p + 28 <= light.length; p += 28) {
            const cube = new Float32Array(18);
            for (let k = 0; k < 6; k++) {
                const exp = (light[p + k * 4 + 3] << 24) >> 24;
                const scale = Math.pow(2, exp) / 255;
                for (let c = 0; c < 3; c++) cube[k * 3 + c] = light[p + k * 4 + c] * scale;
            }
            this.ambientSamples.push({ cube, pos: [light[p + 24] / 255, light[p + 25] / 255, light[p + 26] / 255] });
        }
    }

    private parseBrushes() {
        const v = this.view;
        const sides = this.lumpOffset(Lump.BrushSides);
        const n = this.lumps[Lump.Brushes].length / 12;
        for (let i = 0, o = this.lumpOffset(Lump.Brushes); i < n; i++, o += 12) {
            const first = v.getInt32(o, true);
            const count = v.getInt32(o + 4, true);
            const planes: number[] = [];
            const texInfos: number[] = [];
            for (let k = 0; k < count; k++) {
                // dbrushside_t: planenum u16, texinfo s16, dispinfo s16, bevel s16
                planes.push(v.getUint16(sides + (first + k) * 8, true));
                texInfos.push(v.getInt16(sides + (first + k) * 8 + 2, true));
            }
            this.brushes.push({ contents: v.getInt32(o + 8, true), planes, texInfos });
        }
        const lb = this.lumpBytes(Lump.LeafBrushes);
        this.leafBrushes = new Uint16Array(lb.slice().buffer);
    }

    /** Brush indices reachable from a model's BSP tree. */
    modelBrushes(model: number): number[] {
        const out = new Set<number>();
        const stack = [this.models[model].headNode];
        while (stack.length) {
            const node = stack.pop()!;
            if (node < 0) {
                const leaf = this.leaves[-1 - node];
                if (!leaf) continue;
                for (let k = 0; k < leaf.numLeafBrushes; k++) out.add(this.leafBrushes[leaf.firstLeafBrush + k]);
            } else {
                stack.push(this.nodes[node * 3 + 1], this.nodes[node * 3 + 2]);
            }
        }
        return [...out];
    }

    private parseGameLumps() {
        const v = this.view;
        const o = this.lumpOffset(Lump.GameLump);
        if (this.lumps[Lump.GameLump].length < 4) return;
        const count = v.getInt32(o, true);
        for (let i = 0; i < count; i++) {
            const h = o + 4 + i * 16;
            const id = v.getUint32(h, true);
            const name = String.fromCharCode((id >> 24) & 255, (id >> 16) & 255, (id >> 8) & 255, id & 255);
            const flags = v.getUint16(h + 4, true);
            if (flags & 1) continue; // compressed game lump; not used by Portal
            const ofs = v.getInt32(h + 8, true);
            const len = v.getInt32(h + 12, true);
            this.gameLumps.set(name, { version: v.getUint16(h + 6, true), data: this.data.subarray(ofs, ofs + len) });
        }
    }

    /** Index of the leaf containing a point, walking the world's BSP tree. */
    findLeaf(p: [number, number, number]): number {
        let node = 0;
        while (node >= 0) {
            const plane = this.nodes[node * 3];
            const n = this.planeNormals;
            const d = n[plane * 3] * p[0] + n[plane * 3 + 1] * p[1] + n[plane * 3 + 2] * p[2] - this.planeDists[plane];
            node = this.nodes[node * 3 + (d >= 0 ? 1 : 2)];
        }
        return -1 - node;
    }

    /** Vertex indices of a face, in the order stored (via surfedges). */
    faceVertexIndices(face: Face): number[] {
        const out: number[] = [];
        for (let i = 0; i < face.numEdges; i++) {
            const se = this.surfEdges[face.firstEdge + i];
            out.push(se >= 0 ? this.edges[se * 2] : this.edges[-se * 2 + 1]);
        }
        return out;
    }
}
