import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { useInputContext } from './input-context.js';
import type { MenuController, MenuFrame, MenuInteractionRegistry } from './menu-types.js';
import { MenuStackHost } from './MenuStackHost.js';
import type { MenuServices } from './menu-registry.js';
import { useTheme } from '../presentation/components/theme.js';

const isFocusReportingSequence = (input: string): boolean =>
  input === '\x1b[I' || input === '\x1b[O' || input === '[I' || input === '[O';

const filterableMenuKinds = new Set<MenuFrame['kind']>([
  'slash',
  'path',
  'settings',
  'settings_value',
  'model',
  'skills',
]);

type FilterableMenuFrame = Extract<MenuFrame, { binding: { query: string } }>;

const isFilterableMenu = (frame: MenuFrame | undefined): frame is FilterableMenuFrame =>
  frame !== undefined && filterableMenuKinds.has(frame.kind);

type SettingsValueMenuFrame = Extract<MenuFrame, { kind: 'settings_value' }>;

const isSettingsValueMenu = (frame: MenuFrame | undefined): frame is SettingsValueMenuFrame =>
  frame?.kind === 'settings_value';

export type MenuSurfaceProps = {
  stack: readonly MenuFrame[];
  controller: MenuController;
  interactions: MenuInteractionRegistry;
  services: MenuServices;
  enabled: boolean;
};

/** Prompt text with the editor cursor drawn as an inverse cell, as the composer draws its own. */
function PromptWithCursor({ text, cursor }: { text: string; cursor: number }) {
  const theme = useTheme();
  const at = Math.max(0, Math.min(text.length, cursor));
  return (
    <Text color={theme.text}>
      {text.slice(0, at)}
      <Text inverse>{text.charAt(at) || ' '}</Text>
      {text.slice(at + 1)}
    </Text>
  );
}

/** The sole terminal input boundary while a controller menu is visible. */
export function MenuSurface({ stack, controller, interactions, services, enabled }: MenuSurfaceProps) {
  const theme = useTheme();
  const { input, cursorOffset, menuPromptLabel, setCursorOverride, menus } = useInputContext();
  const { label: getSettingLabel, isSecret: isSecretSetting } = menus.schema;
  const activeFrame = stack.at(-1);
  const filterFrame = isFilterableMenu(activeFrame) ? activeFrame : undefined;
  const valueFrame = isSettingsValueMenu(activeFrame) ? activeFrame : undefined;
  // A settings_value frame edits a value, not a filter: label the line with
  // the setting name (which the binding text itself omits) instead of "Filter:".
  // A credential being typed is masked, so it never shows on screen.
  const promptLabel = valueFrame
    ? `${getSettingLabel(valueFrame.settingKey)} = `
    : activeFrame?.kind === 'settings'
    ? 'Search settings: '
    : activeFrame?.kind === 'slash'
    ? 'Command: /'
    : filterFrame
    ? 'Filter: '
    : menuPromptLabel;
  const valueQuery =
    valueFrame && isSecretSetting(valueFrame.settingKey)
      ? '•'.repeat(valueFrame.binding.query.length)
      : valueFrame?.binding.query;
  // The prompt shows the whole text from the field start, with the cursor drawn in it. binding.query stops
  // at the cursor, so showing it alone hid everything typed after the cursor.
  const promptStart = valueFrame
    ? valueFrame.binding.replacement.start
    : filterFrame
    ? filterFrame.binding.queryStart
    : 0;
  const promptFull = valueFrame
    ? valueQuery === undefined
      ? undefined
      : input.slice(promptStart)
    : filterFrame
    ? input.slice(promptStart)
    : menuPromptLabel
    ? input
    : undefined;
  const promptText =
    promptFull === undefined ? undefined : (
      <PromptWithCursor
        text={valueFrame && isSecretSetting(valueFrame.settingKey) ? '•'.repeat(promptFull.length) : promptFull}
        cursor={cursorOffset - promptStart}
      />
    );

  useEffect(() => {
    if (enabled) setCursorOverride(cursorOffset);
  }, [cursorOffset, enabled, setCursorOverride]);

  const dispatch = (event: Parameters<MenuSurfaceProps['controller']['dispatchActiveEvent']>[0]) => {
    controller.dispatchActiveEvent(event);
    setCursorOverride(controller.getSnapshot().editor.cursor);
  };

  useInput(
    (_input, key) => {
      if (!enabled || controller.getSnapshot().stack.length === 0) return;
      if (isFocusReportingSequence(_input)) return;

      const historyNavigation = services.historyNavigation as
        | {
            isNavigating: boolean;
            navigateUp: (text: string) => { text: string } | null;
            navigateDown: () => { text: string } | null;
          }
        | undefined;
      if (activeFrame?.kind === 'slash' && historyNavigation?.isNavigating && (key.upArrow || key.downArrow)) {
        const next = key.upArrow ? historyNavigation.navigateUp(input) : historyNavigation.navigateDown();
        if (next) controller.replaceText(next.text, next.text.length);
      } else if (key.upArrow) {
        dispatch({ type: 'move', direction: 'up' });
      } else if (key.downArrow) {
        dispatch({ type: 'move', direction: 'down' });
      } else if (key.pageUp) {
        dispatch({ type: 'move', direction: 'page-up' });
      } else if (key.pageDown) {
        dispatch({ type: 'move', direction: 'page-down' });
      } else if ((key as any).home) {
        dispatch({ type: 'move', direction: 'home' });
      } else if ((key as any).end) {
        dispatch({ type: 'move', direction: 'end' });
      } else if (key.tab && !key.shift) {
        dispatch({ type: 'command', command: 'tab' });
      } else if (key.ctrl && (_input === 'a' || _input === 'e')) {
        dispatch({ type: 'move', direction: _input === 'a' ? 'home' : 'end' });
      } else if ((key.leftArrow && (key.ctrl || key.meta)) || (key.meta && _input === 'b')) {
        dispatch({ type: 'command', command: 'word-left' });
      } else if ((key.rightArrow && (key.ctrl || key.meta)) || (key.meta && _input === 'f')) {
        dispatch({ type: 'command', command: 'word-right' });
      } else if (key.ctrl && _input === 'r') {
        dispatch({ type: 'command', command: 'refresh' });
      } else if (key.ctrl && _input === 'd') {
        dispatch({ type: 'command', command: 'reset' });
      } else if (key.ctrl && _input.toLowerCase() === 'f') {
        dispatch({ type: 'command', command: 'favorite' });
      } else if (key.ctrl && _input.toLowerCase() === 'n') {
        dispatch({ type: 'command', command: 'nickname' });
      } else if ((key.ctrl && (_input.toLowerCase() === 'o' || _input === '\x0f')) || _input === '\x0f') {
        controller.replaceText('/model ');
      } else if ((key.ctrl && (_input.toLowerCase() === 't' || _input === '\x14')) || _input === '\x14') {
        controller.replaceText('/effort ');
      } else if (key.return) {
        dispatch({
          type: 'accept',
          input: { kind: 'composer', text: input, cursor: cursorOffset },
          selected: undefined,
        });
      } else if (key.backspace) {
        dispatch({ type: 'command', command: 'backspace' });
      } else if (key.delete) {
        dispatch({ type: 'command', command: 'delete' });
      } else if (key.leftArrow) {
        dispatch({ type: 'command', command: 'left' });
      } else if (key.rightArrow) {
        dispatch({ type: 'command', command: 'right' });
      } else if (
        _input &&
        !key.ctrl &&
        !key.meta &&
        !key.escape &&
        !key.tab &&
        !key.return &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow
      ) {
        dispatch({ type: 'input', text: _input });
      }
    },
    { isActive: enabled },
  );

  return (
    <Box flexDirection="column">
      {promptLabel && (
        <Box marginBottom={0}>
          <Text color={theme.accent} bold>
            {promptLabel}
          </Text>
          {promptText}
        </Box>
      )}
      <MenuStackHost
        stack={stack}
        controller={controller}
        interactions={interactions}
        services={services}
        enabled={enabled}
      />
    </Box>
  );
}
