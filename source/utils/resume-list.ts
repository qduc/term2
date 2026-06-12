import chalk from 'chalk';
import { getResumeCommand } from '../services/conversation/conversation-persistence.js';

import type { SavedAppMode } from '../services/conversation/conversation-persistence-types.js';

interface ConversationListEntry {
  id: string;
  updatedAt: string;
  projectPath?: string;
  sshHost?: string;
  firstUserMessage?: string;
  appMode?: SavedAppMode;
  model?: string;
  provider?: string;
  messageCount?: number;
}

function getActiveMode(appMode?: SavedAppMode): string {
  if (!appMode) return 'standard';
  if (appMode.orchestratorMode) return 'orchestrator';
  if (appMode.liteMode) return 'lite';
  if (appMode.planMode) return 'plan';
  if (appMode.mentorMode) return 'mentor';
  return 'standard';
}

export function formatResumeList(entries: ConversationListEntry[]): string {
  if (entries.length === 0) {
    return 'No saved conversations found.';
  }

  const lines: string[] = [];
  lines.push(chalk.bold('Recent Conversations (last 10):'));
  lines.push('');

  entries.forEach((entry, index) => {
    const num = `${index + 1}.`;
    const idStr = chalk.cyan.bold(entry.id);

    let dateStr = entry.updatedAt;
    try {
      const d = new Date(entry.updatedAt);
      if (!isNaN(d.getTime())) {
        const pad = (n: number) => n.toString().padStart(2, '0');
        const year = d.getFullYear();
        const month = pad(d.getMonth() + 1);
        const date = pad(d.getDate());
        const hours = pad(d.getHours());
        const minutes = pad(d.getMinutes());
        const seconds = pad(d.getSeconds());
        dateStr = `${year}-${month}-${date} ${hours}:${minutes}:${seconds}`;
      }
    } catch {
      // fallback
    }

    const metaParts: string[] = [];
    metaParts.push(entry.sshHost ? `SSH: ${entry.sshHost}` : 'local');
    if (entry.messageCount !== undefined) {
      metaParts.push(`${entry.messageCount} message${entry.messageCount === 1 ? '' : 's'}`);
    }
    if (entry.model) {
      metaParts.push(`model: ${entry.model}`);
    }
    const activeMode = getActiveMode(entry.appMode);
    if (activeMode !== 'standard') {
      metaParts.push(`mode: ${activeMode}`);
    }
    const metaLine = `   Updated: ${chalk.yellow(dateStr)} (${chalk.dim(metaParts.join(', '))})`;
    lines.push(`${chalk.green(num)} ${idStr}`);
    lines.push(metaLine);

    if (entry.firstUserMessage) {
      const truncated =
        entry.firstUserMessage.length > 60 ? entry.firstUserMessage.slice(0, 57) + '...' : entry.firstUserMessage;
      lines.push(`   Prompt:  ${chalk.italic(`"${truncated.replace(/\n/g, ' ')}"`)}`);
    }

    const resumeCmd = getResumeCommand(entry.id, entry.sshHost, entry.sshHost ? entry.projectPath : undefined);
    lines.push(`   Resume:  ${chalk.bold(resumeCmd)}`);
    lines.push('');
  });

  return lines.join('\n').trim();
}
