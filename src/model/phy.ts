// Collision models (.phy): one or more solids, each an IVP compact surface made of
// convex "ledges" (hulls). Points are stored in IVP space (meters, Y down);
// they're converted to Source inches here. Hulls come out in the model's posed
// space (checked against posed mesh bounds).
export type Vec3 = [number, number, number];

export interface Hull {
    points: Vec3[];
    /** Triangles as indices into points. */
    triangles: [number, number, number][];
}

const METERS_TO_INCHES = 1 / 0.0254;

/**
 * Physics properties from the keyvalues text after the solids: total mass (kg) and the first
 * solid's surfaceprop. Mass is null if the file has none.
 */
export function parsePhyProperties(buf: Uint8Array): { mass: number | null; surfaceProp: string | null } {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let p = v.getInt32(0, true);
    const solidCount = v.getInt32(8, true);
    for (let s = 0; s < solidCount && p + 4 <= buf.length; s++) p += 4 + v.getInt32(p, true);
    const text = new TextDecoder().decode(buf.subarray(Math.min(p, buf.length)));
    let mass: number | null = null;
    for (const m of text.matchAll(/"mass"\s+"([-\d.eE]+)"/g)) mass = (mass ?? 0) + Number(m[1]);
    const surfaceProp = /"surfaceprop"\s+"([^"]*)"/.exec(text)?.[1] ?? null;
    return { mass, surfaceProp };
}

export function parsePhy(buf: Uint8Array): Hull[] {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const headerSize = v.getInt32(0, true);
    const solidCount = v.getInt32(8, true);
    const hulls: Hull[] = [];

    let p = headerSize;
    for (let s = 0; s < solidCount && p + 4 <= buf.length; s++) {
        const size = v.getInt32(p, true);
        const solidStart = p + 4;
        p = solidStart + size;
        // "VPHY" header: id, version, model type, surface size, drag areas, axis map size.
        if (v.getUint32(solidStart, true) !== 0x59485056) continue;
        if (v.getInt16(solidStart + 6, true) !== 0) continue; // only convex-hull surfaces
        const surface = solidStart + 28;
        const treeOffset = v.getInt32(surface + 32, true);

        // Ledges are packed back to back; the shared point array follows them.
        let end = surface + treeOffset;
        for (let q = surface + 48; q + 16 <= end; ) {
            const pointOffset = v.getInt32(q, true);
            const flags = v.getUint32(q + 8, true);
            const numTris = v.getInt16(q + 12, true);
            end = Math.min(end, q + pointOffset);
            // Ledges with children are bounding hulls over the real ones.
            if ((flags & 3) === 0) {
                const remap = new Map<number, number>();
                const points: Vec3[] = [];
                const triangles: [number, number, number][] = [];
                const point = (i: number) => {
                    let r = remap.get(i);
                    if (r === undefined) {
                        const o = q + pointOffset + i * 16;
                        const x = v.getFloat32(o, true), y = v.getFloat32(o + 4, true), z = v.getFloat32(o + 8, true);
                        r = points.push([x * METERS_TO_INCHES, z * METERS_TO_INCHES, -y * METERS_TO_INCHES]) - 1;
                        remap.set(i, r);
                    }
                    return r;
                };
                for (let t = 0; t < numTris; t++) {
                    const e = q + 16 + t * 16 + 4;
                    triangles.push([
                        point(v.getUint32(e, true) & 0xffff),
                        point(v.getUint32(e + 4, true) & 0xffff),
                        point(v.getUint32(e + 8, true) & 0xffff),
                    ]);
                }
                if (points.length >= 4) hulls.push({ points, triangles });
            }
            q += 16 + numTris * 16;
        }
    }
    return hulls;
}
