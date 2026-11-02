import React, { useRef, useState } from 'react';
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
  const pending = useRef(false);
  const questionInput = useRef<InteractionInputHandler | null>(null);
  const request = interactions.find((item) => item.id === requestId);
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
    if (entry || key.ctrl || key.meta) return;
    if (request?.kind === 'approval') {
      // A denial shortcut and its reason can arrive in one terminal input chunk.
      // Carry the exact suffix into the reason editor; approval stays single-key.
      if (input[0]?.toLowerCase() === 'n') {
        setEntry('reason');
        setText(input.slice(1));
        return;
      }
      if (input.toLowerCase() === 'y') {
        void send({ kind: 'allow' });
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
      if (index === 0) void send({ kind: 'allow' }).catch(() => {});
      else if (index === 1) {
        setEntry('reason');
        setText('');
      } else if (index === 2) void send({ kind: 'deny' });
      else {
        const grant = request.supportedGrants?.[index - 3];
        if (grant) void send({ kind: 'grant', grant }).catch(() => {});
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
      {!structured ? (
        <Text>
          {request?.kind === 'approval' ? 'y allow once · n deny · ' : ''}↑/↓ select · Enter choose · Esc{' '}
          {onCancel ? 'cancel' : 'back'}
        </Text>
      ) : null}
    </Box>
  );
}
