// env_fade's screen fade: a full-screen colour that holds, then fades (or fades in, then holds).
type Vec3 = [number, number, number];

export interface Fade {
    color: Vec3;
    alpha: number;
    duration: number;
    hold: number;
    /** FFADE_IN: starts covered and clears. Otherwise fades to the colour. */
    fadeFrom: boolean;
    stayOut: boolean;
}

export class FadeOverlay {
    private el = document.createElement('div');
    private fade: (Fade & { t: number }) | null = null;

    constructor(parent: HTMLElement) {
        Object.assign(this.el.style, { position: 'fixed', inset: '0', pointerEvents: 'none', opacity: '0', zIndex: '5' });
        parent.appendChild(this.el);
    }

    start(f: Fade) {
        this.fade = { ...f, t: 0 };
        this.apply();
    }

    update(dt: number) {
        if (!this.fade) return;
        this.fade.t += dt;
        this.apply();
    }

    private apply() {
        const f = this.fade;
        if (!f) return;
        let a: number;
        if (f.fadeFrom) {
            a = f.t < f.hold ? 1 : 1 - (f.t - f.hold) / Math.max(f.duration, 1e-4);
        } else {
            a = f.t < f.duration ? f.t / Math.max(f.duration, 1e-4) : f.t < f.duration + f.hold || f.stayOut ? 1 : 0;
        }
        a = Math.max(0, Math.min(1, a)) * f.alpha;
        this.el.style.background = `rgb(${f.color.join(',')})`;
        this.el.style.opacity = String(a);
        if (a <= 0 && !f.stayOut && f.t > f.hold + f.duration) this.fade = null;
    }
}

/**
 * The map's tonemap brightness scale (env_tonemap_controller's BlendTonemapScale). Source
 * blends in a linear space of HDR light that is then compressed; here the blend is geometric, so
 * a large boost (the intro's 128x) eases off the way eyes adjust rather than staying white.
 */
export class TonemapScale {
    private from = 1;
    private to = 1;
    private t = 0;
    private duration = 0;
    private scale = 1;

    blend(scale: number, duration: number) {
        this.from = this.scale;
        this.to = Math.max(scale, 1e-3);
        this.t = 0;
        this.duration = duration;
        if (duration <= 0) this.scale = this.to;
    }

    update(dt: number) {
        if (this.duration > 0 && this.t < this.duration) {
            this.t = Math.min(this.duration, this.t + dt);
            this.scale = this.from * Math.pow(this.to / this.from, this.t / this.duration);
        }
        return this.scale;
    }
}
