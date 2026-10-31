import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';

/** Direct TUI history is separate from the live CLI's history and conversations. */
const historyFile = () => path.join(envPaths('term2').data, 'tui-history-next.json');

/** Read the direct history without replacing malformed or inaccessible data. */
export function readHistory(): string[] {
  let text: string;
  try { text = readFileSync(historyFile(), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Invalid direct TUI history; original file preserved.');
  return value as string[];
}

/** Atomically replace the separate direct history after re-reading the existing file. */
export function appendHistory(text: string): void {
  const entries = readHistory();
  if (entries.at(-1) === text) return;
  entries.push(text);
  const file = historyFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
