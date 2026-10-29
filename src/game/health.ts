// The player's health. Portal has no health bar: a red flash shows a hit, health creeps back when
// nothing has hurt the player for a few seconds, and at zero the level starts over.

export class PlayerHealth {
    readonly max = 100;
    health = 100;
    dead = false;
    /** Seconds since the last hit; health regenerates once this passes `regenDelay`. */
    sinceHit = 99;
    private regenDelay = 5;
    private regenRate = 10;
    private regenCarry = 0;
    /** Noclip and the like: damage is ignored. */
    invulnerable: () => boolean = () => false;
    onHurt?: (amount: number) => void;
    onDeath?: () => void;

    hurt(amount: number) {
        if (this.dead || this.invulnerable()) return;
        if (amount < 0) return this.heal(-amount);
        this.health = Math.max(0, this.health - amount);
        this.sinceHit = 0;
        this.onHurt?.(amount);
        if (this.health <= 0) {
            this.dead = true;
            this.onDeath?.();
        }
    }

    heal(amount: number) {
        if (!this.dead) this.health = Math.min(this.max, this.health + amount);
    }

    reset() {
        this.health = this.max;
        this.dead = false;
        this.sinceHit = 99;
    }

    update(dt: number) {
        if (this.dead) return;
        this.sinceHit += dt;
        if (this.sinceHit < this.regenDelay || this.health >= this.max) return;
        this.regenCarry += this.regenRate * dt;
        const whole = Math.floor(this.regenCarry);
        if (whole > 0) {
            this.regenCarry -= whole;
            this.heal(whole);
        }
    }
}

/** Screen effects for health: a red wash that follows recent damage, and the death screen. */
export class HealthOverlay {
    private flash = document.createElement('div');
    private deathEl = document.createElement('div');
    private pulse = 0;

    constructor(parent: HTMLElement) {
        Object.assign(this.flash.style, {
            position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '4', opacity: '0',
            background: 'radial-gradient(ellipse at center, rgba(160,0,0,.15) 30%, rgba(190,0,0,.75) 100%)',
        });
        Object.assign(this.deathEl.style, {
            position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '6', opacity: '0', transition: 'opacity 1.2s',
            background: 'rgb(30,0,0)', color: '#e8b0b0', display: 'flex', alignItems: 'center', justifyContent: 'center',
            font: '20px ui-monospace, Consolas, monospace',
        });
        this.deathEl.textContent = 'You died';
        parent.append(this.flash, this.deathEl);
    }

    hit(amount: number) {
        this.pulse = Math.min(1, this.pulse + 0.25 + amount / 40);
    }

    /** `health` 0-1 of max: low health keeps a faint red edge on. */
    update(dt: number, health: number) {
        this.pulse = Math.max(0, this.pulse - dt * 1.2);
        const low = health < 0.4 ? (0.4 - health) / 0.4 * 0.5 : 0;
        this.flash.style.opacity = String(Math.min(1, Math.max(this.pulse, low)));
    }

    death(on: boolean) {
        this.deathEl.style.opacity = on ? '1' : '0';
        if (!on) this.pulse = 0;
    }
}
