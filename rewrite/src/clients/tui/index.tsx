import React, { useRef, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { MultilineInput } from 'ink-prompt';
import type { Connection } from '../../host/index.js';
import { useTheme } from '../../../../source/components/theme.js';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import type { TuiIntegration } from './integration.js';
import { useClient } from './use-client.js';
import { Activity, Transcript } from './views.js';

export type { TuiIntegration } from './integration.js';
export type { TuiState, ViewUpdate, Message, ToolView, InteractionView, QueueItem, TaskView } from './state.js';
export { updateView } from './state.js';
export { submitText, cancelForeground } from './commands.js';

/**
 * Direct TUI surface. The app owns the connection and supplies the C4 adapter;
 * unmounting or replacing the connection unsubscribes without cancelling work.
 * All mutations go through the adapter and failures remain visible to the user.
 */
export function Tui({ connection, integration, onExit }: {
  readonly connection: Connection;
  readonly integration: TuiIntegration;
  readonly onExit: () => void;
}): React.ReactElement {
  const { state, error: connectionError } = useClient(connection, integration);
  const { stdout } = useStdout();
  const { InputFrame, PromptMarker, Hints } = useSkin();
  const theme = useTheme();
  const [value, setValue] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

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
      // Preserve text typed while an asynchronous command was in flight.
      if (valueRef.current === input) setValue('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return <Box flexDirection="column">
    <Transcript state={state} />
    <Activity state={state} />
    {connectionError ? <Text color={theme.danger}>{connectionError}</Text> : null}
    {notice ? <Text>{notice}</Text> : null}
    <InputFrame>
      <PromptMarker mode="input" />
      <MultilineInput value={value} onChange={setValue} onSubmit={submit} width={Math.max(1, (stdout.columns || 80) - 4)} isActive={!busy && !connectionError} />
    </InputFrame>
    <Hints hints={[["Enter", "send"], ["/", "commands"], ["/cancel", "stop"]]} />
  </Box>;
}
