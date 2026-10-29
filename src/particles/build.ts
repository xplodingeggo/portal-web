// Particle systems written in code rather than read from a .pcf: the map's old-style effect
// entities (env_steam, env_spark, ...) made from the same operators the game files use.
import type { ParticleDef, PcfOperator, PcfValue } from './pcf';

type Attrs = Record<string, PcfValue>;

export const op = (fn: string, attrs: Attrs = {}): PcfOperator => ({ name: fn, fn, attrs: new Map(Object.entries(attrs)) });

export interface DefParts {
    /** The material the renderers draw, as the .pcf's `material` setting. */
    material: string;
    additive?: boolean;
    maxParticles?: number;
    radius?: number;
    color?: [number, number, number, number];
    emitters: PcfOperator[];
    initializers?: PcfOperator[];
    operators?: PcfOperator[];
    forces?: PcfOperator[];
    constraints?: PcfOperator[];
    renderers?: PcfOperator[];
}

export function makeDef(name: string, p: DefParts): ParticleDef {
    const attrs = new Map<string, PcfValue>([
        ['material', p.material],
        ['max_particles', p.maxParticles ?? 200],
        ['radius', p.radius ?? 5],
        ['color', p.color ?? [255, 255, 255, 255]],
    ]);
    if (p.additive) attrs.set('additive', true);
    return {
        name,
        attrs,
        children: [],
        emitters: p.emitters,
        initializers: p.initializers ?? [],
        operators: p.operators ?? [],
        forces: p.forces ?? [],
        constraints: p.constraints ?? [],
        renderers: p.renderers ?? [op('render_animated_sprites')],
    };
}
