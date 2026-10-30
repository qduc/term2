import chalk from 'chalk';
import { getResumeCommand } from '../services/conversation/conversation-persistence.js';
import { profileIdFromLegacyMode } from '../services/profiles/legacy-adapter.js';
import { getProfileLabel } from '../services/profiles/labels.js';
function getActiveMode(activeProfileId, appMode) {
    return getProfileLabel(activeProfileId ?? profileIdFromLegacyMode(appMode));
}
export function formatResumeList(entries, options = {}) {
    if (entries.length === 0) {
        return 'No saved conversations found.';
    }
    const lines = [];
    lines.push(chalk.bold('Recent Conversations (last 10):'));
    lines.push('');
    entries.forEach((entry, index) => {
        const num = `${index + 1}.`;
        const reference = entry.shortRef ?? entry.id;
        const idStr = chalk.cyan.bold(reference === entry.id ? reference : `${reference} (${entry.id})`);
        let dateStr = entry.updatedAt;
        try {
            const d = new Date(entry.updatedAt);
            if (!isNaN(d.getTime())) {
                const pad = (n) => n.toString().padStart(2, '0');
                const year = d.getFullYear();
                const month = pad(d.getMonth() + 1);
                const date = pad(d.getDate());
                const hours = pad(d.getHours());
                const minutes = pad(d.getMinutes());
                const seconds = pad(d.getSeconds());
                dateStr = `${year}-${month}-${date} ${hours}:${minutes}:${seconds}`;
            }
        }
        catch {
            // fallback
        }
        const metaParts = [];
        metaParts.push(entry.sshHost ? `SSH: ${entry.sshHost}` : 'local');
        if (entry.messageCount !== undefined) {
            metaParts.push(`${entry.messageCount} message${entry.messageCount === 1 ? '' : 's'}`);
        }
        if (entry.model) {
            metaParts.push(`model: ${entry.model}`);
        }
        const activeMode = getActiveMode(entry.activeProfileId, entry.appMode);
        if (activeMode !== 'standard') {
            metaParts.push(`mode: ${activeMode}`);
        }
        const metaLine = `   Updated: ${chalk.yellow(dateStr)} (${chalk.dim(metaParts.join(', '))})`;
        lines.push(`${chalk.green(num)} ${idStr}`);
        lines.push(metaLine);
        if (entry.firstUserMessage) {
            const truncated = entry.firstUserMessage.length > 60 ? entry.firstUserMessage.slice(0, 57) + '...' : entry.firstUserMessage;
            lines.push(`   Prompt:  ${chalk.italic(`"${truncated.replace(/\n/g, ' ')}"`)}`);
        }
        const resumeCmd = options.resumeCommand?.(entry.id) ??
            getResumeCommand(entry.id, entry.sshHost, entry.sshHost ? entry.projectPath : undefined);
        lines.push(`   Resume:  ${chalk.bold(resumeCmd)}`);
        lines.push('');
    });
    return lines.join('\n').trim();
}
//# sourceMappingURL=resume-list.js.map