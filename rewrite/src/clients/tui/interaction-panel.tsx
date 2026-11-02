import React, { useRef, useState } from 'react';
import { randomBytes } from 'node:crypto';
import { Box, Text } from 'ink';
import { useInteractionInput, type InteractionInput, type InteractionInputHandler } from './interaction-input.js';
import { MultilineInput } from 'ink-prompt';
import type { WireDecision } from '../../protocol/direct-wire.js';
import type { InteractionView } from './state.js';
import { Questions } from './questions.js';

/** Keyboard-operated request picker; all decisions remain pinned to request IDs. */
export function InteractionPanel({
  interactions,
  width,
  initialRequestId,
  inputHandler,
  onClose,
  onCancel,
  onAnswer,
}: {
  readonly interactions: readonly InteractionView[];
  readonly width: number;
  readonly initialRequestId?: string;
  readonly inputHandler: InteractionInput;
  readonly onCancel?: () => Promise<void>;
  readonly onClose: () => void;
  readonly onAnswer: (requestId: string, decision: WireDecision) => Promise<void>;
}): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const [requestId, setRequestId] = useState<string | null>(initialRequestId ?? null);
  const [entry, setEntry] = useState<'answer' | 'reason' | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    requestId: string;
    decision: WireDecision;
    label: string;
  } | null>(null);
  const pending = useRef(false);
  const questionInput = useRef<InteractionInputHandler | null>(null);
  const request = interactions.find((item) => item.id === requestId);
  // Invalidate before input delivery, not in a passive effect after a replacement renders.
  if (confirmation && confirmation.requestId !== request?.id) setConfirmation(null);
  const options = request
    ? request.kind === 'approval'
      ? [
          'Allow once',
          'Deny',
          'Deny without reason',
          ...(request.supportedGrants ?? []).map((grant) => `Grant: ${grant}`),
        ]
      : ['Answer with text', 'Stop after resolving']
    : interactions.map((item) => `${item.kind}: ${item.title}`);

  const commit = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
      onClose();
    } catch (err) {
      pending.current = false;
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const send = async (decision: WireDecision) => {
    if (request) await commit(() => onAnswer(request.id, decision));
  };
  const confirm = (decision: WireDecision, label: string) => {
    if (request) setConfirmation({ requestId: request.id, decision, label });
  };
  const structured = Boolean(request?.kind === 'question' && request.questions?.length);
  useInteractionInput(inputHandler, (input, key) => {
    if (pending.current) return;
    if (key.ctrl && input === 'g') {
      onClose();
      return;
    }
    if (structured) {
      questionInput.current?.(input, key);
      return;
    }
    if (key.escape) {
      if (confirmation) {
        setConfirmation(null);
        return;
      }
      if (onCancel) {
        void commit(onCancel);
        return;
      }
      if (entry) {
        setEntry(null);
        setText('');
      } else if (requestId) {
        setRequestId(null);
        setSelected(0);
      } else onClose();
      return;
    }
    if (entry || confirmation || key.ctrl || key.meta) return;
    if (request?.kind === 'approval') {
      // A denial shortcut and its reason can arrive in one terminal input chunk.
      // Carry the exact suffix into the reason editor; affirmative shortcuts only select.
      if (input[0]?.toLowerCase() === 'n') {
        setEntry('reason');
        setText(input.slice(1));
        return;
      }
      if (input.toLowerCase() === 'y') {
        confirm({ kind: 'allow' }, 'Allow once');
        return;
      }
    }
    if (key.upArrow) {
      setSelected((index) => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((index) => Math.min(Math.max(0, options.length - 1), index + 1));
      return;
    }
    const number = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
    if (!key.return && number < 0) return;
    const index = number >= 0 ? number : selected;
    if (index >= options.length) return;
    if (!requestId) {
      setRequestId(interactions[index]?.id ?? null);
      setSelected(0);
      return;
    }
    if (!request) {
      setError('This request is no longer pending. Press Escape to return.');
      return;
    }
    if (request.kind === 'approval') {
      if (index === 0) confirm({ kind: 'allow' }, 'Allow once');
      else if (index === 1) {
        setEntry('reason');
        setText('');
      } else if (index === 2) void send({ kind: 'deny' });
      else {
        const grant = request.supportedGrants?.[index - 3];
        if (grant) confirm({ kind: 'grant', grant }, `Grant: ${grant}`);
      }
    } else if (index === 0) {
      setEntry('answer');
      setText('');
    } else void send({ kind: 'answer', answer: '', stopAfterApprovalResolution: true }).catch(() => {});
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {request?.kind === 'approval'
          ? 'Allow this action?'
          : request
          ? `Question: ${request.title}`
          : 'Pending interactions'}
      </Text>
      {request?.kind === 'approval' ? <Text>{request.title}</Text> : null}
      {request?.owner ? <Text>Owner: {request.owner}</Text> : null}
      {request?.detail ? <Text>{request.detail}</Text> : null}
      {requestId && !request ? <Text>Request no longer pending.</Text> : null}
      {confirmation && request?.id === confirmation.requestId ? (
        <ApprovalConfirmation
          key={request.id}
          label={confirmation.label}
          width={width}
          busy={busy}
          onConfirm={() => send(confirmation.decision)}
        />
      ) : null}
      {structured && request?.questions ? (
        <Questions
          inputHandler={questionInput}
          key={request.id}
          questions={request.questions}
          width={width}
          active={!busy}
          onBack={() => {
            if (onCancel) void commit(onCancel);
            else {
              setRequestId(null);
              setSelected(0);
            }
          }}
          onAnswer={send}
        />
      ) : null}
      {!structured &&
        !entry &&
        !confirmation &&
        options.map((option, index) => (
          <Text key={index}>
            {selected === index ? '❯' : ' '} {index + 1}. {option}
          </Text>
        ))}
      {!structured && entry ? (
        <Box flexDirection="column">
          <Text>
            {entry === 'reason'
              ? `Why?${onCancel ? ' (or Esc to cancel)' : ' (or Esc to go back)'} · Enter without a reason`
              : 'Your answer:'}
          </Text>
          <MultilineInput
            value={text}
            onChange={setText}
            width={Math.max(1, width - 6)}
            isActive={!busy}
            ignoreInput={(input, key) => busy || key.escape || (key.ctrl && input === 'g')}
            onSubmit={(value) => {
              if (!value.trim() && entry !== 'reason') {
                setError('Enter an answer or press Escape to go back.');
                return;
              }
              void send(
                entry === 'reason'
                  ? value.trim()
                    ? { kind: 'deny', reason: value }
                    : { kind: 'deny' }
                  : { kind: 'answer', answer: value },
              ).catch(() => {});
            }}
          />
        </Box>
      ) : null}
      {error ? <Text>{error}</Text> : null}
      <Text>Ctrl+G return to composer</Text>
      {!structured && !confirmation ? (
        <Text>
          {request?.kind === 'approval' ? 'y select allow · n deny · ' : ''}↑/↓ select · Enter choose · Esc{' '}
          {onCancel ? 'cancel' : 'back'}
        </Text>
      ) : null}
    </Box>
  );
}

/** Fresh per mounted request/action; queued input cannot predict this explicit confirmation.
 * This prevents accidental typeahead, not malicious terminal control or a guessing attacker.
 */
function ApprovalConfirmation({
  label,
  width,
  busy,
  onConfirm,
}: {
  readonly label: string;
  readonly width: number;
  readonly busy: boolean;
  readonly onConfirm: () => Promise<void>;
}): React.ReactElement {
  const [code] = useState(() => randomBytes(3).toString('hex'));
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const consumed = useRef(false);
  return (
    <Box flexDirection="column">
      <Text>
        {label}: type {code} then Enter to confirm (Esc back, Ctrl+G composer).
      </Text>
      <Text>Request-specific confirmation prevents accidental typeahead.</Text>
      <MultilineInput
        value={value}
        onChange={setValue}
        width={Math.max(1, width - 6)}
        isActive={!busy}
        ignoreInput={(input, key) => busy || key.escape || (key.ctrl && input === 'g')}
        onSubmit={(answer) => {
          if (consumed.current) return;
          if (answer !== code) {
            setValue('');
            setError(true);
            return;
          }
          consumed.current = true;
          void onConfirm();
        }}
      />
      {error ? <Text>Confirmation did not match. Type the displayed code exactly.</Text> : null}
    </Box>
  );
}
