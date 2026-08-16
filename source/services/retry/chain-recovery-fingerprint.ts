const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const itemType = (item: unknown): string => {
  const record = asRecord(item);
  const raw = record ? asRecord(record.rawItem) ?? record : null;
  return typeof raw?.type === 'string' ? raw.type : 'unknown';
};

const itemCallId = (item: unknown): string => {
  const record = asRecord(item);
  const raw = record ? asRecord(record.rawItem) ?? record : null;
  const callId = raw?.call_id ?? raw?.callId ?? raw?.tool_call_id ?? raw?.id;
  return typeof callId === 'string' ? callId : '';
};

export type ChainRequestFingerprintInput = {
  provider: string;
  model: string;
  previousResponseId?: string | null;
  input: readonly unknown[];
  recoveryClass: string;
};

/** Stable identity of a rejected chain-state request. Never includes text or tool output bodies. */
export function fingerprintChainRequest(input: ChainRequestFingerprintInput): string {
  return JSON.stringify({
    provider: input.provider,
    model: input.model,
    previousResponseId: input.previousResponseId ?? null,
    itemKeys: input.input.map((item) => `${itemType(item)}:${itemCallId(item)}`),
    recoveryClass: input.recoveryClass,
  });
}
