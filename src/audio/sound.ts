// Game sounds: Source soundscripts (scripts/game_sounds_manifest.txt) resolved to WAVs from the
// game files and played with Web Audio. Positioned sounds fall off with distance by their
// soundlevel the way the engine does (snd_refdist 36 at snd_refdb 60) and pan with the listener.
import type { GameFS } from '../fs/gamefs';
import { parseKeyValueNodes, type KVNode } from '../material/keyvalues';

type Vec3 = [number, number, number];

/** A soundscript entry. */
export interface SoundScript {
    waves: string[];
    volume: [number, number];
    pitch: [number, number];
    soundlevel: number;
}

export interface PlayOptions {
    /** Where the sound is, followed every frame; omitted for sounds heard at full volume everywhere. */
    position?: () => Vec3;
    /** 0-1, multiplied with the script's volume. */
    volume?: number;
    /** Percent, replacing the script's pitch. */
    pitch?: number;
    /** Loop between the WAV's cue point and its end; on by default for WAVs that have one. */
    loop?: boolean;
    /** Overrides falloff: silent beyond this many units (ambient_generic's radius). */
    radius?: number;
    soundlevel?: number;
}

export interface SoundHandle {
    stop(fade?: number): void;
    setVolume(v: number, fade?: number): void;
    setPitch(percent: number): void;
    readonly playing: boolean;
}

/** Leading characters on wave names that only steer Source's mixer. */
const SOUND_CHARS = /^[*#@><^)}$!?&~`+(%]+/;
const SNDLVL_NAMES: Record<string, number> = {
    sndlvl_none: 0, sndlvl_idle: 60, sndlvl_talking: 60, sndlvl_static: 66, sndlvl_norm: 75, sndlvl_gunfire: 140,
};
const SND_REFDIST = 36;
const SND_REFDB = 60;

function parseRange(v: string | undefined, fallback: number, named: Record<string, number> = {}): [number, number] {
    if (!v) return [fallback, fallback];
    const parts = v.split(',').map((s) => {
        const t = s.trim().toLowerCase();
        return t in named ? named[t] : Number(t);
    });
    const lo = Number.isFinite(parts[0]) ? parts[0] : fallback;
    const hi = Number.isFinite(parts[1]) ? parts[1] : lo;
    return [lo, hi];
}

function parseSoundlevel(v: string | undefined): number {
    if (!v) return 75;
    const t = v.trim().toLowerCase();
    if (t in SNDLVL_NAMES) return SNDLVL_NAMES[t];
    const m = /(\d+)/.exec(t);
    return m ? Number(m[1]) : 75;
}

/** Engine falloff: gain at `dist` for a soundlevel (SNDLVL_TO_DIST_MULT, SND_GetGainFromMult). */
export function soundlevelGain(soundlevel: number, dist: number): number {
    if (soundlevel <= 0) return 1;
    const mult = Math.pow(10, SND_REFDB / 20) / Math.pow(10, soundlevel / 20) / SND_REFDIST;
    const rel = dist * mult;
    return Math.min(1, rel > 0.1 ? 1 / rel : 10);
}

/** The loop start in samples from a WAV's 'cue ' chunk, or null if it has none. */
function wavLoopStart(bytes: Uint8Array): number | null {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let o = 12; o + 8 <= bytes.length; ) {
        const id = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
        const size = v.getUint32(o + 4, true);
        // cue chunk: count, then 24-byte points whose sample offset is the last field.
        if (id === 'cue ' && size >= 28 && v.getUint32(o + 8, true) > 0) return v.getUint32(o + 8 + 4 + 20, true);
        o += 8 + size + (size & 1);
    }
    return null;
}

/** A sound requested before audio was unlocked: forwards to the real one if it gets started. */
class DeferredHandle implements SoundHandle {
    inner: SoundHandle | null = null;
    stopped = false;
    get playing() {
        return !this.stopped;
    }
    stop(fade?: number) {
        this.stopped = true;
        this.inner?.stop(fade);
    }
    setVolume(v: number, fade?: number) {
        this.inner?.setVolume(v, fade);
    }
    setPitch(percent: number) {
        this.inner?.setPitch(percent);
    }
}

export class SoundSystem {
    readonly scripts = new Map<string, SoundScript>();
    readonly missing = new Set<string>();
    private ctx: AudioContext | null = null;
    private master: GainNode | null = null;
    private buffers = new Map<string, Promise<{ buffer: AudioBuffer; loopStart: number | null } | null>>();
    private active = new Set<{ update(): void }>();
    private listener = { position: [0, 0, 0] as Vec3, forward: [1, 0, 0] as Vec3, up: [0, 0, 1] as Vec3 };
    volume = 0.7;

    constructor(private fs: GameFS) {}

    /** Reads the manifest and every soundscript it lists. */
    async load() {
        const manifest = await this.fs.read('scripts/game_sounds_manifest.txt');
        if (!manifest) return;
        const files: string[] = [];
        for (const root of parseKeyValueNodes(new TextDecoder().decode(manifest))) {
            if (Array.isArray(root.value)) for (const n of root.value) if (/^precache_file$|^preload_file$/.test(n.key) && typeof n.value === 'string') files.push(n.value);
        }
        await Promise.all(files.map(async (f) => {
            const b = await this.fs.read(f);
            if (b) this.addScripts(parseKeyValueNodes(new TextDecoder().decode(b)));
        }));
    }

    private addScripts(nodes: KVNode[]) {
        for (const n of nodes) {
            if (!Array.isArray(n.value)) continue;
            const get = (k: string) => n.value instanceof Array ? n.value.find((c) => c.key === k && typeof c.value === 'string')?.value as string | undefined : undefined;
            const waves: string[] = [];
            for (const c of n.value) {
                if (c.key === 'wave' && typeof c.value === 'string') waves.push(c.value);
                if (c.key === 'rndwave' && Array.isArray(c.value)) for (const w of c.value) if (typeof w.value === 'string') waves.push(w.value);
            }
            if (!waves.length) continue;
            this.scripts.set(n.key, {
                waves,
                volume: parseRange(get('volume'), 1, { vol_norm: 1 }),
                pitch: parseRange(get('pitch'), 100, { pitch_norm: 100, pitch_low: 95, pitch_high: 120 }),
                soundlevel: parseSoundlevel(get('soundlevel') ?? get('attenuation')),
            });
        }
    }

    /** Sounds asked for before audio was allowed; looping ones start once it is. */
    private pending: { name: string; opts: PlayOptions; handle: DeferredHandle }[] = [];

    /** Browsers only allow audio after a user gesture: call from one (the click that locks the pointer). */
    unlock() {
        if (!this.ctx) {
            this.ctx = new AudioContext();
            this.master = this.ctx.createGain();
            this.master.gain.value = this.volume;
            this.master.connect(this.ctx.destination);
            // Ambient loops the map started while audio was locked: one-shots from back then are stale.
            for (const p of this.pending.splice(0)) {
                if (p.handle.stopped || p.opts.loop === false) continue;
                const script = this.scripts.get(p.name.toLowerCase());
                const wave = script ? script.waves[0] : p.name;
                void this.loadWave(wave).then((w) => {
                    if (!p.handle.stopped && (p.opts.loop || (w && w.loopStart !== null))) p.handle.inner = this.play(p.name, p.opts);
                });
            }
        }
        if (!this.paused) void this.ctx.resume();
    }

    private paused = false;

    /** The pause menu: silences everything without losing where loops and one-shots are. */
    setPaused(paused: boolean) {
        this.paused = paused;
        if (this.ctx) void (paused ? this.ctx.suspend() : this.ctx.resume());
    }

    setListener(position: Vec3, forward: Vec3, up: Vec3) {
        this.listener = { position, forward, up };
        for (const s of this.active) s.update();
    }

    private loadWave(path: string) {
        const p = `sound/${path.replace(SOUND_CHARS, '').replace(/\\/g, '/')}`.toLowerCase();
        let entry = this.buffers.get(p);
        if (!entry) {
            entry = (async () => {
                const bytes = await this.fs.read(p);
                if (!bytes || !this.ctx) {
                    this.missing.add(p);
                    return null;
                }
                try {
                    const loopStart = p.endsWith('.wav') ? wavLoopStart(bytes) : null;
                    const buffer = await this.ctx.decodeAudioData(bytes.slice().buffer);
                    return { buffer, loopStart };
                } catch {
                    this.missing.add(`${p} (undecodable)`);
                    return null;
                }
            })();
            this.buffers.set(p, entry);
        }
        return entry;
    }

    /** Plays a soundscript entry by name, or a WAV path ("weapons/x.wav"). */
    play(name: string, opts: PlayOptions = {}): SoundHandle | null {
        if (!name || name.startsWith('!')) return null;
        if (!this.ctx || !this.master) {
            const handle = new DeferredHandle();
            this.pending.push({ name, opts, handle });
            return handle;
        }
        const script = this.scripts.get(name.toLowerCase());
        const wave = script ? script.waves[Math.floor(Math.random() * script.waves.length)] : name;
        if (!script && !/\.(wav|mp3)$/i.test(wave)) {
            this.missing.add(`soundscript ${name}`);
            return null;
        }
        const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);
        const baseVolume = (script ? rand(script.volume) : 1) * (opts.volume ?? 1);
        const soundlevel = opts.soundlevel ?? script?.soundlevel ?? 75;
        const ctx = this.ctx;
        const gain = ctx.createGain();
        const pan = ctx.createStereoPanner();
        gain.connect(pan).connect(this.master);
        let source: AudioBufferSourceNode | null = null;
        let stopped = false;
        let volume = baseVolume;
        let pitch = opts.pitch ?? (script ? rand(script.pitch) : 100);

        const spatial = () => {
            const pos = opts.position?.();
            if (!pos) return { gain: 1, pan: 0 };
            const l = this.listener;
            const d: Vec3 = [pos[0] - l.position[0], pos[1] - l.position[1], pos[2] - l.position[2]];
            const dist = Math.hypot(d[0], d[1], d[2]);
            const g = opts.radius ? Math.max(0, 1 - dist / opts.radius) : soundlevelGain(soundlevel, dist);
            // Pan by how far to the right it is (right = forward x up).
            const f = l.forward, u = l.up;
            const right: Vec3 = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
            const side = dist > 1 ? (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) / dist : 0;
            return { gain: g, pan: side * 0.8 };
        };
        const handle = {
            update: () => {
                const s = spatial();
                gain.gain.setTargetAtTime(volume * s.gain, ctx.currentTime, 0.02);
                pan.pan.setTargetAtTime(s.pan, ctx.currentTime, 0.02);
            },
        };
        const s0 = spatial();
        gain.gain.value = volume * s0.gain;
        pan.pan.value = s0.pan;
        this.active.add(handle);

        void this.loadWave(wave).then((w) => {
            if (!w || stopped) {
                this.active.delete(handle);
                return;
            }
            source = ctx.createBufferSource();
            source.buffer = w.buffer;
            source.playbackRate.value = pitch / 100;
            const loop = opts.loop ?? w.loopStart !== null;
            if (loop) {
                source.loop = true;
                source.loopStart = (w.loopStart ?? 0) / w.buffer.sampleRate;
                source.loopEnd = w.buffer.duration;
            }
            source.connect(gain);
            source.onended = () => this.active.delete(handle);
            source.start();
        });

        return {
            get playing() {
                return !stopped;
            },
            stop: (fade = 0) => {
                if (stopped) return;
                stopped = true;
                const end = ctx.currentTime + fade;
                gain.gain.setTargetAtTime(0, ctx.currentTime, Math.max(0.005, fade / 4));
                source?.stop(end + 0.05);
                this.active.delete(handle);
            },
            setVolume: (v: number, fade = 0) => {
                volume = baseVolume * v;
                const s = spatial();
                gain.gain.setTargetAtTime(volume * s.gain, ctx.currentTime, Math.max(0.005, fade / 4));
            },
            setPitch: (percent: number) => {
                pitch = percent;
                if (source) source.playbackRate.setTargetAtTime(percent / 100, ctx.currentTime, 0.02);
            },
        };
    }
}
