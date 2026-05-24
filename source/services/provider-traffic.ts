import fs from 'node:fs';

export const TRAFFIC_TEXT_LIMIT = 100;
const PREVIEW_LIMIT = 160;

export type SessionTrafficContext = {
  sessionId: string;
  sessionStartedAt: string;
  firstUserMessagePreview?: string;
  mode?: string;
  traceId?: string;
  evaluator?: boolean;
};

export type SentTrafficRecord = {
  requestId: string;
  timestamp: string;
  provider: string;
  model: string;
  sessionId: string;
  sessionStartedAt: string;
  mode?: string;
  firstUserMessagePreview?: string;
  sentBody: Record<string, unknown>;
};

export type ReceivedTrafficSummary = {
  transport: 'json' | 'sse' | 'text' | 'unknown';
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

const sanitizeInstructionLikeValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  return truncateTrafficText(value);
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

const sanitizeContentArray = (content: unknown[]): unknown[] =>
  content.map((item) => {
    const record = asRecord(item);
    if (!record) return item;
    if (record.type === 'text' && typeof record.text === 'string') {
      return { ...record, text: truncateTrafficText(record.text) };
    }
    return item;
  });

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

export const sanitizeSentTrafficBody = (body: Record<string, unknown>): Record<string, unknown> => {
  const sanitized: Record<string, unknown> = { ...body };

  if (Object.prototype.hasOwnProperty.call(sanitized, 'instructions')) {
    sanitized.instructions = sanitizeInstructionLikeValue(sanitized.instructions);
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
    if (eventType?.includes('output_text') && typeof deltaText === 'string') {
      outputChunks.push(deltaText);
      recognized = true;
    }
    if ((eventType?.includes('reasoning') || eventType?.includes('summary')) && typeof deltaText === 'string') {
      reasoningChunks.push(deltaText);
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
  sessionId: string;
  sessionStartedAt: string;
  mode?: string;
  firstUserMessagePreview?: string;
  sentBody: Record<string, unknown>;
  evaluator?: boolean;
};

type RequestCompleteInput = {
  requestId: string;
  timestamp: string;
  provider: string;
  model: string;
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
    fs.mkdirSync(requestPath.slice(0, requestPath.lastIndexOf('/')), { recursive: true });
    this.#requestPaths.set(input.requestId, requestPath);
    const sentRecord = {
      direction: 'sent',
      requestId: input.requestId,
      timestamp: input.timestamp,
      provider: input.provider,
      model: input.model,
      sessionId: input.sessionId,
      mode: input.mode ?? 'unknown',
      body: sanitizeSentTrafficBody(input.sentBody),
    };
    fs.writeFileSync(requestPath, `${JSON.stringify(sentRecord, null, 2)}\n`, 'utf8');
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
      sessionId: input.sessionId,
      mode: input.mode ?? 'unknown',
      ...(input.receivedSummary ? { summary: input.receivedSummary } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
    fs.mkdirSync(requestPath.slice(0, requestPath.lastIndexOf('/')), { recursive: true });
    fs.appendFileSync(requestPath, `\n${JSON.stringify(receivedRecord, null, 2)}\n`, 'utf8');
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
    const sessionDirName = `${safeTimestampForPath(input.sessionStartedAt)}_${input.sessionId.substring(0, 5)}`;
    const sessionDir = dayDir;
    const timePart = input.timestamp.includes('T')
      ? safeTimestampForPath(input.timestamp.substring(input.timestamp.indexOf('T') + 1))
      : safeTimestampForPath(input.timestamp);
    const prefix = input.evaluator ? 'evaluator_' : '';
    const requestPath = `${dayDir}/${prefix}${timePart}_sess-${input.sessionId.substring(
      0,
      5,
    )}_req-${input.requestId.substring(0, 5)}.jsonl`;
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
