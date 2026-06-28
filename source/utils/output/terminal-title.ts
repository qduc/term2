import path from 'path';
import { writeOscSequence, type WriteOscOptions } from './tty-osc.js';

const DEFAULT_TERMINAL_TITLE = 'term2';
const RUNNING_TITLE_PREFIX = '[...]';

function escapeOscValue(value: string): string {
  return value.replace(/\x1b/g, '').replace(/\x07/g, '');
}

export function buildProjectFolderTitle(cwd: string, fallback = DEFAULT_TERMINAL_TITLE): string {
  const folderName = path.basename(cwd);
  const sanitized = escapeOscValue(folderName).trim();
  if (!sanitized || sanitized === '.' || sanitized === path.sep) {
    return fallback;
  }
  return sanitized || fallback;
}

export function buildTerminalTitleLabel(baseTitle: string, isRunning: boolean): string {
  const sanitized = escapeOscValue(baseTitle).trim() || DEFAULT_TERMINAL_TITLE;
  return isRunning ? `${RUNNING_TITLE_PREFIX} ${sanitized}` : sanitized;
}

export function buildTerminalTitleSequence(title: string): string {
  return `\x1b]0;${escapeOscValue(title)}\x07`;
}

export function setTerminalTitle(title: string, opts: WriteOscOptions = {}): void {
  writeOscSequence(buildTerminalTitleSequence(title), opts);
}
