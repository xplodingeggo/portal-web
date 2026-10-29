// env_shake's screen shake: a few seconds of decaying wobble on the camera (pitch, yaw, roll and a
// little up and down), stronger the closer the shake is. Applied to the camera just before drawing
// and taken off again after, so it never feeds back into the player's own view angles.
import * as THREE from 'three';

type Vec3 = [number, number, number];

interface Shake {
    amplitude: number;
    frequency: number;
    duration: number;
    radius: number;
    origin: Vec3;
    global: boolean;
    name: string;
    age: number;
}

const DEG = Math.PI / 180;

export class ScreenShake {
    private shakes: Shake[] = [];
    private saved: { pos: THREE.Vector3; quat: THREE.Quaternion } | null = null;

    start(s: Omit<Shake, 'age'>) {
        this.stop(s.name);
        this.shakes.push({ ...s, age: 0 });
    }

    stop(name: string) {
        this.shakes = this.shakes.filter((s) => s.name !== name);
    }

    update(dt: number) {
        for (const s of this.shakes) s.age += dt;
        this.shakes = this.shakes.filter((s) => s.age < s.duration);
    }

    apply(camera: THREE.Camera, eye: Vec3) {
        if (!this.shakes.length) return;
        let pitch = 0, yaw = 0, roll = 0, lift = 0;
        for (const s of this.shakes) {
            const d = Math.hypot(eye[0] - s.origin[0], eye[1] - s.origin[1], eye[2] - s.origin[2]);
            const near = s.global ? 1 : Math.max(0, 1 - d / Math.max(s.radius, 1));
            const amp = s.amplitude * near * (1 - s.age / s.duration);
            const w = 2 * Math.PI * s.frequency * s.age;
            pitch += amp * 0.35 * Math.sin(w);
            yaw += amp * 0.2 * Math.sin(w * 1.3 + 1);
            roll += amp * 0.35 * Math.sin(w * 0.7 + 2);
            lift += amp * 0.4 * Math.sin(w * 1.7 + 3);
        }
        this.saved = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
        camera.rotateX(pitch * DEG);
        camera.rotateY(yaw * DEG);
        camera.rotateZ(roll * DEG);
        camera.position.z += lift;
    }

    restore(camera: THREE.Camera) {
        if (!this.saved) return;
        camera.position.copy(this.saved.pos);
        camera.quaternion.copy(this.saved.quat);
        this.saved = null;
    }
}
