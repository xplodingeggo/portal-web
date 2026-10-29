// The portal gun's shot (CWeaponPortalgun::DoEffectBlast): a glowing ball in the portal's
// colour flying from the gun to where the portal will open. The portal itself
// opens, or fizzles, when it arrives (see game/portalgun.ts).
import * as THREE from 'three';
import type { Vec3 } from '../physics/collision';

const TRAIL_POINTS = 12;

/** UTIL_Portal_Color: 1 blue, 2 orange. */
export const PORTAL_COLORS = [new THREE.Color(64 / 255, 160 / 255, 1), new THREE.Color(1, 160 / 255, 32 / 255)];

function glowTexture(): THREE.Texture {
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
        const a = Math.max(0, 1 - d) ** 2;
        const i = (y * size + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255;
        data[i + 3] = Math.round(a * 255);
    }
    const tex = new THREE.DataTexture(data, size, size);
    tex.needsUpdate = true;
    return tex;
}

interface Shot {
    start: THREE.Vector3;
    end: THREE.Vector3;
    duration: number;
    age: number;
    core: THREE.Sprite;
    halo: THREE.Sprite;
    trail: THREE.Line;
    history: THREE.Vector3[];
}

export class BlastEffects {
    private shots: Shot[] = [];
    private texture = glowTexture();

    constructor(private scene: THREE.Scene) {}

    /** Shows a blast flying from `from` to `to` over `duration` seconds. */
    fire(color: 0 | 1, from: Vec3, to: Vec3, duration: number) {
        const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to);
        const tint = PORTAL_COLORS[color];
        const sprite = (scale: number, opacity: number, c: THREE.Color) => {
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, color: c, blending: THREE.AdditiveBlending, transparent: true, opacity, depthWrite: false }));
            s.scale.setScalar(scale);
            s.position.copy(start);
            s.renderOrder = 2;
            this.scene.add(s);
            return s;
        };
        const core = sprite(10, 1, tint.clone().lerp(new THREE.Color(1, 1, 1), 0.6));
        const halo = sprite(28, 0.8, tint);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3));
        const colors = new Float32Array(TRAIL_POINTS * 3);
        for (let i = 0; i < TRAIL_POINTS; i++) {
            const k = 1 - i / (TRAIL_POINTS - 1);
            colors.set([tint.r * k, tint.g * k, tint.b * k], i * 3);
        }
        geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        const trail = new THREE.Line(geom, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
        trail.frustumCulled = false;
        trail.renderOrder = 2;
        this.scene.add(trail);
        this.shots.push({ start, end, duration, age: 0, core, halo, trail, history: [start.clone()] });
    }

    update(dt: number) {
        for (const s of [...this.shots]) {
            s.age += dt;
            const t = s.duration > 0 ? Math.min(1, s.age / s.duration) : 1;
            const p = s.start.clone().lerp(s.end, t);
            s.core.position.copy(p);
            s.halo.position.copy(p);
            s.history.unshift(p.clone());
            s.history.length = Math.min(s.history.length, TRAIL_POINTS);
            const pos = s.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
            for (let i = 0; i < TRAIL_POINTS; i++) {
                const h = s.history[Math.min(i, s.history.length - 1)];
                pos.setXYZ(i, h.x, h.y, h.z);
            }
            pos.needsUpdate = true;
            if (t >= 1) {
                for (const o of [s.core, s.halo, s.trail]) {
                    this.scene.remove(o);
                    (o.material as THREE.Material).dispose();
                }
                s.trail.geometry.dispose();
                this.shots.splice(this.shots.indexOf(s), 1);
            }
        }
    }
}
