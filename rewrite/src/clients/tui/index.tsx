import React, { useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { MultilineInput } from 'ink-prompt';
import type { Connection } from '../../host/index.js';
import { useTheme } from '../../../../source/components/theme.js';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import type { TuiIntegration } from './integration.js';
import { useClient } from './use-client.js';
import { Activity, Transcript } from './views.js';
import { useEditor } from './editor.js';
import { useTerminalSize } from './terminal.js';
import { useTranscriptViewport } from './viewport.js';

export type { TuiIntegration } from './integration.js';
export type { TuiState, ViewUpdate, Message, ToolView, InteractionView, QueueItem, TaskView } from './state.js';
export { updateView } from './state.js';
export { submitText, cancelForeground } from './commands.js';

/**
 * Direct TUI surface. The app owns the connection and supplies the C4 adapter;
 * unmounting or replacing the connection unsubscribes without cancelling work.
 * All mutations go through the adapter and failures remain visible to the user.
 */
export function Tui(props: {
  readonly connection: Connection;
  readonly integration: TuiIntegration;
  readonly onExit: () => void;
}): React.ReactElement {
  // A different session gets its own draft, history and viewport.
  return <TuiSession key={props.connection.sessionId} {...props} />;
}

function TuiSession({ connection, integration, onExit }: {
  readonly connection: Connection;
  readonly integration: TuiIntegration;
  readonly onExit: () => void;
}): React.ReactElement {
  const { state, error: connectionError } = useClient(connection, integration);
  const { columns, rows } = useTerminalSize();
  const viewport = useTranscriptViewport(state.messages, rows);
  const editor = useEditor(state.messages.filter(message => message.role === 'user').map(message => message.text));
  const { InputFrame, PromptMarker, Hints } = useSkin();
  const theme = useTheme();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const submit = async (input: string): Promise<void> => {
    if (!input.trim() || pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    try {
      if (input.startsWith('/answer ')) {
        const match = /^\/answer\s+(\d+)\s+(\d+)(?:\s+([\s\S]*))?$/.exec(input.trim());
        const interaction = match && state.interactions[Number(match[1]) - 1];
        const choice = interaction && match && interaction.choices[Number(match[2]) - 1];
        if (!interaction || !choice || !match) throw new Error('Use /answer <interaction number> <choice number> [text].');
        if (match[3] && !interaction.acceptsText) throw new Error('This choice does not accept text.');
        await integration.answer(connection, interaction.id, choice.id, match[3]);
      } else if (input.trim() === '/cancel') {
        await integration.cancel(connection);
      } else if (input.startsWith('/')) {
        const result = await integration.command(connection, input);
        if (result.message) setNotice(result.message);
        if (result.exit) onExit();
      } else {
        await integration.submit(connection, input);
      }
      // Do not add interaction answers to recallable input history.
      editor.accepted(input, !input.startsWith('/answer '));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return <Box flexDirection="column">
    <Transcript state={state} messages={viewport.messages} columns={columns} live={viewport.live} />
    {viewport.total > 0 && (viewport.start > 0 || !viewport.live) ?
      <Text color={theme.textSubtle}>Messages {viewport.start + 1}–{viewport.end} of {viewport.total} · Page Up/Down to navigate</Text> : null}
    <Activity state={state} />
    {connectionError ? <Text color={theme.danger}>{connectionError}</Text> : null}
    {notice ? <Text>{notice}</Text> : null}
    <InputFrame>
      <PromptMarker mode="input" />
      <MultilineInput
        key={editor.inputKey}
        value={editor.value}
        onChange={editor.change}
        onSubmit={submit}
        onBoundaryArrow={editor.navigate}
        width={Math.max(1, columns - 4)}
        maxHeight={Math.max(1, rows - 8)}
        isActive={!busy && !connectionError}
        ignoreInput={(_input, key) => key.pageUp || key.pageDown}
      />
    </InputFrame>
    <Hints hints={[["Enter", "send"], ["↑/↓", "history"], ["PgUp/PgDn", "messages"], ["/", "commands"], ["/cancel", "stop"]]} />
  </Box>;
}
