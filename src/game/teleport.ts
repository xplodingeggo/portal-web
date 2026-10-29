// The player walking through a portal (CProp_Portal::TeleportTouchingEntity for the player).
import * as THREE from 'three';
import { MAX_EXIT_SPEED, MIN_FLOOR_EXIT_SPEED_PLAYER, type Portal } from '../render/portals';
import { angleVector, PhysProp } from './classes';
import type { Game } from './game';

/** Moves the player through a portal: position, velocity, view direction, and what they carry. */
export function teleportPlayer(game: Game, m: THREE.Matrix4, entry: Portal, exit: Portal) {
    const { player, view } = game.ctx;
    // Anything carried stays held, now through the portal (or back on this side).
    for (const e of game.entities) if (e instanceof PhysProp && e.held) e.playerTeleported(entry, exit);
    const half = player.maxs[2] / 2;
    const c = new THREE.Vector3(player.origin[0], player.origin[1], player.origin[2] + half).applyMatrix4(m);
    player.origin = [c.x, c.y, c.z - half];
    const rot = new THREE.Matrix3().setFromMatrix4(m);
    const v = new THREE.Vector3(...player.velocity).applyMatrix3(rot);
    // A floor exit always launches the player, and exits are capped.
    const exitForward = new THREE.Vector3().setFromMatrixColumn(exit.matrix, 0);
    player.findPassableSpace([exitForward.x, exitForward.y, exitForward.z]);
    if (exitForward.z > 0.7071) v.z = Math.max(v.z, MIN_FLOOR_EXIT_SPEED_PLAYER);
    if (v.length() > MAX_EXIT_SPEED) v.multiplyScalar(MAX_EXIT_SPEED / v.length());
    player.velocity = [v.x, v.y, v.z];
    player.onGround = false;
    player.groundModel = null;
    const look = new THREE.Vector3(...angleVector([view.pitch, view.yaw, 0])).applyMatrix3(rot);
    view.yaw = (Math.atan2(look.y, look.x) * 180) / Math.PI;
    view.pitch = (-Math.asin(Math.max(-1, Math.min(1, look.z))) * 180) / Math.PI;
}
