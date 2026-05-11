import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ProviderTrafficRecord {
  traceId: string;
  lineNumber?: number;
  timestamp: string;
  direction: 'sent' | 'received';
  sourceMessage: string;
  provider: string;
  model: string;
  payload: Record<string, unknown>;
  isEvaluator?: boolean;
}

const toNonEmptyString = (value: unknown, fallback: string): string => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return fallback;
};

const tryParseJson = (line: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const TRUNCATE_LEN = 120;

const truncate = (s: string): string => (s.length > TRUNCATE_LEN ? `${s.slice(0, TRUNCATE_LEN)}…` : s);

const truncateReasoningDetails = (details: unknown): unknown => {
  if (!Array.isArray(details)) return details;
  return details.map((r: unknown) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
    const rd = r as Record<string, unknown>;
    if (typeof rd.text === 'string') {
      return { ...rd, text: truncate(rd.text) };
    }
    return r;
  });
};

const stripMessageContent = (messages: unknown): unknown => {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg: unknown) => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return msg;
    const m = msg as Record<string, unknown>;
    if (m.role === 'system') {
      const { content: _content, ...rest } = m;
      return rest;
    }
    const result = { ...m };
    if (typeof result.content === 'string') {
      result.content = truncate(result.content);
    }
    if (Array.isArray(result.reasoning_details)) {
      result.reasoning_details = truncateReasoningDetails(result.reasoning_details);
    }
    return result;
  });
};

const stripToolSchemas = (tools: unknown): unknown => {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool: unknown) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
    const t = tool as Record<string, unknown>;
    if (t.type === 'function' && t.function && typeof t.function === 'object') {
      const fn = t.function as Record<string, unknown>;
      return { type: t.type, function: { name: fn.name } };
    }
    return tool;
  });
};

const buildSentPayload = (parsed: Record<string, unknown>): Record<string, unknown> => ({
  messageCount: parsed.messageCount,
  messages: stripMessageContent(parsed.messages),
  toolsCount: parsed.toolsCount,
  tools: stripToolSchemas(parsed.tools),
});

const buildReceivedPayload = (parsed: Record<string, unknown>): Record<string, unknown> => ({
  text: parsed.text,
  reasoningDetails: parsed.reasoningDetails,
  toolCalls: parsed.toolCalls,
});

const buildEvaluatorPayload = (parsed: Record<string, unknown>): Record<string, unknown> => {
  const payload = parsed.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
};

const isEvaluatorEventType = (eventType: string): boolean => eventType.startsWith('evaluator.');

const toDirection = (value: unknown): 'sent' | 'received' | null => {
  if (value === 'sent' || value === 'received') {
    return value;
  }
  return null;
};

export function extractProviderTrafficRecordFromRuntimeLog(
  parsed: Record<string, unknown>,
  lineNumber?: number,
): ProviderTrafficRecord | null {
  const sourceMessage = toNonEmptyString(parsed.message, '');
  const eventType = toNonEmptyString(parsed.eventType, '');
  const parsedDirection = toDirection(parsed.direction);

  const isEvaluator = isEvaluatorEventType(eventType);
  const isProviderEvent =
    eventType === 'provider.request.started' ||
    eventType === 'provider.response.received' ||
    sourceMessage.endsWith(' stream start') ||
    sourceMessage.endsWith(' stream done') ||
    sourceMessage.endsWith(' response start') ||
    sourceMessage.endsWith(' response done');

  if (!isEvaluator && !isProviderEvent) {
    return null;
  }

  const direction: 'sent' | 'received' =
    parsedDirection ??
    (sourceMessage.endsWith(' stream start') || sourceMessage.endsWith(' response start')
      ? 'sent'
      : sourceMessage.endsWith(' stream done') || sourceMessage.endsWith(' response done')
      ? 'received'
      : eventType === 'provider.request.started'
      ? 'sent'
      : 'received');

  const payload = isEvaluator
    ? buildEvaluatorPayload(parsed)
    : direction === 'sent'
    ? buildSentPayload(parsed)
    : buildReceivedPayload(parsed);

  const record: ProviderTrafficRecord = {
    traceId: toNonEmptyString(parsed.traceId, 'trace-unknown'),
    timestamp: toNonEmptyString(parsed.timestamp, ''),
    direction,
    sourceMessage,
    provider: toNonEmptyString(parsed.provider, 'unknown'),
    model: toNonEmptyString(parsed.model, 'unknown'),
    payload,
    isEvaluator,
  };

  if (lineNumber !== undefined) {
    record.lineNumber = lineNumber;
  }

  return record;
}

export function extractProviderTrafficFromLogContent(content: string): ProviderTrafficRecord[] {
  const lines = content.split('\n');
  const records: ProviderTrafficRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    const parsed = tryParseJson(line);
    if (!parsed) {
      continue;
    }

    const trafficRecord = extractProviderTrafficRecordFromRuntimeLog(parsed, i + 1);
    if (trafficRecord) {
      records.push(trafficRecord);
    }
  }

  return records;
}

const pad = (value: number): string => String(value).padStart(3, '0');

export async function writeProviderTrafficFiles(
  records: ProviderTrafficRecord[],
  outputDir: string,
): Promise<{
  traces: number;
  files: number;
  indexPath: string;
}> {
  await fs.mkdir(outputDir, { recursive: true });

  const byTrace = new Map<string, ProviderTrafficRecord[]>();
  for (const record of records) {
    const existing = byTrace.get(record.traceId) ?? [];
    existing.push(record);
    byTrace.set(record.traceId, existing);
  }

  const traceIds = [...byTrace.keys()].sort();
  const index: Array<{
    traceId: string;
    entries: number;
    files: string[];
  }> = [];

  let filesWritten = 0;
  for (const traceId of traceIds) {
    const traceRecords = (byTrace.get(traceId) ?? []).sort((a, b) => {
      const left = a.lineNumber ?? 0;
      const right = b.lineNumber ?? 0;
      return left - right;
    });
    const traceDir = path.join(outputDir, traceId);
    await fs.mkdir(traceDir, { recursive: true });

    const files: string[] = [];
    for (let i = 0; i < traceRecords.length; i++) {
      const record = traceRecords[i];
      const fileName = `${pad(i + 1)}-${record.direction}.json`;
      const filePath = path.join(traceDir, fileName);
      await fs.writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
      files.push(path.join(traceId, fileName));
      filesWritten += 1;
    }

    index.push({
      traceId,
      entries: traceRecords.length,
      files,
    });
  }

  const indexPath = path.join(outputDir, 'index.json');
  await fs.writeFile(
    indexPath,
    JSON.stringify(
      {
        traces: traceIds.length,
        files: filesWritten,
        generatedAt: new Date().toISOString(),
        index,
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    traces: traceIds.length,
    files: filesWritten,
    indexPath,
  };
}
