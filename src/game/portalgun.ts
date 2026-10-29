// Firing a portal gun (CWeaponPortalgun::FirePortal), from the player's hands or a weapon_portalgun
// on a pedestal: the shot is traced and judged at once, a blast flies to the spot, and the portal
// opens or fizzles when it arrives (CProp_Portal::DelayedPlacementThink).
import type { Vec3 } from '../physics/collision';
import type { Game } from './game';
import { GameEntity } from './game';
import { placementEnv } from './placementEnv';
import { PlacedBy, PlacementSuccess, traceFirePortal, verifyPortalPlacement, type PlacementResult } from './portalPlacement';

/** weapon_portalgun.cpp: blast speeds, units per second. */
export const BLAST_SPEED = 3000;
export const BLAST_SPEED_NON_PLAYER = 1000;

/** Which particle effect each failed placement shows (CProp_Portal::DoFizzleEffect). */
const FIZZLE_EFFECTS: [number, string][] = [
    [PlacementSuccess.CantFit, 'nofit'],
    [PlacementSuccess.OverlapLinked, 'overlap'],
    [PlacementSuccess.InvalidVolume, 'badvolume'],
    [PlacementSuccess.InvalidSurface, 'badsurface'],
    [PlacementSuccess.Cleanser, 'cleanser'],
    [PlacementSuccess.Near, 'near'],
];

/**
 * Fires portal `color` along `dir` from `start` (the eye, or the gun's muzzle); the blast leaves
 * from `tracerFrom`. Returns the placement verdict; the portal opens when the blast lands.
 */
export function firePortal(game: Game, color: 0 | 1, start: Vec3, dir: Vec3, tracerFrom: Vec3, placedBy: PlacedBy, instant = false): PlacementResult {
    const { portals } = game.ctx;
    const env = (game.ctx.placement ??= placementEnv(game, portals, game.ctx.bsp));
    const current = portals.findPortal(color, 0);
    const r = traceFirePortal(env, current?.key ?? null, start, dir, placedBy);
    const speed = placedBy === PlacedBy.Player ? BLAST_SPEED : BLAST_SPEED_NON_PLAYER;
    const delay = instant ? 0 : Math.hypot(r.origin[0] - tracerFrom[0], r.origin[1] - tracerFrom[1], r.origin[2] - tracerFrom[2]) / speed;
    if (!instant) game.ctx.effects?.blast(color, tracerFrom, r.origin, delay, placedBy === PlacedBy.Player);

    const land = () => {
        let success = r.success;
        // Something may have made the spot invalid mid flight.
        if (success >= 0.5) {
            const again = verifyPortalPlacement(env, portals.findPortal(color, 0)?.key ?? null, r.origin, r.angles, placedBy, true);
            if (again.success === PlacementSuccess.OverlapLinked || again.success === PlacementSuccess.InvalidVolume) success = again.success;
        }
        if (success < 0.5) {
            // DoFizzleEffect: what went wrong picks the particles.
            const burst = FIZZLE_EFFECTS.find(([code]) => code === success);
            if (burst) portals.burst(burst[1], color, r.origin, r.angles);
            // No sound for shots into nothing or that just didn't fit.
            if (success !== PlacementSuccess.PassthroughSurface && success !== PlacementSuccess.CantFit) portals.fizzleSound('invalid', color, r.origin);
            return;
        }
        // The portal's old spot closes.
        const old = portals.findPortal(color, 0);
        if (old?.active) {
            portals.fizzleSound('close', color, old.origin);
            portals.burst('close', color, old.origin, old.angles);
        }
        const p = portals.placeGunPortal(color, r.origin, r.angles);
        portals.burst('success', color, r.origin, r.angles);
        if (placedBy === PlacedBy.Player && p.key instanceof GameEntity) p.key.fire('onplacedsuccessfully', game.playerEntity);
    };
    if (instant) land();
    else game.after(delay, land);
    return r;
}
