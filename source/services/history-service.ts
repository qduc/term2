import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import envPaths from 'env-paths';
import { LoggingService } from './logging/logging-service.js';
import { SettingsService } from './settings/settings-service.js';
import { hasUserTurnContent, normalizeUserTurn, type UserTurn } from '../types/user-turn.js';

const paths = envPaths('term2');

interface HistoryData {
  messages: Array<string | UserTurn>;
}

const cloneUserTurn = (turn: UserTurn): UserTurn => ({
  text: turn.text,
  ...(turn.images?.length
    ? {
        images: turn.images.map((image) => ({ ...image })),
      }
    : {}),
});

const normalizeHistoryEntry = (entry: string | UserTurn): UserTurn => cloneUserTurn(normalizeUserTurn(entry));

const areImagesEqual = (a: UserTurn['images'], b: UserTurn['images']): boolean => {
  const left = a ?? [];
  const right = b ?? [];

  if (left.length !== right.length) return false;

  return left.every((image, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      image.id === other.id &&
      image.data === other.data &&
      image.mimeType === other.mimeType &&
      image.byteSize === other.byteSize &&
      image.displayNumber === other.displayNumber
    );
  });
};

const areTurnsEqual = (a: UserTurn, b: UserTurn): boolean => a.text === b.text && areImagesEqual(a.images, b.images);

/**
 * Service for managing user input history.
 * Saves messages to XDG state directory (~/.local/state/term2/history.json on Linux).
 */
export class HistoryService {
  private messages: UserTurn[] = [];
  private historyFile: string;
  private maxHistorySize: number;
  private loggingService: LoggingService;
  /** Set when the on-disk history failed to parse, so the first save
   *  quarantines the corrupt bytes before publishing a valid replacement. */
  private corruptFileDetected = false;

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
        const parsed = JSON.parse(data) as unknown;
        const rawMessages = Array.isArray(parsed)
          ? parsed
          : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { messages?: unknown }).messages)
          ? (parsed as { messages: Array<string | UserTurn> }).messages ?? []
          : [];
        this.messages = rawMessages
          .filter(
            (message): message is string | UserTurn =>
              typeof message === 'string' || (typeof message === 'object' && message !== null),
          )
          .map((message) => normalizeHistoryEntry(message));
      }
    } catch (error) {
      // If we can't load history, start with empty array but preserve the
      // corrupt bytes: the next save quarantines them instead of overwriting.
      this.loggingService.error('Failed to load history', {
        error: error instanceof Error ? error.message : String(error),
        filePath: this.historyFile,
      });
      this.messages = [];
      this.corruptFileDetected = true;
    }
  }

  /**
   * Move the corrupt history file aside so its bytes survive a valid
   * replacement write. Returns false (and leaves the file in place) if the
   * quarantine itself fails.
   */
  private quarantineCorruptHistory(): boolean {
    try {
      const quarantinePath = `${this.historyFile}.corrupt.${Date.now()}`;
      fs.renameSync(this.historyFile, quarantinePath);
      return true;
    } catch {
      return false;
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

      if (this.corruptFileDetected) {
        this.corruptFileDetected = false;
        if (!this.quarantineCorruptHistory()) {
          // Refuse to replace corrupt bytes we could not preserve.
          this.loggingService.error('Failed to save history', {
            error: 'Could not quarantine corrupt history file',
            filePath: this.historyFile,
            messageCount: this.messages.length,
          });
          return;
        }
      }

      const data: HistoryData = {
        messages: this.messages,
      };

      // Stage to a same-directory temporary file and atomically rename, so an
      // interrupted or failing write never truncates the prior durable file.
      const tempPath = path.join(dir, `.${path.basename(this.historyFile)}.${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tempPath, this.historyFile);
      } finally {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Rename succeeded or there is no temp file to clean up.
        }
      }
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
  addMessage(message: string | UserTurn): void {
    const normalized = normalizeHistoryEntry(message);

    // Don't add empty or duplicate messages
    if (!hasUserTurnContent(normalized)) {
      return;
    }

    // Remove duplicates (if the same message is already the most recent)
    if (this.messages.length > 0 && areTurnsEqual(this.messages[this.messages.length - 1], normalized)) {
      return;
    }

    this.messages.push(normalized);

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
    return this.messages.map((message) => message.text);
  }

  /**
   * Get all saved turns, including image attachments.
   */
  getTurns(): UserTurn[] {
    return this.messages.map(cloneUserTurn);
  }

  /**
   * Clear all history
   */
  clear(): void {
    this.messages = [];
    this.save();
  }
}
