/**
 * Hosts the ported legacy approval/ask_user prompt for the foreground turn's request, as legacy's app.tsx,
 * BottomArea and use-app-keyboard-shortcuts do: the prompt replaces the composer under the divider; `y`/`n` are
 * global shortcuts; Deny opens the composer as a "Why?" reason prompt; "Something else…" opens it as an
 * "Answer:" prompt with the question kept above; Escape (and Ctrl+C) interrupt. Multi-question answers are
 * collected here like legacy's pending-interaction state, then sent once with the wire's question IDs.
 */
import React, { useRef, useState, type MutableRefObject } from 'react';
import { Box, Text } from 'ink';
import { MultilineInput } from 'ink-prompt';
import { ASK_USER_NO_ANSWER_RESULT, type WireDecision, type WireGrant } from '../../protocol/direct-wire.js';
import type { TuiConnection } from './integration.js';
import type { InteractionView } from './state.js';
import { answerInteraction } from './commands.js';
import { useInteractionInput, type InteractionInput, type InteractionInputHandler } from './interaction-input.js';
import ApprovalPrompt, { type ApprovalDescriptor } from './approval-prompt.js';
import { useTheme } from './presentation/components/theme.js';
import { useSkin } from './presentation/skins/SkinContext.js';
import { useTerminalSize } from './terminal.js';

type AskUserAnswer = string | string[];
const GRANTS: readonly WireGrant[] = [
  'allow-remember',
  'unsandboxed-once',
  'allow-folder-session',
  'allow-edit-file-session',
  'allow-edit-folder-session',
  'docker-allow-once',
  'docker-allow-session',
  'docker-allow-project',
];

/** Legacy's ApprovalDescriptor, from the direct-wire request (the data-access half of the port). */
function approvalDescriptor(view: InteractionView): ApprovalDescriptor {
  const presentation = (view.presentation ?? {}) as Record<string, unknown>;
  const record = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  return {
    agentName: 'Agent',
    toolName: view.toolName ?? view.title,
    argumentsText: JSON.stringify(view.input ?? {}),
    ...(view.callId ? { callId: view.callId } : {}),
    dockerHostControl:
      presentation.dockerHostControl === true || /: Docker host control \(this call only\)$/.test(view.summary ?? ''),
    ...(record(presentation.deniedRead)
      ? { deniedRead: presentation.deniedRead as ApprovalDescriptor['deniedRead'] }
      : {}),
    ...(record(presentation.outsideWorkspaceEdit)
      ? { outsideWorkspaceEdit: presentation.outsideWorkspaceEdit as ApprovalDescriptor['outsideWorkspaceEdit'] }
      : {}),
    ...(typeof presentation.workspaceRoot === 'string' ? { workspaceRoot: presentation.workspaceRoot } : {}),
  };
}

/** Legacy's approval answer strings, as wire decisions. */
function approveDecision(answer: string | undefined): WireDecision {
  const grant = GRANTS.find((value) => value === answer);
  return grant ? { kind: 'grant', grant } : { kind: 'allow' };
}

type HostProps = {
  readonly interaction: InteractionView;
  readonly connection: TuiConnection;
  readonly inputHandler: InteractionInput;
  /** Ctrl+C while this prompt is up; returns false when it does not apply. */
  readonly interrupt: MutableRefObject<(() => boolean) | null>;
  readonly cancelInput: (connection: TuiConnection, turnId?: string) => Promise<string>;
  readonly setNotice: (notice: string | null) => void;
  readonly onStopped: () => void;
  /** The session composer's draft. Legacy types the reason and the custom answer in that same composer. */
  readonly editorValue: string;
  readonly changeInput: (text: string) => void;
  readonly replaceInput: (text: string) => void;
};

/** The foreground turn's request, if any; a new request gets fresh prompt state. */
export function ApprovalHost({
  interaction,
  ...props
}: Omit<HostProps, 'interaction'> & { readonly interaction: InteractionView | undefined }): React.ReactElement | null {
  return interaction ? <Host key={interaction.id} interaction={interaction} {...props} /> : null;
}

function Host({
  interaction,
  connection,
  inputHandler,
  interrupt,
  cancelInput,
  setNotice,
  onStopped,
  editorValue: text,
  changeInput,
  replaceInput,
}: HostProps): React.ReactElement {
  const theme = useTheme();
  const { columns, rows } = useTerminalSize();
  const { InputFrame, PromptMarker } = useSkin();
  const approval = approvalDescriptor(interaction);
  const isAskUser = approval.toolName === 'ask_user';
  const [entry, setEntry] = useState<'reason' | 'answer' | null>(null);
  const [answers, setAnswers] = useState<readonly AskUserAnswer[]>([]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const consumed = useRef(false);
  const pending = useRef(false);
  const promptInput = useRef<InteractionInputHandler | null>(null);
  const fail = (error: unknown) => setNotice(error instanceof Error ? error.message : String(error));

  const send = (decision: WireDecision) => {
    if (pending.current) return;
    pending.current = true;
    answerInteraction(connection, interaction.id, decision).catch((error: unknown) => {
      pending.current = false;
      fail(error);
    });
  };
  const stop = () => {
    if (pending.current) return;
    pending.current = true;
    cancelInput(connection, interaction.turnId).then((message) => {
      setNotice(message);
      onStopped();
    }, fail);
  };
  // Legacy clears the composer whenever it leaves a reason or answer entry.
  const leaveEntry = () => {
    setEntry(null);
    replaceInput('');
  };

  const onApprove = (answer?: string) => {
    if (!isAskUser) return send(approveDecision(answer));
    leaveEntry();
    // pending-interaction-state.ts resolve(): one answer per question, in order, then the whole list.
    const questions = interaction.questions ?? [];
    let parsed: AskUserAnswer = answer ?? '';
    if (questions[answers.length]?.multiple) {
      try {
        const value: unknown = JSON.parse(answer ?? '');
        if (Array.isArray(value)) parsed = value.filter((item): item is string => typeof item === 'string');
      } catch {
        // Legacy keeps the plain text.
      }
    }
    const next = [...answers, parsed];
    setAnswers(next);
    setQuestionIndex(next.length);
    if (next.length < questions.length) return;
    send({
      kind: 'answers',
      answers: questions.map((question, index) => ({ questionId: question.id, value: next[index] ?? '' })),
    });
  };
  const onReject = () => setEntry('reason');
  const onCancel = () => {
    if (!isAskUser) return stop();
    // Graceful cancel: the question resolves with no answer and the turn's record stays.
    send({ kind: 'answer', answer: ASK_USER_NO_ANSWER_RESULT, stopAfterApprovalResolution: true });
  };
  const onNavigateQuestion = (direction: 'prev' | 'next') => {
    setEntry(null);
    if (direction === 'next') return setQuestionIndex((index) => index + 1);
    if (questionIndex <= 0) return;
    setQuestionIndex(questionIndex - 1);
    setAnswers(answers.slice(0, -1));
  };

  // use-app-keyboard-shortcuts.ts: Ctrl+C clears a typed reason/answer, else stops the turn.
  interrupt.current = () => {
    if (text.length > 0) replaceInput('');
    else stop();
    return true;
  };
  const shortcuts = !isAskUser && !approval.dockerHostControl;
  useInteractionInput(inputHandler, (input, key) => {
    if (pending.current) return;
    if (entry === 'reason') {
      if (key.escape) {
        consumed.current = false;
        leaveEntry();
      }
      return;
    }
    if (entry === 'answer' && key.escape) leaveEntry();
    if (!entry && shortcuts && !consumed.current) {
      if (input[0] === 'y') {
        consumed.current = true;
        onApprove(approval.deniedRead ? 'allow-once' : undefined);
        return;
      }
      if (input[0] === 'n') {
        consumed.current = true;
        // The draft plus whatever followed `n` in the same chunk becomes the reason.
        if (input.length > 1) replaceInput(text + input.slice(1));
        onReject();
        return;
      }
    }
    promptInput.current?.(input, key);
  });

  const submit = (value: string) => {
    if (!value.trim()) return;
    if (entry !== 'reason') return onApprove(value);
    replaceInput('');
    send({ kind: 'deny', reason: value });
  };
  const composer = entry ? (
    <Box flexDirection="column">
      {entry === 'answer' ? <Text color={theme.accent}>Answer: </Text> : null}
      <InputFrame>
        <PromptMarker mode={entry === 'reason' ? 'rejection' : 'input'} />
        <MultilineInput
          value={text}
          onChange={changeInput}
          onSubmit={(value) => submit(value)}
          width={Math.max(1, columns - 4)}
          maxHeight={Math.max(1, rows - 8)}
          isActive
          ignoreInput={(input, key) => key.escape || (key.ctrl && (input === 'c' || input === 'g'))}
        />
      </InputFrame>
      {entry === 'reason' ? <Text color={theme.textSubtle}>(or Esc to cancel)</Text> : null}
    </Box>
  ) : null;

  return (
    <Box flexDirection="column">
      {entry !== 'reason' ? (
        <Box flexDirection="column" marginBottom={1}>
          <ApprovalPrompt
            approval={approval}
            inputHandler={promptInput}
            onApprove={onApprove}
            onReject={onReject}
            onCancel={onCancel}
            onTypeAnswer={() => setEntry('answer')}
            onNavigateQuestion={onNavigateQuestion}
            currentQuestionIndex={questionIndex}
            waitingForAskUserAnswer={entry === 'answer'}
          />
        </Box>
      ) : null}
      {composer}
    </Box>
  );
}
