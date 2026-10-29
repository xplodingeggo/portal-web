// VTF texture reader for versions 7.0-7.5. Header layout follows the public
// Source SDK 2013 header vtf.h. One animation frame (face 0 / slice 0) is extracted per call.
export enum ImageFormat {
    RGBA8888 = 0,
    ABGR8888 = 1,
    RGB888 = 2,
    BGR888 = 3,
    RGB565 = 4,
    I8 = 5,
    IA88 = 6,
    A8 = 8,
    RGB888_BLUESCREEN = 9,
    BGR888_BLUESCREEN = 10,
    ARGB8888 = 11,
    BGRA8888 = 12,
    DXT1 = 13,
    DXT3 = 14,
    DXT5 = 15,
    BGRX8888 = 16,
    BGR565 = 17,
    BGRA4444 = 19,
    DXT1_ONEBITALPHA = 20,
    UV88 = 22,
    UVWQ8888 = 23,
    RGBA16161616F = 24,
    RGBA16161616 = 25,
}

const TEXTUREFLAGS_ENVMAP = 0x4000;
const RESOURCE_HIGHRES = 0x30;

export interface VtfMip {
    width: number;
    height: number;
    data: Uint8Array;
}

export interface Vtf {
    width: number;
    height: number;
    flags: number;
    format: ImageFormat;
    /** Largest first. Compressed formats keep their block data; everything else is RGBA8. */
    mips: VtfMip[];
    compressed: boolean;
    /** Animation frames in the file. */
    frames: number;
}

function bytesPerPixel(f: ImageFormat): number {
    switch (f) {
        case ImageFormat.RGBA8888:
        case ImageFormat.ABGR8888:
        case ImageFormat.ARGB8888:
        case ImageFormat.BGRA8888:
        case ImageFormat.BGRX8888:
        case ImageFormat.UVWQ8888:
            return 4;
        case ImageFormat.RGB888:
        case ImageFormat.BGR888:
        case ImageFormat.RGB888_BLUESCREEN:
        case ImageFormat.BGR888_BLUESCREEN:
            return 3;
        case ImageFormat.RGB565:
        case ImageFormat.BGR565:
        case ImageFormat.IA88:
        case ImageFormat.BGRA4444:
        case ImageFormat.UV88:
            return 2;
        case ImageFormat.I8:
        case ImageFormat.A8:
            return 1;
        case ImageFormat.RGBA16161616F:
        case ImageFormat.RGBA16161616:
            return 8;
        default:
            return 0;
    }
}

function isDXT(f: ImageFormat) {
    return f === ImageFormat.DXT1 || f === ImageFormat.DXT1_ONEBITALPHA || f === ImageFormat.DXT3 || f === ImageFormat.DXT5;
}

export function imageSize(f: ImageFormat, w: number, h: number): number {
    if (isDXT(f)) {
        const blocks = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4));
        return blocks * (f === ImageFormat.DXT1 || f === ImageFormat.DXT1_ONEBITALPHA ? 8 : 16);
    }
    return w * h * bytesPerPixel(f);
}

export function parseVtf(buf: Uint8Array, frame = 0): Vtf {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (v.getUint32(0, true) !== 0x00465456) throw new Error('not a VTF'); // "VTF\0"
    const minor = v.getUint32(8, true);
    const headerSize = v.getUint32(12, true);
    const width = v.getUint16(16, true);
    const height = v.getUint16(18, true);
    const flags = v.getUint32(20, true);
    const frames = Math.max(1, v.getUint16(24, true));
    const format = v.getInt32(52, true) as ImageFormat;
    const mipCount = v.getUint8(56);
    const lowFormat = v.getInt32(57, true);
    const lowW = v.getUint8(61);
    const lowH = v.getUint8(62);
    const depth = minor >= 2 ? Math.max(1, v.getUint16(63, true)) : 1;
    const faces = flags & TEXTUREFLAGS_ENVMAP ? (minor >= 5 ? 6 : 7) : 1;

    if (!isDXT(format) && bytesPerPixel(format) === 0) throw new Error(`unsupported VTF format ${format}`);

    let hiStart: number;
    if (minor >= 3) {
        const numResources = v.getUint32(68, true);
        hiStart = -1;
        for (let i = 0; i < numResources; i++) {
            const o = 80 + i * 8;
            if (buf[o] === RESOURCE_HIGHRES && buf[o + 1] === 0 && buf[o + 2] === 0) hiStart = v.getUint32(o + 4, true);
        }
        if (hiStart < 0) throw new Error('VTF has no high-res image resource');
    } else {
        hiStart = headerSize + (lowFormat >= 0 ? imageSize(lowFormat, lowW, lowH) : 0);
    }

    // Mips are stored smallest first; each holds frames x faces x slices.
    const mipDims = (m: number) => [Math.max(1, width >> m), Math.max(1, height >> m), Math.max(1, depth >> m)];
    const offsets: number[] = new Array(mipCount);
    let p = hiStart;
    for (let m = mipCount - 1; m >= 0; m--) {
        const [w, h, d] = mipDims(m);
        offsets[m] = p;
        p += imageSize(format, w, h) * d * faces * frames;
    }

    const compressed = isDXT(format);
    const mips: VtfMip[] = [];
    for (let m = 0; m < mipCount; m++) {
        const [w, h] = mipDims(m);
        // Within a mip level, data runs frame-major: frames x faces x slices.
        const [, , d] = mipDims(m);
        const start = offsets[m] + Math.min(frame, frames - 1) * faces * d * imageSize(format, w, h);
        const raw = buf.subarray(start, start + imageSize(format, w, h));
        if (raw.length < imageSize(format, w, h)) throw new Error('VTF truncated');
        mips.push({ width: w, height: h, data: compressed ? raw.slice() : toRGBA(format, raw, w * h) });
    }
    return { width, height, flags, format, mips, compressed, frames };
}

function toRGBA(f: ImageFormat, src: Uint8Array, n: number): Uint8Array {
    const out = new Uint8Array(n * 4);
    const s16 = (i: number) => src[i] | (src[i + 1] << 8);
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        let r = 0, g = 0, b = 0, a = 255;
        switch (f) {
            case ImageFormat.RGBA8888: r = src[o]; g = src[o + 1]; b = src[o + 2]; a = src[o + 3]; break;
            case ImageFormat.ABGR8888: a = src[o]; b = src[o + 1]; g = src[o + 2]; r = src[o + 3]; break;
            case ImageFormat.ARGB8888: a = src[o]; r = src[o + 1]; g = src[o + 2]; b = src[o + 3]; break;
            case ImageFormat.BGRA8888: b = src[o]; g = src[o + 1]; r = src[o + 2]; a = src[o + 3]; break;
            case ImageFormat.BGRX8888: b = src[o]; g = src[o + 1]; r = src[o + 2]; break;
            case ImageFormat.UVWQ8888: r = src[o]; g = src[o + 1]; b = src[o + 2]; a = src[o + 3]; break;
            case ImageFormat.RGB888:
            case ImageFormat.RGB888_BLUESCREEN: r = src[i * 3]; g = src[i * 3 + 1]; b = src[i * 3 + 2]; break;
            case ImageFormat.BGR888:
            case ImageFormat.BGR888_BLUESCREEN: b = src[i * 3]; g = src[i * 3 + 1]; r = src[i * 3 + 2]; break;
            case ImageFormat.I8: r = g = b = src[i]; break;
            case ImageFormat.A8: r = g = b = 255; a = src[i]; break;
            case ImageFormat.IA88: r = g = b = src[i * 2]; a = src[i * 2 + 1]; break;
            case ImageFormat.UV88: r = src[i * 2]; g = src[i * 2 + 1]; break;
            case ImageFormat.RGB565: {
                const c = s16(i * 2);
                r = ((c >> 11) & 31) * 255 / 31; g = ((c >> 5) & 63) * 255 / 63; b = (c & 31) * 255 / 31;
                break;
            }
            case ImageFormat.BGR565: {
                const c = s16(i * 2);
                b = ((c >> 11) & 31) * 255 / 31; g = ((c >> 5) & 63) * 255 / 63; r = (c & 31) * 255 / 31;
                break;
            }
            case ImageFormat.BGRA4444: {
                const c = s16(i * 2);
                b = (c & 15) * 17; g = ((c >> 4) & 15) * 17; r = ((c >> 8) & 15) * 17; a = ((c >> 12) & 15) * 17;
                break;
            }
            case ImageFormat.RGBA16161616F:
            case ImageFormat.RGBA16161616: {
                // Tone-map-free clamp; these are rare in world materials.
                const dv = new DataView(src.buffer, src.byteOffset + i * 8, 8);
                const ch = (k: number) =>
                    f === ImageFormat.RGBA16161616 ? dv.getUint16(k * 2, true) / 257 : Math.min(255, halfToFloat(dv.getUint16(k * 2, true)) * 255);
                r = ch(0); g = ch(1); b = ch(2); a = ch(3);
                break;
            }
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
    return out;
}

function halfToFloat(h: number): number {
    const e = (h >> 10) & 31;
    const m = h & 1023;
    const s = h & 0x8000 ? -1 : 1;
    if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

/** Software DXT1/3/5 decode to RGBA8, for when the GPU lacks S3TC. */
export function decodeDXT(f: ImageFormat, src: Uint8Array, width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    const dxt1 = f === ImageFormat.DXT1 || f === ImageFormat.DXT1_ONEBITALPHA;
    const blockSize = dxt1 ? 8 : 16;
    const bw = Math.max(1, Math.ceil(width / 4));
    const bh = Math.max(1, Math.ceil(height / 4));
    const colors = new Uint8Array(16);
    const alphas = new Uint8Array(8);
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const base = (by * bw + bx) * blockSize;
            const c = dxt1 ? base : base + 8;
            const c0 = src[c] | (src[c + 1] << 8);
            const c1 = src[c + 2] | (src[c + 3] << 8);
            const unpack = (v: number, o: number) => {
                colors[o] = ((v >> 11) & 31) * 255 / 31;
                colors[o + 1] = ((v >> 5) & 63) * 255 / 63;
                colors[o + 2] = (v & 31) * 255 / 31;
                colors[o + 3] = 255;
            };
            unpack(c0, 0);
            unpack(c1, 4);
            for (let k = 0; k < 3; k++) {
                if (c0 > c1 || !dxt1) {
                    colors[8 + k] = (2 * colors[k] + colors[4 + k]) / 3;
                    colors[12 + k] = (colors[k] + 2 * colors[4 + k]) / 3;
                } else {
                    colors[8 + k] = (colors[k] + colors[4 + k]) / 2;
                    colors[12 + k] = 0;
                }
            }
            colors[11] = 255;
            colors[15] = c0 > c1 || !dxt1 ? 255 : 0;

            if (f === ImageFormat.DXT5) {
                alphas[0] = src[base];
                alphas[1] = src[base + 1];
                for (let k = 2; k < 8; k++) {
                    alphas[k] =
                        alphas[0] > alphas[1]
                            ? ((8 - k) * alphas[0] + (k - 1) * alphas[1]) / 7
                            : k < 6 ? ((6 - k) * alphas[0] + (k - 1) * alphas[1]) / 5 : k === 6 ? 0 : 255;
                }
            }
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const t = py * 4 + px;
                    const sel = (src[c + 4 + py] >> (px * 2)) & 3;
                    const o = (y * width + x) * 4;
                    out[o] = colors[sel * 4];
                    out[o + 1] = colors[sel * 4 + 1];
                    out[o + 2] = colors[sel * 4 + 2];
                    out[o + 3] = colors[sel * 4 + 3];
                    if (f === ImageFormat.DXT3) {
                        out[o + 3] = ((src[base + (t >> 1)] >> ((t & 1) * 4)) & 15) * 17;
                    } else if (f === ImageFormat.DXT5) {
                        const bit = t * 3;
                        const byte = base + 2 + (bit >> 3);
                        const bits = (src[byte] | (src[byte + 1] << 8)) >> (bit & 7);
                        out[o + 3] = alphas[bits & 7];
                    }
                }
            }
        }
    }
    return out;
}
