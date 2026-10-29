// Parser for the BSP entity lump: a list of { "key" "value" ... } blocks.
export type Entity = Record<string, string>;

export function parseEntities(text: string): Entity[] {
    const out: Entity[] = [];
    const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
    let cur: Entity | null = null;
    let key: string | null = null;
    for (let m; (m = re.exec(text)); ) {
        if (m[2] === '{') {
            cur = {};
            key = null;
        } else if (m[2] === '}') {
            if (cur) out.push(cur);
            cur = null;
        } else if (cur) {
            if (key === null) key = m[1].toLowerCase();
            else {
                // Duplicate keys (e.g. outputs) keep the first value; fine for rendering.
                if (!(key in cur)) cur[key] = m[1];
                key = null;
            }
        }
    }
    return out;
}

/** Every entity's key/value pairs in file order, duplicates kept (outputs repeat their key). */
export function parseEntityPairs(text: string): [string, string][][] {
    const out: [string, string][][] = [];
    const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
    let cur: [string, string][] | null = null;
    let key: string | null = null;
    for (let m; (m = re.exec(text)); ) {
        if (m[2] === '{') {
            cur = [];
            key = null;
        } else if (m[2] === '}') {
            if (cur) out.push(cur);
            cur = null;
        } else if (cur) {
            if (key === null) key = m[1];
            else {
                cur.push([key, m[1]]);
                key = null;
            }
        }
    }
    return out;
}

export function parseVec3(s: string | undefined): [number, number, number] {
    const p = (s ?? '').trim().split(/\s+/).map(Number);
    return [p[0] || 0, p[1] || 0, p[2] || 0];
}
