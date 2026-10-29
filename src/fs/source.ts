// Byte access to files in the game install, relative to the install root
// (e.g. "portal/portal_pak_dir.vpk"). The browser uses HTTP; tests use the disk.
export interface ByteSource {
    /** Read a whole file, or a slice when offset/length are given. Returns null if missing. */
    read(path: string, offset?: number, length?: number): Promise<Uint8Array | null>;
}

export class HttpSource implements ByteSource {
    constructor(private base = '/game/') {}

    async read(path: string, offset?: number, length?: number): Promise<Uint8Array | null> {
        const headers: Record<string, string> = {};
        if (offset !== undefined && length !== undefined) {
            if (length === 0) return new Uint8Array(0);
            headers.Range = `bytes=${offset}-${offset + length - 1}`;
        }
        const res = await fetch(this.base + path.split('/').map(encodeURIComponent).join('/'), { headers });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
    }
}
