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
import { ASK_USER_NO_ANSWER_RESULT, type WireDecision, type WireGrant } from '../../protocol/wire.js';
import type { TuiConnection } from './integration.js';
import type { InteractionView, TuiState } from './state.js';
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

/** Which owner's request the prompt shows; legacy resolves each one differently. */
type PromptRequest = {
  readonly interaction: InteractionView;
  readonly owner: 'turn' | 'nested' | 'background';
  readonly agentName: string;
  readonly backgroundCount: number;
};

/**
 * app.tsx effectivePendingApproval: a background child's request first, then the turn's own, then a foreground
 * (script) child's, named as legacy names them. A request just answered is gone, as legacy clears it on answer.
 */
export function promptRequest(state: TuiState, answeredId: string | null): PromptRequest | undefined {
  const taskOf = (item: InteractionView) => state.tasks.find((task) => task.id === item.taskId);
  const open = state.interactions.filter((item) => item.id !== answeredId);
  const background = open.filter((item) => item.taskId && taskOf(item)?.wire?.mode === 'background');
  const root = open.find((item) => item.turnId === state.activeTurnId && !item.taskId);
  const nested = open.find((item) => item.taskId && taskOf(item)?.wire?.mode !== 'background');
  const backgroundCount = background.length;
  if (background[0]) {
    const interaction = background[0];
    const agentName = `${interaction.taskId} (${interaction.toolName ?? interaction.title})`;
    return { interaction, owner: 'background', agentName, backgroundCount };
  }
  if (root) return { interaction: root, owner: 'turn', agentName: 'Agent', backgroundCount };
  if (!nested) return undefined;
  const role = taskOf(nested)?.role ?? taskOf(nested)?.wire?.role ?? 'agent';
  return { interaction: nested, owner: 'nested', agentName: `Script child agent (${role})`, backgroundCount };
}

/** Legacy's ApprovalDescriptor, from the direct-wire request (the data-access half of the port). */
/**
 * Legacy interruption-info.ts getCommandFromArgs: a turn's (and a background child's) approval carries only the
 * command when there is one, so the prompt cannot parse shell Cwd/Timeout rows from it. A script child's carries
 * its prepared arguments as JSON (app.tsx projectNestedApproval).
 */
function argumentsText(input: unknown, nested: boolean): string {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined;
  if (!nested && record?.command !== undefined) return String(record.command);
  if (!nested && Array.isArray(record?.commands)) return (record.commands as unknown[]).join('\n');
  return JSON.stringify(input ?? {});
}

function approvalDescriptor(
  view: InteractionView,
  agentName: string,
  owner: PromptRequest['owner'],
): ApprovalDescriptor {
  const nested = owner === 'nested';
  const presentation = (view.presentation ?? {}) as Record<string, unknown>;
  const record = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  return {
    agentName,
    toolName: view.toolName ?? view.title,
    argumentsText: argumentsText(view.input, nested),
    // The turn's own interruption keeps its raw arguments (the prompt reads `sandbox` from them).
    ...(owner === 'turn' ? { rawInterruption: { arguments: JSON.stringify(view.input ?? {}) } } : {}),
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
  readonly request: PromptRequest;
  /** The foreground turn a stop cancels; a background child's request may outlive it. */
  readonly activeTurnId: string | null;
  readonly connection: TuiConnection;
  readonly inputHandler: InteractionInput;
  /** Ctrl+C while this prompt is up; returns false when it does not apply. */
  readonly interrupt: MutableRefObject<(() => boolean) | null>;
  readonly cancelInput: (connection: TuiConnection, turnId?: string) => Promise<string>;
  readonly setNotice: (notice: string | null) => void;
  readonly onStopped: () => void;
  /** Legacy clears its pending approval as it answers; a failed answer brings the prompt back. */
  readonly hide: (requestId: string | null) => void;
  /** The session composer's draft. Legacy types the reason and the custom answer in that same composer. */
  readonly editorValue: string;
  readonly changeInput: (text: string) => void;
  readonly replaceInput: (text: string) => void;
  /** Legacy BottomArea draws the tasks panel straight under the prompt, above its (hidden) input surface. */
  readonly panel?: React.ReactNode;
};

/** The request the prompt shows, if any; a new request gets fresh prompt state. */
export function ApprovalHost({
  request,
  ...props
}: Omit<HostProps, 'request'> & { readonly request: PromptRequest | undefined }): React.ReactElement | null {
  return request ? <Host key={request.interaction.id} request={request} {...props} /> : <>{props.panel}</>;
}

function Host({
  request,
  activeTurnId,
  connection,
  inputHandler,
  interrupt,
  cancelInput,
  setNotice,
  onStopped,
  hide,
  editorValue: text,
  changeInput,
  replaceInput,
  panel,
}: HostProps): React.ReactElement {
  const theme = useTheme();
  const { columns, rows } = useTerminalSize();
  const { InputFrame, PromptMarker } = useSkin();
  const { interaction, owner } = request;
  const approval = approvalDescriptor(interaction, request.agentName, owner);
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
    hide(interaction.id);
    answerInteraction(connection, interaction.id, decision).catch((error: unknown) => {
      pending.current = false;
      hide(null);
      fail(error);
    });
  };
  const stop = () => {
    if (pending.current) return;
    pending.current = true;
    cancelInput(connection, activeTurnId ?? undefined).then((message) => {
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
    // app.tsx handleCancelApproval: a background child's request is denied without a reason; the turn keeps going.
    if (owner === 'background') return send({ kind: 'deny' });
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
    else if (activeTurnId) stop();
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
          {request.backgroundCount > 1 ? (
            <Text color={theme.warning}>Background approval · {request.backgroundCount - 1} queued</Text>
          ) : null}
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
          {panel}
        </Box>
      ) : (
        panel
      )}
      {composer}
    </Box>
  );
}
