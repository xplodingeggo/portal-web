// Camera controls in Source coordinates (Z up, units are inches). Two modes:
//   walk:   the player physics body. WASD, Space jump, Ctrl crouch.
//   noclip: free flight. WASD, Space/Ctrl up/down, Shift fast, Alt slow.
// V toggles between them. Click captures the mouse.
import type * as THREE from 'three';
import type { Vec3 } from '../physics/collision';
import type { Player } from '../physics/player';
import { binds } from '../ui/keybinds';

export type ControlMode = 'walk' | 'noclip';

export class CameraController {
    mode: ControlMode;
    position: Vec3 = [0, 0, 0]; // camera position in noclip mode
    yaw = 0; // degrees, 0 = +X, counter-clockwise
    pitch = 0; // degrees, positive looks down (Source convention)
    /** A scripted view (point_viewcontrol): the player is frozen and looks through it. */
    override: { origin: Vec3; forward: Vec3; up: Vec3 } | null = null;
    noclipSpeed = 400;
    sensitivity = 0.1;
    /** Set while a menu is open: input is ignored. */
    frozen = false;
    private keys = new Set<string>();

    constructor(private camera: THREE.PerspectiveCamera, element: HTMLElement, private player: Player | null) {
        this.mode = player ? 'walk' : 'noclip';
        camera.up.set(0, 0, 1);
        element.addEventListener('click', () => element.requestPointerLock());
        document.addEventListener('mousemove', (e) => {
            if (document.pointerLockElement !== element || this.override || this.frozen) return;
            this.yaw -= e.movementX * this.sensitivity;
            this.pitch = Math.max(-89, Math.min(89, this.pitch + e.movementY * this.sensitivity));
        });
        window.addEventListener('keydown', (e) => {
            this.keys.add(e.code);
            if (e.code === 'AltLeft' || binds.matches('jump', e.code) || binds.matches('duck', e.code)) e.preventDefault();
            if (binds.matches('noclip', e.code) && !e.repeat && !this.frozen) this.toggleNoclip();
        });
        window.addEventListener('keyup', (e) => this.keys.delete(e.code));
        window.addEventListener('blur', () => this.keys.clear());
    }

    /** Current eye position, whichever mode is active. */
    eye(): Vec3 {
        if (this.override) return this.override.origin;
        return this.mode === 'walk' && this.player ? this.player.eye() : this.position;
    }

    toggleNoclip() {
        if (!this.player) return;
        if (this.mode === 'walk') {
            this.position = this.player.eye();
            this.mode = 'noclip';
        } else {
            const e = this.position;
            this.player.teleport([e[0], e[1], e[2] - this.player.eyeHeight]);
            this.mode = 'walk';
        }
    }

    update(dt: number) {
        if (this.override) {
            const { origin: o, forward: f, up: u } = this.override;
            this.camera.up.set(u[0], u[1], u[2]);
            this.camera.position.set(o[0], o[1], o[2]);
            this.camera.lookAt(o[0] + f[0], o[1] + f[1], o[2] + f[2]);
            return;
        }
        this.camera.up.set(0, 0, 1);
        const has = (...codes: string[]) => codes.some((c) => this.keys.has(c));
        const held = (action: string) => binds.codes(action).some((c) => this.keys.has(c));
        const forward = this.frozen ? 0 : (held('forward') ? 1 : 0) - (held('back') ? 1 : 0);
        const side = this.frozen ? 0 : (held('right') ? 1 : 0) - (held('left') ? 1 : 0);

        if (this.mode === 'walk' && this.player) {
            this.player.update(dt, {
                forward,
                side,
                jump: !this.frozen && held('jump'),
                duck: held('duck') || has('ControlRight'),
                yaw: this.yaw,
                pitch: this.pitch,
            });
        } else {
            this.flyNoclip(dt, forward, side, has);
        }

        this.syncCamera();
    }

    /** Points the camera at the current eye and view angles (again after a portal moves the player mid-frame). */
    syncCamera() {
        this.camera.up.set(0, 0, 1);
        const y = (this.yaw * Math.PI) / 180;
        const p = (this.pitch * Math.PI) / 180;
        const [ex, ey, ez] = this.eye();
        this.camera.position.set(ex, ey, ez);
        this.camera.lookAt(ex + Math.cos(p) * Math.cos(y), ey + Math.cos(p) * Math.sin(y), ez - Math.sin(p));
    }

    private flyNoclip(dt: number, forward: number, side: number, has: (...codes: string[]) => boolean) {
        const y = (this.yaw * Math.PI) / 180;
        const p = (this.pitch * Math.PI) / 180;
        const fwd = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
        const right = [Math.sin(y), -Math.cos(y), 0];
        let speed = this.noclipSpeed;
        if (has('ShiftLeft', 'ShiftRight')) speed *= 3;
        if (has('AltLeft')) speed /= 4;
        const move = [0, 1, 2].map((i) => fwd[i] * forward + right[i] * side);
        if (has(...binds.codes('jump'))) move[2] += 1;
        if (has(...binds.codes('duck'))) move[2] -= 1;
        const len = Math.hypot(move[0], move[1], move[2]);
        if (len > 0) for (let i = 0; i < 3; i++) this.position[i] += (move[i] / len) * speed * dt;
    }
}
