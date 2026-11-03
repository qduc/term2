import React, { useState } from 'react';
import { Text, type Key } from 'ink';
import { useTerminalSize } from './terminal.js';
import { useSkin } from './presentation/skins/SkinContext.js';
import { SLASH_COMMAND_TABLE, SLASH_COMMANDS } from './slash-commands.js';

const NAME_WIDTH = Math.max(...SLASH_COMMANDS.map((name) => name.length));
const DESCRIPTIONS = new Map(SLASH_COMMAND_TABLE.map((command) => [command.name, command.description]));

/** Menu key handling stays in the composer input path, not a second Ink listener. */
export function useSlashMenu(value: string, enabled: boolean, subtleColor: React.ComponentProps<typeof Text>['color']) {
  const { MenuFrame } = useSkin();
  const { rows } = useTerminalSize();
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const matches =
    enabled && /^\/[a-z-]*$/.test(value) && value !== dismissed
      ? SLASH_COMMANDS.filter((command) => command.startsWith(value))
      : [];
  const selected = Math.min(index, matches.length - 1);
  // A fully typed command is submitted by plain Enter, like any other line.
  const exact = SLASH_COMMANDS.some((command) => command === value);
  // An exact command plus its completion space is still a dismissible trigger.
  const completed = enabled && SLASH_COMMANDS.some((command) => value === `${command} `);
  const owns = (key: Key) =>
    (matches.length > 0 || (completed && key.escape)) &&
    !key.ctrl &&
    !key.meta &&
    !key.shift &&
    (key.upArrow || key.downArrow || key.escape || key.tab || (key.return && !exact));
  const handle = (key: Key, accept: (command: string, openPicker: boolean) => void) => {
    if (!owns(key)) return false;
    if (key.upArrow || key.downArrow) {
      setIndex((selected + (key.upArrow ? matches.length - 1 : 1)) % matches.length);
    } else if (key.escape) {
      setDismissed(value);
      accept('', false);
    } else {
      const command = matches[selected];
      setDismissed(command);
      setIndex(0);
      // Enter selects; Tab only completes.
      accept(command, Boolean(key.return));
    }
    return true;
  };
  const reset = () => {
    setIndex(0);
    setDismissed(null);
  };
  // Leave room for the frame, title, wrapped hints and composer on short terminals.
  const visibleRows = Math.max(1, Math.min(10, rows - 12));
  const start = Math.min(
    Math.max(0, selected - Math.floor(visibleRows / 2)),
    Math.max(0, matches.length - visibleRows),
  );
  const view = matches.length ? (
    <MenuFrame
      title="Commands"
      hasItems
      borderColor={undefined}
      footer="↑/↓ select · Enter run · Tab complete · Esc dismiss"
      footerPlacement="inside"
    >
      {matches.slice(start, start + visibleRows).map((command) => (
        <Text key={command} wrap="truncate-end">
          {command === matches[selected] ? '› ' : '  '}
          {command.padEnd(NAME_WIDTH)}
          <Text color={subtleColor}> {DESCRIPTIONS.get(command)}</Text>
        </Text>
      ))}
    </MenuFrame>
  ) : null;
  return { owns, handle, reset, view };
}

/** Composer shortcuts are shown only when the composer owns input. */
export function ComposerHints({
  activeTurn,
  queueSelectable,
  columns,
  Hints,
}: {
  readonly activeTurn: boolean;
  readonly queueSelectable: boolean;
  readonly columns: number;
  readonly Hints: React.ComponentType<{ hints: ReadonlyArray<readonly [string, string]> }>;
}): React.ReactElement {
  const hints: ReadonlyArray<readonly [string, string]> = activeTurn
    ? [
        ...(queueSelectable ? [['↑', 'select queued'] as const] : []),
        ['⏎', 'steer'],
        ['Alt+⏎', 'queue'],
        ['Ctrl+O', 'model'],
        ['Ctrl+T', 'effort'],
      ]
    : [
        ['/', 'commands'],
        ['@', 'paths'],
        ['!', 'shell'],
        ['Shift+Tab', 'plan'],
      ];
  let width = 0;
  const visible = hints.filter(([key, action]) => {
    const needed = key.length + 1 + action.length + (width ? 3 : 0);
    if (width + needed > columns) return false;
    width += needed;
    return true;
  });
  return <Hints hints={visible} />;
}
