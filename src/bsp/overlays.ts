// Overlays (info_overlay decals), compiled into lump 45. Each overlay is a quad in
// its own 2D basis that gets clipped to, and projected onto, a list of faces.
// doverlay_t layout follows the public Source SDK 2013 header bspfile.h.
import { Lump, type BspFile } from './bsp';
import type { LightmapAtlas } from './lightmap';
import { surfaceUV, type MaterialBatch, type Vec3 } from './mesh';

const OVERLAY_SIZE = 352;

/** A clip-space vertex: overlay-basis position (s, t) plus texture coordinates. */
type V2 = [number, number, number, number];

export function buildOverlays(bsp: BspFile, lm: LightmapAtlas, faceOrigins: Map<number, Vec3>): MaterialBatch[] {
    const data = bsp.lumpBytes(Lump.Overlays);
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const groups = new Map<string, { material: string; order: number; pos: number[]; uv: number[]; lmuv: number[]; faces: number }>();

    for (let o = 0; o + OVERLAY_SIZE <= data.length; o += OVERLAY_SIZE) {
        const texInfo = v.getInt16(o + 4, true);
        const countAndOrder = v.getUint16(o + 6, true);
        if (texInfo < 0 || texInfo >= bsp.texInfos.length) continue;
        const material = bsp.texDatas[bsp.texInfos[texInfo].texData].name.toLowerCase();
        const order = countAndOrder >> 14;
        const faces: number[] = [];
        for (let k = 0; k < (countAndOrder & 0x3fff); k++) faces.push(v.getInt32(o + 8 + k * 4, true));
        const f32 = (p: number) => v.getFloat32(p, true);
        const u = [f32(o + 264), f32(o + 268)];
        const vv = [f32(o + 272), f32(o + 276)];
        const pts = [0, 1, 2, 3].map((k) => [f32(o + 280 + k * 12), f32(o + 284 + k * 12), f32(o + 288 + k * 12)]);
        const origin: Vec3 = [f32(o + 328), f32(o + 332), f32(o + 336)];
        const normal: Vec3 = [f32(o + 340), f32(o + 344), f32(o + 348)];

        // The U axis is packed into the z components of the four points; V = N x U.
        const basisU: Vec3 = [pts[0][2], pts[1][2], pts[2][2]];
        const basisV = cross(normal, basisU);
        const corners: V2[] = [
            [pts[0][0], pts[0][1], u[0], vv[0]],
            [pts[1][0], pts[1][1], u[0], vv[1]],
            [pts[2][0], pts[2][1], u[1], vv[1]],
            [pts[3][0], pts[3][1], u[1], vv[0]],
        ];
        const tris = [
            [corners[0], corners[1], corners[2]],
            [corners[0], corners[2], corners[3]],
        ];

        const key = `${material}|${order}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { material, order, pos: [], uv: [], lmuv: [], faces: 0 }));

        for (const fi of faces) {
            const faceOrigin = faceOrigins.get(fi);
            const face = bsp.faces[fi];
            if (!faceOrigin || !face || face.dispInfo >= 0) continue;

            let n: Vec3 = [bsp.planeNormals[face.planeNum * 3], bsp.planeNormals[face.planeNum * 3 + 1], bsp.planeNormals[face.planeNum * 3 + 2]];
            let d = bsp.planeDists[face.planeNum] + dot(n, faceOrigin);
            if (face.side) {
                n = [-n[0], -n[1], -n[2]];
                d = -d;
            }
            const denom = dot(n, normal);
            if (Math.abs(denom) < 1e-3) continue;

            // Face outline in overlay space.
            const poly = bsp.faceVertexIndices(face).map((vi): [number, number] => {
                const p: Vec3 = [
                    bsp.vertices[vi * 3] + faceOrigin[0] - origin[0],
                    bsp.vertices[vi * 3 + 1] + faceOrigin[1] - origin[1],
                    bsp.vertices[vi * 3 + 2] + faceOrigin[2] - origin[2],
                ];
                return [dot(p, basisU), dot(p, basisV)];
            });

            let emitted = false;
            for (const tri of tris) {
                const clipped = clipToConvex(tri, poly);
                if (clipped.length < 3) continue;
                const world = clipped.map(([s, t]): Vec3 => {
                    const p0: Vec3 = [
                        origin[0] + s * basisU[0] + t * basisV[0],
                        origin[1] + s * basisU[1] + t * basisV[1],
                        origin[2] + s * basisU[2] + t * basisV[2],
                    ];
                    const k = (d - dot(n, p0)) / denom;
                    return [p0[0] + normal[0] * k, p0[1] + normal[1] * k, p0[2] + normal[2] * k];
                });
                for (let i = 1; i + 1 < clipped.length; i++) {
                    let idx = [0, i, i + 1];
                    // Keep the triangle facing the same way as its face (counter-clockwise front).
                    if (dot(cross(sub(world[idx[1]], world[idx[0]]), sub(world[idx[2]], world[idx[0]])), n) < 0) idx = [0, i + 1, i];
                    for (const j of idx) {
                        const p = world[j];
                        const local: Vec3 = [p[0] - faceOrigin[0], p[1] - faceOrigin[1], p[2] - faceOrigin[2]];
                        const lmUV = surfaceUV(bsp, face, fi, lm, local);
                        g.pos.push(p[0], p[1], p[2]);
                        g.uv.push(clipped[j][2], clipped[j][3]);
                        g.lmuv.push(lmUV[2], lmUV[3]);
                    }
                }
                emitted = true;
            }
            if (emitted) g.faces++;
        }
    }

    return [...groups.values()]
        .filter((g) => g.pos.length > 0)
        .map((g) => ({
            material: g.material,
            positions: new Float32Array(g.pos),
            uvs: new Float32Array(g.uv),
            lightmapUVs: new Float32Array(g.lmuv),
            alphas: new Float32Array(g.pos.length / 3).fill(1),
            faceCount: g.faces,
            overlayOrder: g.order,
        }));
}

/** Sutherland-Hodgman clip of a polygon (with interpolated UVs) against a convex outline. */
function clipToConvex(subject: V2[], outline: [number, number][]): V2[] {
    let area = 0;
    for (let i = 0; i < outline.length; i++) {
        const a = outline[i];
        const b = outline[(i + 1) % outline.length];
        area += a[0] * b[1] - b[0] * a[1];
    }
    const sign = area >= 0 ? 1 : -1;

    let out = subject;
    for (let i = 0; i < outline.length && out.length > 0; i++) {
        const a = outline[i];
        const b = outline[(i + 1) % outline.length];
        const side = (p: V2) => sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
        const input = out;
        out = [];
        for (let k = 0; k < input.length; k++) {
            const cur = input[k];
            const prev = input[(k + input.length - 1) % input.length];
            const dc = side(cur);
            const dp = side(prev);
            if (dc >= 0) {
                if (dp < 0) out.push(lerp(prev, cur, dp / (dp - dc)));
                out.push(cur);
            } else if (dp >= 0) {
                out.push(lerp(prev, cur, dp / (dp - dc)));
            }
        }
    }
    return out;
}

function lerp(a: V2, b: V2, t: number): V2 {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

function dot(a: Vec3, b: Vec3) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
