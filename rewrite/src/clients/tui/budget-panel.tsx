import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { WireBudgetDecision, WireBudgetRequest } from '../../protocol/direct-wire.js';

/** User-owned resolution of a specific Session budget request; no automatic grants. */
export function BudgetPanel({ requests, onClose, onAnswer }: {
  readonly requests: readonly WireBudgetRequest[];
  readonly onClose: () => void;
  readonly onAnswer: (id: string, decision: WireBudgetDecision) => Promise<void>;
}): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [action, setAction] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const request = requests.find(item => item.requestId === requestId);
  const labels = ['Extend budget', 'Stop'];
  const send = async (index: number) => {
    if (!request || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await onAnswer(request.requestId, index === 0 ? { kind: 'extend', grantedBy: 'human' } : { kind: 'stop' }); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { pending.current = false; setBusy(false); }
  };
  useInput((input, key) => {
    if (busy) return;
    if (key.escape) { if (requestId) { setRequestId(null); setSelected(0); } else onClose(); return; }
    if (key.upArrow) { if (requestId) setAction(0); else setSelected(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { if (requestId) setAction(1); else setSelected(i => Math.min(Math.max(0, requests.length - 1), i + 1)); return; }
    const number = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
    if (!key.return && number < 0) return;
    const index = number < 0 ? (requestId ? action : selected) : number;
    if (requestId) { if (!request) setError('Budget request is no longer pending.'); else if (index < labels.length) void send(index); }
    else if (requests[index]) { setRequestId(requests[index].requestId); setAction(0); }
  });
  const evidence = request?.evidence;
  return <Box flexDirection="column" borderStyle="round" paddingX={1}>
    <Text bold>{request ? `Budget request · turn ${request.turnId}` : 'Pending budget decisions'}</Text>
    {evidence?.type === 'budget_stage' ? <Text>{evidence.stage}: {evidence.evidence.dimension} used {evidence.evidence.used}, limit {evidence.evidence.limit}, headroom {evidence.evidence.headroom}</Text> : null}
    {evidence?.type === 'tool_stall' ? <Text>Tool stall: {evidence.toolName} ({evidence.count}/{evidence.threshold})\n{evidence.argumentsText}</Text> : null}
    {requestId && !request ? <Text>Budget request is no longer pending.</Text> : null}
    {(requestId ? labels : requests.map(item => `Turn ${item.turnId} · ${item.evidence.type}`)).map((label, index) =>
      <Text key={index}>{index === (requestId ? action : selected) ? '❯' : ' '} {index + 1}. {label}</Text>)}
    {error ? <Text>{error}</Text> : null}
    <Text>↑/↓ select · Enter choose · Esc back</Text>
  </Box>;
}
