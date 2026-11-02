import React, { useState } from 'react';
import { Text, type Key } from 'ink';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import { SLASH_COMMAND_TABLE, SLASH_COMMANDS } from './slash-commands.js';

const NAME_WIDTH = Math.max(...SLASH_COMMANDS.map((name) => name.length));
const DESCRIPTIONS = new Map(SLASH_COMMAND_TABLE.map((command) => [command.name, command.description]));

/** Menu key handling stays in the composer input path, not a second Ink listener. */
export function useSlashMenu(value: string, enabled: boolean, subtleColor: React.ComponentProps<typeof Text>['color']) {
  const { MenuFrame } = useSkin();
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
      // Enter completes; Tab may open a picker, otherwise it completes.
      accept(command, Boolean(key.tab));
    }
    return true;
  };
  const reset = () => {
    setIndex(0);
    setDismissed(null);
  };
  const start = Math.min(Math.max(0, selected - 5), Math.max(0, matches.length - 10));
  const view = matches.length ? (
    <MenuFrame
      hasItems
      borderColor={undefined}
      footer="↑/↓ select · Enter complete · Tab complete/open · Esc dismiss"
      footerPlacement="inside"
    >
      {matches.slice(start, start + 10).map((command) => (
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
              ['@', 'paths'],
              ['!', 'shell'],
              ['Shift+Tab', 'plan mode'],
              ['↑/↓', 'history'],
              ['Ctrl+O', 'tool output'],
              ['Ctrl+G', 'tasks'],
            ]
      }
    />
  );
}
