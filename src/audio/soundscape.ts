// Ambient soundscapes (scripts/soundscapes_*.txt): looping beds and random one-shots, chosen by the
// env_soundscape the player is in. Positioned beds are played flat and random hits are put at a
// random spot near the player; DSP presets are not applied.
import type { GameFS } from '../fs/gamefs';
import { parseKeyValueNodes, type KVNode } from '../material/keyvalues';
import type { SoundHandle, SoundSystem } from './sound';

type Vec3 = [number, number, number];

const str = (nodes: KVNode[], key: string): string | undefined => nodes.find((n) => n.key === key && typeof n.value === 'string')?.value as string | undefined;
const range = (v: string | undefined, d: number): [number, number] => {
    const p = (v ?? '').split(',').map((x) => parseFloat(x));
    return Number.isFinite(p[0]) ? [p[0], Number.isFinite(p[1]) ? p[1] : p[0]] : [d, d];
};
const pick = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);

interface Timer {
    next: number;
    node: KVNode[];
}

export class Soundscapes {
    private scapes = new Map<string, KVNode[]>();
    private current: string | null = null;
    private loops: SoundHandle[] = [];
    private timers: Timer[] = [];
    private time = 0;
    private reports: { name: string; dist: number }[] = [];
    private listener: Vec3 = [0, 0, 0];

    constructor(private fs: GameFS, private sound: SoundSystem) {}

    async load() {
        const manifest = await this.fs.read('scripts/soundscapes_manifest.txt');
        if (!manifest) return;
        const files: string[] = [];
        for (const root of parseKeyValueNodes(new TextDecoder().decode(manifest))) {
            if (Array.isArray(root.value)) for (const n of root.value) if (n.key === 'file' && typeof n.value === 'string') files.push(n.value);
        }
        await Promise.all(files.map(async (f) => {
            const b = await this.fs.read(f);
            if (!b) return;
            for (const n of parseKeyValueNodes(new TextDecoder().decode(b))) if (Array.isArray(n.value)) this.scapes.set(n.key, n.value);
        }));
    }

    /** An env_soundscape the player is inside this frame; the nearest one wins. */
    report(name: string, dist: number) {
        this.reports.push({ name: name.toLowerCase(), dist });
    }

    update(dt: number, listener: Vec3) {
        this.listener = listener;
        const best = this.reports.sort((a, b) => a.dist - b.dist)[0];
        this.reports = [];
        if ((best?.name ?? null) !== this.current) this.set(best?.name ?? null);
        this.time += dt;
        for (const t of this.timers) {
            if (this.time < t.next) continue;
            this.playRandom(t.node);
            t.next = this.time + pick(range(str(t.node, 'time'), 5));
        }
    }

    private set(name: string | null) {
        for (const h of this.loops) h.stop(1);
        this.loops = [];
        this.timers = [];
        this.current = name;
        const nodes = name ? this.scapes.get(name) : undefined;
        if (nodes) this.start(nodes, 1);
    }

    private start(nodes: KVNode[], gain: number) {
        for (const n of nodes) {
            if (!Array.isArray(n.value)) continue;
            if (n.key === 'playlooping') {
                const wave = str(n.value, 'wave');
                if (!wave) continue;
                const h = this.sound.play(wave, { volume: pick(range(str(n.value, 'volume'), 1)) * gain, pitch: pick(range(str(n.value, 'pitch'), 100)), loop: true });
                if (h) this.loops.push(h);
            } else if (n.key === 'playrandom') {
                this.timers.push({ next: this.time + pick(range(str(n.value, 'time'), 5)), node: n.value });
            } else if (n.key === 'playsoundscape') {
                const sub = str(n.value, 'name');
                const nodesSub = sub && this.scapes.get(sub.toLowerCase());
                if (nodesSub) this.start(nodesSub, gain * pick(range(str(n.value, 'volume'), 1)));
            }
        }
    }

    private playRandom(node: KVNode[]) {
        const waves: string[] = [];
        for (const c of node) {
            if (c.key === 'wave' && typeof c.value === 'string') waves.push(c.value);
            if (c.key === 'rndwave' && Array.isArray(c.value)) for (const w of c.value) if (typeof w.value === 'string') waves.push(w.value);
        }
        if (!waves.length) return;
        const l = this.listener;
        const at: Vec3 = str(node, 'position') === 'random'
            ? [l[0] + (Math.random() - 0.5) * 600, l[1] + (Math.random() - 0.5) * 600, l[2] + (Math.random() - 0.5) * 200]
            : [...l];
        const spatial = str(node, 'position') === 'random';
        this.sound.play(waves[Math.floor(Math.random() * waves.length)], {
            volume: pick(range(str(node, 'volume'), 1)),
            pitch: pick(range(str(node, 'pitch'), 100)),
            position: spatial ? () => at : undefined,
            loop: false,
        });
    }
}
