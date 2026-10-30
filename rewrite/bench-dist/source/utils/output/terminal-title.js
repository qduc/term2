import path from 'path';
import { writeOscSequence } from './tty-osc.js';
const DEFAULT_TERMINAL_TITLE = 'term2';
const RUNNING_TITLE_PREFIX = '[...]';
function escapeOscValue(value) {
    return value.replace(/\x1b/g, '').replace(/\x07/g, '');
}
export function buildProjectFolderTitle(cwd, fallback = DEFAULT_TERMINAL_TITLE) {
    const folderName = path.basename(cwd);
    const sanitized = escapeOscValue(folderName).trim();
    if (!sanitized || sanitized === '.' || sanitized === path.sep) {
        return fallback;
    }
    return sanitized || fallback;
}
export function buildTerminalTitleLabel(baseTitle, isRunning) {
    const sanitized = escapeOscValue(baseTitle).trim() || DEFAULT_TERMINAL_TITLE;
    return isRunning ? `${RUNNING_TITLE_PREFIX} ${sanitized}` : sanitized;
}
export function buildTerminalTitleSequence(title) {
    return `\x1b]0;${escapeOscValue(title)}\x07`;
}
export function setTerminalTitle(title, opts = {}) {
    writeOscSequence(buildTerminalTitleSequence(title), opts);
}
//# sourceMappingURL=terminal-title.js.map