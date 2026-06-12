export interface InputSurgeStats {
  messageCount: number;
  totalSerializedBytes: number;
  duplicateToolCallSignatures: number;
  maxDuplicateToolCallSignatureCount: number;
}

export interface InputSurgeGuardConfig {
  maxDuplicateToolCallSignatureCount: number;
  minDuplicateToolCallSignaturesForBlock: number;
}

export interface InputSurgeDecision {
  action: 'allow' | 'block';
  reason?: string;
  stats: InputSurgeStats;
  previousStats?: InputSurgeStats;
}

export type InputSurgeInputKind = 'delta' | 'full_history';

export interface InputSurgeInspectOptions {
  kind?: InputSurgeInputKind;
  preview?: boolean;
}

export interface InputSurgeRecordOptions extends InputSurgeInspectOptions {
  previousInput?: unknown;
}

export const DEFAULT_INPUT_SURGE_GUARD_CONFIG: InputSurgeGuardConfig = {
  maxDuplicateToolCallSignatureCount: 4,
  minDuplicateToolCallSignaturesForBlock: 20,
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const toolCallSignature = (item: unknown): string | null => {
  const record = asRecord(item);
  if (!record) {
    return null;
  }

  const raw = asRecord(record.rawItem) ?? record;
  const callId = raw.callId ?? raw.call_id ?? raw.tool_call_id;
  const type = raw.type;
  if (typeof callId !== 'string' || !callId || typeof type !== 'string' || !type) {
    return null;
  }

  return `${type}:${callId}`;
};

const toolCallRecord = (item: unknown): { callId: string; type: string } | null => {
  const record = asRecord(item);
  if (!record) {
    return null;
  }

  const raw = asRecord(record.rawItem) ?? record;
  const callId = raw.callId ?? raw.call_id ?? raw.tool_call_id;
  const type = raw.type;
  if (typeof callId !== 'string' || !callId || typeof type !== 'string' || !type) {
    return null;
  }

  return { callId, type };
};

const serializedBytes = (input: unknown): number => {
  try {
    const serialized = JSON.stringify(input);
    return Buffer.byteLength(serialized ?? String(input));
  } catch {
    return Buffer.byteLength(String(input));
  }
};

export const collectInputSurgeStats = (input: unknown): InputSurgeStats => {
  const items = Array.isArray(input) ? input : [input];
  const toolCallCounts = new Map<string, number>();

  for (const item of items) {
    const signature = toolCallSignature(item);
    if (!signature) {
      continue;
    }
    toolCallCounts.set(signature, (toolCallCounts.get(signature) ?? 0) + 1);
  }

  const duplicateCounts = [...toolCallCounts.values()].filter((count) => count > 1);

  return {
    messageCount: items.length,
    totalSerializedBytes: serializedBytes(input),
    duplicateToolCallSignatures: duplicateCounts.length,
    maxDuplicateToolCallSignatureCount: duplicateCounts.length > 0 ? Math.max(...duplicateCounts) : 0,
  };
};

export const collectDuplicateToolCallResultPairs = (input: unknown): { pairs: number; maxCopies: number } => {
  const items = Array.isArray(input) ? input : [input];
  const calls = new Map<string, number>();
  const results = new Map<string, number>();

  for (const item of items) {
    const record = toolCallRecord(item);
    if (!record) {
      continue;
    }

    if (record.type === 'function_call') {
      calls.set(record.callId, (calls.get(record.callId) ?? 0) + 1);
    }
    if (record.type === 'function_call_result') {
      results.set(record.callId, (results.get(record.callId) ?? 0) + 1);
    }
  }

  let pairs = 0;
  let maxCopies = 0;
  for (const [callId, callCount] of calls) {
    const copies = Math.min(callCount, results.get(callId) ?? 0);
    if (copies < 2) {
      continue;
    }
    pairs++;
    maxCopies = Math.max(maxCopies, copies);
  }

  return { pairs, maxCopies };
};

export class InputSurgeGuard {
  #config: InputSurgeGuardConfig;

  constructor(config: Partial<InputSurgeGuardConfig> = {}) {
    this.#config = { ...DEFAULT_INPUT_SURGE_GUARD_CONFIG, ...config };
  }

  reset(): void {}

  inspect(input: unknown, _options: InputSurgeInspectOptions = {}): InputSurgeDecision {
    const stats = collectInputSurgeStats(input);

    const duplicatePairs = collectDuplicateToolCallResultPairs(input);
    if (duplicatePairs.pairs >= 3 && duplicatePairs.maxCopies >= 2) {
      return {
        action: 'block',
        reason: `Detected replayed tool call/result pairs: ${duplicatePairs.pairs} duplicated pairs, max repetition ${duplicatePairs.maxCopies}.`,
        stats,
      };
    }

    if (
      stats.maxDuplicateToolCallSignatureCount >= this.#config.maxDuplicateToolCallSignatureCount &&
      stats.duplicateToolCallSignatures >= this.#config.minDuplicateToolCallSignaturesForBlock
    ) {
      return {
        action: 'block',
        reason: `Detected replayed tool-call history: ${stats.duplicateToolCallSignatures} duplicated tool-call signatures, max repetition ${stats.maxDuplicateToolCallSignatureCount}.`,
        stats,
      };
    }

    return { action: 'allow', stats };
  }

  recordSuccessfulInput(_input: unknown, _options: InputSurgeRecordOptions = {}): void {}
}
