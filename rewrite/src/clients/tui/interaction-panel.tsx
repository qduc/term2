import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultilineInput } from 'ink-prompt';
import type { WireDecision } from '../../protocol/direct-wire.js';
import type { InteractionView } from './state.js';
import { Questions } from './questions.js';

/** Keyboard-operated request picker; all decisions remain pinned to request IDs. */
export function InteractionPanel({ interactions, width, onClose, onAnswer }: {
  readonly interactions: readonly InteractionView[];
  readonly width: number;
  readonly onClose: () => void;
  readonly onAnswer: (requestId: string, decision: WireDecision) => Promise<void>;
}): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [entry, setEntry] = useState<'answer' | 'reason' | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = interactions.find(item => item.id === requestId);
  const options = request ? (request.kind === 'approval'
    ? ['Allow', 'Deny', 'Deny with reason', ...(request.supportedGrants ?? []).map(grant => `Grant: ${grant}`)]
    : ['Answer with text', 'Stop after resolving']) : interactions.map(item => `${item.kind}: ${item.title}`);

  const send = async (decision: WireDecision) => {
    if (!request || busy) return;
    setBusy(true); setError(null);
    try { await onAnswer(request.id, decision); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); throw err; }
    finally { setBusy(false); }
  };
  const structured = Boolean(request?.kind === 'question' && request.questions?.length);
  useInput((input, key) => {
    if (busy) return;
    if (key.escape) {
      if (entry) { setEntry(null); setText(''); }
      else if (requestId) { setRequestId(null); setSelected(0); }
      else onClose();
      return;
    }
    if (entry) return;
    if (key.upArrow) { setSelected(index => Math.max(0, index - 1)); return; }
    if (key.downArrow) { setSelected(index => Math.min(Math.max(0, options.length - 1), index + 1)); return; }
    const number = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
    if (!key.return && number < 0) return;
    const index = number >= 0 ? number : selected;
    if (index >= options.length) return;
    if (!requestId) { setRequestId(interactions[index]?.id ?? null); setSelected(0); return; }
    if (!request) { setError('This request is no longer pending. Press Escape to return.'); return; }
    if (request.kind === 'approval') {
      if (index === 0) void send({ kind: 'allow' }).catch(() => {});
      else if (index === 1) void send({ kind: 'deny' }).catch(() => {});
      else if (index === 2) { setEntry('reason'); setText(''); }
      else { const grant = request.supportedGrants?.[index - 3]; if (grant) void send({ kind: 'grant', grant }).catch(() => {}); }
    } else if (index === 0) { setEntry('answer'); setText(''); }
    else void send({ kind: 'answer', answer: '', stopAfterApprovalResolution: true }).catch(() => {});
  }, { isActive: !structured });

  return <Box flexDirection="column" borderStyle="round" paddingX={1}>
    <Text bold>{request ? `${request.kind}: ${request.title}` : 'Pending interactions'}</Text>
    {request?.owner ? <Text>Owner: {request.owner}</Text> : null}
    {request?.detail ? <Text>{request.detail}</Text> : null}
    {requestId && !request ? <Text>Request no longer pending.</Text> : null}
    {structured && request?.questions ? <Questions key={request.id} questions={request.questions} width={width} onBack={() => { setRequestId(null); setSelected(0); }} onAnswer={send} /> : null}
    {!structured && !entry && options.map((option, index) => <Text key={index}>{selected === index ? '❯' : ' '} {index + 1}. {option}</Text>)}
    {!structured && entry ? <Box flexDirection="column">
      <Text>{entry === 'reason' ? 'Rejection reason:' : 'Your answer:'}</Text>
      <MultilineInput value={text} onChange={setText} width={Math.max(1, width - 6)} isActive={!busy}
        ignoreInput={(_input, key) => key.escape}
        onSubmit={value => {
          if (!value.trim()) { setError('Enter text or press Escape to go back.'); return; }
          void send(entry === 'reason' ? { kind: 'deny', reason: value } : { kind: 'answer', answer: value }).catch(() => {});
        }} />
    </Box> : null}
    {error ? <Text>{error}</Text> : null}
    {!structured ? <Text>↑/↓ select · Enter choose · Esc back</Text> : null}
  </Box>;
}
