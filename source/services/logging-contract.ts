import { z } from 'zod';

export const LOG_CATEGORIES = ['provider', 'tool', 'stream', 'approval', 'retry', 'general'] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

const LOG_PHASES = [
  'request_start',
  'provider_response',
  'normalization',
  'validation',
  'approval',
  'execution',
  'retry',
  'abort',
  'runtime',
] as const;

export const RuntimeLogSchema = z
  .object({
    timestamp: z.string().min(1),
    level: z.string().min(1),
    eventType: z.string().min(1),
    traceId: z.string().min(1),
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    phase: z.enum(LOG_PHASES),
    toolName: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    retryType: z.string().min(1).optional(),
    retryAttempt: z.number().int().nonnegative().optional(),
    errorCode: z.string().min(1).optional(),
    errorMessage: z.string().min(1).optional(),
    payloadRef: z.string().min(1).optional(),
    category: z.enum(LOG_CATEGORIES).optional(),
  })
  .passthrough();

const looksLikeUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const EVENT_CATEGORY_PREFIXES: Array<{ prefix: string; category: LogCategory }> = [
  { prefix: 'provider.', category: 'provider' },
  { prefix: 'tool_call.', category: 'tool' },
  { prefix: 'tool.', category: 'tool' },
  { prefix: 'stream.', category: 'stream' },
  { prefix: 'approval.', category: 'approval' },
  { prefix: 'retry.', category: 'retry' },
];

export const resolveLogCategory = ({
  eventType,
  explicitCategory,
}: {
  eventType?: unknown;
  explicitCategory?: unknown;
}): LogCategory => {
  if (typeof explicitCategory === 'string' && LOG_CATEGORIES.includes(explicitCategory as LogCategory)) {
    return explicitCategory as LogCategory;
  }

  if (typeof eventType !== 'string' || !eventType.trim()) {
    return 'general';
  }

  for (const entry of EVENT_CATEGORY_PREFIXES) {
    if (eventType.startsWith(entry.prefix)) {
      return entry.category;
    }
  }

  return 'general';
};

const toNonEmptyString = (value: unknown, fallback: string): string => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return fallback;
};

const toPhase = (value: unknown): (typeof LOG_PHASES)[number] => {
  if (typeof value === 'string' && (LOG_PHASES as readonly string[]).includes(value)) {
    return value as (typeof LOG_PHASES)[number];
  }
  return 'runtime';
};

const buildMessageId = (meta: Record<string, unknown>): string => {
  const candidate = meta.messageId;
  if (typeof candidate === 'string' && candidate.trim()) {
    return candidate.trim();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

export const buildRuntimeLogRecord = ({
  timestamp,
  level,
  correlationId,
  meta = {},
}: {
  timestamp?: string;
  level: string;
  correlationId?: string;
  meta?: Record<string, unknown>;
}): Record<string, unknown> => {
  const traceCandidate = toNonEmptyString((meta.traceId as string | undefined) ?? correlationId, 'trace-unknown');
  const eventType = toNonEmptyString(meta.eventType, 'log.message');
  const category = resolveLogCategory({ eventType, explicitCategory: meta.category });
  const provider = toNonEmptyString(meta.provider, 'unknown');
  const model = toNonEmptyString(meta.model, 'unknown');

  const record: Record<string, unknown> = {
    ...meta,
    timestamp: timestamp ?? new Date().toISOString(),
    level,
    eventType,
    traceId: traceCandidate,
    sessionId: toNonEmptyString(meta.sessionId, 'session-unknown'),
    messageId: buildMessageId(meta),
    provider,
    model,
    phase: toPhase(meta.phase),
    category,
  };

  if (!looksLikeUuid(traceCandidate) && correlationId && looksLikeUuid(correlationId)) {
    record.traceId = correlationId;
  }

  return record;
};

export const parseCategoryFilter = (raw: string | undefined): Set<LogCategory> | null => {
  if (!raw || !raw.trim()) {
    return null;
  }

  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is LogCategory => LOG_CATEGORIES.includes(part as LogCategory));

  if (!values.length) {
    return null;
  }

  return new Set(values);
};

export const shouldLogForCategory = ({
  level,
  category,
  enabledCategories,
}: {
  level: string;
  category: LogCategory;
  enabledCategories: Set<LogCategory> | null;
}): boolean => {
  if (!enabledCategories || enabledCategories.size === 0) {
    return true;
  }

  if (level === 'error' || level === 'warn') {
    return true;
  }

  return enabledCategories.has(category);
};

export const shouldIncludeVerbosePayload = ({
  level,
  verbosePayloads,
}: {
  level: string;
  verbosePayloads: boolean;
}): boolean => {
  if (verbosePayloads) {
    return true;
  }
  return level === 'error';
};

export const shouldSampleLog = ({
  level,
  sampleRate,
  randomValue,
}: {
  level: string;
  sampleRate: number;
  randomValue: number;
}): boolean => {
  if (level === 'error' || level === 'warn') {
    return true;
  }

  if (!Number.isFinite(sampleRate) || sampleRate >= 1) {
    return true;
  }

  if (sampleRate <= 0) {
    return false;
  }

  return randomValue <= sampleRate;
};

export const createInvalidToolCallDiagnostic = ({
  toolName,
  toolCallId,
  rawPayload,
  normalizedToolCall,
  validationErrors,
  traceId,
  retryContext,
}: {
  toolName: string;
  toolCallId: string;
  rawPayload: string;
  normalizedToolCall: Record<string, unknown>;
  validationErrors: string[];
  traceId: string;
  retryContext: Record<string, unknown>;
}): Record<string, unknown> => {
  return {
    eventType: 'tool_call.parse_failed',
    category: 'tool',
    phase: 'validation',
    errorCode: 'INVALID_TOOL_CALL_FORMAT',
    errorMessage: 'Invalid tool call argument payload',
    toolName,
    toolCallId,
    traceId,
    rawPayloadSnippet: rawPayload.slice(0, 500),
    normalizedToolCall,
    validationErrors,
    retryContext,
  };
};
