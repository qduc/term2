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

const buildSentPayload = (parsed: Record<string, unknown>): Record<string, unknown> => ({
  messageCount: parsed.messageCount,
  messages: parsed.messages,
  toolsCount: parsed.toolsCount,
  tools: parsed.tools,
  modelRequest: parsed.modelRequest,
});

const buildReceivedPayload = (parsed: Record<string, unknown>): Record<string, unknown> => ({
  text: parsed.text,
  reasoningDetails: parsed.reasoningDetails,
  toolCalls: parsed.toolCalls,
});

export function extractProviderTrafficRecordFromRuntimeLog(
  parsed: Record<string, unknown>,
  lineNumber?: number,
): ProviderTrafficRecord | null {
  const sourceMessage = toNonEmptyString(parsed.message, '');
  if (sourceMessage !== 'OpenRouter stream start' && sourceMessage !== 'OpenRouter stream done') {
    return null;
  }

  const direction = sourceMessage === 'OpenRouter stream start' ? 'sent' : 'received';
  const payload = direction === 'sent' ? buildSentPayload(parsed) : buildReceivedPayload(parsed);

  const record: ProviderTrafficRecord = {
    traceId: toNonEmptyString(parsed.traceId, 'trace-unknown'),
    timestamp: toNonEmptyString(parsed.timestamp, ''),
    direction,
    sourceMessage,
    provider: toNonEmptyString(parsed.provider, 'unknown'),
    model: toNonEmptyString(parsed.model, 'unknown'),
    payload,
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
