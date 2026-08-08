import type { ISSHService } from '../service-interfaces.js';
import type { SettingsService } from '../settings/settings-service.js';
import {
  executeFormattedShellCommand,
  serializeShellHistory,
  type ShellHistoryEntry,
} from '../../utils/shell/shell-session.js';

export interface SSHInfo {
  host: string;
  user: string;
  remoteDir: string;
}

export interface ShellInteractionSnapshot {
  isShellMode: boolean;
}

export interface ShellContextSink {
  addShellContext(historyText: string): void;
}

interface ShellInteractionSessionOptions {
  settingsService: Pick<SettingsService, 'get'>;
  conversationSink: ShellContextSink;
  liteMode: boolean;
  sshInfo?: SSHInfo;
  sshService?: ISSHService;
}

export interface ShellSubmission {
  command: string;
  completion: Promise<ShellHistoryEntry>;
}

/**
 * Owns the direct-shell lifecycle independently of any terminal renderer.
 * The interactive surface translates accepted commands into composer and
 * message updates, while this session preserves shell-mode eligibility and
 * the exact context that must be supplied to a later agent turn.
 */
export class ShellInteractionSession {
  readonly #settingsService: Pick<SettingsService, 'get'>;
  readonly #conversationSink: ShellContextSink;
  readonly #sshInfo?: SSHInfo;
  readonly #sshService?: ISSHService;
  readonly #listeners = new Set<() => void>();
  #liteMode: boolean;
  #history: ShellHistoryEntry[] = [];
  #snapshot: ShellInteractionSnapshot = { isShellMode: false };

  constructor(options: ShellInteractionSessionOptions) {
    this.#settingsService = options.settingsService;
    this.#conversationSink = options.conversationSink;
    this.#liteMode = options.liteMode;
    this.#sshInfo = options.sshInfo;
    this.#sshService = options.sshService;
  }

  getSnapshot = (): ShellInteractionSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setLiteMode(liteMode: boolean): void {
    this.#liteMode = liteMode;
    if (!liteMode && this.#snapshot.isShellMode) {
      this.#setShellMode(false);
      this.flushShellHistory();
    }
  }

  toggleShellMode(): void {
    if (!this.#liteMode) {
      return;
    }

    const nextIsShellMode = !this.#snapshot.isShellMode;
    this.#setShellMode(nextIsShellMode);
    if (!nextIsShellMode) {
      this.flushShellHistory();
    }
  }

  submit(value: string): ShellSubmission | null {
    if (!this.#liteMode || !this.#snapshot.isShellMode) {
      return null;
    }

    const command = value.trim();
    if (!command) {
      return null;
    }

    return { command, completion: this.#execute(command) };
  }

  async #execute(command: string): Promise<ShellHistoryEntry> {
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

  flushShellHistory(): void {
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

  #setShellMode(isShellMode: boolean): void {
    if (this.#snapshot.isShellMode === isShellMode) {
      return;
    }
    this.#snapshot = { isShellMode };
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
