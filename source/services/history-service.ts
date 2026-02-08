import fs from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import { LoggingService } from './logging-service.js';
import { SettingsService } from './settings-service.js';

const paths = envPaths('term2');

interface HistoryData {
  messages: string[];
}

/**
 * Service for managing user input history.
 * Saves messages to XDG state directory (~/.local/state/term2/history.json on Linux).
 */
export class HistoryService {
  private messages: string[] = [];
  private historyFile: string;
  private maxHistorySize: number;
  private loggingService: LoggingService;

  constructor(deps: { loggingService: LoggingService; settingsService: SettingsService; historyFile?: string }) {
    this.loggingService = deps.loggingService;
    this.historyFile = deps.historyFile || path.join(paths.log, 'history.json');
    this.maxHistorySize = deps.settingsService.get('ui.historySize');
    this.load();
  }

  /**
   * Load history from disk
   */
  private load(): void {
    try {
      if (fs.existsSync(this.historyFile)) {
        const data = fs.readFileSync(this.historyFile, 'utf-8');
        const parsed = JSON.parse(data) as HistoryData;
        this.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      }
    } catch (error) {
      // If we can't load history, start with empty array
      this.loggingService.error('Failed to load history', {
        error: error instanceof Error ? error.message : String(error),
        filePath: this.historyFile,
      });
      this.messages = [];
    }
  }

  /**
   * Save history to disk
   */
  private save(): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: HistoryData = {
        messages: this.messages,
      };

      fs.writeFileSync(this.historyFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.loggingService.error('Failed to save history', {
        error: error instanceof Error ? error.message : String(error),
        filePath: this.historyFile,
        messageCount: this.messages.length,
      });
    }
  }

  /**
   * Add a message to history
   */
  addMessage(message: string): void {
    // Don't add empty or duplicate messages
    if (!message.trim()) {
      return;
    }

    // Remove duplicates (if the same message is already the most recent)
    if (this.messages.length > 0 && this.messages[this.messages.length - 1] === message) {
      return;
    }

    this.messages.push(message);

    // Trim history if it exceeds max size
    if (this.messages.length > this.maxHistorySize) {
      this.messages = this.messages.slice(-this.maxHistorySize);
    }

    this.save();
  }

  /**
   * Get all messages
   */
  getMessages(): string[] {
    return [...this.messages];
  }

  /**
   * Clear all history
   */
  clear(): void {
    this.messages = [];
    this.save();
  }
}

/**
 * @deprecated DO NOT USE - Singleton pattern is deprecated
 *
 * This singleton is deprecated and should not be used in application code.
 * Instead, pass the HistoryService instance via dependency injection:
 *
 * - In App component: Accept as prop from cli.tsx
 * - In services/tools: Accept via constructor deps parameter
 * - In hooks: Accept as parameter or use a context provider
 *
 * This export now throws an error when accessed to catch deprecated usage.
 * It's only allowed in test files for backwards compatibility.
 */
const _historyServiceInstance = new HistoryService({
  loggingService: new LoggingService({ disableLogging: false }),
  settingsService: new (class MockSettingsService {
    get() {
      return 1000;
    } // Default history size
  })() as any,
});

const isTestEnvironment = () => {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST !== undefined ||
    process.env.AVA_PATH !== undefined ||
    process.env.JEST_WORKER_ID !== undefined ||
    process.env.TERM2_TEST_MODE === 'true'
  );
};

export const historyService = new Proxy(_historyServiceInstance, {
  get(target, prop) {
    // Allow access in test environment for backwards compatibility
    if (isTestEnvironment()) {
      const value = target[prop as keyof typeof target];
      // Bind methods to the original target to preserve 'this' context
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    }

    // Get the caller's stack trace to show where the deprecated usage is
    const stack = new Error().stack || '';
    const callerLine = stack.split('\n')[2] || 'unknown location';

    throw new Error(
      `DEPRECATED: Direct use of historyService singleton is not allowed.\n` +
        `Called from: ${callerLine.trim()}\n\n` +
        `Instead, pass HistoryService via dependency injection:\n` +
        `  - In App component: Accept as prop from cli.tsx\n` +
        `  - In services/tools: Accept via 'deps' constructor parameter\n` +
        `  - In hooks: Accept as parameter or use a context provider\n\n` +
        `The singleton pattern prevents proper testing and makes dependencies unclear.`,
    );
  },
});
