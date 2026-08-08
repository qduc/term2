import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { useInputContext } from '../../context/InputContext.js';
import type { MenuController, MenuFrame, MenuInteractionRegistry } from './menu-types.js';
import { MenuStackHost } from './MenuStackHost.js';
import type { MenuServices } from './menu-registry.js';

const isFocusReportingSequence = (input: string): boolean =>
  input === '\x1b[I' || input === '\x1b[O' || input === '[I' || input === '[O';

export type MenuSurfaceProps = {
  stack: readonly MenuFrame[];
  controller: MenuController;
  interactions: MenuInteractionRegistry;
  services: MenuServices;
  enabled: boolean;
};

/** The sole terminal input boundary while a controller menu is visible. */
export function MenuSurface({ stack, controller, interactions, services, enabled }: MenuSurfaceProps) {
  const { input, cursorOffset, menuPromptLabel, setCursorOverride } = useInputContext();

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

      if (key.escape) {
        controller.escape();
        setCursorOverride(controller.getSnapshot().editor.cursor);
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
      } else if (key.ctrl && _input === 'r') {
        dispatch({ type: 'command', command: 'refresh' });
      } else if (key.ctrl && _input === 'd') {
        dispatch({ type: 'command', command: 'reset' });
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
      {menuPromptLabel && (
        <Box>
          <Text color="#22d3ee">{menuPromptLabel}</Text>
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
