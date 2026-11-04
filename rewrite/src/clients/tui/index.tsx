/** Public direct TUI shell: cross-session notices and terminal interrupt ownership. */
import React, { useRef, useState } from 'react';
import { Box, useInput, useStdout } from 'ink';
import { clearTerminalForRedraw } from './terminal.js';
import type { TuiProps } from './integration.js';
import { TuiSession } from './session.js';

export type { TuiIntegration } from './integration.js';
export type { TuiState, ViewUpdate, Message, ToolView, InteractionView, QueueItem, TaskView } from './state.js';
export { updateView } from './state.js';
export { submitText, cancelForeground, answerInteraction, directSlashCommand } from './commands.js';
export { projectSnapshot } from './direct-projection.js';

/**
 * Direct TUI surface. The app owns the connection and supplies host/config actions;
 * unmounting or replacing the connection unsubscribes without cancelling work.
 * Session mutations go through the direct wire and failures remain visible.
 */
export function Tui(props: TuiProps): React.ReactElement {
  // Signal keys stay above the keyed session/editor and every modal input owner.
  const interrupt = useRef<() => void>(() => {});
  const exitArmedUntil = useRef(0);
  useInput((input, key) => {
    if (!key.ctrl || input !== 'c') return;
    const now = performance.now();
    if (now < exitArmedUntil.current) {
      exitArmedUntil.current = 0;
      props.onExit();
      return;
    }
    // Retain the terminal's two-second interrupt/confirm gesture.
    exitArmedUntil.current = now + 2000;
    interrupt.current();
  });
  // Keep transition notices above the keyed per-session component.
  const [transition, setTransition] = useState<{ sessionId: string; message: string } | null>(null);
  const { stdout } = useStdout();
  const switchSession = props.integration.switchSession
    ? async (sessionId: string, notice?: string) => {
        const result = await props.integration.switchSession!(sessionId);
        clearTerminalForRedraw(stdout);
        const message = [notice, result?.message].filter(Boolean).join('\n');
        setTransition(message ? { sessionId, message } : null);
      }
    : undefined;
  return (
    <Box flexDirection="column">
      <TuiSession
        key={props.connection.sessionId}
        {...props}
        interrupt={interrupt}
        switchSession={switchSession}
        transitionNotice={transition?.sessionId === props.connection.sessionId ? transition.message : undefined}
      />
    </Box>
  );
}
