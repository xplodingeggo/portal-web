// Layered game filesystem following Portal's gameinfo.txt search order:
// map pakfile, portal VPKs, hl2 VPKs, then loose portal and hl2 directories.
import type { ByteSource } from './source';
import { Vpk } from './vpk';
import type { Zip } from './zip';

const VPKS = ['portal/portal_pak_dir.vpk', 'hl2/hl2_textures_dir.vpk', 'hl2/hl2_sound_misc_dir.vpk', 'hl2/hl2_misc_dir.vpk'];
const LOOSE_ROOTS = ['portal', 'hl2'];

export class GameFS {
    private vpks: Vpk[] = [];
    private loose = new Set<string>();
    private pak: Zip | null = null;

    constructor(readonly source: ByteSource) {}

    /** @param looseIndex lowercase install-relative paths of loose files (e.g. "portal/maps/x.bsp") */
    async mount(looseIndex: Iterable<string>) {
        for (const f of looseIndex) this.loose.add(f);
        const vpks = await Promise.all(VPKS.map((p) => Vpk.open(this.source, p)));
        this.vpks = vpks.filter((v): v is Vpk => v !== null);
    }

    /** Mount (or clear) the current map's embedded pakfile. */
    setPakfile(pak: Zip | null) {
        this.pak = pak;
    }

    exists(path: string): boolean {
        const p = normalize(path);
        return (
            !!this.pak?.has(p) ||
            this.vpks.some((v) => v.has(p)) ||
            LOOSE_ROOTS.some((r) => this.loose.has(`${r}/${p}`))
        );
    }

    /** Lowercase paths in the game's archives that start with `prefix` and end with `suffix`. */
    list(prefix: string, suffix: string): string[] {
        const out = new Set<string>();
        for (const v of this.vpks) for (const k of v.entries.keys()) if (k.startsWith(prefix) && k.endsWith(suffix)) out.add(k);
        return [...out];
    }

    async read(path: string): Promise<Uint8Array | null> {
        const p = normalize(path);
        if (this.pak?.has(p)) return this.pak.read(p);
        for (const v of this.vpks) if (v.has(p)) return v.read(p);
        for (const r of LOOSE_ROOTS) if (this.loose.has(`${r}/${p}`)) return this.source.read(`${r}/${p}`);
        return null;
    }
}

export function normalize(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').toLowerCase();
}
