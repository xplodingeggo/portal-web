// Rebindable keys. Each action has up to two key codes (KeyboardEvent.code); the player's choices
// live in localStorage. Escape always opens the pause menu and can't be rebound.

export interface ActionInfo {
    id: string;
    label: string;
    defaults: string[];
}

export const ACTIONS: ActionInfo[] = [
    { id: 'forward', label: 'Move forward', defaults: ['KeyW'] },
    { id: 'back', label: 'Move back', defaults: ['KeyS'] },
    { id: 'left', label: 'Move left', defaults: ['KeyA'] },
    { id: 'right', label: 'Move right', defaults: ['KeyD'] },
    { id: 'jump', label: 'Jump', defaults: ['Space'] },
    { id: 'duck', label: 'Crouch', defaults: ['ControlLeft', 'KeyC'] },
    { id: 'use', label: 'Use / carry', defaults: ['KeyE'] },
    { id: 'gun', label: 'Portal gun (debug)', defaults: ['KeyG'] },
    { id: 'noclip', label: 'Noclip (debug)', defaults: ['KeyV'] },
    { id: 'quicksave', label: 'Quick save', defaults: ['Semicolon'] },
    { id: 'quickload', label: 'Quick load', defaults: ['Quote'] },
    { id: 'hud', label: 'Hide / show on-screen text', defaults: ['F3', 'Digit0'] },
    { id: 'fullscreen', label: 'Fullscreen', defaults: ['F11'] },
    { id: 'pause', label: 'Pause', defaults: ['Pause'] },
    { id: 'exposureDown', label: 'Exposure down', defaults: ['BracketLeft'] },
    { id: 'exposureUp', label: 'Exposure up', defaults: ['BracketRight'] },
];

const KEY = 'portal-web.binds';

let custom: Record<string, string[]> = {};
try {
    custom = JSON.parse(localStorage.getItem(KEY) ?? '{}');
} catch { /* private window: defaults only */ }

export const binds = {
    codes(action: string): string[] {
        return custom[action] ?? ACTIONS.find((a) => a.id === action)?.defaults ?? [];
    },

    matches(action: string, code: string): boolean {
        return this.codes(action).includes(code);
    },

    /** Sets one slot (0 or 1) of an action. A key can only drive one action, so it's taken from any other. */
    set(action: string, slot: number, code: string) {
        for (const a of ACTIONS) {
            const cur = this.codes(a.id);
            if (a.id !== action && cur.includes(code)) this.write(a.id, cur.filter((c) => c !== code));
        }
        const cur = [...this.codes(action)];
        cur[slot] = code;
        this.write(action, cur.filter(Boolean));
    },

    clear(action: string, slot: number) {
        const cur = [...this.codes(action)];
        cur.splice(slot, 1);
        this.write(action, cur);
    },

    reset() {
        custom = {};
        this.persist();
    },

    write(action: string, codes: string[]) {
        custom[action] = codes;
        this.persist();
    },

    persist() {
        try { localStorage.setItem(KEY, JSON.stringify(custom)); } catch { /* ignore */ }
    },
};

/** "KeyW" -> "W", "Semicolon" -> ";" and so on, for showing in menus. */
export function keyName(code: string): string {
    const special: Record<string, string> = {
        Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']',
        Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
        ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', AltLeft: 'Left Alt', AltRight: 'Right Alt',
    };
    if (special[code]) return special[code];
    return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '');
}
