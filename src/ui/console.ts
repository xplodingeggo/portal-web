// Developer console in the style of Source's: a translucent panel over the top of the screen with
// scrollback, a command line (history, Tab completion) and cvars. ` or P opens it; ` or Esc closes it.
// While it is open it swallows keyboard input so the game doesn't see it.
export type Print = (msg: string, cls?: 'echo' | 'warn' | 'error' | 'dim') => void;

interface Command {
    name: string;
    help: string;
    cheat: boolean;
    run: (args: string[], print: Print) => void;
    /** Candidates for the argument being typed (`word`, lowercase) after the earlier `prior` arguments. */
    complete?: (word: string, prior: string[]) => string[];
}

interface Cvar {
    name: string;
    help: string;
    cheat: boolean;
    def: string;
    get: () => string;
    set: (v: string) => void;
}

const MAX_HINTS = 100;

const STYLE = `
#devconsole { position: fixed; left: 0; right: 0; top: 0; height: 55vh; z-index: 1000; display: none; flex-direction: column;
    background: rgba(24, 28, 22, 0.88); border-bottom: 2px solid rgba(255, 190, 60, 0.55);
    font: 13px/1.35 Consolas, ui-monospace, monospace; color: #e6e6dc; }
#devconsole.open { display: flex; }
#devconsole .title { padding: 3px 10px; background: rgba(0, 0, 0, 0.45); color: #ffb83c; font-size: 12px; letter-spacing: 0.04em; }
#devconsole .log { flex: 1; overflow-y: auto; padding: 6px 10px; white-space: pre-wrap; word-break: break-word; user-select: text; }
#devconsole .log div.echo { color: #ffd890; }
#devconsole .log div.warn { color: #ffe066; }
#devconsole .log div.error { color: #ff7a6a; }
#devconsole .log div.dim { color: #9a9a90; }
#devconsole .row { display: flex; gap: 6px; padding: 6px 10px; background: rgba(0, 0, 0, 0.4); position: relative; }
#devconsole input { flex: 1; background: rgba(0, 0, 0, 0.55); color: #fff; border: 1px solid rgba(255, 190, 60, 0.4);
    padding: 4px 6px; font: inherit; outline: none; }
#devconsole button { background: rgba(80, 90, 70, 0.8); color: #eee; border: 1px solid rgba(255, 255, 255, 0.25);
    padding: 0 14px; font: inherit; cursor: pointer; }
#devconsole .hints { position: absolute; left: 10px; right: 90px; bottom: 100%; background: rgba(0, 0, 0, 0.88);
    border: 1px solid rgba(255, 190, 60, 0.4); max-height: 40vh; overflow-y: auto; display: none; }
#devconsole .hints div { padding: 1px 8px; white-space: pre; }
#devconsole .hints div.sel { background: rgba(255, 190, 60, 0.3); }
`;

/** Splits a line on `;` outside quotes. */
function splitStatements(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (const ch of line) {
        if (ch === '"') quoted = !quoted;
        if (ch === ';' && !quoted) {
            out.push(cur);
            cur = '';
        } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
}

/** Splits a statement into arguments; double quotes group words. */
function tokenize(stmt: string): string[] {
    return [...stmt.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

export class DevConsole {
    readonly root: HTMLDivElement;
    private log: HTMLDivElement;
    private input: HTMLInputElement;
    private hints: HTMLDivElement;
    private commands = new Map<string, Command>();
    private cvars = new Map<string, Cvar>();
    private history: string[] = [];
    private historyPos = 0;
    private matches: string[] = [];
    private matchSel = -1;
    /** Text before the word being completed, what follows a completed word, and whether Tab has listed them. */
    private base = '';
    private trail = '';
    private listed = false;
    private lines = 0;
    /** Fired when it opens or closes (the game releases the mouse and drops held keys). */
    onToggle: (open: boolean) => void = () => {};
    /** sv_cheats: cheat commands and cvars refuse to run while it is 0. */
    cheats = false;

    constructor(parent: HTMLElement = document.body) {
        const style = document.createElement('style');
        style.textContent = STYLE;
        document.head.appendChild(style);

        this.root = document.createElement('div');
        this.root.id = 'devconsole';
        this.root.innerHTML =
            '<div class="title">Console</div><div class="log"></div>' +
            '<div class="row"><div class="hints"></div><input type="text" spellcheck="false" autocomplete="off" />' +
            '<button type="button">Submit</button></div>';
        parent.appendChild(this.root);
        this.log = this.root.querySelector('.log')!;
        this.input = this.root.querySelector('input')!;
        this.hints = this.root.querySelector('.hints')!;
        this.root.querySelector('button')!.addEventListener('click', () => {
            this.submit();
            this.input.focus();
        });
        this.input.addEventListener('input', () => this.updateHints());
        this.input.addEventListener('keydown', (e) => this.onInputKey(e));
        this.input.addEventListener('blur', () => this.hideHints());

        // Capture phase: runs before the game's own window listeners, which it starves while open.
        window.addEventListener('keydown', (e) => this.onKey(e), true);
        window.addEventListener('keyup', (e) => this.isOpen && e.stopImmediatePropagation(), true);
        window.addEventListener('mousedown', (e) => this.isOpen && !this.root.contains(e.target as Node) && e.stopImmediatePropagation(), true);
        window.addEventListener('click', (e) => this.isOpen && !this.root.contains(e.target as Node) && e.stopImmediatePropagation(), true);

        this.registerBuiltins();
    }

    get isOpen() {
        return this.root.classList.contains('open');
    }

    open() {
        if (this.isOpen) return;
        this.root.classList.add('open');
        this.onToggle(true);
        this.input.value = '';
        // Focus after the keydown that opened it, or its character would be typed into the line.
        setTimeout(() => this.input.focus(), 0);
        this.scrollEnd();
    }

    close() {
        if (!this.isOpen) return;
        this.root.classList.remove('open');
        this.hideHints();
        this.input.blur();
        this.onToggle(false);
    }

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    private onKey(e: KeyboardEvent) {
        if (e.code === 'Backquote') {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (!e.repeat) this.toggle();
            return;
        }
        if (!this.isOpen) {
            // P opens it; typing a P into the open line must still work, so it can't close it.
            if (e.code === 'KeyP' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                e.stopImmediatePropagation();
                this.open();
            }
            return;
        }
        // The input's own listener needs the key (Enter, Tab, arrows): it stops it from reaching the game.
        if (e.target !== this.input) e.stopImmediatePropagation();
        if (e.code === 'Escape') {
            e.preventDefault();
            this.close();
        } else if (e.code === 'PageUp') {
            this.log.scrollTop -= this.log.clientHeight * 0.8;
        } else if (e.code === 'PageDown') {
            this.log.scrollTop += this.log.clientHeight * 0.8;
        }
    }

    private onInputKey(e: KeyboardEvent) {
        e.stopPropagation();
        if (e.code === 'Enter' || e.code === 'NumpadEnter') {
            e.preventDefault();
            this.submit();
        } else if (e.code === 'ArrowUp') {
            e.preventDefault();
            if (this.matches.length && this.hints.style.display === 'block') this.moveSel(-1);
            else this.recall(-1);
        } else if (e.code === 'ArrowDown') {
            e.preventDefault();
            if (this.matches.length && this.hints.style.display === 'block') this.moveSel(1);
            else this.recall(1);
        } else if (e.code === 'Tab') {
            e.preventDefault();
            this.complete(e.shiftKey ? -1 : 1);
        }
    }

    private recall(dir: number) {
        if (!this.history.length) return;
        this.historyPos = Math.max(0, Math.min(this.history.length, this.historyPos + dir));
        this.input.value = this.history[this.historyPos] ?? '';
        this.hideHints();
    }

    private submit() {
        const line = this.input.value.trim();
        this.input.value = '';
        this.hideHints();
        if (!line) return;
        if (this.history[this.history.length - 1] !== line) this.history.push(line);
        this.historyPos = this.history.length;
        this.print(`] ${line}`, 'echo');
        this.exec(line);
    }

    // --- Completion -----------------------------------------------------------------------------

    private names(): string[] {
        return [...this.commands.keys(), ...this.cvars.keys()].sort();
    }

    private candidates(): { base: string; trail: string; list: string[] } | null {
        const raw = this.input.value.replace(/^\s+/, '');
        if (!raw) return null;
        const sp = raw.search(/\s/);
        if (sp < 0) {
            const w = raw.toLowerCase();
            return { base: '', trail: ' ', list: this.names().filter((n) => n.startsWith(w)) };
        }
        const cmd = this.commands.get(raw.slice(0, sp).toLowerCase());
        if (!cmd?.complete) return null;
        const rest = raw.slice(sp);
        const cut = rest.search(/\S*$/);
        return { base: raw.slice(0, sp + cut), trail: '', list: cmd.complete(rest.slice(cut).toLowerCase(), tokenize(rest.slice(0, cut))) };
    }

    private updateHints() {
        const c = this.candidates();
        this.matches = c?.list ?? [];
        this.base = c?.base ?? '';
        this.trail = c?.trail ?? '';
        this.matchSel = -1;
        this.listed = false;
        if (!this.matches.length) return this.hideHints();
        this.renderHints();
    }

    private renderHints() {
        const shown = this.matches.slice(0, MAX_HINTS);
        const rows = shown.map((n, i) => {
            const d = document.createElement('div');
            const cv = this.base === '' ? this.cvars.get(n) : undefined;
            d.textContent = cv ? `${n} ${cv.get()}` : n;
            if (i === this.matchSel) d.className = 'sel';
            return d;
        });
        if (this.matches.length > shown.length) {
            const more = document.createElement('div');
            more.textContent = `... ${this.matches.length - shown.length} more, keep typing to narrow`;
            rows.push(more);
        }
        this.hints.replaceChildren(...rows);
        this.hints.style.display = 'block';
        (this.hints.children[this.matchSel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    }

    private hideHints() {
        this.hints.style.display = 'none';
        this.matches = [];
        this.matchSel = -1;
    }

    private moveSel(dir: number) {
        const n = Math.min(this.matches.length, MAX_HINTS);
        this.matchSel = this.matchSel < 0 ? (dir > 0 ? 0 : n - 1) : (this.matchSel + dir + n) % n;
        this.input.value = this.base + this.matches[this.matchSel] + this.trail;
        this.renderHints();
    }

    private complete(dir: number) {
        if (this.hints.style.display !== 'block') this.updateHints();
        if (!this.matches.length) return;
        if (this.matches.length === 1) {
            this.input.value = this.base + this.matches[0] + this.trail;
            this.hideHints();
            return;
        }
        if (this.matchSel < 0 && !this.listed) {
            // First Tab: extend to the common prefix and list the candidates.
            let prefix = this.matches[0];
            for (const m of this.matches) while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
            const word = this.input.value.slice(this.base.length);
            if (prefix.length > word.length && prefix.startsWith(word.toLowerCase())) this.input.value = this.base + prefix;
            this.listed = true;
            if (this.matches.length <= 40) this.print(this.matches.join('  '), 'dim');
            return;
        }
        this.moveSel(dir);
    }

    // --- Output ---------------------------------------------------------------------------------

    print: Print = (msg, cls) => {
        for (const line of String(msg).split('\n')) {
            const d = document.createElement('div');
            if (cls) d.className = cls;
            d.textContent = line || ' ';
            this.log.appendChild(d);
            if (++this.lines > 1000) {
                this.log.firstChild?.remove();
                this.lines--;
            }
        }
        this.scrollEnd();
    };

    clear() {
        this.log.replaceChildren();
        this.lines = 0;
    }

    private scrollEnd() {
        this.log.scrollTop = this.log.scrollHeight;
    }

    // --- Commands and cvars ----------------------------------------------------------------------

    addCommand(name: string, help: string, run: Command['run'], cheat = false, complete?: Command['complete']) {
        this.commands.set(name.toLowerCase(), { name: name.toLowerCase(), help, run, cheat, complete });
    }

    /** A variable: `name` prints it, `name value` sets it. */
    addCvar(name: string, def: string, help: string, get: () => string, set: (v: string) => void, cheat = false) {
        const n = name.toLowerCase();
        this.cvars.set(n, { name: n, help, cheat, def, get, set });
        set(def);
    }

    /** Runs one or more `;`-separated commands. */
    exec(line: string) {
        for (const stmt of splitStatements(line)) {
            const [name, ...args] = tokenize(stmt);
            if (!name) continue;
            const key = name.toLowerCase();
            const cmd = this.commands.get(key);
            if (cmd) {
                if (cmd.cheat && !this.cheats) {
                    this.print(`Can't use cheat command ${cmd.name} in multiplayer, unless the server has sv_cheats set to 1.`, 'warn');
                    continue;
                }
                try {
                    cmd.run(args, this.print);
                } catch (err) {
                    this.print(`${cmd.name}: ${(err as Error).message}`, 'error');
                }
                continue;
            }
            const cv = this.cvars.get(key);
            if (cv) {
                if (!args.length) {
                    this.print(`"${cv.name}" = "${cv.get()}"${cv.get() === cv.def ? '' : ` ( def. "${cv.def}" )`}${cv.cheat ? ' cheat' : ''}`);
                    if (cv.help) this.print(` - ${cv.help}`, 'dim');
                } else if (cv.cheat && !this.cheats) {
                    this.print(`Can't use cheat cvar ${cv.name} in multiplayer, unless the server has sv_cheats set to 1.`, 'warn');
                } else {
                    cv.set(args.join(' '));
                }
                continue;
            }
            this.print(`Unknown command: ${name}`, 'warn');
        }
    }

    private registerBuiltins() {
        this.addCommand('help', 'Find help about a convar/concommand.', (a, p) => {
            if (!a.length) {
                p('To get help on a command or cvar, type: help <name>');
                p('Type cmdlist or cvarlist to list them all, find <text> to search. ` or P opens the console, ` or Esc closes it.');
                return;
            }
            const n = a[0].toLowerCase();
            const c = this.commands.get(n);
            const v = this.cvars.get(n);
            if (c) p(`${c.name}${c.cheat ? ' (cheat)' : ''}\n - ${c.help}`);
            else if (v) p(`"${v.name}" = "${v.get()}" ( def. "${v.def}" )${v.cheat ? ' cheat' : ''}\n - ${v.help}`);
            else p(`help: no cvar or command named ${a[0]}`, 'warn');
        });
        this.addCommand('clear', 'Clear all console output.', () => this.clear());
        this.addCommand('echo', 'Echo text to console.', (a, p) => p(a.join(' ')));
        this.addCommand('cmdlist', 'Show the list of commands.', (a, p) => {
            const f = (a[0] ?? '').toLowerCase();
            const list = [...this.commands.values()].filter((c) => c.name.includes(f)).sort((x, y) => x.name.localeCompare(y.name));
            p('--------------');
            for (const c of list) p(`${c.name.padEnd(24)}${c.cheat ? 'cheat ' : '      '}- ${c.help}`);
            p('--------------');
            p(`${list.length} commands`);
        });
        this.addCommand('cvarlist', 'Show the list of convars.', (a, p) => {
            const f = (a[0] ?? '').toLowerCase();
            const list = [...this.cvars.values()].filter((c) => c.name.includes(f)).sort((x, y) => x.name.localeCompare(y.name));
            p('--------------');
            for (const c of list) p(`${c.name.padEnd(24)}: ${c.get().padEnd(10)}${c.cheat ? 'cheat ' : '      '}- ${c.help}`);
            p('--------------');
            p(`${list.length} convars`);
        });
        this.addCommand('find', 'Find concommands with the specified string in their name/help text.', (a, p) => {
            const f = a.join(' ').toLowerCase();
            if (!f) return p('Usage:  find <string>');
            const hits = [...this.commands.values(), ...this.cvars.values()]
                .filter((c) => c.name.includes(f) || c.help.toLowerCase().includes(f))
                .sort((x, y) => x.name.localeCompare(y.name));
            for (const c of hits) p(`${c.name.padEnd(24)}- ${c.help}`);
            if (!hits.length) p(`No matches for "${a.join(' ')}"`);
        });
        this.addCommand('toggleconsole', 'Show/hide the console.', () => this.close());
        this.addCommand('hideconsole', 'Hide the console.', () => this.close());
        this.addCommand('showconsole', 'Show the console.', () => this.open());
        this.addCvar('sv_cheats', '0', 'Allow cheats on server', () => (this.cheats ? '1' : '0'), (v) => (this.cheats = Number(v) !== 0));
    }
}
