// Choreographed scenes: scenes/scenes.image holds every compiled .vcd (LZMA-packed "bvcd" binaries,
// choreoscene.cpp's RestoreFromBinaryBuffer). Only what the game logic needs is kept: when each
// line is spoken, when triggers fire and when the scene ends.
import type { GameFS } from '../fs/gamefs';
import { lzmaDecode } from './lzma';

const EV_SPEAK = 5, EV_GESTURE = 6, EV_FIRETRIGGER = 9, EV_LOOP = 12;
const NUM_ABS_TAG_TYPES = 2;

export interface SceneEvent {
    type: 'speak' | 'trigger';
    /** Seconds from the start of the scene. */
    start: number;
    end: number;
    /** The soundscript name, or the trigger number. */
    param: string;
}

export interface Scene {
    events: SceneEvent[];
    /** FindStopTime: the end of the last event, in seconds. */
    duration: number;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(s: string) {
    let c = 0xffffffff;
    for (const ch of new TextEncoder().encode(s)) c = crcTable[(c ^ ch) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

class Reader {
    pos = 0;
    private v: DataView;
    constructor(private b: Uint8Array) {
        this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    }
    u8() { return this.b[this.pos++]; }
    i8() { return (this.b[this.pos++] << 24) >> 24; }
    i16() { const x = this.v.getInt16(this.pos, true); this.pos += 2; return x; }
    u16() { const x = this.v.getUint16(this.pos, true); this.pos += 2; return x; }
    i32() { const x = this.v.getInt32(this.pos, true); this.pos += 4; return x; }
    f32() { const x = this.v.getFloat32(this.pos, true); this.pos += 4; return x; }
}

export class SceneLibrary {
    private image: Uint8Array | null = null;
    private view!: DataView;
    private cache = new Map<string, Scene | null>();

    constructor(private fs: GameFS) {}

    async load() {
        this.image = await this.fs.read('scenes/scenes.image');
        if (this.image) this.view = new DataView(this.image.buffer, this.image.byteOffset, this.image.byteLength);
    }

    private str(i: number) {
        const b = this.image!;
        const o = this.view.getInt32(20 + i * 4, true);
        let e = o;
        while (b[e]) e++;
        return new TextDecoder().decode(b.subarray(o, e));
    }

    /** A scene by its .vcd path ("scenes/test_chamber/ai_01_a_entry.vcd"). */
    get(file: string): Scene | null {
        const key = file.toLowerCase().replaceAll('/', '\\');
        if (this.cache.has(key)) return this.cache.get(key)!;
        let scene: Scene | null = null;
        try {
            scene = this.find(key);
        } catch (e) {
            console.warn('scene', file, e);
        }
        this.cache.set(key, scene);
        return scene;
    }

    private find(key: string): Scene | null {
        const b = this.image;
        if (!b) return null;
        const want = crc32(key);
        const count = this.view.getInt32(8, true), entries = this.view.getInt32(16, true);
        for (let i = 0; i < count; i++) {
            const e = entries + i * 16;
            if (this.view.getUint32(e, true) !== want) continue;
            const ofs = this.view.getInt32(e + 4, true), len = this.view.getInt32(e + 8, true);
            let data = b.subarray(ofs, ofs + len);
            if (String.fromCharCode(...data.subarray(0, 4)) === 'LZMA') {
                const h = new DataView(data.buffer, data.byteOffset, data.byteLength);
                const actual = h.getUint32(4, true);
                data = lzmaDecode(data.subarray(12, 17), data, 17, actual);
            }
            return this.parse(data);
        }
        return null;
    }

    private parse(data: Uint8Array): Scene {
        const r = new Reader(data);
        if (r.i32() !== 0x64637662 /* 'bvcd' */) throw new Error('not a binary scene');
        if (r.i8() !== 4) throw new Error('unsupported scene version');
        r.i32(); // CRC
        const events: SceneEvent[] = [];
        let duration = 0;
        const ramp = () => {
            for (let n = r.u8(); n > 0; n--) { r.f32(); r.u8(); }
        };
        const samples = (n: number) => {
            for (let j = 0; j < n; j++) { r.f32(); r.u8(); r.u16(); }
        };
        const event = () => {
            const type = r.i8();
            r.i16(); // name
            const start = r.f32(), end = r.f32();
            const param = this.str(r.i16());
            r.i16(); r.i16(); // parameters 2 and 3
            ramp();
            r.u8(); // flags
            r.f32(); // distance to target
            for (let n = r.u8(); n > 0; n--) { r.i16(); r.u8(); } // relative tags
            for (let n = r.u8(); n > 0; n--) { r.i16(); r.u8(); } // timing tags
            for (let t = 0; t < NUM_ABS_TAG_TYPES; t++) for (let n = r.u8(); n > 0; n--) { r.i16(); r.u16(); }
            if (type === EV_GESTURE) r.f32();
            if (r.i8() === 1) { r.i16(); r.i16(); }
            for (let n = r.u8(); n > 0; n--) { // flex animation tracks
                r.i16();
                const flags = r.u8();
                r.f32(); r.f32();
                samples(r.i16());
                if (flags & 2) samples(r.u16());
            }
            if (type === EV_LOOP) r.i8();
            if (type === EV_SPEAK) { r.i8(); r.i16(); r.i8(); }
            if (end > duration) duration = end;
            if (type === EV_SPEAK) events.push({ type: 'speak', start, end, param });
            else if (type === EV_FIRETRIGGER) events.push({ type: 'trigger', start, end, param });
        };
        for (let n = r.u8(); n > 0; n--) event();
        for (let n = r.u8(); n > 0; n--) { // actors
            r.i16();
            for (let c = r.u8(); c > 0; c--) { // channels
                r.i16();
                for (let e = r.u8(); e > 0; e--) event();
                r.i8();
            }
            r.i8();
        }
        events.sort((a, b) => a.start - b.start);
        return { events, duration };
    }
}
