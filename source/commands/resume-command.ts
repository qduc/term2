import type { SlashCommand } from '../slash-commands.js';
import type { ConversationListEntry } from '../services/conversation/conversation-persistence.js';
import { RESUME_TRIGGER } from '../components/input/triggers.js';

interface CreateResumeSlashCommandDeps {
  listConversations: () => ConversationListEntry[];
  resumeConversation: (target?: string) => void | Promise<void>;
  addSystemMessage: (text: string) => void;
  replaceInput: (text: string) => void;
}

function parseTarget(args: string | undefined): { target?: string; list: boolean } | { error: string } {
  const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    return { error: 'Usage: /resume [ls | conversation-id]' };
  }

  const token = tokens[0];
  if (!token) return { list: true };
  const normalized = token.toLowerCase();
  if (normalized === 'ls' || normalized === 'list') return { list: true };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(token)) {
    return { error: 'Invalid conversation id. Usage: /resume [ls | conversation-id]' };
  }
  return { target: token, list: false };
}

export function createResumeSlashCommand({
  listConversations: _listConversations,
  resumeConversation,
  addSystemMessage,
  replaceInput,
}: CreateResumeSlashCommandDeps): SlashCommand {
  return {
    name: 'resume',
    description: 'Resume a saved conversation (browse with /resume)',
    expectsArgs: true,
    completion: { type: 'resume', trigger: RESUME_TRIGGER },
    action: (args?: string) => {
      const parsed = parseTarget(args);
      if ('error' in parsed) {
        addSystemMessage(parsed.error);
        return true;
      }

      if (parsed.list || !parsed.target) {
        replaceInput(RESUME_TRIGGER);
        return false;
      }

      void Promise.resolve(resumeConversation(parsed.target)).catch((error: unknown) => {
        addSystemMessage(`Failed to resume conversation: ${error instanceof Error ? error.message : String(error)}`);
      });
      return true;
    },
  };
}
