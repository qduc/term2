export interface InputSurgeStats {
  messageCount: number;
  totalSerializedBytes: number;
  duplicateToolCallSignatures: number;
  maxDuplicateToolCallSignatureCount: number;
}

export interface InputSurgeGuardConfig {
  maxMessageGrowthRatio: number;
  minMessageGrowthForRatioBlock: number;
  maxSerializedByteGrowthRatio: number;
  minSerializedByteGrowthForRatioBlock: number;
  maxDuplicateToolCallSignatureCount: number;
  minDuplicateToolCallSignaturesForBlock: number;
}

export interface InputSurgeDecision {
  action: 'allow' | 'block';
  reason?: string;
  stats: InputSurgeStats;
  previousStats?: InputSurgeStats;
}

export const DEFAULT_INPUT_SURGE_GUARD_CONFIG: InputSurgeGuardConfig = {
  maxMessageGrowthRatio: 3,
  minMessageGrowthForRatioBlock: 100,
  maxSerializedByteGrowthRatio: 5,
  minSerializedByteGrowthForRatioBlock: 100_000,
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

export class InputSurgeGuard {
  #lastSuccessfulStats: InputSurgeStats | null = null;
  #config: InputSurgeGuardConfig;

  constructor(config: Partial<InputSurgeGuardConfig> = {}) {
    this.#config = { ...DEFAULT_INPUT_SURGE_GUARD_CONFIG, ...config };
  }

  reset(): void {
    this.#lastSuccessfulStats = null;
  }

  inspect(input: unknown): InputSurgeDecision {
    const stats = collectInputSurgeStats(input);
    const previousStats = this.#lastSuccessfulStats ?? undefined;

    if (
      previousStats &&
      stats.messageCount - previousStats.messageCount >= this.#config.minMessageGrowthForRatioBlock &&
      stats.messageCount > previousStats.messageCount * this.#config.maxMessageGrowthRatio
    ) {
      return {
        action: 'block',
        reason: `Outgoing message count jumped from ${previousStats.messageCount} to ${stats.messageCount}.`,
        stats,
        previousStats,
      };
    }

    if (
      previousStats &&
      stats.totalSerializedBytes - previousStats.totalSerializedBytes >=
        this.#config.minSerializedByteGrowthForRatioBlock &&
      stats.totalSerializedBytes > previousStats.totalSerializedBytes * this.#config.maxSerializedByteGrowthRatio
    ) {
      return {
        action: 'block',
        reason: `Outgoing input size jumped from ${previousStats.totalSerializedBytes} to ${stats.totalSerializedBytes} bytes.`,
        stats,
        previousStats,
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
        previousStats,
      };
    }

    return { action: 'allow', stats, previousStats };
  }

  recordSuccessfulInput(input: unknown): void {
    this.#lastSuccessfulStats = collectInputSurgeStats(input);
  }
}
