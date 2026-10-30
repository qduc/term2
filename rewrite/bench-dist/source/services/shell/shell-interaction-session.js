import { executeFormattedShellCommand, serializeShellHistory, } from '../../utils/shell/shell-session.js';
/**
 * Owns the direct-shell lifecycle independently of any terminal renderer.
 * The interactive surface translates accepted commands into composer and
 * message updates, while this session preserves the exact context that must
 * be supplied to a later agent turn.
 */
export class ShellInteractionSession {
    #settingsService;
    #conversationSink;
    #sshInfo;
    #sshService;
    #listeners = new Set();
    #history = [];
    #pendingExecutions = 0;
    #flushRequested = false;
    #snapshot = { isShellMode: false };
    constructor(options) {
        this.#settingsService = options.settingsService;
        this.#conversationSink = options.conversationSink;
        this.#sshInfo = options.sshInfo;
        this.#sshService = options.sshService;
    }
    getSnapshot = () => this.#snapshot;
    subscribe = (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };
    enterShellMode() {
        this.#setShellMode(true);
    }
    exitShellMode() {
        this.#setShellMode(false);
        this.flushShellHistory();
    }
    submit(value) {
        if (!this.#snapshot.isShellMode) {
            return null;
        }
        const command = value.trim();
        if (!command) {
            return null;
        }
        return { command, completion: this.#execute(command) };
    }
    async #execute(command) {
        this.#pendingExecutions += 1;
        this.#snapshot = { ...this.#snapshot, activeCommand: command };
        this.#notify();
        try {
            const result = await executeFormattedShellCommand({
                command,
                settingsService: this.#settingsService,
                sshInfo: this.#sshInfo,
                sshService: this.#sshService,
            });
            const entry = {
                command,
                output: result.text,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
            };
            this.#history.push(entry);
            return entry;
        }
        finally {
            this.#pendingExecutions -= 1;
            this.#snapshot = {
                ...this.#snapshot,
                ...(this.#pendingExecutions === 0 ? { activeCommand: undefined } : {}),
            };
            this.#notify();
            if (this.#pendingExecutions === 0 && this.#flushRequested) {
                this.#flushRequested = false;
                this.#flushCompletedHistory();
            }
        }
    }
    flushShellHistory() {
        if (this.#pendingExecutions > 0) {
            this.#flushRequested = true;
            return;
        }
        this.#flushRequested = false;
        this.#flushCompletedHistory();
    }
    #flushCompletedHistory() {
        if (this.#history.length === 0) {
            return;
        }
        const historyText = serializeShellHistory(this.#history);
        if (!historyText) {
            return;
        }
        this.#conversationSink.addShellContext(historyText);
        this.#history = [];
    }
    #setShellMode(isShellMode) {
        if (this.#snapshot.isShellMode === isShellMode) {
            return;
        }
        this.#snapshot = { isShellMode };
        this.#notify();
    }
    #notify() {
        for (const listener of this.#listeners)
            listener();
    }
}
//# sourceMappingURL=shell-interaction-session.js.map