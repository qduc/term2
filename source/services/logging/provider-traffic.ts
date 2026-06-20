import fs from 'node:fs';
import path from 'node:path';

export const TRAFFIC_TEXT_LIMIT = 100;
const PREVIEW_LIMIT = 160;

export type { SessionTrafficContext } from '../service-interfaces.js';
import type {
  ILoggingService,
  ISessionContextService,
  IProviderTraffic,
  ProviderTrafficRequest,
  ProviderTrafficResponse,
} from '../service-interfaces.js';

export type SentTrafficRecord = {
  requestId: string;
  timestamp: string;
  provider: string;
  model: string;
  modelClass?: string;
  modelWrapperClass?: string;
  sessionId: string;
  sessionStartedAt: string;
  mode?: string;
  firstUserMessagePreview?: string;
  sentBody: Record<string, unknown>;
};

export type ReceivedTrafficSummary = {
  transport: 'json' | 'sse' | 'websocket' | 'text' | 'unknown';
  status: number;
  errorFrames: Array<Record<string, unknown>>;
  malformedFrames: Array<{ raw: string; error: string }>;
  unknownFrames: Array<{
    signature: string;
    count: number;
    firstRaw: string;
    lastRaw: string;
  }>;
  fallbackBody?: unknown;
  payload?: unknown;
};

export type DailySessionIndexEntry = {
  sessionId: string;
  sessionDir: string;
  firstRequestAt: string;
  lastRequestAt: string;
  requestCount: number;
  firstUserMessagePreview: string;
  latestProvider: string;
  latestModel: string;
  providersSeen: string[];
  modelsSeen: string[];
  latestMode: string;
  modesSeen: string[];
};

type TrafficEnvelope = {
  sent: Record<string, unknown>;
  received: Record<string, unknown>;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

const truncateTrafficText = (text: string): string => {
  if (text.length <= TRAFFIC_TEXT_LIMIT) return text;
  const omitted = text.length - TRAFFIC_TEXT_LIMIT;
  return `${text.slice(0, TRAFFIC_TEXT_LIMIT)}[omitted ${omitted} chars]`;
};

const normalizePreview = (text: string | undefined): string => {
  const normalized = normalizeWhitespace(text ?? '');
  if (normalized.length <= PREVIEW_LIMIT) return normalized;
  return normalized.slice(0, PREVIEW_LIMIT);
};

const sanitizeContentArray = (content: unknown[]): unknown[] =>
  content.map((item) => {
    const record = asRecord(item);
    if (!record) return item;
    if (record.type === 'text' && typeof record.text === 'string') {
      return { ...record, text: truncateTrafficText(record.text) };
    }
    return item;
  });

const sanitizeInstructionLikeValue = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return truncateTrafficText(value);
  }
  if (Array.isArray(value)) {
    return sanitizeContentArray(value);
  }
  return value;
};

const sanitizeToolDefinitions = (tools: unknown): unknown => {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    const record = asRecord(tool);
    if (!record) return tool;
    const fn = asRecord(record.function);
    if (typeof fn?.name === 'string') return fn.name;
    if (typeof record.name === 'string') return record.name;
    if (typeof record.type === 'string') return record.type;
    return 'unknown-tool';
  });
};

const sanitizeReasoningDetails = (reasoningDetails: unknown): unknown => {
  if (!Array.isArray(reasoningDetails)) return reasoningDetails;
  return reasoningDetails.map((item) => {
    const record = asRecord(item);
    if (!record) return item;
    if (record.type === 'reasoning.encrypted' && typeof record.data === 'string') {
      return { ...record, data: '' };
    }
    return item;
  });
};

const sanitizeMessageContent = (message: Record<string, unknown>): Record<string, unknown> => {
  const sanitizedMessage = Object.prototype.hasOwnProperty.call(message, 'reasoning_details')
    ? { ...message, reasoning_details: sanitizeReasoningDetails(message.reasoning_details) }
    : message;
  const role = typeof message.role === 'string' ? message.role : undefined;
  if (role !== 'system' && role !== 'developer') return sanitizedMessage;
  if (!Object.prototype.hasOwnProperty.call(message, 'content')) return sanitizedMessage;
  const content = message.content;
  if (Array.isArray(content)) {
    return { ...sanitizedMessage, content: sanitizeContentArray(content) };
  }
  return { ...sanitizedMessage, content: sanitizeInstructionLikeValue(content) };
};

const emptyTrafficRecord = (): Record<string, unknown> => ({});

const parseTrafficEnvelope = (requestPath: string): TrafficEnvelope => {
  if (!fs.existsSync(requestPath)) {
    return { sent: emptyTrafficRecord(), received: emptyTrafficRecord() };
  }

  const raw = fs.readFileSync(requestPath, 'utf8').trim();
  if (!raw) {
    return { sent: emptyTrafficRecord(), received: emptyTrafficRecord() };
  }

  const parsed = asRecord(tryParseJson(raw));
  if (
    parsed &&
    (Object.prototype.hasOwnProperty.call(parsed, 'sent') || Object.prototype.hasOwnProperty.call(parsed, 'received'))
  ) {
    return {
      sent: asRecord(parsed.sent) ?? emptyTrafficRecord(),
      received: asRecord(parsed.received) ?? emptyTrafficRecord(),
    };
  }

  const legacyBlocks = raw
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  return {
    sent: asRecord(tryParseJson(legacyBlocks[0] ?? '')) ?? emptyTrafficRecord(),
    received: asRecord(tryParseJson(legacyBlocks[1] ?? '')) ?? emptyTrafficRecord(),
  };
};

const writeTrafficEnvelope = (requestPath: string, envelope: TrafficEnvelope): void => {
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  fs.writeFileSync(requestPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
};

export const sanitizeSentTrafficBody = (body: Record<string, unknown>): Record<string, unknown> => {
  const sanitized: Record<string, unknown> = { ...body };

  if (Object.prototype.hasOwnProperty.call(sanitized, 'instructions')) {
    sanitized.instructions = sanitizeInstructionLikeValue(sanitized.instructions);
  }

  if (Object.prototype.hasOwnProperty.call(sanitized, 'system')) {
    sanitized.system = sanitizeInstructionLikeValue(sanitized.system);
  }

  if (Array.isArray(sanitized.messages)) {
    sanitized.messages = sanitized.messages.map((item) => {
      const record = asRecord(item);
      return record ? sanitizeMessageContent(record) : item;
    });
  }

  if (Array.isArray(sanitized.input)) {
    sanitized.input = sanitized.input.map((item) => {
      const record = asRecord(item);
      if (!record) return item;
      const role = typeof record.role === 'string' ? record.role : undefined;
      const type = typeof record.type === 'string' ? record.type : undefined;
      if (role === 'system' || role === 'developer' || type === 'message') {
        return sanitizeMessageContent(record);
      }
      return item;
    });
  }

  if (Object.prototype.hasOwnProperty.call(sanitized, 'tools')) {
    sanitized.tools = sanitizeToolDefinitions(sanitized.tools);
  }

  return sanitized;
};

const safeTimestampForPath = (timestamp: string): string => timestamp.replace(/:/g, '-');

const safePathSegment = (segment: string): string => segment.replace(/[\\/]/g, '_');

const timePartForPath = (timestamp: string): string =>
  safeTimestampForPath(timestamp.includes('T') ? timestamp.substring(timestamp.indexOf('T') + 1) : timestamp);

const detectContentType = (response: Response): string => response.headers.get('content-type')?.toLowerCase() ?? '';

const sniffTransportFromBody = (raw: string): 'sse' | 'json' | 'text' | 'unknown' => {
  const head = raw.trimStart().slice(0, 64);
  if (!head) return 'unknown';
  if (/^(event:|data:|:)/.test(head)) return 'sse';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return 'unknown';
};

const transportFromContentType = (contentType: string): 'sse' | 'json' | 'text' | 'unknown' => {
  if (contentType.includes('text/event-stream')) return 'sse';
  if (contentType.includes('application/json')) return 'json';
  if (contentType.startsWith('text/')) return 'text';
  return 'unknown';
};

const parseToolArgumentsJson = (text: string | undefined): unknown => {
  if (!text) return undefined;
  return tryParseJson(text);
};

const getFrameSignature = (parsed: Record<string, unknown>): string => {
  const keys = Object.keys(parsed).sort();
  const choiceDelta = asRecord((parsed.choices as unknown[] | undefined)?.[0])?.delta;
  const deltaKeys = choiceDelta ? Object.keys(asRecord(choiceDelta) ?? {}).sort() : [];
  return JSON.stringify({ keys, deltaKeys });
};

const mergeStringMapValue = (map: Map<string, string>, key: string, chunk: string): void => {
  map.set(key, (map.get(key) ?? '') + chunk);
};

const decodeJsonStringFragment = (value: string): string => {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
};

const firstDefinedString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
};

const extractJsonText = (body: Record<string, unknown>): string | undefined => {
  if (typeof body.output_text === 'string') return body.output_text;
  if (typeof body.text === 'string') return body.text;
  const response = asRecord(body.response);
  if (typeof response?.output_text === 'string') return response.output_text;
  const choice = asRecord((body.choices as unknown[] | undefined)?.[0]);
  const message = asRecord(choice?.message);
  const delta = asRecord(choice?.delta);
  return firstDefinedString(message?.content, choice?.text, delta?.content, delta?.text);
};

const extractJsonReasoning = (body: Record<string, unknown>): string | undefined => {
  const choice = asRecord((body.choices as unknown[] | undefined)?.[0]);
  const delta = asRecord(choice?.delta);
  const message = asRecord(choice?.message);
  return firstDefinedString(
    body.reasoning,
    body.reasoning_text,
    delta?.reasoning,
    delta?.reasoning_text,
    message?.reasoning,
    message?.reasoning_text,
  );
};

const extractJsonToolCalls = (body: Record<string, unknown>): unknown[] => {
  const choice = asRecord((body.choices as unknown[] | undefined)?.[0]);
  const message = asRecord(choice?.message);
  const delta = asRecord(choice?.delta);
  const toolCalls = (message?.tool_calls as unknown[]) ?? (delta?.tool_calls as unknown[]) ?? [];
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls.map((item, index) => {
    const record = asRecord(item) ?? {};
    const fn = asRecord(record.function) ?? {};
    const key = firstDefinedString(record.id, String(record.index ?? index)) ?? String(index);
    const argumentsText = typeof fn.arguments === 'string' ? fn.arguments : undefined;
    return {
      key,
      name: typeof fn.name === 'string' ? fn.name : undefined,
      argumentsText,
      argumentsJson: parseToolArgumentsJson(argumentsText),
    };
  });
};

export async function summarizeReceivedTraffic(response: Response): Promise<ReceivedTrafficSummary> {
  const contentType = detectContentType(response);
  const raw = await response.text();
  let transport = transportFromContentType(contentType);
  if (transport === 'unknown' || transport === 'text') {
    const sniffed = sniffTransportFromBody(raw);
    if (sniffed !== 'unknown') transport = sniffed;
  }
  const summary: ReceivedTrafficSummary = {
    transport,
    status: response.status,
    errorFrames: [],
    malformedFrames: [],
    unknownFrames: [],
  };

  if (summary.transport === 'json') {
    const parsed = asRecord(tryParseJson(raw));
    if (!parsed) {
      summary.fallbackBody = raw;
      return summary;
    }
    const extractedText = extractJsonText(parsed);
    const extractedReasoning = extractJsonReasoning(parsed);
    const extractedToolCalls = extractJsonToolCalls(parsed);
    const extractedId = firstDefinedString(parsed.id, asRecord(parsed.response)?.id);
    if (!extractedText && !extractedReasoning && extractedToolCalls.length === 0 && !extractedId) {
      summary.fallbackBody = parsed;
    } else {
      summary.payload = parsed;
    }
    return summary;
  }

  if (summary.transport !== 'sse') {
    summary.fallbackBody = raw;
    return summary;
  }

  let sseResponseId: string | undefined;
  let sseFinishReason: string | undefined;
  let sseUsage: Record<string, unknown> | undefined;
  const outputChunks: string[] = [];
  const reasoningChunks: string[] = [];
  const toolNameByKey = new Map<string, string>();
  const toolArgsByKey = new Map<string, string>();
  const toolKeyByIndex = new Map<number, string>();
  const unknownFrameMap = new Map<string, { signature: string; count: number; firstRaw: string; lastRaw: string }>();

  const blocks = raw.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;

    const lines = block.split(/\r?\n/);
    const dataLines = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    const dataText = dataLines.join('\n');
    if (dataText === '[DONE]') continue;

    const parsed = asRecord(tryParseJson(dataText));
    if (!parsed) {
      const argMatch = dataText.match(/"arguments":"((?:\\.|[^"])*)"/);
      if (argMatch) {
        const indexMatch = dataText.match(/"index":(\d+)/);
        const index = indexMatch?.[1] ? Number.parseInt(indexMatch[1], 10) : 0;
        const key = toolKeyByIndex.get(index) ?? String(index);
        mergeStringMapValue(toolArgsByKey, key, decodeJsonStringFragment(argMatch[1]));

        const finishMatch = dataText.match(/"finish_reason":"([^"]+)"/);
        if (finishMatch?.[1]) sseFinishReason = sseFinishReason ?? finishMatch[1];
        const idMatches = [...dataText.matchAll(/"id":"([^"]+)"/g)];
        const lastId = idMatches[idMatches.length - 1]?.[1];
        if (lastId) sseResponseId = sseResponseId ?? lastId;
        continue;
      }
      summary.malformedFrames.push({ raw: dataText, error: 'invalid_json' });
      continue;
    }

    const response = asRecord(parsed.response);
    const choice = asRecord((parsed.choices as unknown[] | undefined)?.[0]);
    const delta = asRecord(choice?.delta);

    sseResponseId =
      sseResponseId ?? firstDefinedString(parsed.id, response?.id, (asRecord(choice?.message) as any)?.id);
    const usageData = asRecord(parsed.usage) ?? asRecord(response?.usage);
    if (usageData) sseUsage = usageData;
    sseFinishReason =
      sseFinishReason ??
      firstDefinedString(
        parsed.finish_reason,
        choice?.finish_reason,
        delta?.finish_reason,
        response?.status,
        parsed.status,
      );

    if (parsed.error) {
      summary.errorFrames.push(parsed);
      continue;
    }

    const eventType = typeof parsed.type === 'string' ? parsed.type : undefined;
    let recognized = false;

    const deltaText = firstDefinedString(parsed.delta, parsed.text);
    if (eventType?.includes('output_text') && typeof parsed.delta === 'string') {
      outputChunks.push(parsed.delta);
      recognized = true;
    } else if (eventType?.includes('output_text') && typeof deltaText === 'string') {
      recognized = true;
    }
    if ((eventType?.includes('reasoning') || eventType?.includes('summary')) && typeof parsed.delta === 'string') {
      reasoningChunks.push(parsed.delta);
      recognized = true;
    } else if ((eventType?.includes('reasoning') || eventType?.includes('summary')) && typeof deltaText === 'string') {
      recognized = true;
    }
    if (eventType?.includes('function_call_arguments') && typeof parsed.delta === 'string') {
      const key = firstDefinedString(parsed.item_id, parsed.call_id, parsed.id) ?? String(toolArgsByKey.size);
      mergeStringMapValue(toolArgsByKey, key, parsed.delta);
      recognized = true;
    }
    if (eventType?.includes('completed') || eventType?.includes('done')) {
      recognized = true;
    }
    if (eventType?.includes('content_part')) {
      recognized = true;
    }
    const outputItem = asRecord(parsed.item);
    if (eventType?.includes('output_item') && outputItem) {
      if (outputItem.type === 'function_call') {
        const name = typeof outputItem.name === 'string' ? outputItem.name : undefined;
        if (name) {
          if (typeof outputItem.id === 'string') toolNameByKey.set(outputItem.id, name);
          if (typeof outputItem.call_id === 'string') toolNameByKey.set(outputItem.call_id, name);
        }
      }
      recognized = true;
    }

    const toolCalls = Array.isArray(delta?.tool_calls) ? (delta?.tool_calls as unknown[]) : [];
    if (typeof delta?.content === 'string') {
      outputChunks.push(delta.content);
      recognized = true;
    }
    if (typeof delta?.reasoning === 'string') {
      reasoningChunks.push(delta.reasoning);
      recognized = true;
    }
    if (typeof delta?.reasoning_text === 'string') {
      reasoningChunks.push(delta.reasoning_text);
      recognized = true;
    }
    if (typeof delta?.reasoning_content === 'string') {
      reasoningChunks.push(delta.reasoning_content);
      recognized = true;
    }
    for (const toolCall of toolCalls) {
      const toolCallRecord = asRecord(toolCall) ?? {};
      const fn = asRecord(toolCallRecord.function) ?? {};
      const frameId = typeof toolCallRecord.id === 'string' && toolCallRecord.id ? toolCallRecord.id : undefined;
      const frameIndex = typeof toolCallRecord.index === 'number' ? toolCallRecord.index : undefined;
      const key =
        frameId ?? (frameIndex !== undefined ? toolKeyByIndex.get(frameIndex) : undefined) ?? String(frameIndex ?? 0);
      if (frameIndex !== undefined) {
        toolKeyByIndex.set(frameIndex, key);
      }
      if (typeof fn.name === 'string') toolNameByKey.set(key, fn.name);
      if (typeof fn.arguments === 'string') mergeStringMapValue(toolArgsByKey, key, fn.arguments);
      recognized = true;
    }

    const message = asRecord(choice?.message);
    if (Array.isArray(message?.tool_calls)) {
      for (const toolCall of message.tool_calls as unknown[]) {
        const toolCallRecord = asRecord(toolCall) ?? {};
        const fn = asRecord(toolCallRecord.function) ?? {};
        const key = firstDefinedString(toolCallRecord.id, String(toolCallRecord.index ?? 0)) ?? '0';
        if (typeof fn.name === 'string') toolNameByKey.set(key, fn.name);
        if (typeof fn.arguments === 'string') mergeStringMapValue(toolArgsByKey, key, fn.arguments);
        recognized = true;
      }
    }

    // Frames with no output content but metadata already captured by maybe* calls
    if (
      !recognized &&
      (choice?.finish_reason || (Array.isArray(parsed.choices) && parsed.choices.length === 0 && parsed.usage))
    ) {
      recognized = true;
    }
    // Responses API lifecycle frames (response.created, response.in_progress, response.completed, etc.)
    if (!recognized && asRecord(parsed.response)) {
      recognized = true;
    }
    // Provider-specific bookkeeping frames with no useful content for the assembled payload.
    if (
      !recognized &&
      typeof parsed.cost === 'string' &&
      Array.isArray(parsed.choices) &&
      parsed.choices.length === 0
    ) {
      recognized = true;
    }
    // Init frame: role announcement with no content
    if (
      !recognized &&
      delta &&
      typeof delta.role === 'string' &&
      !Object.prototype.hasOwnProperty.call(delta, 'content') &&
      Object.keys(delta).length === 1
    ) {
      recognized = true;
    }
    if (
      !recognized &&
      delta &&
      typeof delta.role === 'string' &&
      delta.content === null &&
      Object.keys(delta).length <= 2
    ) {
      recognized = true;
    }

    if (!recognized) {
      const signature = getFrameSignature(parsed);
      const existing = unknownFrameMap.get(signature);
      if (existing) {
        existing.count += 1;
        existing.lastRaw = dataText;
      } else {
        unknownFrameMap.set(signature, {
          signature,
          count: 1,
          firstRaw: dataText,
          lastRaw: dataText,
        });
      }
    }
  }

  if (!sseResponseId) {
    const idMatches = [...raw.matchAll(/"id":"([^"]+)"/g)];
    sseResponseId = idMatches[idMatches.length - 1]?.[1];
  }
  if (!sseFinishReason) {
    const finishMatch = raw.match(/"finish_reason":"([^"]+)"/);
    if (finishMatch?.[1]) sseFinishReason = finishMatch[1];
  }

  const assembledContent = outputChunks.length > 0 ? outputChunks.join('') : undefined;
  const assembledReasoning = reasoningChunks.length > 0 ? reasoningChunks.join('') : undefined;
  const assembledToolCalls = [...toolArgsByKey.entries()].map(([key, argumentsText]) => {
    const name = toolNameByKey.get(key);
    return {
      id: key,
      type: 'function' as const,
      function: {
        ...(name !== undefined ? { name } : {}),
        arguments: argumentsText,
      },
    };
  });
  summary.unknownFrames = [...unknownFrameMap.values()];

  const hasAssembled =
    assembledContent !== undefined || assembledReasoning !== undefined || assembledToolCalls.length > 0;
  if (hasAssembled || sseResponseId || sseFinishReason || sseUsage) {
    summary.payload = {
      ...(sseResponseId ? { id: sseResponseId } : {}),
      ...(sseUsage ? { usage: sseUsage } : {}),
      choices: [
        {
          ...(sseFinishReason ? { finish_reason: sseFinishReason } : {}),
          delta: {
            ...(assembledContent !== undefined ? { content: assembledContent } : {}),
            ...(assembledReasoning !== undefined ? { reasoning: assembledReasoning } : {}),
            ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
          },
        },
      ],
    };
  }

  if (!summary.payload && summary.unknownFrames.length === 0) {
    summary.fallbackBody = raw;
  }

  return summary;
}

type RequestStartInput = {
  requestId: string;
  timestamp: string;
  provider: string;
  model: string;
  modelClass?: string;
  modelWrapperClass?: string;
  sessionId: string;
  sessionStartedAt: string;
  mode?: string;
  firstUserMessagePreview?: string;
  sentBody: Record<string, unknown>;
  headers?: Record<string, string>;
  evaluator?: boolean;
};

type RequestCompleteInput = {
  requestId: string;
  timestamp: string;
  provider: string;
  model: string;
  modelClass?: string;
  modelWrapperClass?: string;
  sessionId: string;
  sessionStartedAt: string;
  mode?: string;
  receivedSummary?: Record<string, unknown>;
  error?: Record<string, unknown>;
  evaluator?: boolean;
};

export class ProviderTrafficArtifactStore {
  readonly #rootDir: string;
  readonly #requestPaths = new Map<string, string>();

  constructor({ rootDir }: { rootDir: string }) {
    this.#rootDir = rootDir;
  }

  recordRequestStart(input: RequestStartInput): void {
    const { dayDir, requestPath, sessionDirName } = this.#pathsFor(input);
    this.#requestPaths.set(input.requestId, requestPath);
    const sentRecord = {
      direction: 'sent',
      requestId: input.requestId,
      timestamp: input.timestamp,
      provider: input.provider,
      model: input.model,
      ...(input.modelClass ? { modelClass: input.modelClass } : {}),
      ...(input.modelWrapperClass ? { modelWrapperClass: input.modelWrapperClass } : {}),
      sessionId: input.sessionId,
      mode: input.mode ?? 'unknown',
      ...(input.headers ? { headers: input.headers } : {}),
      body: sanitizeSentTrafficBody(input.sentBody),
    };
    writeTrafficEnvelope(requestPath, { sent: sentRecord, received: emptyTrafficRecord() });
    this.#upsertDailyIndex(dayDir, {
      sessionId: input.sessionId,
      sessionDir: sessionDirName,
      firstRequestAt: input.timestamp,
      lastRequestAt: input.timestamp,
      requestCount: 1,
      firstUserMessagePreview: normalizePreview(input.firstUserMessagePreview),
      latestProvider: input.provider,
      latestModel: input.model,
      providersSeen: [input.provider],
      modelsSeen: [input.model],
      latestMode: input.mode ?? 'unknown',
      modesSeen: [input.mode ?? 'unknown'],
    });
  }

  recordRequestComplete(input: RequestCompleteInput): void {
    const { dayDir, requestPath: fallbackRequestPath, sessionDirName } = this.#pathsFor(input);
    const requestPath = this.#requestPaths.get(input.requestId) ?? fallbackRequestPath;
    const receivedRecord = {
      direction: 'received',
      requestId: input.requestId,
      timestamp: input.timestamp,
      provider: input.provider,
      model: input.model,
      ...(input.modelClass ? { modelClass: input.modelClass } : {}),
      ...(input.modelWrapperClass ? { modelWrapperClass: input.modelWrapperClass } : {}),
      sessionId: input.sessionId,
      mode: input.mode ?? 'unknown',
      ...(input.receivedSummary ? { summary: input.receivedSummary } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
    const envelope = parseTrafficEnvelope(requestPath);
    writeTrafficEnvelope(requestPath, {
      sent: envelope.sent,
      received: receivedRecord,
    });
    this.#requestPaths.delete(input.requestId);
    this.#touchDailyIndex(dayDir, {
      sessionId: input.sessionId,
      sessionDir: sessionDirName,
      lastRequestAt: input.timestamp,
      latestProvider: input.provider,
      latestModel: input.model,
      latestMode: input.mode ?? 'unknown',
    });
  }

  #pathsFor(input: {
    timestamp: string;
    sessionId: string;
    sessionStartedAt: string;
    requestId: string;
    evaluator?: boolean;
  }): {
    dayDir: string;
    sessionDir: string;
    requestPath: string;
    sessionDirName: string;
  } {
    const dateKey = input.timestamp.slice(0, 10);
    const dayDir = `${this.#rootDir}/${dateKey}`;
    const sessionTimePart = timePartForPath(input.sessionStartedAt).replace(/\..*$/, '');
    const sessionDirName = `${sessionTimePart}_${input.sessionId.substring(0, 5)}`;
    const sessionDir = `${dayDir}/${sessionDirName}`;
    const requestTimePart = timePartForPath(input.timestamp);
    const requestIdShort = safePathSegment(input.requestId).substring(0, 5);
    const requestFileName = `${input.evaluator ? 'evaluator_' : ''}${requestTimePart}_${requestIdShort}.json`;
    const requestPath = `${sessionDir}/${requestFileName}`;
    return { dayDir, sessionDir, requestPath, sessionDirName };
  }

  #readDailyIndex(dayDir: string): DailySessionIndexEntry[] {
    const indexPath = `${dayDir}/index.jsonl`;
    if (!fs.existsSync(indexPath)) return [];
    return fs
      .readFileSync(indexPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as DailySessionIndexEntry);
  }

  #writeDailyIndex(dayDir: string, entries: DailySessionIndexEntry[]): void {
    fs.mkdirSync(dayDir, { recursive: true });
    const sorted = [...entries].sort((a, b) => b.lastRequestAt.localeCompare(a.lastRequestAt));
    fs.writeFileSync(`${dayDir}/index.jsonl`, `${sorted.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  }

  #upsertDailyIndex(dayDir: string, entry: DailySessionIndexEntry): void {
    const entries = this.#readDailyIndex(dayDir);
    const index = entries.findIndex((candidate) => candidate.sessionDir === entry.sessionDir);
    if (index === -1) {
      entries.push(entry);
    } else {
      entries[index] = entry;
    }
    this.#writeDailyIndex(dayDir, entries);
  }

  #touchDailyIndex(
    dayDir: string,
    update: Pick<
      DailySessionIndexEntry,
      'sessionId' | 'sessionDir' | 'lastRequestAt' | 'latestProvider' | 'latestModel' | 'latestMode'
    >,
  ): void {
    const entries = this.#readDailyIndex(dayDir);
    const index = entries.findIndex((candidate) => candidate.sessionDir === update.sessionDir);
    if (index === -1) {
      return;
    }
    const current = entries[index];
    entries[index] = {
      ...current,
      lastRequestAt: update.lastRequestAt,
      requestCount: current.requestCount + 1,
      latestProvider: update.latestProvider,
      latestModel: update.latestModel,
      latestMode: update.latestMode,
      providersSeen: [...new Set([...current.providersSeen, update.latestProvider])],
      modelsSeen: [...new Set([...current.modelsSeen, update.latestModel])],
      modesSeen: [...new Set([...current.modesSeen, update.latestMode])],
    };
    this.#writeDailyIndex(dayDir, entries);
  }
}

export const extractResponseText = (body: Record<string, unknown> | null | undefined): string | undefined => {
  if (!body) return undefined;
  if (typeof body.output_text === 'string') {
    return body.output_text;
  }
  if (typeof body.text === 'string') {
    return body.text;
  }

  const choices = body.choices;
  if (Array.isArray(choices)) {
    const firstChoice = asRecord(choices[0]);
    const message = asRecord(firstChoice?.message);
    if (typeof message?.content === 'string') {
      return message.content;
    }
    const delta = asRecord(firstChoice?.delta);
    if (typeof delta?.content === 'string') {
      return delta.content;
    }
    if (typeof firstChoice?.text === 'string') {
      return firstChoice.text;
    }
  }

  return undefined;
};

export const extractToolCalls = (body: Record<string, unknown> | null | undefined): unknown => {
  if (!body) return undefined;
  const choices = body.choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }

  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const delta = asRecord(firstChoice?.delta);
  return message?.tool_calls ?? delta?.tool_calls;
};

const stringValue = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/**
 * Summarize a websocket response (non-Response payload with output items)
 * into a ReceivedTrafficSummary with transport: 'websocket'.
 */
export function summarizeWebsocketResponse(response: unknown): ReceivedTrafficSummary {
  const record = asRecord(response) ?? {};

  // Some callers pass a normalized ModelResponse that wraps provider-specific
  // data. Unwrap providerData while keeping the output items for extraction.
  const providerDataRecord = asRecord(record.providerData);
  const effectiveRecord = providerDataRecord ? { ...record, ...providerDataRecord } : record;
  const output = Array.isArray(effectiveRecord.output) ? effectiveRecord.output : [];

  // Extract text content from assistant message items
  const messageTexts: string[] = [];
  for (const item of output) {
    const itemRec = asRecord(item);
    if (itemRec?.type === 'message' && (itemRec.role === 'assistant' || itemRec.role === undefined)) {
      const content = itemRec.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const partRec = asRecord(part);
          if ((partRec?.type === 'output_text' || partRec?.type === 'text') && typeof partRec.text === 'string') {
            messageTexts.push(partRec.text);
          }
        }
      } else if (typeof content === 'string') {
        messageTexts.push(content);
      }
    }
  }
  const text = messageTexts.length > 0 ? messageTexts.join('\n') : undefined;

  // Extract reasoning content from reasoning items
  const reasoningTexts: string[] = [];
  for (const item of output) {
    const itemRec = asRecord(item);
    if (itemRec?.type === 'reasoning') {
      const reasoningVal =
        stringValue(itemRec.text) ??
        stringValue(itemRec.delta) ??
        stringValue(itemRec.summary) ??
        stringValue(itemRec.reasoning_content);
      if (reasoningVal) {
        reasoningTexts.push(reasoningVal);
      }
    }
  }
  const reasoning = reasoningTexts.length > 0 ? reasoningTexts.join('\n') : undefined;

  // Extract tool calls
  const toolCalls: any[] = [];
  for (const item of output) {
    const itemRec = asRecord(item);
    if (itemRec?.type === 'function_call') {
      const name = stringValue(itemRec.name);
      const args = stringValue(itemRec.arguments) ?? '{}';
      toolCalls.push({
        id: stringValue(itemRec.call_id) ?? stringValue(itemRec.id),
        type: 'function',
        function: {
          ...(name !== undefined ? { name } : {}),
          arguments: args,
        },
      });
    }
  }

  const payload: Record<string, unknown> = {
    choices: [
      {
        delta: {
          ...(text !== undefined ? { content: text } : {}),
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  };

  const responseId = stringValue(effectiveRecord.id);
  if (responseId) {
    payload.id = responseId;
  }
  if (effectiveRecord.usage) {
    payload.usage = effectiveRecord.usage;
  }

  return {
    transport: 'websocket',
    status: 200,
    errorFrames: [],
    malformedFrames: [],
    unknownFrames: [],
    payload,
    ...(text ? { text } : {}),
    ...(responseId ? { responseId } : {}),
  };
}

export class ProviderTraffic implements IProviderTraffic {
  constructor(
    private readonly loggingService: Pick<ILoggingService, 'debug' | 'error' | 'getCorrelationId'>,
    private readonly sessionContextService: ISessionContextService,
    private readonly store: ProviderTrafficArtifactStore,
  ) {}

  recordRequestStart(input: ProviderTrafficRequest): void {
    const trafficContext = this.sessionContextService.getContext() ?? null;
    const isEvaluator = trafficContext?.evaluator === true;
    const eventPrefix = isEvaluator ? 'evaluator' : 'provider';

    const timestamp = new Date().toISOString();
    const sessionId = trafficContext?.sessionId ?? 'unknown';
    const sessionStartedAt = trafficContext?.sessionStartedAt ?? timestamp;
    const mode = trafficContext?.mode ?? 'unknown';
    const firstUserMessagePreview = trafficContext?.firstUserMessagePreview;

    // 1. Write the sent request to artifact store directly
    this.store.recordRequestStart({
      requestId: input.requestId,
      timestamp,
      provider: input.provider,
      model: input.model,
      modelClass: input.modelClass,
      modelWrapperClass: input.modelWrapperClass,
      sessionId,
      sessionStartedAt,
      mode,
      firstUserMessagePreview,
      sentBody: input.sentBody,
      headers: input.headers,
      evaluator: isEvaluator,
    });

    const baseMeta = {
      requestId: input.requestId,
      traceId: trafficContext?.traceId ?? this.loggingService.getCorrelationId?.(),
      sessionId,
      sessionStartedAt,
      firstUserMessagePreview,
      mode,
      provider: input.provider,
      model: input.model,
      modelClass: input.modelClass,
      modelWrapperClass: input.modelWrapperClass,
    };

    // 2. Log request start via logging service for winston
    this.loggingService.debug(`${input.provider} request start`, {
      eventType: `${eventPrefix}.request.started`,
      category: 'provider',
      phase: 'request_start',
      direction: 'sent',
      ...baseMeta,
      messageCount: Array.isArray(input.sentBody?.messages) ? input.sentBody.messages.length : undefined,
      messages: input.sentBody?.messages,
      toolsCount: Array.isArray(input.sentBody?.tools) ? input.sentBody.tools.length : undefined,
      payload: input.sentBody,
      headers: input.headers,
    });
  }

  async recordResponseReceived(input: ProviderTrafficResponse): Promise<void> {
    const trafficContext = this.sessionContextService.getContext() ?? null;
    const isEvaluator = trafficContext?.evaluator === true;
    const eventPrefix = isEvaluator ? 'evaluator' : 'provider';

    const timestamp = new Date().toISOString();
    const sessionId = trafficContext?.sessionId ?? 'unknown';
    const sessionStartedAt = trafficContext?.sessionStartedAt ?? timestamp;
    const mode = trafficContext?.mode ?? 'unknown';
    const firstUserMessagePreview = trafficContext?.firstUserMessagePreview;

    const baseMeta = {
      requestId: input.requestId,
      traceId: trafficContext?.traceId ?? this.loggingService.getCorrelationId?.(),
      sessionId,
      sessionStartedAt,
      firstUserMessagePreview,
      mode,
      provider: input.provider,
      model: input.model,
      modelClass: input.modelClass,
      modelWrapperClass: input.modelWrapperClass,
    };

    if (input.error) {
      // 1. Write failure to artifact store
      this.store.recordRequestComplete({
        requestId: input.requestId,
        timestamp,
        provider: input.provider,
        model: input.model,
        modelClass: input.modelClass,
        modelWrapperClass: input.modelWrapperClass,
        sessionId,
        sessionStartedAt,
        mode,
        error: input.error,
        evaluator: isEvaluator,
      });

      // 2. Log failure to winston
      this.loggingService.error(`${input.provider} request failed`, {
        eventType: 'provider.response.failed',
        category: 'provider',
        phase: 'provider_response',
        ...baseMeta,
        error: input.error,
      });
      return;
    }

    // Process response
    let summary: ReceivedTrafficSummary;
    if (input.response instanceof Response) {
      summary = await summarizeReceivedTraffic(input.response.clone());
      // Override transport if explicit value was provided
      if (input.transport) {
        summary = { ...summary, transport: input.transport };
      }
    } else if (input.transport === 'websocket') {
      summary = summarizeWebsocketResponse(input.response);
    } else {
      // It's a WS/JSON response payload, let's summarize it
      let payload = input.response ?? {};
      let text: string | undefined;

      if (payload && typeof payload === 'object' && 'providerData' in payload && payload.providerData) {
        const modelResponse = payload as any;
        if (Array.isArray(modelResponse.output)) {
          const firstOutput = modelResponse.output[0];
          if (firstOutput?.type === 'message' && Array.isArray(firstOutput.content)) {
            const firstContent = firstOutput.content[0];
            if (firstContent?.type === 'output_text' && typeof firstContent.text === 'string') {
              text = firstContent.text;
            }
          }
        }
        payload = modelResponse.providerData;
      } else {
        const summaryPayload = asRecord(payload);
        const output = (summaryPayload as any)?.output;
        text = Array.isArray(output) && output[0]?.type === 'message' ? output[0]?.content?.[0]?.text : undefined;
      }

      summary = {
        transport: 'json',
        status: input.status,
        errorFrames: [],
        malformedFrames: [],
        unknownFrames: [],
        payload,
        ...(text ? { text } : {}),
      };
    }

    // 1. Write complete payload to artifact store
    this.store.recordRequestComplete({
      requestId: input.requestId,
      timestamp,
      provider: input.provider,
      model: input.model,
      modelClass: input.modelClass,
      modelWrapperClass: input.modelWrapperClass,
      sessionId,
      sessionStartedAt,
      mode,
      receivedSummary: summary,
      evaluator: isEvaluator,
    });

    // 2. Log response received via logging service for winston
    const summaryPayload = asRecord(summary.payload);
    const responseText = summaryPayload
      ? extractResponseText(summaryPayload)
      : typeof summary.fallbackBody === 'string'
      ? summary.fallbackBody
      : undefined;
    const toolCalls = extractToolCalls(summaryPayload);

    this.loggingService.debug(`${input.provider} response received`, {
      eventType: `${eventPrefix}.response.received`,
      category: 'provider',
      phase: 'provider_response',
      direction: 'received',
      ...baseMeta,
      status: input.status,
      text: responseText,
      toolCalls,
      payload: summary,
    });
  }

  recordRequestFailed(input: {
    requestId: string;
    provider: string;
    model: string;
    error: unknown;
    modelClass?: string;
    modelWrapperClass?: string;
    wsAttempt?: number;
    wsMaxAttempts?: number;
  }): void {
    const trafficContext = this.sessionContextService.getContext() ?? null;
    const isEvaluator = trafficContext?.evaluator === true;

    const timestamp = new Date().toISOString();
    const sessionId = trafficContext?.sessionId ?? 'unknown';
    const sessionStartedAt = trafficContext?.sessionStartedAt ?? timestamp;
    const mode = trafficContext?.mode ?? 'unknown';
    const firstUserMessagePreview = trafficContext?.firstUserMessagePreview;

    const baseMeta = {
      requestId: input.requestId,
      traceId: trafficContext?.traceId ?? this.loggingService.getCorrelationId?.(),
      sessionId,
      sessionStartedAt,
      firstUserMessagePreview,
      mode,
      provider: input.provider,
      model: input.model,
      modelClass: input.modelClass,
      modelWrapperClass: input.modelWrapperClass,
    };

    const errorDetails: Record<string, any> = {
      message:
        typeof input.error === 'object' && input.error && 'message' in (input.error as any)
          ? String((input.error as any).message)
          : String(input.error),
    };
    if (input.wsAttempt !== undefined) {
      errorDetails.wsAttempt = input.wsAttempt;
    }
    if (input.wsMaxAttempts !== undefined) {
      errorDetails.wsMaxAttempts = input.wsMaxAttempts;
    }

    // 1. Write failure to artifact store
    this.store.recordRequestComplete({
      requestId: input.requestId,
      timestamp,
      provider: input.provider,
      model: input.model,
      modelClass: input.modelClass,
      modelWrapperClass: input.modelWrapperClass,
      sessionId,
      sessionStartedAt,
      mode,
      error: errorDetails,
      evaluator: isEvaluator,
    });

    // 2. Log failure to winston
    this.loggingService.error(`${input.provider} request failed`, {
      eventType: 'provider.response.failed',
      category: 'provider',
      phase: 'provider_response',
      ...baseMeta,
      error: errorDetails.message,
      wsAttempt: input.wsAttempt,
      wsMaxAttempts: input.wsMaxAttempts,
    });
  }
}
