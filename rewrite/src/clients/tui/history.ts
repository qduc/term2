import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import type { WireContent } from '../../protocol/direct-wire.js';

export type HistoryEntry = { readonly text: string; readonly attachments: readonly WireContent[] };
/** Direct TUI history is separate from the live CLI's history and conversations. */
const historyFile = () => path.join(envPaths('term2').data, 'tui-history-next.json');

function validContent(value: unknown): value is WireContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  return part.type === 'text'
    ? typeof part.text === 'string'
    : part.type === 'image' &&
        typeof part.mediaType === 'string' &&
        typeof part.data === 'string' &&
        (part.detail === undefined || typeof part.detail === 'string');
}

/** Validate the whole file before retaining newest whole entries; corruption must never be hidden by the cap. */
export function readHistory(limit: number): HistoryEntry[] {
  let text: string;
  try {
    text = readFileSync(historyFile(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error('Invalid direct TUI history; original file preserved.');
  return value
    .map((entry: unknown) => {
      if (typeof entry === 'string') return { text: entry, attachments: [] };
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error('Invalid direct TUI history; original file preserved.');
      const item = entry as Record<string, unknown>;
      if (typeof item.text !== 'string' || !Array.isArray(item.attachments) || !item.attachments.every(validContent)) {
        throw new Error('Invalid direct TUI history; original file preserved.');
      }
      return { text: item.text, attachments: item.attachments as WireContent[] };
    })
    .slice(-limit);
}

/** Bound composer recall only, never conversation data; atomically save newest whole text/attachment entries. */
export function appendHistory(entry: HistoryEntry, limit: number): void {
  const entries = readHistory(limit);
  if (JSON.stringify(entries.at(-1)) !== JSON.stringify(entry)) entries.push(entry);
  const file = historyFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(entries.slice(-limit)), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Cleanup must not hide the original save failure; a renamed file has no temporary path.
    }
    throw error;
  }
}
