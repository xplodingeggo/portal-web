// The particle test map's entity list: parses, keeps the base worldspawn, and every effect class is registered.
import { describe, expect, it } from 'vitest';
import { parseEntityPairs } from '../src/bsp/entities';
import { ENTITY_CLASSES } from '../src/game/classes';
import { particleTestMap } from '../src/game/fxtestmap';

describe('particle test map', () => {
    it('lists registered effect entities after the base worldspawn', () => {
        const m = particleTestMap();
        const ents = parseEntityPairs(m.entities('{\n"classname" "worldspawn"\n"skyname" "sky_day01_01"\n}\n{\n"classname" "info_player_start"\n}'));
        const classes = ents.map((e) => (e as [string, string][]).find(([k]) => k === 'classname')![1]);
        expect(classes[0]).toBe('worldspawn');
        expect(classes.filter((c) => c === 'info_player_start')).toHaveLength(1);
        for (const c of ['env_steam', 'env_spark', 'env_explosion', 'env_splash', 'env_fire', 'env_shooter', 'env_physexplosion', 'env_beam', 'env_sprite', 'point_spotlight', 'env_smokestack', 'func_smokevolume']) {
            expect(ENTITY_CLASSES[c], c).toBeDefined();
        }
        expect(classes).toContain('env_steam');
    });
});
