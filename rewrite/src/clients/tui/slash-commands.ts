/** Commands accepted by the direct TUI and its app integration, with the line the menu and `/help` both show. */
export const SLASH_COMMAND_TABLE: ReadonlyArray<{ readonly name: string; readonly description: string }> = [
  { name: '/help', description: 'Show commands and keyboard shortcuts' },
  { name: '/providers', description: 'List configured providers and their status' },
  { name: '/model', description: 'Choose or set the model (/model <provider>/<model>)' },
  { name: '/effort', description: 'Set the reasoning effort' },
  { name: '/profile', description: 'Switch the active profile' },
  { name: '/settings', description: 'Show or change settings' },
  { name: '/auto-approve', description: 'Set tool auto-approval (off, advisory, auto, always)' },
  { name: '/sandbox', description: 'Toggle shell sandboxing (preference only here)' },
  { name: '/resume', description: 'List saved conversations or resume one by ID' },
  { name: '/clear', description: 'Start a new conversation' },
  { name: '/rollover', description: 'Continue in a fresh conversation seeded from this one' },
  { name: '/compact', description: 'Compact older turns into a summary' },
  { name: '/retry', description: 'Regenerate the latest turn (alias for /retry-turn)' },
  { name: '/retry-turn', description: 'Regenerate the latest turn from its original prompt' },
  { name: '/retry-tool', description: 'Retry the last tool call' },
  { name: '/rewind', description: 'Go back to an earlier message' },
  { name: '/usage', description: 'Show token usage for this session' },
  { name: '/copy', description: 'Copy an assistant response (/copy N counts back)' },
  { name: '/skills', description: 'Activate a skill for a request' },
  { name: '/goal', description: 'Inspect or update the durable session goal' },
  { name: '/handoff', description: 'Send the last response to another model for review' },
  { name: '/tasks', description: 'Manage background tasks' },
  { name: '/queue', description: 'Resume, discard, retract or edit queued messages' },
  { name: '/steer', description: 'Send a message into the running turn' },
  { name: '/followup', description: 'Queue a message for after the running turn' },
  { name: '/cancel', description: 'Stop the running turn' },
  { name: '/answer', description: 'Answer a pending approval or question' },
  { name: '/bridge', description: "Attach or detach this session's control socket" },
  { name: '/restart', description: 'Reload this executable (/restart stop also stops background work)' },
  { name: '/quit', description: 'Exit the application' },
  { name: '/exit', description: 'Exit the application' },
  { name: '/command-status', description: 'Show the outcome of a command by ID' },
  { name: '/command-apply', description: 'Apply a finished command result by ID' },
  { name: '/mcp', description: 'Show configured MCP servers and their state' },
  { name: '/mcp-login', description: 'Authenticate with an OAuth-protected MCP server' },
  { name: '/plan', description: 'Toggle the plan profile' },
  { name: '/bare', description: 'Switch to the bare profile' },
  { name: '/mentor', description: 'Toggle the mentor profile' },
  { name: '/orchestrator', description: 'Toggle the orchestrator profile' },
];

export const SLASH_COMMANDS: readonly string[] = SLASH_COMMAND_TABLE.map((command) => command.name);

/** The text `/help` prints: every command with its description, then the keyboard shortcuts. */
export function helpText(): string {
  return [
    'Commands',
    ...SLASH_COMMAND_TABLE.map((command) => `${command.name} — ${command.description}`),
    'Keyboard shortcuts',
    'Enter send/steer · Alt+Enter follow-up · ↑/↓ history · PgUp/PgDn scroll · Ctrl+O tool output',
    'Ctrl+G approvals/tasks · Ctrl+B budget · Ctrl+C stop turn / clear input / exit',
  ].join('\n');
}
