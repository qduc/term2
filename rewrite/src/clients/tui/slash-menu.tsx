import React, { useState } from 'react';
import { Box, Text, type Key } from 'ink';
/** Commands accepted by the direct TUI and its app integration. */
export const SLASH_COMMANDS = [
  '/help',
  '/model',
  '/effort',
  '/profile',
  '/settings',
  '/auto-approve',
  '/sandbox',
  '/resume',
  '/clear',
  '/rollover',
  '/compact',
  '/retry-turn',
  '/retry-tool',
  '/rewind',
  '/usage',
  '/copy',
  '/skills',
  '/goal',
  '/handoff',
  '/tasks',
  '/queue',
  '/steer',
  '/followup',
  '/cancel',
  '/answer',
  '/bridge',
  '/restart',
  '/quit',
  '/exit',
  '/command-status',
  '/command-apply',
  '/mcp',
  '/mcp-login',
  '/plan',
  '/bare',
  '/mentor',
  '/orchestrator',
] as const;

/** Menu key handling stays in the composer input path, not a second Ink listener. */
export function useSlashMenu(value: string, enabled: boolean, subtleColor: React.ComponentProps<typeof Text>['color']) {
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const matches =
    enabled && /^\/[a-z-]*$/.test(value) && value !== dismissed
      ? SLASH_COMMANDS.filter((command) => command.startsWith(value))
      : [];
  const selected = Math.min(index, matches.length - 1);
  // A fully typed command is submitted by plain Enter, like any other line.
  const exact = SLASH_COMMANDS.some((command) => command === value);
  const owns = (key: Key) =>
    matches.length > 0 &&
    !key.ctrl &&
    !key.meta &&
    !key.shift &&
    (key.upArrow || key.downArrow || key.escape || key.tab || (key.return && !exact));
  const handle = (key: Key, accept: (command: string, run: boolean) => void) => {
    if (!owns(key)) return false;
    if (key.upArrow || key.downArrow) {
      setIndex((selected + (key.upArrow ? matches.length - 1 : 1)) % matches.length);
    } else if (key.escape) setDismissed(value);
    else {
      const command = matches[selected];
      setDismissed(command);
      setIndex(0);
      // Enter never runs a menu pick: it completes into the draft like Tab, and only a fully typed command runs.
      accept(command, false);
    }
    return true;
  };
  const reset = () => {
    setIndex(0);
    setDismissed(null);
  };
  const view = matches.length ? (
    <Box flexDirection="column">
      {matches.slice(Math.max(0, selected - 4), Math.max(0, selected - 4) + 8).map((command) => (
        <Text key={command}>
          {command === matches[selected] ? '› ' : '  '}
          {command}
        </Text>
      ))}
      <Text color={subtleColor}>↑/↓ select · Enter/Tab complete · Esc dismiss</Text>
    </Box>
  ) : null;
  return { owns, handle, reset, view };
}

/** Composer shortcuts are shown only when the composer owns input. */
export function ComposerHints({
  activeTurn,
  Hints,
}: {
  readonly activeTurn: boolean;
  readonly Hints: React.ComponentType<{ hints: ReadonlyArray<readonly [string, string]> }>;
}): React.ReactElement {
  return (
    <Hints
      hints={
        activeTurn
          ? [
              ['Enter', 'steer'],
              ['Alt+Enter', 'follow-up'],
              ['/cancel', 'stop'],
            ]
          : [
              ['/', 'commands'],
              ['↑/↓', 'history'],
              ['Ctrl+O', 'tool output'],
              ['Ctrl+G', 'tasks'],
            ]
      }
    />
  );
}
