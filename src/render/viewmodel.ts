// The first-person weapon (v_portalgun.mdl): drawn at the eye with Source's viewmodel FOV in a
// pass of its own over the world, animated by activity (ACT_VM_*), with HL2's walk bob
// (CBaseHLCombatWeapon::AddViewmodelBob) and lag behind turning (CBaseViewModel::CalcViewModelLag).
import * as THREE from 'three';
import type { Vec3 } from '../physics/collision';
import { sequenceTiming } from '../model/pose';
import type { PropHandle, PropRenderer } from './props';

/** viewmodel_fov: horizontal degrees at 4:3, like the world's 75. */
const VIEWMODEL_FOV = 54;
const HL2_BOB_CYCLE_MAX = 0.45;
const HL2_BOB_UP = 0.5;
const MAX_VIEWMODEL_LAG = 1.5;
const DEG = Math.PI / 180;

function angleVectors(a: Vec3) {
    const sp = Math.sin(a[0] * DEG), cp = Math.cos(a[0] * DEG);
    const sy = Math.sin(a[1] * DEG), cy = Math.cos(a[1] * DEG);
    const sr = Math.sin(a[2] * DEG), cr = Math.cos(a[2] * DEG);
    return {
        forward: new THREE.Vector3(cp * cy, cp * sy, -sp),
        right: new THREE.Vector3(-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp),
        up: new THREE.Vector3(cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp),
    };
}

export class ViewModel {
    readonly scene = new THREE.Scene();
    readonly camera: THREE.PerspectiveCamera;
    private handle: PropHandle | null = null;
    private sequence = 0;
    private posedSequence = -1;
    private posedFrame = 0;
    private animStart = 0;
    private time = 0;
    visible = false;
    private holstering = false;
    // Bob and lag state.
    private bobTime = 0;
    private lastFacing: THREE.Vector3 | null = null;

    constructor(private props: PropRenderer, readonly model: string) {
        // Horizontal FOV at 4:3 to the vertical FOV three.js wants.
        const vfov = (2 * Math.atan(Math.tan((VIEWMODEL_FOV * DEG) / 2) * 0.75)) / DEG;
        this.camera = new THREE.PerspectiveCamera(vfov, 1, 1, 1000);
        this.camera.matrixAutoUpdate = false;
    }

    async load() {
        const h = await this.props.build({ model: this.model, origin: [0, 0, 0], angles: [0, 0, 0], skin: 0, body: 0, solid: false });
        if (!h) return;
        h.group.matrixAutoUpdate = true;
        // Posing moves vertices well outside the bind-pose bounds.
        h.group.traverse((o) => (o.frustumCulled = false));
        this.scene.add(h.group);
        this.handle = h;
        this.play('ACT_VM_IDLE');
    }

    /** The first sequence with an activity, or -1. */
    private sequenceFor(activity: string): number {
        return this.handle ? this.handle.model.mdl.sequences.findIndex((s) => s.activity.toUpperCase() === activity) : -1;
    }

    /** SendWeaponAnim: plays an activity's sequence from the start. */
    play(activity: string) {
        const seq = this.sequenceFor(activity);
        if (seq < 0) return;
        this.sequence = seq;
        this.animStart = this.time;
    }

    /** Takes the weapon out (ACT_VM_DRAW) or puts it away (ACT_VM_HOLSTER, then hidden). */
    setEquipped(on: boolean) {
        if (on) {
            this.visible = true;
            this.holstering = false;
            this.play('ACT_VM_DRAW');
        } else if (this.visible) {
            this.holstering = true;
            this.play('ACT_VM_HOLSTER');
        }
    }

    /**
     * Places the weapon for this frame's view and advances its animation.
     * @param eye the eye position, @param angles view [pitch, yaw, roll], @param speed horizontal speed
     */
    update(dt: number, eye: Vec3, angles: Vec3, speed: number) {
        this.time += dt;
        const h = this.handle;
        if (!h) return;
        const mdl = h.model.mdl;

        // Animation: a finished one-shot falls back to idle (or hides after holstering).
        const t = sequenceTiming(mdl, this.sequence);
        let frame = (this.time - this.animStart) * t.fps;
        if (frame >= t.frames - 1) {
            if (t.looping) frame %= Math.max(1, t.frames - 1);
            else if (this.holstering) {
                this.visible = false;
                this.holstering = false;
                frame = t.frames - 1;
            } else {
                this.play('ACT_VM_IDLE');
                frame = 0;
            }
        }
        // Skinning the whole gun is the dear part: re-pose at half-frame steps, not every refresh.
        if (this.posedSequence !== this.sequence || Math.abs(frame - this.posedFrame) >= 0.5) {
            this.props.setPose(h, this.sequence, frame, false);
            this.posedSequence = this.sequence;
            this.posedFrame = frame;
        }

        const origin = new THREE.Vector3(...eye);
        const ang: Vec3 = [...angles];
        this.addLag(dt, origin, ang, angles);
        this.addBob(dt, origin, ang, speed);

        h.group.visible = this.visible;
        h.group.position.copy(origin);
        h.group.rotation.set(ang[2] * DEG, ang[0] * DEG, ang[1] * DEG, 'ZYX');
        h.group.updateMatrixWorld(true);
        this.props.relight(h);
    }

    /** CBaseViewModel::CalcViewModelLag: the gun trails behind quick turns and dips with pitch. */
    private addLag(dt: number, origin: THREE.Vector3, angles: Vec3, original: Vec3) {
        const forward = angleVectors(angles).forward;
        if (!this.lastFacing) this.lastFacing = forward.clone();
        if (dt > 0) {
            const diff = forward.clone().sub(this.lastFacing);
            let speed = 5;
            const len = diff.length();
            if (len > MAX_VIEWMODEL_LAG) speed *= len / MAX_VIEWMODEL_LAG;
            this.lastFacing.addScaledVector(diff, speed * dt).normalize();
            origin.addScaledVector(diff, -5);
        }
        const { forward: f, right, up } = angleVectors(original);
        let pitch = original[0];
        if (pitch > 180) pitch -= 360;
        else if (pitch < -180) pitch += 360;
        origin.addScaledVector(f, -pitch * 0.035).addScaledVector(right, -pitch * 0.03).addScaledVector(up, -pitch * 0.02);
    }

    /** CBaseHLCombatWeapon::CalcViewmodelBob and AddViewmodelBob. */
    private addBob(dt: number, origin: THREE.Vector3, angles: Vec3, speed: number) {
        speed = Math.max(-320, Math.min(320, speed));
        this.bobTime += dt * (speed / 320);
        const cycleAt = (period: number) => {
            let c = (this.bobTime - Math.floor(this.bobTime / period) * period) / period;
            c = c < HL2_BOB_UP ? (Math.PI * c) / HL2_BOB_UP : Math.PI + (Math.PI * (c - HL2_BOB_UP)) / (1 - HL2_BOB_UP);
            const b = speed * 0.005;
            return Math.max(-7, Math.min(4, b * 0.3 + b * 0.7 * Math.sin(c)));
        };
        const vertical = cycleAt(HL2_BOB_CYCLE_MAX);
        const lateral = cycleAt(HL2_BOB_CYCLE_MAX * 2);
        const { forward, right } = angleVectors(angles);
        origin.addScaledVector(forward, vertical * 0.1);
        origin.z += vertical * 0.1;
        angles[2] += vertical * 0.5;
        angles[0] -= vertical * 0.4;
        angles[1] -= lateral * 0.3;
        origin.addScaledVector(right, lateral * 0.8);
    }

    /** Draws the weapon over the frame just rendered with `camera`. */
    render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera) {
        if (!this.visible || !this.handle) return;
        this.camera.aspect = camera.aspect;
        this.camera.updateProjectionMatrix();
        this.camera.matrixWorld.copy(camera.matrixWorld);
        this.camera.matrixWorldInverse.copy(camera.matrixWorldInverse);
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(this.scene, this.camera);
        renderer.autoClear = autoClear;
    }

    /** Where shots and the blast leave from: the muzzle attachment isn't parsed, so near it. */
    muzzle(eye: Vec3, angles: Vec3): Vec3 {
        const { forward, right, up } = angleVectors(angles);
        // CWeaponPortalgun::FirePortal's tracer origin: eye + forward 30 + right 4 + up -5.
        const p = new THREE.Vector3(...eye).addScaledVector(forward, 30).addScaledVector(right, 4).addScaledVector(up, -5);
        return [p.x, p.y, p.z];
    }
}
