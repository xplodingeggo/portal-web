// Pause menu: resume, save manager, settings (key bindings, mouse, volume) and the debug readout.
import type { SaveGame } from '../game/savegame';
import { ACTIONS, binds, keyName } from './keybinds';

export interface PauseHooks {
    resume(): void;
    listSaves(): Promise<SaveGame[]>;
    save(name: string, overwriteId?: string): Promise<void>;
    load(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    debugText(): string;
    hudHidden(): boolean;
    toggleHud(): void;
    toggleFullscreen(): void;
    sensitivity: { get(): number; set(v: number): void };
    volume: { get(): number; set(v: number): void };
    changeSource(): void;
    levels(): { name: string; label: string }[];
    currentMap: string;
    loadLevel(name: string): void;
}

const CSS = `
#pausemenu { position: fixed; inset: 0; z-index: 8; display: none; align-items: center; justify-content: center;
    background: rgba(6, 6, 10, .78); color: #e8e8e8; font: 14px/1.5 ui-monospace, Consolas, monospace; }
#pausemenu.open { display: flex; }
#pausemenu .panel { width: min(640px, 94vw); max-height: 88vh; overflow: auto; display: flex; flex-direction: column; gap: 8px;
    background: #14141b; border: 1px solid #33333f; border-radius: 6px; padding: 16px; }
#pausemenu h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
#pausemenu h2 { margin: 8px 0 0; font-size: 13px; color: #99a; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
#pausemenu button { padding: 8px 12px; background: #1d1d27; color: inherit; border: 1px solid #33333f; font: inherit; cursor: pointer; border-radius: 4px; text-align: left; }
#pausemenu button:hover:not(:disabled) { border-color: #6a8; }
#pausemenu .gh { position: absolute; left: 16px; bottom: 16px; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;
    color: #99a; background: #14141b; border: 1px solid #33333f; border-radius: 50%; }
#pausemenu .gh:hover { color: #e8e8e8; border-color: #6a8; }
#pausemenu button:disabled { opacity: .45; cursor: default; }
#pausemenu .row { display: flex; gap: 8px; align-items: center; }
#pausemenu .row > .grow { flex: 1; min-width: 0; }
#pausemenu .small { color: #99a; font-size: 12px; }
#pausemenu input[type=text] { flex: 1; background: #0e0e14; color: inherit; border: 1px solid #33333f; padding: 6px 8px; font: inherit; border-radius: 4px; }
#pausemenu input[type=range] { flex: 1; }
#pausemenu .save { display: flex; gap: 10px; align-items: center; padding: 6px; border: 1px solid #26262f; border-radius: 4px; }
#pausemenu .save img, #pausemenu .save .noimg { width: 96px; height: 54px; object-fit: cover; background: #0b0b0e; border-radius: 3px; flex: none; }
#pausemenu .bind { display: grid; grid-template-columns: 1fr 120px 120px; gap: 6px; align-items: center; }
#pausemenu .bind button { text-align: center; }
#pausemenu .bind button.wait { border-color: #fd8; color: #fd8; }
#pausemenu pre { margin: 0; white-space: pre-wrap; font-size: 12px; color: #9fd; }
#pausemenu pre.miss { color: #f8a; }
#pausemenu .err { color: #f8a; }
body.hidetext .hud, body.hidetext #dlcorner { display: none; }
`;

type Page = 'main' | 'saves' | 'levels' | 'settings' | 'debug';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: object = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids);
    return e;
}

export class PauseMenu {
    private root = el('div', { id: 'pausemenu' });
    private page: Page = 'main';
    private timer = 0;
    private capturing: (() => void) | null = null;

    constructor(private hooks: PauseHooks) {
        document.head.append(el('style', { textContent: CSS }));
        document.body.append(this.root);
        // Capture phase so a key being rebound never reaches the game or the other handlers.
        window.addEventListener('keydown', (e) => {
            if (!this.isOpen) return;
            if (this.capturing) {
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
            if (e.code === 'Escape' && !e.repeat) {
                e.preventDefault();
                e.stopImmediatePropagation();
                if (this.page === 'main') hooks.resume();
                else this.show('main');
            }
        }, true);
    }

    get isOpen() {
        return this.root.classList.contains('open');
    }

    open(page: Page = 'main') {
        this.root.classList.add('open');
        this.show(page);
    }

    close() {
        this.root.classList.remove('open');
        clearInterval(this.timer);
        this.capturing = null;
    }

    private show(page: Page) {
        this.page = page;
        clearInterval(this.timer);
        const gh = el('a', { className: 'gh', href: 'https://github.com/xplodingeggo/portal-web', target: '_blank', rel: 'noopener', title: 'Source on GitHub' });
        gh.innerHTML = '<svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
        this.root.replaceChildren(el('div', { className: 'panel' }, ...this.render(page)), gh);
    }

    private back() {
        return el('button', { onclick: () => this.show('main') }, '← Back');
    }

    private render(page: Page): HTMLElement[] {
        const h = this.hooks;
        if (page === 'saves') return this.renderSaves();
        if (page === 'levels') return this.renderLevels();
        if (page === 'settings') return this.renderSettings();
        if (page === 'debug') return this.renderDebug();
        const btn = (label: string, on: () => void) => el('button', { onclick: on }, label);
        return [
            el('h1', {}, 'Paused'),
            btn('Resume', () => h.resume()),
            btn('Level select', () => this.show('levels')),
            btn('Save manager', () => this.show('saves')),
            btn('Settings and key bindings', () => this.show('settings')),
            btn('Debug info', () => this.show('debug')),
            btn('Fullscreen', () => h.toggleFullscreen()),
            btn('Change where game files come from', () => h.changeSource()),
            el('div', { className: 'small' }, `Quick save ${binds.codes('quicksave').map(keyName).join(' / ')} · quick load ${binds.codes('quickload').map(keyName).join(' / ')} · hide text ${binds.codes('hud').map(keyName).join(' / ')}`),
        ];
    }

    // ---- saves ----

    private renderSaves(): HTMLElement[] {
        const h = this.hooks;
        const list = el('div', { style: 'display:flex;flex-direction:column;gap:6px' });
        const msg = el('div', { className: 'small' });
        const name = el('input', { type: 'text', placeholder: 'Name for a new save', maxLength: 40 });
        const run = async (what: () => Promise<void>, ok: string) => {
            msg.className = 'small';
            msg.textContent = '…';
            try {
                await what();
                msg.textContent = ok;
                await refresh();
            } catch (e) {
                msg.className = 'err';
                msg.textContent = (e as Error).message;
            }
        };
        const refresh = async () => {
            const saves = await h.listSaves();
            list.replaceChildren(
                ...(saves.length ? saves.map((s) => this.saveRow(s, run)) : [el('div', { className: 'small' }, 'No saves yet.')]),
            );
        };
        void refresh();
        return [
            el('h1', {}, 'Save manager'),
            el('div', { className: 'row' }, name, el('button', { onclick: () => run(() => h.save(name.value.trim() || `Save ${new Date().toLocaleString()}`).then(() => { name.value = ''; }), 'Saved.') }, 'Save game')),
            msg,
            list,
            el('div', { className: 'small' }, 'Saves live in this browser. They keep map logic, cubes, doors, portals and your position; sounds and things mid-flight start over.'),
            this.back(),
        ];
    }

    private saveRow(s: SaveGame, run: (what: () => Promise<void>, ok: string) => Promise<void>) {
        const h = this.hooks;
        const thumb = s.thumb ? el('img', { src: s.thumb }) : el('div', { className: 'noimg' });
        return el('div', { className: 'save' },
            thumb,
            el('div', { className: 'grow', style: 'flex:1;min-width:0' },
                el('div', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, s.id === 'quick' ? `Quick save` : s.name),
                el('div', { className: 'small' }, `${s.map} · ${new Date(s.created).toLocaleString()}`),
            ),
            el('button', { onclick: () => run(() => h.load(s.id), 'Loading…') }, 'Load'),
            el('button', { onclick: () => run(() => h.save(s.name, s.id), 'Overwritten.') }, 'Overwrite'),
            el('button', { onclick: () => run(() => h.remove(s.id), 'Deleted.') }, 'Delete'),
        );
    }

    // ---- levels ----

    private renderLevels(): HTMLElement[] {
        const h = this.hooks;
        const rows = h.levels().map((l) =>
            el('button', { onclick: () => h.loadLevel(l.name), disabled: false },
                l.label, el('span', { className: 'small' }, `  ${l.name}${l.name === h.currentMap ? ' · current' : ''}`)),
        );
        return [
            el('h1', {}, 'Level select'),
            el('div', { className: 'small' }, 'Starts the level fresh, with no portal gun unless the level gives it to you. Unsaved progress is lost: save first.'),
            ...rows,
            this.back(),
        ];
    }

    // ---- settings ----

    private renderSettings(): HTMLElement[] {
        const h = this.hooks;
        const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
            const out = el('span', { className: 'small' }, fmt(get()));
            const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()) });
            input.oninput = () => {
                set(Number(input.value));
                out.textContent = fmt(Number(input.value));
            };
            return el('div', { className: 'row' }, el('span', { style: 'width:140px' }, label), input, out);
        };
        const rows = ACTIONS.map((a) => {
            const slots = [0, 1].map((slot) => {
                const b = el('button', {});
                const paint = () => (b.textContent = binds.codes(a.id)[slot] ? keyName(binds.codes(a.id)[slot]) : '—');
                paint();
                b.onclick = () => {
                    b.textContent = 'press a key…';
                    b.classList.add('wait');
                    const done = () => {
                        window.removeEventListener('keydown', onKey, true);
                        this.capturing = null;
                        b.classList.remove('wait');
                        this.show('settings');
                    };
                    const onKey = (e: KeyboardEvent) => {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        if (e.code === 'Escape') return done();
                        if (e.code === 'Backspace' || e.code === 'Delete') binds.clear(a.id, slot);
                        else binds.set(a.id, slot, e.code);
                        done();
                    };
                    this.capturing = done;
                    window.addEventListener('keydown', onKey, true);
                };
                return b;
            });
            return el('div', { className: 'bind' }, el('span', {}, a.label), ...slots);
        });
        return [
            el('h1', {}, 'Settings'),
            slider('Mouse sensitivity', 0.02, 0.4, 0.01, h.sensitivity.get, h.sensitivity.set, (v) => v.toFixed(2)),
            slider('Volume', 0, 1, 0.05, h.volume.get, h.volume.set, (v) => `${Math.round(v * 100)}%`),
            el('h2', {}, 'Key bindings'),
            el('div', { className: 'small' }, 'Click a key, then press the new one. Backspace clears it, Escape cancels. Escape always pauses.'),
            ...rows,
            el('button', { onclick: () => { binds.reset(); this.show('settings'); } }, 'Reset all to defaults'),
            this.back(),
        ];
    }

    // ---- debug ----

    private renderDebug(): HTMLElement[] {
        const h = this.hooks;
        const out = el('pre', {});
        const refresh = () => (out.textContent = h.debugText());
        refresh();
        this.timer = window.setInterval(refresh, 500);
        const toggle = el('button', {}, '');
        const paint = () => (toggle.textContent = h.hudHidden() ? 'Show debug text on screen' : 'Hide debug text on screen');
        paint();
        toggle.onclick = () => {
            h.toggleHud();
            paint();
        };
        return [el('h1', {}, 'Debug info'), toggle, out, this.back()];
    }
}
