// Particle definitions: .pcf files are Valve DMX binary (v2/v3, "format pcf 1"). The root holds
// "particleSystemDefinitions"; each definition has its own settings plus operator lists
// (emitters, initializers, operators, renderers, forces, constraints) and child systems.
export type PcfValue = number | boolean | string | number[] | PcfElement | null | PcfValue[];

export interface PcfElement {
    type: string;
    name: string;
    attrs: Map<string, PcfValue>;
}

/** One operator of a system: its functionName plus the parameters it sets. */
export interface PcfOperator {
    name: string;
    fn: string;
    attrs: Map<string, PcfValue>;
}

export interface PcfChild {
    system: string;
    delay: number;
}

export interface ParticleDef {
    name: string;
    attrs: Map<string, PcfValue>;
    children: PcfChild[];
    emitters: PcfOperator[];
    initializers: PcfOperator[];
    operators: PcfOperator[];
    renderers: PcfOperator[];
    forces: PcfOperator[];
    constraints: PcfOperator[];
}

const ATTR_ELEMENT = 1, ATTR_INT = 2, ATTR_FLOAT = 3, ATTR_BOOL = 4, ATTR_STRING = 5, ATTR_VOID = 6, ATTR_TIME = 7;
const ATTR_COLOR = 8, ATTR_VEC2 = 9, ATTR_VEC3 = 10, ATTR_VEC4 = 11, ATTR_QANGLE = 12, ATTR_QUAT = 13, ATTR_MATRIX = 14;
const ARRAY_BASE = 14;

class Reader {
    pos = 0;
    private v: DataView;
    constructor(readonly b: Uint8Array) {
        this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    }
    u8() { return this.b[this.pos++]; }
    u16() { const x = this.v.getUint16(this.pos, true); this.pos += 2; return x; }
    i32() { const x = this.v.getInt32(this.pos, true); this.pos += 4; return x; }
    f32() { const x = this.v.getFloat32(this.pos, true); this.pos += 4; return x; }
    cstr() {
        const s = this.pos;
        while (this.b[this.pos]) this.pos++;
        const out = new TextDecoder().decode(this.b.subarray(s, this.pos));
        this.pos++;
        return out;
    }
}

/** Parses the DMX binary container into elements. Returns the root. */
function parseDmx(buf: Uint8Array): PcfElement {
    const r = new Reader(buf);
    const header = r.cstr();
    const m = /binary (\d+) format/.exec(header);
    if (!m) throw new Error('not a binary DMX file');
    const version = Number(m[1]);
    if (version < 2 || version > 5) throw new Error('unsupported DMX version ' + version);
    const count = version >= 5 ? r.i32() : r.u16();
    const dict: string[] = [];
    for (let i = 0; i < count; i++) dict.push(r.cstr());
    const symbol = () => dict[version >= 5 ? r.i32() : r.u16()] ?? '';
    const name = () => (version >= 4 ? symbol() : r.cstr());

    const n = r.i32();
    const elements: PcfElement[] = [];
    for (let i = 0; i < n; i++) {
        const type = symbol();
        const nm = name();
        r.pos += 16; // GUID
        elements.push({ type, name: nm, attrs: new Map() });
    }

    const scalar = (type: number): PcfValue => {
        switch (type) {
            case ATTR_ELEMENT: { const i = r.i32(); if (i === -2) r.cstr(); return i >= 0 ? elements[i] : null; }
            case ATTR_INT: return r.i32();
            case ATTR_FLOAT: return r.f32();
            case ATTR_BOOL: return r.u8() !== 0;
            case ATTR_STRING: return version >= 4 ? symbol() : r.cstr();
            case ATTR_VOID: { const len = r.i32(); r.pos += len; return null; }
            case ATTR_TIME: return r.i32() / 10000;
            case ATTR_COLOR: return [r.u8(), r.u8(), r.u8(), r.u8()];
            case ATTR_VEC2: return [r.f32(), r.f32()];
            case ATTR_VEC3: case ATTR_QANGLE: return [r.f32(), r.f32(), r.f32()];
            case ATTR_VEC4: case ATTR_QUAT: return [r.f32(), r.f32(), r.f32(), r.f32()];
            case ATTR_MATRIX: return Array.from({ length: 16 }, () => r.f32());
            default: throw new Error('unknown DMX attribute type ' + type);
        }
    };
    for (const e of elements) {
        for (let a = r.i32(); a > 0; a--) {
            const key = symbol();
            const type = r.u8();
            if (type > ARRAY_BASE) {
                const len = r.i32();
                const list: PcfValue[] = [];
                for (let k = 0; k < len; k++) list.push(scalar(type - ARRAY_BASE));
                e.attrs.set(key, list);
            } else {
                e.attrs.set(key, scalar(type));
            }
        }
    }
    return elements[0];
}

const operatorList = (e: PcfElement, key: string): PcfOperator[] => {
    const list = e.attrs.get(key);
    if (!Array.isArray(list)) return [];
    return (list as PcfElement[]).filter(Boolean).map((o) => ({
        name: o.name,
        fn: String(o.attrs.get('functionName') ?? ''),
        attrs: o.attrs,
    }));
};

/** Every particle system in a .pcf, by name. */
export function parsePcf(buf: Uint8Array): Map<string, ParticleDef> {
    const root = parseDmx(buf);
    const defs = (root.attrs.get('particleSystemDefinitions') as PcfElement[] | undefined) ?? [];
    const out = new Map<string, ParticleDef>();
    for (const d of defs) {
        const children = ((d.attrs.get('children') as PcfElement[] | undefined) ?? []).filter(Boolean).map((c) => ({
            system: String((c.attrs.get('child') as PcfElement | null)?.name ?? ''),
            delay: Number(c.attrs.get('delay') ?? 0),
        }));
        out.set(d.name, {
            name: d.name,
            attrs: d.attrs,
            children,
            emitters: operatorList(d, 'emitters'),
            initializers: operatorList(d, 'initializers'),
            operators: operatorList(d, 'operators'),
            renderers: operatorList(d, 'renderers'),
            forces: operatorList(d, 'forces'),
            constraints: operatorList(d, 'constraints'),
        });
    }
    return out;
}
