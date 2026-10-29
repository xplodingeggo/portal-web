// Start screen: pick where the game files come from. Returns once the player has chosen and the
// chosen source is ready to mount. A download started with "keep a copy" keeps running afterwards.
import type { ByteSource } from '../fs/source';
import {
    CachedSource,
    LocalSource,
    opfsSupported,
    rememberDirectory,
    rememberedDirectory,
    serverBackend,
    type ServerBackend,
} from '../fs/sources';

export interface ChosenSource {
    source: ByteSource;
    /** Lowercase paths of loose files, for GameFS.mount. */
    index: string[];
}

const CSS = `
#launcher { position: fixed; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center;
    background: #0b0b0e; color: #e8e8e8; font: 14px/1.5 ui-monospace, Consolas, monospace; }
#launcher .box { width: min(560px, 92vw); display: flex; flex-direction: column; gap: 10px; }
#launcher h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
#launcher button { text-align: left; padding: 10px 12px; background: #1a1a22; color: inherit; border: 1px solid #33333f;
    font: inherit; cursor: pointer; border-radius: 4px; }
#launcher button:hover:not(:disabled) { border-color: #6a8; }
#launcher button:disabled { opacity: .45; cursor: default; }
#launcher button small { display: block; color: #99a; }
#launcher label { color: #99a; display: flex; gap: 6px; align-items: center; }
#launcher progress { width: 100%; }
#launcher .msg { min-height: 1.5em; color: #fd8; white-space: pre-wrap; }
#launcher .err { color: #f8a; }
#dlcorner { position: fixed; right: 8px; bottom: 8px; font: 11px ui-monospace, Consolas, monospace; color: #9fd;
    text-shadow: 0 1px 2px #000; pointer-events: none; }
`;

const gb = (n: number) => (n / 1e9).toFixed(2);

type Pref = 'stream' | 'keep' | 'download' | 'local';
const PREF_KEY = 'portal-web.source';

function getPref(): Pref | null {
    try {
        const v = localStorage.getItem(PREF_KEY);
        return v === 'stream' || v === 'keep' || v === 'download' || v === 'local' ? v : null;
    } catch {
        return null;
    }
}

function setPref(p: Pref | null) {
    try {
        if (p) localStorage.setItem(PREF_KEY, p);
        else localStorage.removeItem(PREF_KEY);
    } catch { /* ignore */ }
}

/** Forget the remembered choice and reload so the start screen shows again (pause menu). */
export function changeSource() {
    setPref(null);
    const params = new URLSearchParams(location.search);
    params.set('launcher', '1');
    location.search = params.toString();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: object = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids);
    return e;
}

export async function chooseSource(): Promise<ChosenSource> {
    // vite dev server serves GAME_DIR directly; keep that loop quick unless ?launcher is given
    if (import.meta.env.DEV && !new URLSearchParams(location.search).has('launcher')) {
        const b = await serverBackend();
        return { source: b.source, index: b.index };
    }

    document.head.append(el('style', { textContent: CSS }));
    const root = el('div', { id: 'launcher' });
    document.body.append(root);

    return new Promise<ChosenSource>((resolve) => {
        const msg = el('div', { className: 'msg' });
        const bar = el('progress', { hidden: true, max: 1, value: 0 });
        const keepBox = el('input', { type: 'checkbox', checked: true });
        const canSave = opfsSupported();
        const buttons: HTMLButtonElement[] = [];
        const busy = (on: boolean) => buttons.forEach((b) => (b.disabled = on));
        const fail = (e: unknown) => {
            root.style.display = '';
            msg.className = 'msg err';
            msg.textContent = (e as Error).message;
            busy(false);
        };
        const done = (c: ChosenSource) => {
            root.remove();
            resolve(c);
        };
        const button = (title: string, sub: string, run: () => Promise<void>) => {
            const b = el('button', {}, title, el('small', {}, sub));
            b.onclick = async () => {
                msg.className = 'msg';
                msg.textContent = '';
                busy(true);
                try { await run(); } catch (e) { fail(e); }
            };
            buttons.push(b);
            return b;
        };

        let backend: ServerBackend | null = null;
        const server = async () => (backend ??= await serverBackend());

        const cornerProgress = (cached: CachedSource, b: ServerBackend) => {
            const corner = el('div', { id: 'dlcorner' });
            document.body.append(corner);
            cached
                .downloadAll(b.base, (s, t) => (corner.textContent = `saving game files to this browser: ${gb(s)} / ${gb(t)} GB`))
                .then(() => {
                    corner.textContent = 'game files saved to this browser';
                    setTimeout(() => corner.remove(), 4000);
                })
                .catch((e) => (corner.textContent = `save stopped: ${(e as Error).message}`));
        };

        const stream = button('Play now', 'streams game files from the server as you play', async () => {
            const b = await server();
            setPref(keepBox.checked && canSave && b.manifest.length ? 'keep' : 'stream');
            if (keepBox.checked && canSave && b.manifest.length) {
                const cached = new CachedSource(b.source, b.manifest);
                done({ source: cached, index: b.index });
                cornerProgress(cached, b);
            } else {
                done({ source: b.source, index: b.index });
            }
        });

        const download = button('Download, then play', canSave ? 'saves everything to this browser first, then loads fastest and works offline' : 'needs a browser with private file storage (Chrome, Edge, Firefox)', async () => {
            const b = await server();
            if (!canSave || !b.manifest.length) throw new Error('This browser cannot save files. Use "Play now" or import a folder.');
            setPref('download');
            const cached = new CachedSource(b.source, b.manifest);
            bar.hidden = false;
            await cached.downloadAll(b.base, (s, t) => {
                bar.value = s / t;
                msg.textContent = `${gb(s)} / ${gb(t)} GB`;
            });
            done({ source: cached, index: b.index });
        });
        if (!canSave) download.disabled = true;

        const finishLocal = async (local: LocalSource) => {
            setPref('local');
            done({ source: local, index: local.index });
        };

        const pick = button('Import my Portal folder', 'use your own install (the folder holding "portal" and "hl2"); nothing is uploaded', async () => {
            const picker = (window as any).showDirectoryPicker as undefined | ((o?: object) => Promise<FileSystemDirectoryHandle>);
            if (picker) {
                let handle: FileSystemDirectoryHandle;
                try {
                    handle = await picker({ id: 'portal-install', mode: 'read' });
                } catch (e) {
                    if ((e as Error).name === 'AbortError') return busy(false);
                    throw e;
                }
                msg.textContent = 'Reading folder…';
                const local = await LocalSource.fromDirectoryHandle(handle);
                await rememberDirectory(handle);
                return finishLocal(local);
            }
            // no File System Access API: classic folder input, remembered only for this page load
            const input = el('input', { type: 'file', multiple: true });
            input.setAttribute('webkitdirectory', '');
            const files = await new Promise<FileList | null>((res) => {
                input.onchange = () => res(input.files);
                input.oncancel = () => res(null);
                input.click();
            });
            if (!files?.length) return busy(false);
            return finishLocal(LocalSource.fromFileList(files));
        });

        const box = el('div', { className: 'box' }, el('h1', {}, 'Portal (browser port)'), stream);
        if (canSave) box.append(el('label', {}, keepBox, 'also keep a copy in this browser while playing'));
        box.append(download, pick);

        // a folder picked on an earlier visit: one click, no re-browsing
        rememberedDirectory().then((h) => {
            if (!h) return;
            const again = button(`Use ${h.name} again`, 'your imported folder from last time', async () => {
                if ((await (h as any).requestPermission({ mode: 'read' })) !== 'granted') throw new Error('Folder access was not granted.');
                msg.textContent = 'Reading folder…';
                return finishLocal(await LocalSource.fromDirectoryHandle(h));
            });
            box.insertBefore(again, pick.nextSibling);
        });

        box.append(bar, msg);
        root.append(box);

        // A remembered choice starts straight away (level changes reload the page): the start screen
        // only shows if that fails, or when asked for with ?launcher.
        const pref = getPref();
        if (pref && !new URLSearchParams(location.search).has('launcher')) {
            const reveal = () => (root.style.display = '');
            const attempt = async () => {
                if (pref === 'local') {
                    const h = await rememberedDirectory();
                    // Re-reading a folder needs permission, which is only granted from a click.
                    if (!h || (await (h as any).queryPermission({ mode: 'read' })) !== 'granted') return reveal();
                    msg.textContent = 'Reading folder…';
                    return finishLocal(await LocalSource.fromDirectoryHandle(h));
                }
                keepBox.checked = pref === 'keep';
                if (pref === 'download') {
                    reveal();
                    return download.click();
                }
                stream.click();
            };
            root.style.display = 'none';
            attempt().catch((e) => {
                reveal();
                fail(e);
            });
            // click() handlers report their own failures, so show the screen if nothing started
            setTimeout(() => root.isConnected && !buttons.every((b) => b.disabled) && reveal(), 0);
            setTimeout(() => root.isConnected && msg.classList.contains('err') && reveal(), 4000);
        }
    });
}
