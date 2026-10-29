// Sprite sheets: the 0x10 resource of a particle VTF lists, for each sequence, the frames and where
// each lies in the texture (Source's CSheet). Particles pick a sequence and step through its frames.
export interface SheetFrame {
    /** Seconds this frame lasts. */
    duration: number;
    /** [u0, v0, u1, v1] of the first image; V runs down the texture. */
    rect: [number, number, number, number];
}

export interface SheetSequence {
    clamp: boolean;
    totalTime: number;
    frames: SheetFrame[];
}

export interface Sheet {
    sequences: Map<number, SheetSequence>;
}

const RESOURCE_SHEET = 0x10;

/** The sheet of a VTF, or null if it has none. */
export function parseSheet(vtf: Uint8Array): Sheet | null {
    const v = new DataView(vtf.buffer, vtf.byteOffset, vtf.byteLength);
    if (v.getUint32(0, true) !== 0x00465456 || v.getUint32(8, true) < 3) return null;
    const count = v.getUint32(68, true);
    for (let i = 0; i < count; i++) {
        const o = 80 + i * 8;
        if (vtf[o] !== RESOURCE_SHEET || vtf[o + 1] !== 0 || vtf[o + 2] !== 0) continue;
        const start = v.getUint32(o + 4, true);
        return readSheet(new DataView(vtf.buffer, vtf.byteOffset + start + 4, v.getUint32(start, true)));
    }
    return null;
}

function readSheet(v: DataView): Sheet {
    let p = 0;
    const i32 = () => { const x = v.getInt32(p, true); p += 4; return x; };
    const f32 = () => { const x = v.getFloat32(p, true); p += 4; return x; };
    const version = i32();
    // Version 1 stores up to four images per frame (for blending two sequences); version 0 one.
    const images = version === 0 ? 1 : 4;
    const sequences = new Map<number, SheetSequence>();
    for (let n = i32(); n > 0; n--) {
        const id = i32();
        const clamp = i32() !== 0;
        const frameCount = i32();
        const totalTime = f32();
        const frames: SheetFrame[] = [];
        for (let f = 0; f < frameCount; f++) {
            const duration = f32();
            const rect: [number, number, number, number] = [0, 0, 1, 1];
            for (let k = 0; k < images; k++) {
                const r: [number, number, number, number] = [f32(), f32(), f32(), f32()];
                if (k === 0) rect.splice(0, 4, ...r);
            }
            frames.push({ duration, rect });
        }
        sequences.set(id, { clamp, totalTime, frames });
    }
    return { sequences };
}
