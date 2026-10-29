// Saved games: a snapshot of map logic plus the player, portals and view, kept in IndexedDB.
// A save only restores state this port tracks as plain data (see GameEntity.saveState); sounds,
// particles and things in flight (a portal blast, a cube still dropping out of a dispenser) restart.
import type { CameraController } from '../render/noclip';
import type { PortalSystem } from '../render/portals';
import type { Player } from '../physics/player';
import type { Vec3 } from '../physics/collision';
import { GameEntity, type Game, type GameState } from './game';

export interface SavedPortal {
    /** Entity index for a map portal, null for the player's gun portals. */
    entity: number | null;
    color: 0 | 1;
    group: number;
    origin: Vec3;
    angles: Vec3;
    active: boolean;
}

export interface SaveGame {
    id: string;
    name: string;
    map: string;
    created: number;
    /** Game clock when saved, for the list. */
    playtime: number;
    thumb: string | null;
    health?: number;
    player: { origin: Vec3; velocity: Vec3; ducked: boolean; yaw: number; pitch: number; mode: 'walk' | 'noclip'; position: Vec3 };
    game: GameState;
    portals: SavedPortal[];
}

export interface SaveDeps {
    mapName: string;
    health?: number;
    game: Game;
    player: Player;
    view: CameraController;
    portals: PortalSystem;
}

export function capture(d: SaveDeps, id: string, name: string, thumb: string | null): SaveGame {
    return {
        id,
        name,
        map: d.mapName,
        created: Date.now(),
        playtime: d.game.time,
        thumb,
        health: d.health,
        player: {
            origin: [...d.player.origin],
            velocity: [...d.player.velocity],
            ducked: d.player.ducked,
            yaw: d.view.yaw,
            pitch: d.view.pitch,
            mode: d.view.mode,
            position: [...d.view.position],
        },
        game: d.game.snapshot(),
        portals: d.portals.portals.map((p) => ({
            entity: p.key instanceof GameEntity ? p.key.index : null,
            color: p.color,
            group: p.group,
            origin: [...p.origin],
            angles: [...p.angles],
            active: p.active,
        })),
    };
}

/** Puts a save back into a freshly loaded (or running) copy of the same map. */
export function apply(d: SaveDeps, s: SaveGame) {
    d.game.restore(s.game);

    // Portals: map portals by entity, the player's own recreated from scratch, quietly.
    const sound = d.portals.sound;
    d.portals.sound = undefined;
    d.portals.fizzleGunPortals();
    for (const sp of s.portals) {
        if (sp.entity === null) {
            if (sp.active) d.portals.placeGunPortal(sp.color, sp.origin, sp.angles);
            continue;
        }
        const e = d.game.entities.find((x) => x.index === sp.entity);
        if (!e) continue;
        d.portals.move(e, sp.origin, sp.angles);
        d.portals.setActive(e, sp.active);
    }
    d.portals.sound = sound;

    const p = s.player;
    d.player.teleport(p.origin);
    d.player.velocity = [...p.velocity];
    d.player.ducked = p.ducked;
    d.view.yaw = p.yaw;
    d.view.pitch = p.pitch;
    d.view.mode = p.mode;
    d.view.position = [...p.position];
    d.view.syncCamera();
}

// ---- storage ----

function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open('portal-web-saves', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('saves', { keyPath: 'id' });
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

function request<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return open().then(
        (db) =>
            new Promise<T>((resolve, reject) => {
                const r = run(db.transaction('saves', mode).objectStore('saves'));
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            }),
    );
}

export const saves = {
    put: (s: SaveGame) => request('readwrite', (st) => st.put(s)).then(() => undefined),
    get: (id: string) => request<SaveGame | undefined>('readonly', (st) => st.get(id)),
    delete: (id: string) => request('readwrite', (st) => st.delete(id)).then(() => undefined),
    async list(): Promise<SaveGame[]> {
        const all = await request<SaveGame[]>('readonly', (st) => st.getAll());
        return all.sort((a, b) => b.created - a.created);
    },
};

export const QUICK_ID = 'quick';
