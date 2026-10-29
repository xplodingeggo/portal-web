// Rigid-body physics: the role VPhysics plays in Source, on Rapier (VPhysics itself isn't in the
// SDK). Units stay Source's: inches, kilograms, seconds, gravity 600 in/s². The world's brushes
// are fixed convex hulls; brush entities and prop hulls that map logic moves or toggles are
// mirrored as kinematic bodies; physics props are dynamic bodies. Open portals carve the wall
// behind them out of the world here too, using the same pieces the player collides with.
import RAPIER from '@dimforge/rapier3d-compat';
import { brushPoints, Contents, type CollisionBrush, type CollisionHole, type CollisionModel, type CollisionWorld, type Vec3 } from './collision';

let ready: Promise<void> | null = null;
/** Loads Rapier's WASM; await once before creating a PhysicsWorld. */
export function initPhysics(): Promise<void> {
    return (ready ??= RAPIER.init());
}

/** VPhysics steps at the server tick. */
export const PHYSICS_TICK = 1 / 66;
export const GRAVITY = 600;

/** What physics objects collide with: solid, windows, grates; not player clips. */
const MASK_SOLID = Contents.Solid | Contents.Window | Contents.Grate | Contents.Moveable;

const Group = { World: 1, Prop: 2, Player: 4, Held: 8 };
const groups = (member: number, filter: number) => (member << 16) | filter;
const WORLD_GROUPS = groups(Group.World, Group.Prop | Group.Held);
const PROP_GROUPS = groups(Group.Prop, Group.World | Group.Prop | Group.Player | Group.Held);
/** Carried objects don't touch the player who carries them. */
const HELD_GROUPS = groups(Group.Held, Group.World | Group.Prop);
const PLAYER_GROUPS = groups(Group.Player, Group.Prop);
/**
 * Turned off: interacts with nothing. (Collider.setEnabled leaves stale contacts on bodies that
 * were resting on it, so they float on a cover that has opened.)
 */
const NO_GROUPS = 0;

/** Default friction of physics surfaces (VPhysics' "default" surfaceprop). */
const FRICTION = 0.8;

export interface RigidBody {
    body: RAPIER.RigidBody;
    colliders: RAPIER.Collider[];
}

/** Something that runs every physics tick (grab controllers, portal checks). */
export interface PhysicsController {
    beforeTick?(dt: number): void;
    afterTick?(dt: number): void;
}

/** Whether points span a solid at least a hundredth of an inch thick in every direction. */
function hasVolume(points: Vec3[]): boolean {
    if (points.length < 4) return false;
    const a = points[0];
    let b: Vec3 | null = null, c: Vec3 | null = null;
    for (const p of points) if (!b && Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]) > 0.01) b = p;
    if (!b) return false;
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let n: number[] = [0, 0, 0];
    for (const p of points) {
        const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
        const x = [ab[1] * ap[2] - ab[2] * ap[1], ab[2] * ap[0] - ab[0] * ap[2], ab[0] * ap[1] - ab[1] * ap[0]];
        if (Math.hypot(x[0], x[1], x[2]) > 0.01) {
            c = p;
            n = x;
            break;
        }
    }
    if (!c) return false;
    const len = Math.hypot(n[0], n[1], n[2]);
    return points.some((p) => Math.abs(((p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1] + (p[2] - a[2]) * n[2]) / len) > 0.01);
}

export class PhysicsWorld {
    readonly world: RAPIER.World;
    private brushColliders = new Map<CollisionBrush, RAPIER.Collider>();
    private holes: CollisionHole[] = [];
    private pieceColliders: RAPIER.Collider[] = [];
    private mirrored = new Map<CollisionModel, { body: RAPIER.RigidBody; colliders: RAPIER.Collider[]; solid: boolean }>();
    private controllers = new Set<PhysicsController>();
    private player: { body: RAPIER.RigidBody; collider: RAPIER.Collider | null; height: number } | null = null;
    private accumulator = 0;
    /** Where the player's body is, for the kinematic box props bump into (null: no player). */
    playerBox: () => { origin: Vec3; mins: Vec3; maxs: Vec3 } | null = () => null;

    constructor(private collision: CollisionWorld) {
        this.world = new RAPIER.World({ x: 0, y: 0, z: -GRAVITY });
        this.world.timestep = PHYSICS_TICK;
        // Rapier's tolerances scale with this: one meter in inches.
        this.world.integrationParameters.lengthUnit = 39.37;
        for (const b of collision.world.brushes) {
            const c = this.addHull(brushPoints(b), b.contents, WORLD_GROUPS);
            if (c) this.brushColliders.set(b, c);
        }
    }

    private addHull(points: Vec3[], contents: number, collisionGroups: number, parent?: RAPIER.RigidBody): RAPIER.Collider | null {
        if (!(contents & MASK_SOLID) || !hasVolume(points)) return null;
        const desc = RAPIER.ColliderDesc.convexHull(Float32Array.from(points.flat()));
        if (!desc) return null;
        // VPhysics multiplies the two surfaces' friction.
        desc.setCollisionGroups(collisionGroups).setFriction(FRICTION).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply);
        try {
            return this.world.createCollider(desc, parent);
        } catch {
            // Rapier couldn't build a hull from the points (a sliver); it has nothing to collide with anyway.
            return null;
        }
    }

    /**
     * Adds a dynamic body: convex hulls given relative to `origin` (rotation baked in), with
     * `mass` spread over their volume.
     */
    addBody(hulls: Vec3[][], origin: Vec3, mass: number): RigidBody | null {
        const body = this.world.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic().setTranslation(origin[0], origin[1], origin[2]).setCcdEnabled(true).setAngularDamping(0.05),
        );
        const colliders = hulls.map((h) => this.addHull(h, Contents.Solid, PROP_GROUPS, body)).filter((c): c is RAPIER.Collider => !!c);
        if (!colliders.length) {
            this.world.removeRigidBody(body);
            return null;
        }
        const volume = colliders.reduce((s, c) => s + c.volume(), 0);
        for (const c of colliders) c.setDensity(volume > 0 ? mass / volume : 1);
        return { body, colliders };
    }

    removeBody(r: RigidBody) {
        this.world.removeRigidBody(r.body);
    }

    /** prop_physics EnableMotion/DisableMotion: a motion-disabled body is fixed in place. */
    setMotionEnabled(r: RigidBody, on: boolean) {
        r.body.setBodyType(on ? RAPIER.RigidBodyType.Dynamic : RAPIER.RigidBodyType.Fixed, true);
    }

    /** A carried body collides with the world and other props but not the player. */
    setHeld(r: RigidBody, held: boolean) {
        for (const c of r.colliders) c.setCollisionGroups(held ? HELD_GROUPS : PROP_GROUPS);
    }

    addController(c: PhysicsController) {
        this.controllers.add(c);
    }

    removeController(c: PhysicsController) {
        this.controllers.delete(c);
    }

    /** Advances physics by `dt` in fixed ticks; returns how many ran. */
    step(dt: number): number {
        this.accumulator = Math.min(this.accumulator + dt, 0.25);
        let ticks = 0;
        while (this.accumulator >= PHYSICS_TICK) {
            this.accumulator -= PHYSICS_TICK;
            this.syncHoles();
            this.syncModels();
            this.syncPlayer();
            for (const c of this.controllers) c.beforeTick?.(PHYSICS_TICK);
            this.world.step();
            for (const c of [...this.controllers]) c.afterTick?.(PHYSICS_TICK);
            ticks++;
        }
        return ticks;
    }

    /** Portal holes: the carved wall brushes stop colliding and their leftover pieces collide instead. */
    private syncHoles() {
        if (this.collision.holes === this.holes) return;
        for (const h of this.holes) for (const b of h.brushes) this.brushColliders.get(b)?.setCollisionGroups(WORLD_GROUPS);
        for (const c of this.pieceColliders) this.world.removeCollider(c, true);
        this.pieceColliders = [];
        this.holes = this.collision.holes;
        for (const h of this.holes) {
            for (const b of h.brushes) this.brushColliders.get(b)?.setCollisionGroups(NO_GROUPS);
            for (const p of h.pieces) {
                const c = this.addHull(brushPoints(p), p.contents, WORLD_GROUPS);
                if (c) this.pieceColliders.push(c);
            }
        }
        // Wake anything resting against a wall that just opened.
        this.world.forEachRigidBody((b) => b.isDynamic() && b.wakeUp());
    }

    /** Brush entities and prop hulls follow their collision models as kinematic bodies. */
    private syncModels() {
        const live = new Set<CollisionModel>();
        for (const m of this.collision.allModels) {
            if (m === this.collision.world || m.rigid) continue;
            live.add(m);
            let k = this.mirrored.get(m);
            if (!k) {
                const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(m.origin[0], m.origin[1], m.origin[2]));
                const colliders = m.brushes.map((b) => this.addHull(brushPoints(b), b.contents, WORLD_GROUPS, body)).filter((c): c is RAPIER.Collider => !!c);
                k = { body, colliders, solid: true };
                this.mirrored.set(m, k);
            }
            const t = k.body.translation();
            if (t.x !== m.origin[0] || t.y !== m.origin[1] || t.z !== m.origin[2]) {
                k.body.setNextKinematicTranslation({ x: m.origin[0], y: m.origin[1], z: m.origin[2] });
            }
            if (k.solid !== m.solid) {
                k.solid = m.solid;
                for (const c of k.colliders) c.setCollisionGroups(m.solid ? WORLD_GROUPS : NO_GROUPS);
                this.world.forEachRigidBody((b) => b.isDynamic() && b.wakeUp());
            }
        }
        for (const [m, k] of this.mirrored) {
            if (live.has(m)) continue;
            this.world.removeRigidBody(k.body);
            this.mirrored.delete(m);
        }
    }

    /** The player as a kinematic box, so props land on and are nudged by them. */
    private syncPlayer() {
        const box = this.playerBox();
        if (!box) {
            if (this.player) this.player.collider?.setCollisionGroups(NO_GROUPS);
            return;
        }
        const half: Vec3 = [(box.maxs[0] - box.mins[0]) / 2, (box.maxs[1] - box.mins[1]) / 2, (box.maxs[2] - box.mins[2]) / 2];
        const center = { x: box.origin[0] + (box.mins[0] + box.maxs[0]) / 2, y: box.origin[1] + (box.mins[1] + box.maxs[1]) / 2, z: box.origin[2] + (box.mins[2] + box.maxs[2]) / 2 };
        if (!this.player) {
            const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(center.x, center.y, center.z));
            this.player = { body, collider: null, height: 0 };
        }
        const p = this.player;
        if (p.height !== half[2]) {
            if (p.collider) this.world.removeCollider(p.collider, true);
            p.collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2]).setCollisionGroups(PLAYER_GROUPS).setFriction(FRICTION), p.body);
            p.height = half[2];
            p.body.setTranslation(center, true);
        }
        p.collider!.setCollisionGroups(PLAYER_GROUPS);
        p.body.setNextKinematicTranslation(center);
    }
}
