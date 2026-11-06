/** Public direct TUI shell: cross-session notices and terminal interrupt ownership. */
import React, { useRef, useState } from 'react';
import { Box, useInput, useStdout } from 'ink';
import { clearTerminalForRedraw } from './terminal.js';
import type { TuiProps } from './integration.js';
import { TuiSession } from './session.js';
import type { HandoffHolder } from './use-handoff.js';

export type { TuiIntegration } from './integration.js';
export type { TuiState, ViewUpdate, Message, ToolView, InteractionView, QueueItem, TaskView } from './state.js';
export { updateView } from './state.js';
export { submitText, cancelForeground, answerInteraction, directSlashCommand } from './commands.js';
export { projectSnapshot } from './projection.js';

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
  const [transition, setTransition] = useState<{ sessionId: string; message: string; resumed: boolean } | null>(null);
  const [handoff, setHandoff] = useState<HandoffHolder['state']>(null);
  const { stdout } = useStdout();
  // Legacy's clearConversationAndRefreshBanner: the next session to mount opens under a "New conversation"
  // rule with these system lines, and the old transcript stays in scrollback. Armed before the switch,
  // because the new connection can be published (and render) after the switch's promise settles.
  const pendingNewConversation = useRef<readonly string[] | null>(null);
  const newConversation = useRef<{ sessionId: string; lines: readonly string[] } | null>(null);
  const mounted = useRef(props.connection.sessionId);
  if (mounted.current !== props.connection.sessionId) {
    mounted.current = props.connection.sessionId;
    newConversation.current = pendingNewConversation.current
      ? { sessionId: props.connection.sessionId, lines: pendingNewConversation.current }
      : null;
    pendingNewConversation.current = null;
  }
  const beginNewConversation = (lines: readonly string[] | null) => {
    pendingNewConversation.current = lines;
  };
  const switchSession = props.integration.switchSession
    ? async (sessionId: string, notice?: string, opening?: readonly string[], resumed = false) => {
        if (opening) beginNewConversation(opening);
        const result = await props.integration.switchSession!(sessionId);
        if (!opening) clearTerminalForRedraw(stdout);
        const message = [notice, result?.message].filter(Boolean).join('\n');
        setTransition(message || resumed ? { sessionId, message, resumed } : null);
      }
    : undefined;
  return (
    <Box flexDirection="column">
      <TuiSession
        key={props.connection.sessionId}
        {...props}
        interrupt={interrupt}
        switchSession={switchSession}
        beginNewConversation={beginNewConversation}
        handoff={{ state: handoff, set: setHandoff }}
        newConversation={
          newConversation.current?.sessionId === props.connection.sessionId ? newConversation.current.lines : undefined
        }
        transitionNotice={
          transition?.sessionId === props.connection.sessionId ? transition.message || undefined : undefined
        }
        resumed={transition?.sessionId === props.connection.sessionId && transition.resumed}
      />
    </Box>
  );
}
