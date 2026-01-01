import {EventEmitter} from 'events';

export type CompanionMode = 'watch' | 'auto';

export interface ModeManagerEvents {
    modeChange: (mode: CompanionMode, previousMode: CompanionMode) => void;
}

/**
 * Mode manager for companion mode.
 * Handles transitions between Watch and Auto modes.
 */
export class ModeManager extends EventEmitter {
    #currentMode: CompanionMode = 'watch';

    /**
     * Get the current mode.
     */
    get mode(): CompanionMode {
        return this.#currentMode;
    }

    /**
     * Check if in watch mode.
     */
    get isWatchMode(): boolean {
        return this.#currentMode === 'watch';
    }

    /**
     * Check if in auto mode.
     */
    get isAutoMode(): boolean {
        return this.#currentMode === 'auto';
    }

    /**
     * Set the mode.
     */
    setMode(mode: CompanionMode): void {
        if (mode === this.#currentMode) {
            return;
        }

        const previousMode = this.#currentMode;
        this.#currentMode = mode;
        this.emit('modeChange', mode, previousMode);
    }

    /**
     * Enter watch mode.
     */
    enterWatchMode(): void {
        this.setMode('watch');
    }

    /**
     * Enter auto mode.
     */
    enterAutoMode(): void {
        this.setMode('auto');
    }

    /**
     * Reset to default mode (watch).
     */
    reset(): void {
        this.#currentMode = 'watch';
    }
}
