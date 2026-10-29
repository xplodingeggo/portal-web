// Sprites and beams for the map's old-style effect entities: env_sprite glows, env_beam lasers and
// lightning, point_spotlight cones. Both face the camera and take their look from a material.
import * as THREE from 'three';
import type { GameFS } from '../fs/gamefs';
import { loadMaterial } from '../material/vmt';
import type { Vec3 } from '../particles/system';
import type { TextureCache } from './textures';

interface Look {
    map: THREE.Texture | null;
    additive: boolean;
    /** Texture size in pixels, for sprites that are sized by the image. */
    size: number;
}

export interface SpriteOpts {
    material: string;
    pos: Vec3;
    /** Entity scale: world size = image size x scale. */
    scale: number;
    /** Overrides the image-based size: world units across. */
    size?: number;
    color?: [number, number, number];
    alpha?: number;
    /** Source render mode: 3, 5 and 9 add; the rest blend (or follow the material). */
    renderMode?: number;
}

export interface SpriteHandle {
    visible: boolean;
    setPos(p: Vec3): void;
    remove(): void;
}

export interface BeamOpts {
    material: string;
    from: Vec3;
    to: Vec3;
    /** Width at each end, in world units. */
    width: number;
    endWidth?: number;
    color?: [number, number, number];
    alpha?: number;
    endAlpha?: number;
    additive?: boolean;
    /** World units per texture repeat along the beam; 0 stretches the texture once. */
    tile?: number;
    /** Texture scroll in repeats per second. */
    scroll?: number;
    /** Sideways jitter of the points along it (lightning). */
    noise?: number;
}

export interface BeamHandle {
    from: Vec3;
    to: Vec3;
    visible: boolean;
    remove(): void;
}

const SEGMENTS = 24;

export function spriteMaterialName(model: string): string {
    let n = model.replace(/\\/g, '/').toLowerCase().replace(/^materials\//, '');
    n = n.replace(/\.spr$/, '.vmt');
    return n.endsWith('.vmt') ? n : n + '.vmt';
}

interface BeamState {
    o: BeamOpts;
    mesh: THREE.Mesh;
    geom: THREE.BufferGeometry;
    handle: BeamHandle;
    ready: boolean;
    nextJitter: number;
    jitter: Float32Array;
}

export class FxLayer {
    private looks = new Map<string, Promise<Look>>();
    private beams = new Set<BeamState>();
    private time = 0;

    constructor(private fs: GameFS, private textures: TextureCache, private scene: THREE.Scene) {}

    private look(material: string): Promise<Look> {
        const key = spriteMaterialName(material);
        let p = this.looks.get(key);
        if (!p) {
            p = (async (): Promise<Look> => {
                const none: Look = { map: null, additive: false, size: 32 };
                const def = await loadMaterial(this.fs, key).catch(() => null);
                const base = def?.params['$basetexture'];
                if (!def || !base) return none;
                const map = await this.textures.get(base);
                const flag = (k: string) => (def.params[k] ?? '0') !== '0';
                const img = map?.image as { width?: number } | undefined;
                const size = img?.width ?? (map?.mipmaps as { width: number }[] | undefined)?.[0]?.width ?? 32;
                return {
                    map,
                    additive: flag('$additive') || flag('$addself') || def.params['$spriterendermode'] === '5',
                    size,
                };
            })();
            this.looks.set(key, p);
        }
        return p;
    }

    sprite(o: SpriteOpts): SpriteHandle {
        const mat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false });
        const [r, g, b] = o.color ?? [1, 1, 1];
        // The map's render colour is a display value; given as sRGB it comes out as written (a colour of
        // 8 8 8 must stay near black, not be lifted to grey by the output encoding).
        mat.color.setRGB(r, g, b, THREE.SRGBColorSpace);
        mat.opacity = o.alpha ?? 1;
        const sprite = new THREE.Sprite(mat);
        sprite.position.set(...o.pos);
        sprite.renderOrder = 5;
        sprite.visible = false;
        this.scene.add(sprite);
        let alive = true, loaded = false, wanted = true;
        const handle: SpriteHandle = {
            get visible() { return wanted; },
            set visible(v: boolean) { wanted = v; sprite.visible = v && loaded; },
            setPos: (p) => sprite.position.set(...p),
            remove: () => { alive = false; this.scene.remove(sprite); mat.dispose(); },
        };
        void this.look(o.material).then((l) => {
            if (!alive || !l.map) return;
            mat.map = l.map;
            const add = [3, 5, 9].includes(o.renderMode ?? 0) || l.additive;
            mat.blending = add ? THREE.AdditiveBlending : THREE.NormalBlending;
            mat.needsUpdate = true;
            const size = o.size ?? l.size * o.scale;
            sprite.scale.set(size, size, 1);
            loaded = true;
            sprite.visible = wanted;
        });
        return handle;
    }

    beam(o: BeamOpts): BeamHandle {
        const geom = new THREE.BufferGeometry();
        const n = SEGMENTS + 1;
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
        geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2 * 2), 2));
        geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 2 * 4), 4));
        const idx: number[] = [];
        for (let i = 0; i < SEGMENTS; i++) {
            const a = i * 2;
            idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        geom.setIndex(idx);
        const mat = new THREE.MeshBasicMaterial({
            vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
            blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        // Beam textures repeat along their length.
        const mesh = new THREE.Mesh(geom, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 4;
        mesh.visible = false;
        this.scene.add(mesh);
        const state: BeamState = { o, mesh, geom, handle: null as unknown as BeamHandle, ready: false, nextJitter: 0, jitter: new Float32Array(n * 2 + 2) };
        state.handle = {
            from: [...o.from], to: [...o.to], visible: true,
            remove: () => { this.beams.delete(state); this.scene.remove(mesh); geom.dispose(); mat.dispose(); },
        };
        this.beams.add(state);
        void this.look(o.material).then((l) => {
            if (l.map) {
                l.map.wrapS = THREE.RepeatWrapping;
                mat.map = l.map;
            } else if (!o.additive) {
                return;
            }
            if (l.additive) mat.blending = THREE.AdditiveBlending;
            mat.needsUpdate = true;
            state.ready = true;
        });
        return state.handle;
    }

    update(dt: number, camera: THREE.Camera) {
        this.time += dt;
        const eye = camera.position;
        for (const b of this.beams) this.fillBeam(b, eye);
    }

    private fillBeam(b: BeamState, eye: THREE.Vector3) {
        const { o, handle } = b;
        b.mesh.visible = b.ready && handle.visible;
        if (!b.mesh.visible) return;
        const [fx, fy, fz] = handle.from, [tx, ty, tz] = handle.to;
        const dx = tx - fx, dy = ty - fy, dz = tz - fz;
        const length = Math.hypot(dx, dy, dz);
        if (length < 0.01) {
            b.mesh.visible = false;
            return;
        }
        const d: Vec3 = [dx / length, dy / length, dz / length];
        const pos = b.geom.getAttribute('position') as THREE.BufferAttribute;
        const uv = b.geom.getAttribute('uv') as THREE.BufferAttribute;
        const col = b.geom.getAttribute('color') as THREE.BufferAttribute;
        const [r, g, bl] = o.color ?? [1, 1, 1];
        const w1 = o.endWidth ?? o.width, a0 = o.alpha ?? 1, a1 = o.endAlpha ?? a0;
        const scroll = (o.scroll ?? 0) * this.time;
        const repeats = o.tile ? length / o.tile : 1;
        if (o.noise && this.time >= b.nextJitter) {
            b.nextJitter = this.time + 0.06;
            for (let i = 0; i < b.jitter.length; i++) b.jitter[i] = Math.random() * 2 - 1;
        }
        const n = SEGMENTS + 1;
        for (let i = 0; i < n; i++) {
            const t = i / SEGMENTS;
            let px = fx + dx * t, py = fy + dy * t, pz = fz + dz * t;
            if (o.noise && i > 0 && i < SEGMENTS) {
                // Wander sideways, most in the middle.
                const amp = o.noise * Math.sin(Math.PI * t);
                px += b.jitter[i * 2] * amp;
                py += b.jitter[i * 2 + 1] * amp;
                pz += b.jitter[i * 2 + 2] * amp * 0.5;
            }
            const vx = eye.x - px, vy = eye.y - py, vz = eye.z - pz;
            let sx = d[1] * vz - d[2] * vy, sy = d[2] * vx - d[0] * vz, sz = d[0] * vy - d[1] * vx;
            const half = (o.width + (w1 - o.width) * t) / 2 / (Math.hypot(sx, sy, sz) || 1);
            sx *= half;
            sy *= half;
            sz *= half;
            pos.setXYZ(i * 2, px + sx, py + sy, pz + sz);
            pos.setXYZ(i * 2 + 1, px - sx, py - sy, pz - sz);
            const u = t * repeats + scroll;
            uv.setXY(i * 2, u, 0);
            uv.setXY(i * 2 + 1, u, 1);
            const a = a0 + (a1 - a0) * t;
            col.setXYZW(i * 2, r, g, bl, a);
            col.setXYZW(i * 2 + 1, r, g, bl, a);
        }
        pos.needsUpdate = uv.needsUpdate = col.needsUpdate = true;
    }
}
