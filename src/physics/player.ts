// First-person player movement in the style of Source/Quake: ground friction and
// acceleration, air control, gravity, jumping, crouching and stair stepping, all
// resolved with box traces. Runs at a fixed tick like the game does.
import { CollisionWorld, type CollisionModel, type Trace, type Vec3 } from './collision';
import { PORTAL_HALF_HEIGHT, PORTAL_HALF_WIDTH } from '../render/portals';

/**
 * Tuning, in inches and seconds. Taken from the Portal SDK: movevars_shared.cpp (gravity, friction,
 * stopspeed, accelerate), gamemovement.h (jump height, overridden below) and portal_gamemovement.cpp (air control,
 * fling lock, funnel). Walk speed isn't in the SDK (it's the retail cl_forwardspeed), so 175 is kept.
 */
export const PlayerTuning = {
    tickRate: 66,
    gravity: 600,
    friction: 4,
    stopSpeed: 100,
    accelerate: 10,
    /** CPortalGameMovement::AirMove passes 15 instead of sv_airaccelerate. */
    airAccelerate: 15,
    /** CPortalGameMovement::AirAccelerate caps the wish speed at 60 (HL2 uses 30). */
    airSpeedCap: 60,
    /** Horizontal speed above which air control can't reverse a fling (MIN_FLING_SPEED). */
    flingSpeed: 300,
    /** How hard falling players are pulled toward a floor portal (PORTAL_FUNNEL_AMOUNT). */
    funnelAmount: 6,
    maxSpeed: 175,
    duckSpeedScale: 1 / 3,
    /** SDK's 21 can't reach the 40-unit metal_box top; 45 leaves a window to land on it. */
    jumpHeight: 45,
    stepSize: 18,
    standHeight: 72,
    duckHeight: 36,
    standEye: 64,
    duckEye: 28,
    halfWidth: 16,
    /** Steepest floor you can stand on (normal z). */
    minFloorNormal: 0.7,
};

/** gamemovement.cpp's CreateStuckTable: tiny nudges first, then moves of 1 to 6 units. */
const STUCK_OFFSETS: Vec3[] = (() => {
    const t: Vec3[] = [];
    for (const z of [-0.125, 0, 0.125]) t.push([0, 0, z]);
    for (const y of [-0.125, 0, 0.125]) t.push([0, y, 0]);
    for (const x of [-0.125, 0, 0.125]) t.push([x, 0, 0]);
    for (const x of [-0.125, 0.125]) for (const y of [-0.125, 0.125]) for (const z of [-0.125, 0.125]) t.push([x, y, z]);
    for (const z of [0, 1, 6]) t.push([0, 0, z]);
    for (const y of [-2, 0, 2]) t.push([0, y, 0]);
    for (const x of [-2, 0, 2]) t.push([x, 0, 0]);
    for (const x of [-2, 2]) for (const y of [-2, 2]) for (const z of [0, 1, 6]) t.push([x, y, z]);
    return t;
})();

export interface PlayerInput {
    forward: number; // -1..1
    side: number; // -1..1, positive = right
    jump: boolean;
    duck: boolean;
    yaw: number; // degrees
    /** Degrees, positive looks down. Only used to decide whether to funnel into floor portals. */
    pitch?: number;
}

/** An open, linked portal as the air-control funnel sees it. */
export interface FunnelPortal {
    origin: Vec3;
    /** Direction out of the portal surface. */
    forward: Vec3;
    /** Direction across the portal's width (sign doesn't matter). */
    right: Vec3;
    up: Vec3;
}

export class Player {
    origin: Vec3; // feet, center of the box bottom
    velocity: Vec3 = [0, 0, 0];
    /** Extra velocity from a trigger_push, added while moving and not kept (Source's base velocity). */
    baseVelocity: Vec3 = [0, 0, 0];
    /** trigger_gravity: multiplies gravity while set. */
    gravityScale = 1;
    onGround = false;
    /** What the player is standing on, so moving platforms can carry them. */
    groundModel: CollisionModel | null = null;
    ducked = false;
    /** Smoothed eye height for the camera. */
    eyeHeight = PlayerTuning.standEye;
    /** Open portals, for floor-portal funnelling. Set by the game. */
    funnelPortals: () => FunnelPortal[] = () => [];
    /** Called when a move runs into a physics prop's hulls, with the velocity going into it. */
    onTouch: (model: CollisionModel, normal: Vec3, velocity: Vec3) => void = () => {};
    private jumpHeld = false;
    private accumulator = 0;

    constructor(private world: CollisionWorld, origin: Vec3) {
        this.origin = [...origin];
        this.unstick();
    }

    get mins(): Vec3 {
        const w = PlayerTuning.halfWidth;
        return [-w, -w, 0];
    }

    get maxs(): Vec3 {
        const w = PlayerTuning.halfWidth;
        return [w, w, this.ducked ? PlayerTuning.duckHeight : PlayerTuning.standHeight];
    }

    eye(): Vec3 {
        return [this.origin[0], this.origin[1], this.origin[2] + this.eyeHeight];
    }

    teleport(origin: Vec3) {
        this.origin = [...origin];
        this.velocity = [0, 0, 0];
        this.unstick();
    }

    update(dt: number, input: PlayerInput) {
        const tick = 1 / PlayerTuning.tickRate;
        this.accumulator = Math.min(this.accumulator + dt, 0.25);
        let ran = false;
        while (this.accumulator >= tick) {
            this.accumulator -= tick;
            this.tick(tick, input);
            ran = true;
        }
        if (ran) this.baseVelocity = [0, 0, 0];
        const target = this.ducked ? PlayerTuning.duckEye : PlayerTuning.standEye;
        this.eyeHeight += (target - this.eyeHeight) * Math.min(1, dt * 12);
    }

    private trace(start: Vec3, end: Vec3): Trace {
        return this.world.trace(start, end, this.mins, this.maxs);
    }

    private tick(dt: number, input: PlayerInput) {
        const b = this.baseVelocity;
        if (!b[0] && !b[1] && !b[2]) return this.moveTick(dt, input);
        for (let i = 0; i < 3; i++) this.velocity[i] += b[i];
        this.moveTick(dt, input);
        for (let i = 0; i < 3; i++) this.velocity[i] -= b[i];
    }

    private moveTick(dt: number, input: PlayerInput) {
        const T = PlayerTuning;
        this.checkStuck();
        this.updateDuck(input.duck);
        this.categorize();

        // Wish direction from yaw only; looking up or down doesn't change walking.
        const yaw = (input.yaw * Math.PI) / 180;
        const fwd = [Math.cos(yaw), Math.sin(yaw)];
        const right = [Math.sin(yaw), -Math.cos(yaw)];
        let wx = fwd[0] * input.forward + right[0] * input.side;
        let wy = fwd[1] * input.forward + right[1] * input.side;
        const len = Math.hypot(wx, wy);
        let wishSpeed = 0;
        if (len > 0) {
            wx /= len;
            wy /= len;
            wishSpeed = T.maxSpeed * Math.min(1, len) * (this.ducked ? T.duckSpeedScale : 1);
        }

        if (input.jump && !this.jumpHeld && this.onGround) {
            this.velocity[2] = Math.sqrt(2 * T.gravity * T.jumpHeight);
            this.onGround = false;
        }
        this.jumpHeld = input.jump;

        if (this.onGround) {
            this.velocity[2] = 0;
            this.applyFriction(dt);
            this.accelerate(wx, wy, wishSpeed, T.accelerate, dt);
            this.walkMove(dt);
        } else {
            this.airMove(input, dt);
            this.velocity[2] -= T.gravity * this.gravityScale * dt * 0.5;
            this.flyMove(dt);
            this.velocity[2] -= T.gravity * this.gravityScale * dt * 0.5;
        }
        this.categorize();
        if (this.onGround) this.velocity[2] = 0;
    }

    private updateDuck(wantDuck: boolean) {
        const diff = PlayerTuning.standHeight - PlayerTuning.duckHeight;
        if (wantDuck && !this.ducked) {
            this.ducked = true;
            // In the air, ducking pulls the legs up instead of lowering the head.
            if (!this.onGround) this.origin[2] += diff;
        } else if (!wantDuck && this.ducked) {
            const standOrigin: Vec3 = [...this.origin];
            if (!this.onGround) standOrigin[2] -= diff;
            this.ducked = false;
            const tr = this.trace(standOrigin, standOrigin);
            if (tr.startSolid) this.ducked = true; // no room to stand
            else this.origin = standOrigin;
        }
    }

    private categorize() {
        // Moving up fast (jumping or launched) means not on the ground.
        if (this.velocity[2] > 140) {
            this.onGround = false;
            this.groundModel = null;
            return;
        }
        const down: Vec3 = [this.origin[0], this.origin[1], this.origin[2] - 2];
        const tr = this.trace(this.origin, down);
        this.onGround = tr.fraction < 1 && tr.normal[2] >= PlayerTuning.minFloorNormal && !tr.allSolid;
        this.groundModel = this.onGround ? tr.model ?? null : null;
        if (this.onGround && !tr.startSolid) this.origin = tr.end;
    }

    private applyFriction(dt: number) {
        const v = this.velocity;
        const speed = Math.hypot(v[0], v[1], v[2]);
        if (speed < 0.1) return;
        const control = Math.max(speed, PlayerTuning.stopSpeed);
        const scale = Math.max(0, speed - control * PlayerTuning.friction * dt) / speed;
        for (let i = 0; i < 3; i++) v[i] *= scale;
    }

    private accelerate(wx: number, wy: number, wishSpeed: number, accel: number, dt: number) {
        const current = this.velocity[0] * wx + this.velocity[1] * wy;
        const add = wishSpeed - current;
        if (add <= 0) return;
        const speed = Math.min(accel * dt * wishSpeed, add);
        this.velocity[0] += speed * wx;
        this.velocity[1] += speed * wy;
    }

    /** CPortalGameMovement::AirMove: air control with the fling lock and floor-portal funnel. */
    private airMove(input: PlayerInput, dt: number) {
        const T = PlayerTuning;
        const yaw = (input.yaw * Math.PI) / 180;
        const fwd = [Math.cos(yaw), Math.sin(yaw)];
        const right = [Math.sin(yaw), -Math.cos(yaw)];
        const scale = T.maxSpeed * (this.ducked ? T.duckSpeedScale : 1);
        // Wish velocity in units/second, like the engine's forwardmove/sidemove.
        const wish: [number, number] = [
            (fwd[0] * input.forward + right[0] * input.side) * scale,
            (fwd[1] * input.forward + right[1] * input.side) * scale,
        ];

        const v = this.velocity;
        if (v[0] * v[0] + v[1] * v[1] > T.flingSpeed * T.flingSpeed) {
            // Don't let the player cancel a fling by steering against it.
            for (let i = 0; i < 2; i++) {
                if (v[i] > T.flingSpeed * 0.5 && wish[i] < 0) wish[i] = 0;
                else if (v[i] < -T.flingSpeed * 0.5 && wish[i] > 0) wish[i] = 0;
            }
        } else {
            for (const p of this.funnelPortals()) this.funnelIntoPortal(p, wish, input.pitch ?? 0);
        }

        let speed = Math.hypot(wish[0], wish[1]);
        if (speed === 0) return;
        const wx = wish[0] / speed, wy = wish[1] / speed;
        speed = Math.min(speed, T.maxSpeed);
        this.airAccelerate(wx, wy, speed, dt);
    }

    /** CPortalGameMovement::FunnelIntoPortal: steer a falling player toward the middle of a floor portal. */
    private funnelIntoPortal(p: FunnelPortal, wish: [number, number], pitch: number) {
        if (p.forward[2] < 0.8) return; // floor portals only
        // The player must be looking down.
        if (-Math.sin((pitch * Math.PI) / 180) > -0.1) return;

        const flat = (a: Vec3): [number, number] => {
            const l = Math.hypot(a[0], a[1]) || 1;
            return [a[0] / l, a[1] / l];
        };
        const pr = flat(p.right), pu = flat(p.up);
        const to: Vec3 = [p.origin[0] - this.origin[0], p.origin[1] - this.origin[1], p.origin[2] - this.origin[2]];

        // Only while air controlling, falling fast, and not too far above the portal.
        if (Math.abs(wish[0]) > 64 || Math.abs(wish[1]) > 64 || this.velocity[2] > -165 || to[2] < -512) return;
        // Inside the portal's rectangle, with 50% slack.
        if (Math.abs(to[0] * pr[0] + to[1] * pr[1]) > PORTAL_HALF_WIDTH * 1.5) return;
        if (Math.abs(to[0] * pu[0] + to[1] * pu[1]) > PORTAL_HALF_HEIGHT * 1.5) return;

        if (to[2] > -8) {
            // Too close to keep correcting: zero it so the fling comes out clean.
            this.velocity[0] = 0;
            this.velocity[1] = 0;
        } else {
            wish[0] += to[0] * PlayerTuning.funnelAmount - this.velocity[0];
            wish[1] += to[1] * PlayerTuning.funnelAmount - this.velocity[1];
        }
    }

    private airAccelerate(wx: number, wy: number, wishSpeed: number, dt: number) {
        const capped = Math.min(wishSpeed, PlayerTuning.airSpeedCap);
        const current = this.velocity[0] * wx + this.velocity[1] * wy;
        const add = capped - current;
        if (add <= 0) return;
        const speed = Math.min(PlayerTuning.airAccelerate * wishSpeed * dt, add);
        this.velocity[0] += speed * wx;
        this.velocity[1] += speed * wy;
    }

    /** Moves along the velocity, sliding along up to four surfaces. */
    private flyMove(dt: number) {
        const v = this.velocity;
        const primal: Vec3 = [...v];
        const planes: Vec3[] = [];
        let timeLeft = dt;
        for (let bump = 0; bump < 4; bump++) {
            if (v[0] === 0 && v[1] === 0 && v[2] === 0) break;
            const end: Vec3 = [this.origin[0] + v[0] * timeLeft, this.origin[1] + v[1] * timeLeft, this.origin[2] + v[2] * timeLeft];
            const tr = this.trace(this.origin, end);
            if (tr.allSolid) {
                v.fill(0);
                return;
            }
            if (tr.fraction > 0) {
                this.origin = tr.end;
                planes.length = 0;
            }
            if (tr.fraction === 1) break;
            if (tr.model?.rigid) this.onTouch(tr.model, tr.normal, [...v]);
            timeLeft -= timeLeft * tr.fraction;
            planes.push(tr.normal);
            if (planes.length >= 5) {
                v.fill(0);
                break;
            }

            const original: Vec3 = [...v];
            let i = 0;
            for (; i < planes.length; i++) {
                const clipped = clip(original, planes[i]);
                let ok = true;
                for (let j = 0; j < planes.length; j++) {
                    if (j !== i && dot(clipped, planes[j]) < 0) {
                        ok = false;
                        break;
                    }
                }
                if (ok) {
                    v[0] = clipped[0];
                    v[1] = clipped[1];
                    v[2] = clipped[2];
                    break;
                }
            }
            if (i === planes.length) {
                if (planes.length !== 2) {
                    v.fill(0);
                    break;
                }
                // Slide along the crease between two planes.
                const dir = cross(planes[0], planes[1]);
                const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
                const s = dot(dir, v) / (l * l);
                for (let k = 0; k < 3; k++) v[k] = dir[k] * s;
            }
            if (dot(v, primal) <= 0) {
                v.fill(0);
                break;
            }
        }
    }

    /** Ground movement: tries a plain slide and a step up/over, and keeps whichever got further. */
    private walkMove(dt: number) {
        const step = PlayerTuning.stepSize;
        const start: Vec3 = [...this.origin];
        const startVel: Vec3 = [...this.velocity];

        this.flyMove(dt);
        const downPos: Vec3 = [...this.origin];
        const downVel: Vec3 = [...this.velocity];

        this.origin = [...start];
        this.velocity = [...startVel];
        let tr = this.trace(this.origin, [this.origin[0], this.origin[1], this.origin[2] + step]);
        if (!tr.startSolid && !tr.allSolid) this.origin = tr.end;
        this.flyMove(dt);
        tr = this.trace(this.origin, [this.origin[0], this.origin[1], this.origin[2] - step]);
        if (!tr.startSolid && !tr.allSolid) this.origin = tr.end;

        const stepped = tr.fraction < 1 && tr.normal[2] >= PlayerTuning.minFloorNormal;
        const downDist = (downPos[0] - start[0]) ** 2 + (downPos[1] - start[1]) ** 2;
        const upDist = (this.origin[0] - start[0]) ** 2 + (this.origin[1] - start[1]) ** 2;
        if (!stepped || downDist >= upDist) {
            this.origin = downPos;
            this.velocity = downVel;
        } else {
            this.velocity[2] = downVel[2];
        }
        this.stayOnGround();
    }

    /** Keeps the player glued to the floor walking down stairs and slopes. */
    private stayOnGround() {
        const up: Vec3 = [this.origin[0], this.origin[1], this.origin[2] + 2];
        const down: Vec3 = [this.origin[0], this.origin[1], this.origin[2] - PlayerTuning.stepSize];
        const tr = this.trace(up, down);
        if (tr.fraction > 0 && tr.fraction < 1 && !tr.startSolid && tr.normal[2] >= PlayerTuning.minFloorNormal) {
            this.origin = tr.end;
        }
    }

    /**
     * CGameMovement::CheckStuck: if the player is inside something (a prop whose collision loaded
     * around them, a level change landing them a hair into the floor), nudge them out using
     * Source's stuck offsets, then a wider search for deeper overlaps.
     */
    private checkStuck() {
        const o = this.origin;
        if (!this.trace(o, o).startSolid) return;
        for (const d of STUCK_OFFSETS) {
            const p: Vec3 = [o[0] + d[0], o[1] + d[1], o[2] + d[2]];
            if (!this.trace(p, p).startSolid) {
                this.origin = p;
                return;
            }
        }
        this.findPassableSpace([0, 0, 1]);
    }

    /**
     * After a portal teleport, moves the player out of any solid they landed in, nearest spot
     * first, trying the exit portal's facing `push` and up (like FindClosestPassableSpace).
     */
    findPassableSpace(push: Vec3) {
        const o = this.origin;
        if (!this.trace(o, o).startSolid) return;
        const diag: Vec3 = [push[0] * Math.SQRT1_2, push[1] * Math.SQRT1_2, push[2] * Math.SQRT1_2 + Math.SQRT1_2];
        const sideways: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
        for (let d = 1; d <= 32; d++) {
            for (const dir of [[0, 0, 1], push, diag, ...sideways]) {
                const p: Vec3 = [o[0] + dir[0] * d, o[1] + dir[1] * d, o[2] + dir[2] * d];
                if (!this.trace(p, p).startSolid) {
                    this.origin = p;
                    return;
                }
            }
        }
    }

    /** Nudges the player up out of solid geometry (e.g. a spawn point inside a prop). */
    private unstick() {
        for (let z = 0; z <= 64; z += 4) {
            const p: Vec3 = [this.origin[0], this.origin[1], this.origin[2] + z];
            if (!this.trace(p, p).startSolid) {
                this.origin = p;
                return;
            }
        }
    }
}

function dot(a: Vec3, b: Vec3) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function clip(v: Vec3, n: Vec3): Vec3 {
    const backoff = dot(v, n);
    return [v[0] - n[0] * backoff, v[1] - n[1] * backoff, v[2] - n[2] * backoff];
}
