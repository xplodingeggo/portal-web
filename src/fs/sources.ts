// Where the game files come from. All of these are ByteSources keyed by install-relative paths
// ("portal/portal_pak_dir.vpk"), so GameFS does not care which one it gets.
//   server  stream byte ranges from the host on demand, so play starts straight away
//   local   a Portal folder the player picks on their own machine (nothing is uploaded)
//   cached  server streaming plus a copy in the browser's private storage (OPFS), filled in the
//           background; files that are fully saved are read from disk instead of the network
import type { ByteSource } from './source';
import { HttpSource } from './source';

export interface ManifestEntry {
    path: string;
    size: number;
}

const INDEX_ROOTS = ['portal/', 'hl2/'];

/** Lowercase install-relative paths of loose (non-VPK) files, the format GameFS.mount expects. */
export function looseIndex(paths: Iterable<string>): string[] {
    const out: string[] = [];
    for (const p of paths) {
        const l = p.toLowerCase();
        if (INDEX_ROOTS.some((r) => l.startsWith(r)) && !l.endsWith('.vpk')) out.push(l);
    }
    return out;
}

// ---- server ----

export interface ServerBackend {
    source: ByteSource;
    base: string;
    manifest: ManifestEntry[];
    index: string[];
}

export async function serverBackend(): Promise<ServerBackend> {
    if (import.meta.env.DEV) {
        // vite dev server: server/gameFiles.ts serves GAME_DIR and the loose index directly
        const index: string[] = await (await fetch('/__gameindex')).json();
        return { source: new HttpSource('/game/'), base: '/game/', manifest: [], index };
    }
    const base = `${import.meta.env.BASE_URL}files/`;
    const res = await fetch(`${base}manifest.json`);
    if (!res.ok) throw new Error(`game files unavailable on this server (HTTP ${res.status})`);
    const manifest: ManifestEntry[] = await res.json();
    return { source: new HttpSource(base), base, manifest, index: looseIndex(manifest.map((m) => m.path)) };
}

// ---- local folder ----

type Entry = { file: File } | { handle: FileSystemFileHandle };

const SKIP_DIRS = new Set(['bin', 'save', 'cfg', 'downloadlists']);

export class LocalSource implements ByteSource {
    private constructor(private files: Map<string, Entry>) {}

    get index(): string[] {
        return looseIndex(this.files.keys());
    }

    /** Needs the File System Access API (Chromium). */
    static async fromDirectoryHandle(root: FileSystemDirectoryHandle): Promise<LocalSource> {
        const files = new Map<string, Entry>();
        const walk = async (dir: FileSystemDirectoryHandle, rel: string) => {
            for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
                if (h.kind === 'directory') {
                    if (SKIP_DIRS.has(name.toLowerCase())) continue;
                    await walk(h as FileSystemDirectoryHandle, `${rel}/${name}`);
                } else {
                    files.set(`${rel}/${name}`.toLowerCase(), { handle: h as FileSystemFileHandle });
                }
            }
        };
        for await (const [name, h] of (root as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
            const l = name.toLowerCase();
            if (h.kind === 'directory' && (l === 'portal' || l === 'hl2')) await walk(h as FileSystemDirectoryHandle, name);
        }
        return LocalSource.checked(files);
    }

    /** Fallback for browsers without showDirectoryPicker: files from <input webkitdirectory>. */
    static fromFileList(list: FileList): LocalSource {
        const files = new Map<string, Entry>();
        for (const file of Array.from(list)) {
            // webkitRelativePath is "<picked folder>/portal/maps/x.bsp"
            const rel = file.webkitRelativePath.split('/').slice(1).join('/').toLowerCase();
            const parts = rel.split('/');
            if (parts.length < 2 || SKIP_DIRS.has(parts[1])) continue;
            files.set(rel, { file });
        }
        return LocalSource.checked(files);
    }

    private static checked(files: Map<string, Entry>): LocalSource {
        if (!files.has('portal/portal_pak_dir.vpk')) {
            throw new Error('That folder has no portal/portal_pak_dir.vpk. Pick the Portal install folder (the one containing "portal" and "hl2").');
        }
        return new LocalSource(files);
    }

    async read(path: string, offset?: number, length?: number): Promise<Uint8Array | null> {
        const e = this.files.get(path.toLowerCase());
        if (!e) return null;
        const file = 'file' in e ? e.file : await e.handle.getFile();
        if (offset !== undefined && length !== undefined) {
            if (length === 0) return new Uint8Array(0);
            return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        }
        return new Uint8Array(await file.arrayBuffer());
    }
}

function idb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open('portal-web', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('kv');
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
    });
}

export async function rememberDirectory(h: FileSystemDirectoryHandle): Promise<void> {
    try {
        (await idb()).transaction('kv', 'readwrite').objectStore('kv').put(h, 'gameDir');
    } catch { /* storage blocked: the player just picks the folder again next time */ }
}

export async function rememberedDirectory(): Promise<FileSystemDirectoryHandle | null> {
    try {
        const db = await idb();
        return await new Promise((resolve) => {
            const r = db.transaction('kv').objectStore('kv').get('gameDir');
            r.onsuccess = () => resolve((r.result as FileSystemDirectoryHandle) ?? null);
            r.onerror = () => resolve(null);
        });
    } catch {
        return null;
    }
}

// ---- browser copy of the server files ----

const DONE_KEY = 'portal-web.saved';

export const opfsSupported = () =>
    typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory && 'createWritable' in FileSystemFileHandle.prototype;

function loadDone(): Record<string, number> {
    try { return JSON.parse(localStorage.getItem(DONE_KEY) ?? '{}'); } catch { return {}; }
}

export class CachedSource implements ByteSource {
    private done = loadDone();
    private root: Promise<FileSystemDirectoryHandle> = navigator.storage.getDirectory();
    private aborter: AbortController | null = null;

    constructor(private net: ByteSource, private manifest: ManifestEntry[]) {
        // forget entries whose size no longer matches the server (game update)
        const sizes = new Map(manifest.map((m) => [m.path, m.size]));
        for (const p of Object.keys(this.done)) if (sizes.get(p) !== this.done[p]) delete this.done[p];
    }

    get savedBytes(): number {
        return Object.values(this.done).reduce((a, b) => a + b, 0);
    }

    get totalBytes(): number {
        return this.manifest.reduce((a, m) => a + m.size, 0);
    }

    isSaved(path: string): boolean {
        return path in this.done;
    }

    private async fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
        let dir = await this.root;
        const parts = path.split('/');
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
        return dir.getFileHandle(parts[parts.length - 1], { create });
    }

    async read(path: string, offset?: number, length?: number): Promise<Uint8Array | null> {
        if (this.isSaved(path)) {
            try {
                const file = await (await this.fileHandle(path, false)).getFile();
                if (file.size === this.done[path]) {
                    if (offset !== undefined && length !== undefined) {
                        if (length === 0) return new Uint8Array(0);
                        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
                    }
                    return new Uint8Array(await file.arrayBuffer());
                }
            } catch { /* evicted by the browser: fall through to the network */ }
            delete this.done[path];
            this.persist();
        }
        return this.net.read(path, offset, length);
    }

    private persist() {
        try { localStorage.setItem(DONE_KEY, JSON.stringify(this.done)); } catch { /* ignore */ }
    }

    /** Save every manifest file not already saved. Resumable: finished files are skipped. */
    async downloadAll(base: string, onProgress: (saved: number, total: number) => void): Promise<void> {
        this.aborter = new AbortController();
        const signal = this.aborter.signal;
        const total = this.totalBytes;
        let saved = this.savedBytes;
        onProgress(saved, total);
        // small files first so the loose index fills in quickly, big VPKs after
        const todo = this.manifest.filter((m) => !this.isSaved(m.path)).sort((a, b) => a.size - b.size);
        let next = 0;
        const worker = async () => {
            while (next < todo.length && !signal.aborted) {
                const m = todo[next++];
                const res = await fetch(base + m.path.split('/').map(encodeURIComponent).join('/'), { signal });
                if (!res.ok || !res.body) throw new Error(`${m.path}: HTTP ${res.status}`);
                const out = await (await this.fileHandle(m.path, true)).createWritable();
                let got = 0;
                try {
                    const reader = res.body.getReader();
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        await out.write(value);
                        got += value.length;
                        saved += value.length;
                        onProgress(saved, total);
                    }
                    await out.close();
                } catch (e) {
                    saved -= got;
                    await out.abort().catch(() => {});
                    throw e;
                }
                this.done[m.path] = m.size;
                this.persist();
            }
        };
        await Promise.all([worker(), worker()]);
    }

    stop() {
        this.aborter?.abort();
    }

    /** Delete the browser copy. */
    async clear(): Promise<void> {
        this.stop();
        const root = await this.root;
        for (const d of ['portal', 'hl2']) await root.removeEntry(d, { recursive: true }).catch(() => {});
        this.done = {};
        this.persist();
    }
}
