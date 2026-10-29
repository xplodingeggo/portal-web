// One shader for world surfaces: base texture (optionally blended with a second
// texture for WorldVertexTransition) times the baked lightmap.
import * as THREE from 'three';
import { paramBool, type MaterialDef } from '../material/vmt';
import type { TextureCache } from './textures';

const vertexShader = /* glsl */ `
attribute vec2 lmUv;
attribute float blendAlpha;
varying vec2 vUv;
varying vec2 vLmUv;
varying float vBlend;
void main() {
    vUv = uv;
    vLmUv = lmUv;
    vBlend = blendAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D baseTexture;
uniform sampler2D baseTexture2;
uniform sampler2D lightmap;
uniform bool useBase2;
uniform bool unlit;
uniform bool selfIllum;
uniform float alphaTest;
uniform float alpha;
uniform float exposure;
uniform bool flatTint;
uniform vec3 tint;
varying vec2 vUv;
varying vec2 vLmUv;
varying float vBlend;
void main() {
    if (flatTint) {
        gl_FragColor = vec4(tint, alpha);
        return;
    }
    vec4 base = texture2D(baseTexture, vUv);
    if (useBase2) base = mix(base, texture2D(baseTexture2, vUv), vBlend);
    if (base.a < alphaTest) discard;
    vec3 albedo = pow(base.rgb, vec3(2.2));
    vec3 light = unlit ? vec3(1.0) : texture2D(lightmap, vLmUv).rgb * exposure;
    if (selfIllum) light = mix(light, vec3(1.0), base.a);
    gl_FragColor = vec4(pow(albedo * light, vec3(1.0 / 2.2)), base.a * alpha);
}
`;

export async function createWorldMaterial(
    def: MaterialDef | null,
    textures: TextureCache,
    lightmap: THREE.Texture,
    fallback: THREE.Texture,
    exposure: { value: number },
): Promise<THREE.ShaderMaterial> {
    const p = def?.params ?? {};
    const [base, base2] = await Promise.all([
        p.$basetexture ? textures.get(p.$basetexture) : null,
        p.$basetexture2 ? textures.get(p.$basetexture2) : null,
    ]);

    const shader = def?.shader ?? '';
    // Refract (glass) has no base texture; until a refraction pass exists, draw a faint tinted pane.
    const refract = shader === 'refract';
    const translucent = refract || (!!def && (paramBool(def, '$translucent') || paramBool(def, '$additive')));
    const alphaTested = !!def && paramBool(def, '$alphatest');
    const alpha = refract ? 0.15 : p.$alpha !== undefined ? Number(p.$alpha) : 1;

    const mat = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
            baseTexture: { value: base ?? fallback },
            baseTexture2: { value: base2 ?? base ?? fallback },
            lightmap: { value: lightmap },
            useBase2: { value: shader === 'worldvertextransition' && !!base2 },
            unlit: { value: shader === 'unlitgeneric' },
            selfIllum: { value: !!def && paramBool(def, '$selfillum') },
            alphaTest: { value: alphaTested ? Number(p.$alphatestreference ?? 0.5) || 0.5 : 0 },
            alpha: { value: alpha },
            exposure,
            flatTint: { value: refract },
            tint: { value: parseColor(p.$refracttint) ?? new THREE.Color(0.8, 0.9, 1) },
        },
        side: def && paramBool(def, '$nocull') ? THREE.DoubleSide : THREE.FrontSide,
        transparent: translucent || alpha < 1,
        depthWrite: !(translucent || alpha < 1),
        blending: def && paramBool(def, '$additive') ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    mat.name = def?.name ?? 'missing';
    return mat;
}

/** VMT colors: "[r g b]" is 0-1 floats, "{r g b}" is 0-255 bytes. */
export function parseColor(s: string | undefined): THREE.Color | null {
    const m = s ? /^\s*([[{])\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s) : null;
    if (!m) return null;
    const k = m[1] === '{' ? 255 : 1;
    return new THREE.Color(Number(m[2]) / k, Number(m[3]) / k, Number(m[4]) / k);
}
