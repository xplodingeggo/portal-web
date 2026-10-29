// Places studio models (static props and prop entities) in the scene. Lighting is
// either the baked per-vertex .vhv data or the ambient cube at the prop's position.
import * as THREE from 'three';
import type { BspFile } from '../bsp/bsp';
import { parseVec3, type Entity } from '../bsp/entities';
import { parseStaticProps, sampleAmbientCube, StaticPropFlags } from '../bsp/props';
import type { GameFS } from '../fs/gamefs';
import { loadMaterial, paramBool, type MaterialDef } from '../material/vmt';
import { parsePhy, parsePhyProperties, type Hull } from '../model/phy';
import { computePose, type BoneAdjust } from '../model/pose';
import { bodyGroupModel, loadStudioModel, meshMaterialCandidates, parseVhv, skinMesh, type StudioMesh, type StudioModel } from '../model/studio';
import type { TextureCache } from './textures';
import { parseColor } from './worldMaterial';

type Vec3 = [number, number, number];

/** Entities that draw a model without naming it in their keyvalues. */
const DEFAULT_MODELS: Record<string, string> = {
    npc_security_camera: 'models/props/security_camera.mdl',
    npc_portal_turret_floor: 'models/props/turret_01.mdl',
    npc_rocket_turret: 'models/props_bts/rocket_sentry.mdl',
    // Weapons in the world show their "playermodel" (scripts/weapon_portalgun.txt).
    weapon_portalgun: 'models/weapons/w_portalgun.mdl',
};

const vertexShader = /* glsl */ `
attribute vec3 vlight;
uniform bool useVertexLight;
uniform vec3 ambientCube[6];
varying vec2 vUv;
varying vec3 vLight;
void main() {
    vUv = uv;
    if (useVertexLight) {
        vLight = vlight;
    } else {
        vec3 n = normalize(mat3(modelMatrix) * normal);
        vec3 n2 = n * n;
        vLight = n2.x * (n.x >= 0.0 ? ambientCube[0] : ambientCube[1])
               + n2.y * (n.y >= 0.0 ? ambientCube[2] : ambientCube[3])
               + n2.z * (n.z >= 0.0 ? ambientCube[4] : ambientCube[5]);
    }
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D baseTexture;
uniform bool unlit;
uniform bool selfIllum;
uniform float alphaTest;
uniform float alpha;
uniform float exposure;
uniform vec3 color;
varying vec2 vUv;
varying vec3 vLight;
void main() {
    vec4 base = texture2D(baseTexture, vUv);
    if (base.a < alphaTest) discard;
    vec3 albedo = pow(base.rgb * color, vec3(2.2));
    vec3 light = unlit ? vec3(1.0) : vLight * exposure;
    if (selfIllum) light = mix(light, vec3(1.0), base.a);
    gl_FragColor = vec4(pow(albedo * light, vec3(1.0 / 2.2)), (selfIllum ? 1.0 : base.a) * alpha);
}
`;

export interface PropInstance {
    model: string;
    origin: Vec3;
    angles: Vec3;
    skin: number;
    body: number;
    color?: THREE.Color;
    /** Static props: index into the map's sp_N.vhv files. */
    staticIndex?: number;
    /** Point to sample ambient light at, in world space; defaults to the model's illum position. */
    lightingOrigin?: Vec3;
    /** Sequence label to pose from; defaults to the model's first sequence. */
    sequence?: string;
    /** Blocks the player (using the model's .phy collision hulls). */
    solid: boolean;
    /** Index into the map's entity list, for prop entities (not static props). */
    entityIndex?: number;
}

/** A placed prop that map logic can move, re-skin, animate and hide. */
export interface PropHandle {
    prop: PropInstance;
    group: THREE.Group;
    model: StudioModel;
    meshes: { mesh: THREE.Mesh; studio: StudioMesh }[];
    skin: number;
    cube: THREE.Vector3[];
    hasVertexLight: boolean;
}

/** Entity props that never collide. */
const NON_SOLID_CLASSES = new Set(['npc_security_camera', 'weapon_portalgun']);

const TOILET_BODY = 'models/props/toilet_body_reference.mdl';

/** An axis-aligned box as a hull. */
function boxHull(min: Vec3, max: Vec3): Hull {
    const points: Vec3[] = [];
    for (const z of [min[2], max[2]]) for (const y of [min[1], max[1]]) for (const x of [min[0], max[0]]) points.push([x, y, z]);
    // Point index is x + 2y + 4z; two triangles a face (the collision code orients them outward).
    const quads = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
    return { points, triangles: quads.flatMap(([a, b, c, d]): [number, number, number][] => [[a, b, c], [a, c, d]]) };
}

/**
 * The toilet's .phy is a solid bowl, so nothing can be dropped in. Swap the bowl and seat hulls
 * (9-18 of the body) for a floor and four walls around the opening, in the model's own space.
 */
function openToiletBowl(hulls: Hull[]): Hull[] {
    const hole = { x0: -16.5, x1: 2.5, y: 7.5 };
    const wall = (x0: number, x1: number, y0: number, y1: number): Hull => boxHull([x0, y0, 8], [x1, y1, 23.9]);
    return [
        ...hulls.slice(0, 8),
        boxHull([-19.8, -11.6, 1.8], [15.8, 11.6, 8]),
        wall(-19.8, hole.x0, -11.6, 11.6),
        wall(hole.x1, 15.8, -11.6, 11.6),
        wall(hole.x0, hole.x1, -11.6, -hole.y),
        wall(hole.x0, hole.x1, hole.y, 11.6),
        ...hulls.slice(19),
    ];
}

export class PropRenderer {
    readonly missingModels = new Set<string>();
    readonly missingMaterials = new Set<string>();
    private models = new Map<string, Promise<StudioModel | null>>();
    private materials = new Map<string, Promise<MaterialDef | null>>();

    constructor(
        private fs: GameFS,
        private bsp: BspFile,
        private textures: TextureCache,
        private fallback: THREE.Texture,
        private exposure: { value: number },
    ) {}

    /** The model prop an entity draws, or null if it has none. */
    propFor(e: Entity, entityIndex: number): PropInstance | null {
        const model = (e.model?.toLowerCase().endsWith('.mdl') ? e.model : DEFAULT_MODELS[e.classname])?.toLowerCase();
        if (!model || e.classname === 'prop_portal') return null;
        if (e.rendermode === '10') return null;
        const rc = e.rendercolor ? parseVec3(e.rendercolor) : null;
        return {
            model,
            origin: parseVec3(e.origin),
            angles: parseVec3(e.angles),
            skin: Number(e.skin ?? 0) || 0,
            body: Number(e.body ?? e.setbodygroup ?? 0) || 0,
            sequence: e.defaultanim || undefined,
            solid: !NON_SOLID_CLASSES.has(e.classname) && (e.solid ?? '6') !== '0',
            color: rc && !(rc[0] === 255 && rc[1] === 255 && rc[2] === 255) ? new THREE.Color(rc[0] / 255, rc[1] / 255, rc[2] / 255) : undefined,
            entityIndex,
        };
    }

    /** All static props plus model-bearing entities in the map. */
    collect(entities: Entity[]): PropInstance[] {
        const out: PropInstance[] = parseStaticProps(this.bsp).map((p) => ({
            model: p.model,
            origin: p.origin,
            angles: p.angles,
            skin: p.skin,
            body: 0,
            staticIndex: p.flags & StaticPropFlags.NoPerVertexLighting ? undefined : p.index,
            lightingOrigin: p.flags & StaticPropFlags.UseLightingOrigin ? p.lightingOrigin : undefined,
            solid: p.solid !== 0,
        }));
        entities.forEach((e, entityIndex) => {
            const p = this.propFor(e, entityIndex);
            if (p) out.push(p);
        });
        return out;
    }

    /** A prop's physics mass in kg from its .phy, or null. */
    async physicsMass(prop: PropInstance): Promise<number | null> {
        const buf = await this.fs.read(prop.model.replace(/\.mdl$/, '.phy'));
        return buf ? parsePhyProperties(buf).mass : null;
    }

    /** World-space collision hulls of a solid prop, from its .phy file. */
    async collisionHulls(prop: PropInstance): Promise<Hull[]> {
        if (!prop.solid) return [];
        const buf = await this.fs.read(prop.model.replace(/\.mdl$/, '.phy'));
        if (!buf) return [];
        const d = Math.PI / 180;
        const m = new THREE.Matrix4().makeRotationFromEuler(
            new THREE.Euler(prop.angles[2] * d, prop.angles[0] * d, prop.angles[1] * d, 'ZYX'),
        );
        m.setPosition(...prop.origin);
        const v = new THREE.Vector3();
        const hulls = prop.model === TOILET_BODY ? openToiletBowl(parsePhy(buf)) : parsePhy(buf);
        return hulls.map((h) => ({
            triangles: h.triangles,
            points: h.points.map((p): Vec3 => {
                v.set(p[0], p[1], p[2]).applyMatrix4(m);
                return [v.x, v.y, v.z];
            }),
        }));
    }

    async build(prop: PropInstance): Promise<PropHandle | null> {
        const model = await this.model(prop.model, prop.sequence);
        if (!model) {
            this.missingModels.add(prop.model);
            return null;
        }
        // Chamber signs start dark; map logic lights them from a look trigger that's enabled
        // by a scripted scene, which isn't run. Start them lit; Skin inputs still apply.
        const skin = prop.model.startsWith('models/props_animsigns/')
            ? model.mdl.skinFamilies.length - 1
            : prop.skin;

        const group = new THREE.Group();
        group.name = prop.model;
        group.position.set(...prop.origin);
        const d = Math.PI / 180;
        group.rotation.set(prop.angles[2] * d, prop.angles[0] * d, prop.angles[1] * d, 'ZYX'); // roll, pitch, yaw
        group.updateMatrixWorld();

        let vertexLight: Map<number, Float32Array> | null = null;
        if (prop.staticIndex !== undefined) {
            const name = this.bsp.usesHDR ? `sp_hdr_${prop.staticIndex}.vhv` : `sp_${prop.staticIndex}.vhv`;
            const vhv = await this.fs.read(name);
            if (vhv) vertexLight = parseVhv(vhv, model);
        }
        const illum = new THREE.Vector3(...model.mdl.illumPosition).applyMatrix4(group.matrixWorld);
        const cube = sampleAmbientCube(this.bsp, prop.lightingOrigin ?? [illum.x, illum.y, illum.z]);
        const cubeUniform = [0, 1, 2, 3, 4, 5].map((k) => new THREE.Vector3(cube[k * 3], cube[k * 3 + 1], cube[k * 3 + 2]));

        const handle: PropHandle = { prop, group, model, meshes: [], skin, cube: cubeUniform, hasVertexLight: !!vertexLight };
        await Promise.all(
            model.meshes.map(async (mesh, i) => {
                if (mesh.model !== bodyGroupModel(model.mdl, mesh.bodyPart, prop.body)) return;
                if (mesh.indices.length === 0) return;
                const def = await this.material(model, skin, mesh.skinRef);

                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
                geom.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
                geom.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
                const vl = vertexLight?.get(i);
                geom.setAttribute('vlight', new THREE.BufferAttribute(vl ?? new Float32Array(mesh.positions.length), 3));
                geom.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

                const material = await this.createMaterial(def, cubeUniform, !!vl, prop.color);
                const m = new THREE.Mesh(geom, material);
                if (material.transparent) m.renderOrder = 1;
                m.visible = !(def && paramBool(def, '$no_draw'));
                group.add(m);
                handle.meshes.push({ mesh: m, studio: mesh });
            }),
        );
        return handle;
    }

    /** Switches a prop to another skin family. */
    async setSkin(h: PropHandle, skin: number) {
        if (skin === h.skin) return;
        h.skin = skin;
        await Promise.all(
            h.meshes.map(async (entry) => {
                const def = await this.material(h.model, skin, entry.studio.skinRef);
                const old = entry.mesh.material as THREE.ShaderMaterial;
                const vl = old.uniforms.useVertexLight.value as boolean;
                entry.mesh.material = await this.createMaterial(def, h.cube, vl, h.prop.color);
                entry.mesh.visible = !(def && paramBool(def, '$no_draw'));
                old.dispose();
            }),
        );
    }

    /** Resamples a moving prop's ambient light where it is now (Source relights props every frame). */
    relight(h: PropHandle) {
        if (h.hasVertexLight) return;
        h.group.updateMatrixWorld();
        const illum = new THREE.Vector3(...h.model.mdl.illumPosition).applyMatrix4(h.group.matrixWorld);
        const c = sampleAmbientCube(this.bsp, [illum.x, illum.y, illum.z]);
        // The materials share these vectors as their ambientCube uniform.
        h.cube.forEach((v, k) => v.set(c[k * 3], c[k * 3 + 1], c[k * 3 + 2]));
    }

    /** Re-skins a prop's vertices to a frame of a sequence. */
    setPose(h: PropHandle, sequence: number, frame: number, bounds = true, adjust?: BoneAdjust) {
        const pose = computePose(h.model.mdl, sequence, frame, adjust);
        for (const { mesh, studio } of h.meshes) {
            const geom = mesh.geometry;
            let pos = geom.getAttribute('position') as THREE.BufferAttribute;
            let nrm = geom.getAttribute('normal') as THREE.BufferAttribute;
            // Meshes share arrays with the model cache until first posed.
            if (pos.array === studio.positions) {
                pos = new THREE.BufferAttribute(new Float32Array(studio.positions.length), 3);
                nrm = new THREE.BufferAttribute(new Float32Array(studio.normals.length), 3);
                geom.setAttribute('position', pos);
                geom.setAttribute('normal', nrm);
            }
            skinMesh(h.model, studio, pose, pos.array as Float32Array, nrm.array as Float32Array);
            pos.needsUpdate = true;
            nrm.needsUpdate = true;
            if (bounds) geom.computeBoundingSphere();
            else mesh.frustumCulled = false;
        }
    }

    private model(path: string, sequence?: string) {
        const key = `${path}|${sequence ?? ''}`;
        let p = this.models.get(key);
        if (!p) {
            p = loadStudioModel(this.fs, path, sequence).catch((e) => {
                console.warn(`${path}: ${(e as Error).message}`);
                return null;
            });
            this.models.set(key, p);
        }
        return p;
    }

    private material(model: StudioModel, skin: number, skinRef: number): Promise<MaterialDef | null> {
        const candidates = meshMaterialCandidates(model.mdl, skin, skinRef);
        const key = candidates.join('|');
        let p = this.materials.get(key);
        if (!p) {
            p = (async () => {
                for (const c of candidates) {
                    const def = await loadMaterial(this.fs, c);
                    if (def) return def;
                }
                this.missingMaterials.add(candidates[0] ?? `${model.path} skinref ${skinRef}`);
                return null;
            })();
            this.materials.set(key, p);
        }
        return p;
    }

    private async createMaterial(def: MaterialDef | null, cube: THREE.Vector3[], useVertexLight: boolean, tint?: THREE.Color) {
        const p = def?.params ?? {};
        const base = p.$basetexture ? await this.textures.get(p.$basetexture) : null;
        const translucent = !!def && (paramBool(def, '$translucent') || paramBool(def, '$additive'));
        const alpha = p.$alpha !== undefined ? Number(p.$alpha) : 1;
        const color = parseColor(p.$color2) ?? parseColor(p.$color) ?? new THREE.Color(1, 1, 1);
        if (tint) color.multiply(tint);
        const mat = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms: {
                baseTexture: { value: base ?? this.fallback },
                useVertexLight: { value: useVertexLight },
                ambientCube: { value: cube },
                unlit: { value: def?.shader === 'unlitgeneric' },
                selfIllum: { value: !!def && paramBool(def, '$selfillum') },
                alphaTest: { value: def && paramBool(def, '$alphatest') ? Number(p.$alphatestreference ?? 0.5) || 0.5 : 0 },
                alpha: { value: alpha },
                exposure: this.exposure,
                color: { value: color },
            },
            side: def && paramBool(def, '$nocull') ? THREE.DoubleSide : THREE.FrontSide,
            transparent: translucent || alpha < 1,
            depthWrite: !(translucent || alpha < 1),
            blending: def && paramBool(def, '$additive') ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        mat.name = def?.name ?? 'missing';
        return mat;
    }
}
