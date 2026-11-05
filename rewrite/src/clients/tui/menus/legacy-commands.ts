/**
 * Legacy's slash command list (source/hooks/use-app-commands.ts and
 * rewrite/src/clients/commands/*), in its order and with its names, descriptions,
 * `expectsArgs` and menu completions. Commands dropped by owner scope (plan,
 * mentor, orchestrator, sandbox, mcp, mcp-login) are left out. Actions run the
 * typed command through the session, so behaviour stays with its native owner;
 * a no-argument command with a picker puts its trigger in the composer, as the
 * legacy action's `replaceInput('/<name> ')` did.
 */
import type { SlashCommand, SlashCommandCompletion } from './slash-command-types.js';

type Entry = {
  readonly name: string;
  readonly description: string;
  readonly expectsArgs?: boolean;
  readonly completion?: SlashCommandCompletion;
  /** Legacy runs another command's action (`/lite` toggles Bare). */
  readonly runs?: string;
  /** Legacy's action opens this explicitly opened frame instead of running a command. */
  readonly opens?: 'providers';
};

export const LEGACY_COMMANDS: readonly Entry[] = [
  {
    name: 'model',
    description: 'Choose or set the AI model (Ctrl+O; use /model <model-id>)',
    expectsArgs: true,
    completion: { type: 'model', trigger: '/model ' },
  },
  {
    name: 'effort',
    description: 'Choose the model reasoning effort (Ctrl+T)',
    expectsArgs: true,
    completion: { type: 'setting-value', trigger: '/effort ', settingKey: 'agent.reasoningEffort' },
  },
  { name: 'clear', description: 'Start a new conversation' },
  { name: 'goal', description: 'Inspect or update the durable session goal; /clear retains it', expectsArgs: true },
  { name: 'copy', description: 'Copy an assistant response (latest by default; use /copy N to count backward)' },
  { name: 'usage', description: 'Show token usage for the current session' },
  {
    name: 'resume',
    description: 'Browse saved conversations or resume one by ID',
    expectsArgs: true,
    completion: { type: 'resume', trigger: '/resume ' },
  },
  { name: 'rewind', description: 'Rewind to a user turn and put it back in the input box', expectsArgs: true },
  {
    name: 'undo',
    description: 'Choose a user turn to remove and return to the input (same options as /rewind)',
    expectsArgs: true,
  },
  { name: 'retry', description: 'Resend the last user turn, or choose a turn to resend', expectsArgs: true },
  { name: 'retry-tool', description: 'Retry the last tool call' },
  { name: 'retry-turn', description: 'Regenerate the latest user turn from its original prompt' },
  { name: 'compact', description: 'Compact older conversation turns into a local summary' },
  { name: 'bare', description: 'Toggle the Bare profile (minimal prompt)' },
  { name: 'lite', description: 'Toggle the Bare profile (Lite was merged into Bare)', runs: 'bare' },
  {
    name: 'auto-approve',
    description: 'Set tool auto-approval mode (off, advisory, auto, always)',
    expectsArgs: true,
    completion: { type: 'setting-value', trigger: '/auto-approve ', settingKey: 'shell.autoApproveMode' },
  },
  {
    name: 'profile',
    description: 'Switch the active profile',
    expectsArgs: true,
    completion: { type: 'profile', trigger: '/profile ' },
  },
  { name: 'handoff', description: 'Send the last assistant response to another model for review' },
  {
    name: 'settings',
    description: 'View or modify settings',
    expectsArgs: true,
    completion: { type: 'settings', trigger: '/settings ', resetTrigger: '/settings reset ' },
  },
  { name: 'bridge', description: 'Attach or detach this local session for Discord bridge input' },
  { name: 'providers', description: 'Manage API providers (list, add, edit, delete)', opens: 'providers' },
  {
    name: 'skills',
    description: 'Activate a skill for the next request',
    expectsArgs: true,
    completion: { type: 'skills', trigger: '/skills ' },
  },
  { name: 'restart', description: 'Reload the built CLI in place; /restart stop consents to stopping background work' },
  { name: 'quit', description: 'Exit the application' },
  { name: 'help', description: 'Show commands and keyboard shortcuts' },
];

/** `run(text)` executes `/name [args]` through the session; picker commands without arguments keep their trigger. */
export function legacySlashCommands(
  run: (text: string) => void,
  open: (frame: 'providers') => boolean = () => false,
): SlashCommand[] {
  return LEGACY_COMMANDS.map(({ runs, opens, ...entry }) => ({
    ...entry,
    action: (args?: string) => {
      // Legacy's /providers ignores arguments and opens the manager (use-app-commands openProvidersMenu).
      if (opens && open(opens)) return true;
      // The slash menu already wrote `/<name> ` into the editor; keeping it open lets its trigger open the picker.
      if (!args && entry.completion) return false;
      run(`/${runs ?? entry.name}${args ? ` ${args}` : ''}`);
      return true;
    },
  }));
}
