/**
 * Command names, descriptions and picker triggers shared by the slash menu,
 * typed command resolution and /help. Actions run through the session.
 */
import type { SlashCommand, SlashCommandCompletion } from './slash-command-types.js';

type Entry = Readonly<Pick<SlashCommand, 'name' | 'description' | 'expectsArgs' | 'alias'>> & {
  readonly completion?: SlashCommandCompletion;
  readonly opens?: 'providers';
};

export const COMMAND_SECTIONS: readonly (readonly [string, readonly Entry[]])[] = [
  [
    'Setup',
    [
      {
        name: 'model',
        description: 'Choose a model (Ctrl+O)',
        expectsArgs: true,
        completion: { type: 'model', trigger: '/model ' },
      },
      {
        name: 'effort',
        description: 'Set reasoning effort (Ctrl+T)',
        expectsArgs: true,
        completion: { type: 'setting-value', trigger: '/effort ', settingKey: 'agent.reasoningEffort' },
      },
      { name: 'providers', description: 'Manage model providers and accounts', opens: 'providers' },
      {
        name: 'settings',
        description: 'Browse, search, or edit settings',
        expectsArgs: true,
        completion: { type: 'settings', trigger: '/settings ', resetTrigger: '/settings reset ' },
      },
      {
        name: 'auto-approve',
        description: 'Choose when tools need approval',
        expectsArgs: true,
        completion: { type: 'setting-value', trigger: '/auto-approve ', settingKey: 'shell.autoApproveMode' },
      },
      {
        name: 'skills',
        description: 'Use a skill for the next request',
        expectsArgs: true,
        completion: { type: 'skills', trigger: '/skills ' },
      },
    ],
  ],
  [
    'Conversation',
    [
      { name: 'clear', description: 'Start a new conversation' },
      {
        name: 'resume',
        description: 'Browse or resume saved conversations',
        expectsArgs: true,
        completion: { type: 'resume', trigger: '/resume ' },
      },
      { name: 'goal', description: 'View or update the session goal (kept by /clear)', expectsArgs: true },
      { name: 'copy', description: 'Copy the latest response (use /copy N for an earlier one)' },
      { name: 'usage', description: 'Show token usage for this session' },
      { name: 'compact', description: 'Summarize older conversation turns' },
    ],
  ],
  [
    'Rewind & Retry',
    [
      { name: 'rewind', description: 'Rewind to a user turn and restore its prompt', expectsArgs: true },
      { name: 'undo', description: 'Alias for /rewind', expectsArgs: true, alias: true },
      { name: 'retry', description: 'Resend the last user turn or choose one', expectsArgs: true },
      { name: 'retry-turn', description: 'Regenerate the latest turn from its original prompt' },
      { name: 'retry-tool', description: 'Retry the last tool call' },
      { name: 'handoff', description: 'Send the last response to another model for review' },
    ],
  ],
  [
    'Application',
    [
      { name: 'help', description: 'Show commands and keyboard shortcuts' },
      { name: 'bridge', description: 'Connect or disconnect this session from the Discord bridge' },
      { name: 'restart', description: 'Reload Term2 (use /restart stop to stop background work)' },
      { name: 'quit', description: 'Exit Term2' },
    ],
  ],
];

export const LEGACY_COMMANDS = COMMAND_SECTIONS.flatMap(([section, commands]) =>
  commands.map((entry) => ({ ...entry, section })),
);

/** `run(text)` executes `/name [args]` through the session; picker commands without arguments keep their trigger. */
export function legacySlashCommands(
  run: (text: string) => void,
  open: (frame: 'providers') => boolean = () => false,
): SlashCommand[] {
  return LEGACY_COMMANDS.map(({ opens, ...entry }) => ({
    ...entry,
    action: (args?: string) => {
      // Legacy's /providers ignores arguments and opens the manager (use-app-commands openProvidersMenu).
      if (opens && open(opens)) return true;
      // The slash menu already wrote `/<name> ` into the editor; keeping it open lets its trigger open the picker.
      if (!args && entry.completion) return false;
      run(`/${entry.name}${args ? ` ${args}` : ''}`);
      return true;
    },
  }));
}
