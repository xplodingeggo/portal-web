// Minimal ZIP reader for the BSP PAKFILE lump. Reads the central directory and
// supports stored (0) entries, plus deflate (8) where DecompressionStream exists.
export class Zip {
    private entries = new Map<string, { method: number; offset: number; size: number }>();

    constructor(private data: Uint8Array) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        // End of central directory record: signature 0x06054b50, scanned from the end.
        let eocd = -1;
        for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
            if (view.getUint32(i, true) === 0x06054b50) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) throw new Error('zip: no end of central directory');
        const count = view.getUint16(eocd + 10, true);
        let p = view.getUint32(eocd + 16, true);
        const dec = new TextDecoder();
        for (let i = 0; i < count; i++) {
            if (view.getUint32(p, true) !== 0x02014b50) throw new Error('zip: bad central directory');
            const method = view.getUint16(p + 10, true);
            const size = view.getUint32(p + 20, true);
            const nameLen = view.getUint16(p + 28, true);
            const extraLen = view.getUint16(p + 30, true);
            const commentLen = view.getUint16(p + 32, true);
            const localOffset = view.getUint32(p + 42, true);
            const name = dec.decode(data.subarray(p + 46, p + 46 + nameLen)).toLowerCase();
            // Local header: 30 bytes + name + extra, whose lengths can differ from the central copy.
            const lNameLen = view.getUint16(localOffset + 26, true);
            const lExtraLen = view.getUint16(localOffset + 28, true);
            this.entries.set(name, { method, offset: localOffset + 30 + lNameLen + lExtraLen, size });
            p += 46 + nameLen + extraLen + commentLen;
        }
    }

    names(): string[] {
        return [...this.entries.keys()];
    }

    has(path: string): boolean {
        return this.entries.has(path.toLowerCase());
    }

    async read(path: string): Promise<Uint8Array | null> {
        const e = this.entries.get(path.toLowerCase());
        if (!e) return null;
        const raw = this.data.subarray(e.offset, e.offset + e.size);
        if (e.method === 0) return raw;
        if (e.method === 8) {
            const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            return new Uint8Array(await new Response(stream).arrayBuffer());
        }
        throw new Error(`zip: ${path} uses unsupported method ${e.method}`);
    }
}
