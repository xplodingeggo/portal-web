// Portal's crosshair (client/portal/hud_quickinfo.cpp, CHUDQuickInfo::Paint): a dot, a bracket
// either side in each portal's colour (solid where that portal can be placed, hollow where it
// can't), and a pulsing mark beside the colour fired last. Sprites from sprites/hud/portal_crosshairs
// with the rects in scripts/mod_textures.txt.
import * as THREE from 'three';
import { PORTAL_COLORS } from './blast';
import type { TextureCache } from './textures';

/** mod_textures.txt: x, y, width, height in the 256-wide sheet. */
const ICONS = {
    lbn: [2, 0, 44, 64],
    rbn: [50, 0, 44, 64],
    lb: [98, 0, 44, 64],
    rb: [146, 0, 44, 64],
    lbe: [194, 0, 28, 64],
    rbe: [194, 0, 28, 64],
} as const;
type Icon = keyof typeof ICONS;
/** UTIL_Portal_Color(0): the carrying ("gravity beam") colour. */
const HOLD_COLOR = new THREE.Color(242 / 255, 202 / 255, 167 / 255);
const LAST_PLACED_BASE_ALPHA = 128;
const LAST_PLACED_LERP_SPEED = 300;

export interface CrosshairState {
    canFire: [boolean, boolean];
    /** Whether each portal would place where the player is looking. */
    placeable: [boolean, boolean];
    /** 0 none, 1 blue, 2 orange. */
    lastFired: 0 | 1 | 2;
    holding: boolean;
}

export class Hud {
    readonly scene = new THREE.Scene();
    readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    private sprites = new Map<Icon, THREE.Mesh>();
    private dot: THREE.Mesh;
    private sheet: { w: number; h: number } | null = null;
    private lastPlacedAlpha = [80, 80];
    private countingUp = [true, true];
    private size = { w: 1, h: 1 };
    visible = false;

    constructor() {
        this.dot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false }));
        this.scene.add(this.dot);
    }

    async load(textures: TextureCache) {
        const tex = await textures.get('sprites/hud/portal_crosshairs');
        if (!tex) return;
        const img = tex.image as { width: number; height: number };
        this.sheet = { w: img.width, h: img.height };
        for (const name of Object.keys(ICONS) as Icon[]) {
            const [x, y, w, h] = ICONS[name];
            const geom = new THREE.PlaneGeometry(1, 1);
            const u0 = x / img.width, u1 = (x + w) / img.width;
            // VTF rows run top-down; the texture is uploaded as-is, so v=0 is the top row.
            const v0 = y / img.height, v1 = (y + h) / img.height;
            const uv = geom.getAttribute('uv') as THREE.BufferAttribute;
            // PlaneGeometry corners: top-left, top-right, bottom-left, bottom-right.
            uv.setXY(0, u0, tex.flipY ? 1 - v0 : v0);
            uv.setXY(1, u1, tex.flipY ? 1 - v0 : v0);
            uv.setXY(2, u0, tex.flipY ? 1 - v1 : v1);
            uv.setXY(3, u1, tex.flipY ? 1 - v1 : v1);
            const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
            this.sprites.set(name, mesh);
            this.scene.add(mesh);
        }
    }

    setSize(w: number, h: number) {
        this.size = { w, h };
        this.camera.left = 0;
        this.camera.right = w;
        this.camera.top = 0;
        this.camera.bottom = -h;
        this.camera.updateProjectionMatrix();
    }

    /** HUD textures are authored for small screens; scale them with the window. */
    private get scale() {
        return Math.max(0.5, this.size.h / 1200);
    }

    /** DrawSelf: an icon with its top-left corner at (x, y) in screen pixels, y down. */
    private draw(icon: Icon, x: number, y: number, color: THREE.Color, alpha: number) {
        const m = this.sprites.get(icon);
        if (!m) return;
        const [, , w, h] = ICONS[icon];
        const s = this.scale;
        m.visible = alpha > 0;
        m.scale.set(w * s, h * s, 1);
        m.position.set(x + (w * s) / 2, -(y + (h * s) / 2), 0);
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.color.copy(color);
        mat.opacity = alpha / 255;
    }

    /** CHUDQuickInfo::Paint. */
    update(dt: number, st: CrosshairState) {
        for (const m of this.sprites.values()) m.visible = false;
        this.dot.visible = this.visible;
        const W = this.size.w, H = this.size.h, s = this.scale;
        this.dot.scale.set(Math.max(2, 3 * s), Math.max(2, 3 * s), 1);
        this.dot.position.set(W / 2, -H / 2, 0);
        if (!this.visible || !this.sheet || (!st.canFire[0] && !st.canFire[1])) return;

        const iconW = (i: Icon) => ICONS[i][2] * s, iconH = (i: Icon) => ICONS[i][3] * s;
        const xCenter = W / 2;
        const yCenter = (H - iconH('lb')) / 2;
        let color1 = PORTAL_COLORS[0].clone(), color2 = PORTAL_COLORS[1].clone();
        let alpha1 = 150, alpha2 = 150;
        let place = [...st.placeable];
        let last1 = 0, last2 = 0;

        if (st.canFire[0] && st.canFire[1]) {
            // The last placed portal's mark pulses up, then settles; the other fades out.
            const i = st.lastFired === 2 ? 1 : 0;
            if (this.countingUp[i]) {
                this.lastPlacedAlpha[i] += dt * LAST_PLACED_LERP_SPEED * 2;
                if (this.lastPlacedAlpha[i] > 255) {
                    this.countingUp[i] = false;
                    this.lastPlacedAlpha[i] = 255 - (this.lastPlacedAlpha[i] - 255);
                }
            } else {
                this.lastPlacedAlpha[i] = Math.max(LAST_PLACED_BASE_ALPHA, this.lastPlacedAlpha[i] - dt * LAST_PLACED_LERP_SPEED);
            }
            this.lastPlacedAlpha[1 - i] = Math.max(0, this.lastPlacedAlpha[1 - i] - dt * LAST_PLACED_LERP_SPEED);
            this.countingUp[1 - i] = true;
            if (st.lastFired) [last1, last2] = this.lastPlacedAlpha;
        } else if (!st.canFire[0]) {
            // Only one colour: both brackets show it.
            color1 = color2.clone();
            place = [place[1], place[1]];
        } else {
            color2 = color1.clone();
            place = [place[0], place[0]];
        }
        if (st.holding) {
            color1 = HOLD_COLOR.clone();
            color2 = HOLD_COLOR.clone();
            place = [false, false];
            alpha1 = alpha2 = 150;
        }

        this.draw(place[0] ? 'lb' : 'lbn', xCenter - iconW('lb') * 0.64, yCenter - iconH('rb') * 0.17, color1, alpha1);
        this.draw(place[1] ? 'rb' : 'rbn', xCenter + iconW('rb') * -0.35, yCenter + iconH('rb') * 0.17, color2, alpha2);
        this.draw('lbe', xCenter - iconW('lbe') * 1.85, yCenter, PORTAL_COLORS[0], last1);
        this.draw('rbe', xCenter + iconW('rbe') * 0.75, yCenter, PORTAL_COLORS[1], last2);
    }

    render(renderer: THREE.WebGLRenderer) {
        if (!this.visible) return;
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.render(this.scene, this.camera);
        renderer.autoClear = autoClear;
    }
}
