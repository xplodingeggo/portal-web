// Portal transforms, independent of any map.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CollisionWorld } from '../src/physics/collision';
import { PortalSystem } from '../src/render/portals';

function system() {
    // No BSP: an empty collision world, only needed for portal holes and surface snapping.
    const collision = Object.create(CollisionWorld.prototype) as CollisionWorld;
    Object.assign(collision, { holes: [], models: [], worldBrushesIn: () => [] });
    return new PortalSystem(new THREE.Scene(), null as never, collision);
}

describe('portal transforms', () => {
    it('walking into a wall portal comes out of a floor portal moving up', () => {
        const ps = system();
        ps.addMapPortal({ origin: [0, 0, 64], angles: [0, 0, 0] }, 0, 0); // faces +X
        ps.addMapPortal({ origin: [500, 0, 0], angles: [-90, 0, 0] }, 1, 0); // faces +Z (pitch -90 = up)
        ps.setActive(ps.portals[0].key, true);
        ps.setActive(ps.portals[1].key, true);

        const through = ps.crossing([4, 0, 64], [-4, 0, 64]);
        expect(through).not.toBeNull();
        expect(through!.to).toBe(ps.portals[1]);
        const m = through!.matrix;
        const exit = new THREE.Vector3(-4, 0, 64).applyMatrix4(m);
        expect(exit.x).toBeCloseTo(500, 3);
        expect(exit.z).toBeGreaterThan(0); // in front of (above) the floor portal
        const vel = new THREE.Vector3(-100, 0, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(m));
        expect(vel.z).toBeCloseTo(100, 3);
    });

    it('ignores crossings outside the oval and from behind', () => {
        const ps = system();
        ps.addMapPortal({ origin: [0, 0, 64], angles: [0, 0, 0] }, 0, 0);
        ps.addMapPortal({ origin: [0, 300, 64], angles: [0, 180, 0] }, 1, 0);
        ps.setActive(ps.portals[0].key, true);
        ps.setActive(ps.portals[1].key, true);
        expect(ps.crossing([4, 40, 64], [-4, 40, 64])).toBeNull(); // outside the 32-unit half width
        expect(ps.crossing([-4, 0, 64], [4, 0, 64])).toBeNull(); // from behind
        expect(ps.crossing([4, 0, 100], [-4, 0, 100])).not.toBeNull();
    });
});
