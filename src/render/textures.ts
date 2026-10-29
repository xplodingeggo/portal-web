// Uploads VTF textures to three.js, keeping DXT data compressed on the GPU.
import * as THREE from 'three';
import type { GameFS } from '../fs/gamefs';
import { texturePath } from '../material/vmt';
import { decodeDXT, ImageFormat, parseVtf, type Vtf } from '../material/vtf';

export class TextureCache {
    private cache = new Map<string, Promise<THREE.Texture | null>>();
    readonly missing = new Set<string>();
    private s3tc: boolean;
    private anisotropy: number;

    constructor(private fs: GameFS, renderer: THREE.WebGLRenderer) {
        this.s3tc = renderer.extensions.has('WEBGL_compressed_texture_s3tc');
        this.anisotropy = renderer.capabilities.getMaxAnisotropy();
    }

    /** A texture by material-relative name; `frame` picks an animation frame (clamped). */
    get(name: string, frame = 0): Promise<THREE.Texture | null> {
        const path = texturePath(name);
        const key = `${path}#${frame}`;
        let p = this.cache.get(key);
        if (!p) {
            p = this.load(path, frame);
            this.cache.set(key, p);
        }
        return p;
    }

    /** Number of animation frames in a texture (1 if missing). */
    async frameCount(name: string): Promise<number> {
        const tex = await this.get(name);
        return (tex?.userData.frames as number | undefined) ?? 1;
    }

    private bytes = new Map<string, Promise<Uint8Array | null>>();

    private async load(path: string, frame: number): Promise<THREE.Texture | null> {
        let b = this.bytes.get(path);
        if (!b) this.bytes.set(path, (b = this.fs.read(path)));
        const bytes = await b;
        if (!bytes) {
            this.missing.add(path);
            return null;
        }
        try {
            const vtf = parseVtf(bytes, frame);
            const tex = this.toTexture(vtf);
            tex.name = path;
            tex.userData.frames = vtf.frames;
            return tex;
        } catch (e) {
            console.warn(`${path}: ${(e as Error).message}`);
            this.missing.add(path);
            return null;
        }
    }

    private toTexture(vtf: Vtf): THREE.Texture {
        let tex: THREE.Texture;
        const gpuDXT = vtf.compressed && this.s3tc && vtf.width % 4 === 0 && vtf.height % 4 === 0;
        if (gpuDXT) {
            const format =
                vtf.format === ImageFormat.DXT1
                    ? THREE.RGB_S3TC_DXT1_Format
                    : vtf.format === ImageFormat.DXT1_ONEBITALPHA
                      ? THREE.RGBA_S3TC_DXT1_Format
                      : vtf.format === ImageFormat.DXT3
                        ? THREE.RGBA_S3TC_DXT3_Format
                        : THREE.RGBA_S3TC_DXT5_Format;
            tex = new THREE.CompressedTexture(
                vtf.mips.map((m) => ({ data: m.data, width: m.width, height: m.height })),
                vtf.width,
                vtf.height,
                format,
            );
        } else {
            const mips = vtf.mips.map((m) => ({
                width: m.width,
                height: m.height,
                data: vtf.compressed ? decodeDXT(vtf.format, m.data, m.width, m.height) : m.data,
            }));
            const top = mips[0];
            tex = new THREE.DataTexture(top.data, top.width, top.height, THREE.RGBAFormat);
            tex.mipmaps = mips;
            tex.generateMipmaps = false;
        }
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = vtf.mips.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        tex.anisotropy = this.anisotropy;
        // Source V runs down the image; VTF rows are top to bottom, as WebGL uploads them unflipped.
        tex.flipY = false;
        tex.needsUpdate = true;
        return tex;
    }
}

export function checkerTexture(): THREE.Texture {
    const n = 8;
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const on = (x >> 2) ^ (y >> 2);
            data.set(on ? [255, 0, 255, 255] : [0, 0, 0, 255], (y * n + x) * 4);
        }
    }
    const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
}

export function lightmapTexture(width: number, height: number, linear: Float32Array): THREE.DataTexture {
    const half = new Uint16Array(linear.length);
    for (let i = 0; i < linear.length; i++) half[i] = THREE.DataUtils.toHalfFloat(Math.min(linear[i], 65000));
    const tex = new THREE.DataTexture(half, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
}
