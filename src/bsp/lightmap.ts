// Packs every face's baked lightmap into one atlas of linear RGB half floats.
import type { BspFile, Face } from './bsp';

export interface LightmapRect {
    x: number;
    y: number;
}

export interface LightmapAtlas {
    width: number;
    height: number;
    /** RGBA float32, linear light (1.0 = full brightness). */
    data: Float32Array;
    /** Atlas position per face index; faces without lighting map to the white block. */
    rects: Map<number, LightmapRect>;
    /** Center of a 2x2 white block for unlit or fullbright faces. */
    white: { u: number; v: number };
}

const ATLAS_WIDTH = 2048;

export function buildLightmapAtlas(bsp: BspFile, faceIndices: number[]): LightmapAtlas {
    const lit = faceIndices.filter((i) => {
        const f = bsp.faces[i];
        return f.lightOfs >= 0 && f.styles[0] !== 255;
    });
    // Shelf packing, tallest first. One texel of padding avoids filtering bleed.
    lit.sort((a, b) => bsp.faces[b].lightmapSize[1] - bsp.faces[a].lightmapSize[1]);

    const rects = new Map<number, LightmapRect>();
    let x = 3; // columns 0-1 hold the white block
    let y = 0;
    let shelf = 2;
    for (const i of lit) {
        const w = bsp.faces[i].lightmapSize[0] + 1;
        const h = bsp.faces[i].lightmapSize[1] + 1;
        if (x + w > ATLAS_WIDTH) {
            x = 0;
            y += shelf + 1;
            shelf = 0;
        }
        rects.set(i, { x, y });
        x += w + 1;
        shelf = Math.max(shelf, h);
    }
    const width = ATLAS_WIDTH;
    const height = Math.max(4, y + shelf);
    const data = new Float32Array(width * height * 4);

    for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) data.set([1, 1, 1, 1], (yy * width + xx) * 4);

    for (const [i, r] of rects) writeFace(bsp, bsp.faces[i], r, data, width);

    return { width, height, data, rects, white: { u: 1 / width, v: 1 / height } };
}

function writeFace(bsp: BspFile, face: Face, r: LightmapRect, data: Float32Array, width: number) {
    const w = face.lightmapSize[0] + 1;
    const h = face.lightmapSize[1] + 1;
    const light = bsp.lighting;
    // Style 0 only. For bump-lit faces the first of the four maps is the flat average.
    let p = face.lightOfs;
    for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++, p += 4) {
            const exp = (light[p + 3] << 24) >> 24; // signed byte
            const scale = Math.pow(2, exp) / 255;
            const o = ((r.y + yy) * width + r.x + xx) * 4;
            data[o] = light[p] * scale;
            data[o + 1] = light[p + 1] * scale;
            data[o + 2] = light[p + 2] * scale;
            data[o + 3] = 1;
        }
    }
}
