// VMT material loading, including "patch" materials (include + replace/insert),
// which maps use to attach per-location cubemaps to stock materials.
import type { GameFS } from '../fs/gamefs';
import { parseKeyValues, type KVBlock } from './keyvalues';

export interface MaterialDef {
    name: string;
    shader: string; // lowercase, e.g. "lightmappedgeneric"
    params: Record<string, string>; // "$basetexture" -> "metal/metalwall048b"
}

export async function loadMaterial(fs: GameFS, name: string, depth = 0): Promise<MaterialDef | null> {
    const path = materialPath(name);
    const bytes = await fs.read(path);
    if (!bytes) return null;
    const { name: shader, body } = parseKeyValues(new TextDecoder().decode(bytes));

    if (shader === 'patch') {
        const include = typeof body.include === 'string' ? body.include : null;
        if (!include || depth > 8) return null;
        const base = await loadMaterial(fs, include, depth + 1);
        if (!base) return null;
        const params = { ...base.params };
        for (const section of ['insert', 'replace']) {
            const block = body[section];
            if (typeof block === 'object') Object.assign(params, flatten(block));
        }
        return { name, shader: base.shader, params };
    }
    return { name, shader, params: flatten(body) };
}

function flatten(block: KVBlock): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(block)) if (typeof v === 'string') out[k] = v;
    return out;
}

/** "METAL/Foo" or "materials/metal/foo.vmt" -> "materials/metal/foo.vmt" */
export function materialPath(name: string): string {
    let p = name.replace(/\\/g, '/').toLowerCase();
    if (!p.startsWith('materials/')) p = 'materials/' + p;
    if (!p.endsWith('.vmt')) p += '.vmt';
    return p;
}

export function texturePath(name: string): string {
    let p = name.replace(/\\/g, '/').toLowerCase();
    if (!p.startsWith('materials/')) p = 'materials/' + p;
    if (!p.endsWith('.vtf')) p += '.vtf';
    return p;
}

export function paramBool(def: MaterialDef, key: string): boolean {
    const v = def.params[key];
    return v !== undefined && v !== '0' && v !== '';
}
