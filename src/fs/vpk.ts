// VPK (Valve Pak) directory reader, versions 1 and 2.
// Layout: header, then a tree of extension -> directory -> filename, each file
// followed by a fixed entry record and its preload bytes.
import type { ByteSource } from './source';

const VPK_SIGNATURE = 0x55aa1234;
const DIR_ARCHIVE = 0x7fff;

interface VpkEntry {
    archiveIndex: number;
    offset: number;
    length: number;
    preload: Uint8Array;
}

export class Vpk {
    readonly entries = new Map<string, VpkEntry>();
    private dataStart = 0;

    /** @param dirPath install-relative path of the `_dir.vpk` file */
    constructor(private source: ByteSource, private dirPath: string, dir: Uint8Array) {
        const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
        if (view.getUint32(0, true) !== VPK_SIGNATURE) throw new Error(`${dirPath}: not a VPK`);
        const version = view.getUint32(4, true);
        const treeSize = view.getUint32(8, true);
        const headerSize = version === 1 ? 12 : version === 2 ? 28 : -1;
        if (headerSize < 0) throw new Error(`${dirPath}: unsupported VPK version ${version}`);
        this.dataStart = headerSize + treeSize;

        let p = headerSize;
        const readString = () => {
            const start = p;
            while (dir[p] !== 0) p++;
            const s = new TextDecoder().decode(dir.subarray(start, p));
            p++;
            return s;
        };

        for (;;) {
            const ext = readString();
            if (!ext) break;
            for (;;) {
                const dirName = readString();
                if (!dirName) break;
                for (;;) {
                    const name = readString();
                    if (!name) break;
                    const preloadBytes = view.getUint16(p + 4, true);
                    const archiveIndex = view.getUint16(p + 6, true);
                    const offset = view.getUint32(p + 8, true);
                    const length = view.getUint32(p + 12, true);
                    p += 18; // crc u32, preload u16, archive u16, offset u32, length u32, terminator u16
                    const preload = dir.slice(p, p + preloadBytes);
                    p += preloadBytes;
                    const full = (dirName === ' ' ? '' : dirName + '/') + name + (ext === ' ' ? '' : '.' + ext);
                    this.entries.set(full.toLowerCase(), { archiveIndex, offset, length, preload });
                }
            }
        }
    }

    static async open(source: ByteSource, dirPath: string): Promise<Vpk | null> {
        const dir = await source.read(dirPath);
        return dir ? new Vpk(source, dirPath, dir) : null;
    }

    has(path: string): boolean {
        return this.entries.has(path.toLowerCase());
    }

    async read(path: string): Promise<Uint8Array | null> {
        const e = this.entries.get(path.toLowerCase());
        if (!e) return null;
        if (e.length === 0) return e.preload;

        let data: Uint8Array | null;
        if (e.archiveIndex === DIR_ARCHIVE) {
            data = await this.source.read(this.dirPath, this.dataStart + e.offset, e.length);
        } else {
            const archive = this.dirPath.replace(/_dir\.vpk$/i, `_${String(e.archiveIndex).padStart(3, '0')}.vpk`);
            data = await this.source.read(archive, e.offset, e.length);
        }
        if (!data) return null;
        if (e.preload.length === 0) return data;
        const out = new Uint8Array(e.preload.length + data.length);
        out.set(e.preload);
        out.set(data, e.preload.length);
        return out;
    }
}
