import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultilineInput, type ImageRef } from 'ink-prompt';
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import type { WireDecision } from '../../protocol/direct-wire.js';
import { useTheme } from '../../../../source/components/theme.js';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import type { TuiIntegration } from './integration.js';
import { useClient } from './use-client.js';
import { Activity } from './views.js';
import { InteractionPanel } from './interaction-panel.js';
import { useEditor } from './editor.js';
import { useTerminalSize } from './terminal.js';
import { useTranscriptViewport } from './viewport.js';
import { answerInteraction, cancelForeground, directSlashCommand, queueAction, submitText } from './commands.js';

export type { TuiIntegration } from './integration.js';
export type { TuiState, ViewUpdate, Message, ToolView, InteractionView, QueueItem, TaskView } from './state.js';
export { updateView } from './state.js';
export { submitText, cancelForeground, answerInteraction, directSlashCommand } from './commands.js';
export { projectSnapshot, projectEvent } from './direct-projection.js';

/**
 * Direct TUI surface. The app owns the connection and supplies host/config actions;
 * unmounting or replacing the connection unsubscribes without cancelling work.
 * Session mutations go through the direct wire and failures remain visible.
 */
export function Tui(props: {
  readonly connection: DirectConnection;
  readonly integration: TuiIntegration;
  readonly onExit: () => void;
}): React.ReactElement {
  // A different session gets its own draft, history and viewport.
  return <TuiSession key={props.connection.sessionId} {...props} />;
}

function TuiSession({ connection, integration, onExit }: {
  readonly connection: DirectConnection;
  readonly integration: TuiIntegration;
  readonly onExit: () => void;
}): React.ReactElement {
  const { state, error: connectionError } = useClient(connection);
  const { columns, rows } = useTerminalSize();
  const [interactionOpen, setInteractionOpen] = useState(false);
  const [images, setImages] = useState<ImageRef[]>([]);
  const viewport = useTranscriptViewport(state, columns, rows, !interactionOpen);
  const editor = useEditor(state.messages.filter(message => message.role === 'user').map(message => message.text));
  const { InputFrame, PromptMarker, Hints } = useSkin();
  const theme = useTheme();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const answerOwners = useRef<readonly string[] | null>(null);
  const queueOwners = useRef<readonly string[] | null>(null);
  useInput((input, key) => {
    if (key.ctrl && input === 'g' && state.interactions.length && !busy) setInteractionOpen(true);
  }, { isActive: !interactionOpen });

  const changeInput = (value: string) => {
    if (/^\/answer(?:\s|$)/.test(value)) {
      if (!answerOwners.current) answerOwners.current = state.interactions.map(item => item.id);
    } else {
      answerOwners.current = null;
    }
    if (/^\/queue(?:\s|$)/.test(value)) {
      if (!queueOwners.current) queueOwners.current = state.queue.map(item => item.id);
    } else {
      queueOwners.current = null;
    }
    editor.change(value);
  };

  const submit = async (input: string, submittedImages: ImageRef[] = images): Promise<void> => {
    if ((!input.trim() && !submittedImages.length) || pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    try {
      if (input.startsWith('/') && submittedImages.length) throw new Error('Remove attachments before running a command.');
      if (input.startsWith('/answer ')) {
        const match = /^\/answer\s+(\d+)\s+(\d+)(?:\s+([\s\S]*))?$/.exec(input.trim());
        const interaction = match && state.interactions[Number(match[1]) - 1];
        const choice = interaction && match && interaction.choices[Number(match[2]) - 1];
        if (!interaction || !choice || !match) throw new Error('Use /answer <interaction number> <choice number> [text].');
        if (answerOwners.current && answerOwners.current[Number(match[1]) - 1] !== interaction.id) {
          throw new Error('The interaction list changed. Check the prompt and re-enter your answer.');
        }
        let decision: WireDecision;
        switch (choice.id) {
          case 'allow':
            if (match[3]) throw new Error('Allow does not accept text.');
            decision = { kind: 'allow' }; break;
          case 'deny': decision = { kind: 'deny', ...(match[3] ? { reason: match[3] } : {}) }; break;
          case 'answer':
            if (!match[3]?.trim()) throw new Error('Enter an answer after the choice number.');
            decision = { kind: 'answer', answer: match[3] }; break;
          case 'stop':
            if (match[3]) throw new Error('Stop does not accept text.');
            decision = { kind: 'answer', answer: '', stopAfterApprovalResolution: true }; break;
          default: throw new Error('Unsupported interaction choice.');
        }
        await answerInteraction(connection, interaction.id, decision);
      } else if (/^\/steer(?:\s|$)/.test(input)) {
        throw new Error('Explicit steering is unavailable: the direct submit protocol has no delivery selector.');
      } else if (/^\/queue(?:\s|$)/.test(input)) {
        const match = /^\/queue\s+(resume|discard|retract|edit)(?:\s+(\d+))?(?:\s+([\s\S]*))?$/.exec(input.trim());
        if (!match) throw new Error('Use /queue resume|discard|retract <number>|edit <number> <text>.');
        const action = match[1] as 'resume' | 'discard' | 'retract' | 'edit';
        const item = match[2] ? state.queue[Number(match[2]) - 1] : undefined;
        if ((action === 'edit' || action === 'retract') && !item) throw new Error('No queued message at that number.');
        if (item && queueOwners.current && queueOwners.current[Number(match[2]) - 1] !== item.id) {
          throw new Error('The queue changed. Check the list and re-enter your command.');
        }
        if ((action === 'resume' || action === 'discard') && match[2]) throw new Error('This operation takes no message number.');
        await queueAction(connection, action, item?.id, match[3]);
      } else if (input.trim() === '/cancel') {
        await cancelForeground(connection);
      } else if (input.startsWith('/')) {
        if (!await directSlashCommand(connection, input)) {
          const result = await integration.command(connection, input);
          if (result.message) setNotice(result.message);
          if (result.exit) onExit();
        }
      } else {
        await submitText(connection, input, submittedImages.map(image => ({ type: 'image' as const, mediaType: image.mimeType, data: image.data })));
        setImages([]);
      }
      // Do not add interaction answers to recallable input history.
      editor.accepted(input, !input.startsWith('/answer '));
      answerOwners.current = null;
      queueOwners.current = null;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return <Box flexDirection="column">
    {viewport.text ? <Text>{viewport.text}</Text> : null}
    {viewport.total > 0 && (viewport.start > 0 || !viewport.live) ?
      <Text color={theme.textSubtle}>Lines {viewport.start + 1}–{viewport.end} of {viewport.total} · PgUp/PgDn or Ctrl+↑/↓</Text> : null}
    <Activity state={state} />
    {interactionOpen ? <InteractionPanel interactions={state.interactions} width={columns} onClose={() => setInteractionOpen(false)}
      onAnswer={(id, decision) => answerInteraction(connection, id, decision)} /> : null}
    {connectionError ? <Text color={theme.danger}>{connectionError}</Text> : null}
    {notice ? <Text>{notice}</Text> : null}
    {editor.historyError ? <Text>{editor.historyError}</Text> : null}
    <InputFrame>
      <PromptMarker mode="input" />
      <MultilineInput
        key={editor.inputKey}
        value={editor.value}
        onChange={changeInput}
        onSubmit={submit}
        onBoundaryArrow={editor.navigate}
        width={Math.max(1, columns - 4)}
        maxHeight={Math.max(1, rows - 8)}
        isActive={!busy && !connectionError && !interactionOpen}
        images={images}
        onImagesChange={setImages}
        enableImagePaste
        onPasteError={reason => setNotice(`Image paste failed: ${reason}`)}
        ignoreInput={(input, key) => key.pageUp || key.pageDown || (key.ctrl && (key.upArrow || key.downArrow || input === 'g'))}
      />
    </InputFrame>
    <Hints hints={[["Enter", "send"], ["↑/↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+G", "approvals"], ["/", "commands"], ["/cancel", "stop"]]} />
  </Box>;
}
