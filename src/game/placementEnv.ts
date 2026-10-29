// Wires portal placement to this engine: surfaces from the BSP and materials, volumes and
// moving or ignored models from map logic, and the open portals.
import { SurfFlags, type BspFile } from '../bsp/bsp';
import { paramBool, type MaterialDef } from '../material/vmt';
import type { CollisionModel } from '../physics/collision';
import type { PortalSystem } from '../render/portals';
import { parseVec3 } from '../bsp/entities';
import { PhysProp, PortalOrientationVolume, PortalPlacementVolume } from './classes';
import type { Game, GameEntity } from './game';
import { PlacementSuccess, type PlacementEnv, type PlacedPortal, type PlacementVolume } from './portalPlacement';

/** Pass-through materials (g_ppszPortalPassThroughMaterials). */
const PASS_THROUGH = ['lights/light_orange001'];

/**
 * @param materials world materials by name, as loaded for rendering; null entries are missing.
 * Without one (headless) only the compiled SURF_NOPORTAL flag marks unportalable surfaces.
 */
export function placementEnv(game: Game, portals: PortalSystem, bsp: BspFile, materials: Map<string, MaterialDef | null> = new Map()): PlacementEnv {
    const owner = (model: CollisionModel | undefined): GameEntity | undefined =>
        model ? game.entities.find((e) => e.collision === model && !e.removed) : undefined;
    const bounds = (e: GameEntity) => e.brushBounds();
    return {
        collision: game.ctx.collision,
        surface(texInfo) {
            const ti = bsp.texInfos[texInfo];
            if (!ti) return { noPortal: false, passThrough: false };
            const name = (bsp.texDatas[ti.texData]?.name ?? '').toLowerCase();
            const def = materials.get(name);
            // IsNoPortalMaterial: the compiled flag, or glass (materials with a glass surfaceprop).
            const glass = !!def && /glass/i.test(def.params.$surfaceprop ?? '');
            const noPortal = (ti.flags & SurfFlags.NoPortal) !== 0 || glass || (!!def && paramBool(def, '%noportal'));
            const passThrough = (ti.flags & SurfFlags.Sky) !== 0 || PASS_THROUGH.some((m) => name.includes(m));
            return { noPortal, passThrough };
        },
        classOf: (model) => owner(model)?.classname ?? '',
        isMoving: (model) => owner(model)?.isMoving() ?? false,
        shotIgnores() {
            // UTIL_Portal_Trace_Filter: shots pass through physics props.
            return game.entities
                .filter((e) => !e.removed && (e instanceof PhysProp || e.classname.startsWith('prop_physics') || e.classname === 'func_physbox'))
                .map((e) => e.collision)
                .filter((m): m is CollisionModel => !!m);
        },
        volumes() {
            const out: PlacementVolume[] = [];
            for (const e of game.entities) {
                if (e.removed) continue;
                const cls = e.classname;
                if (cls !== 'func_portal_bumper' && cls !== 'trigger_portal_cleanser' && cls !== 'func_noportal_volume') continue;
                const b = bounds(e);
                if (!b) continue;
                const active = e instanceof PortalPlacementVolume ? e.active : (e as GameEntity & { enabled?: boolean }).enabled !== false;
                out.push({ classname: cls, key: e, mins: b.mins, maxs: b.maxs, active });
            }
            return out;
        },
        orientationVolumes() {
            return game.entities
                .filter((e): e is PortalOrientationVolume => e instanceof PortalOrientationVolume && !e.removed)
                .flatMap((e) => {
                    const b = bounds(e);
                    return b ? [{ ...b, anglesToFace: parseVec3(e.kv.anglestoface), matchLinkedAngles: e.kv.matchlinkedangles === '1', active: e.enabled }] : [];
                });
        },
        portals() {
            const map = new Map<object, PlacedPortal>();
            for (const p of portals.portals) map.set(p.key, { key: p.key, origin: p.origin, angles: p.angles, active: p.active, linked: null });
            for (const p of portals.portals) {
                const partner = portals.partner(p);
                if (partner) map.get(p.key)!.linked = map.get(partner.key)!;
            }
            return [...map.values()];
        },
    };
}

/** What a failed placement's analog success value means, for the HUD. */
export function placementFailure(success: number): string {
    if (success === PlacementSuccess.PassthroughSurface) return 'nothing to place a portal on';
    if (success === PlacementSuccess.InvalidSurface) return "can't place portals on that surface";
    if (success === PlacementSuccess.InvalidVolume) return "portals can't go there";
    if (success === PlacementSuccess.OverlapLinked) return 'overlaps the other portal';
    if (success === PlacementSuccess.Cleanser) return 'the emancipation grid fizzled it';
    return "portal doesn't fit there";
}
