import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type BackfillProviderTrafficIndexResult = {
  dayCount: number;
  sessionCount: number;
  requestCount: number;
  changedDays: string[];
  skippedFiles: number;
};

type IndexEntry = {
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
  [key: string]: unknown;
};

type TrafficRecord = Record<string, unknown>;

type ScannedRequest = {
  sent: TrafficRecord;
  timestamp: string;
};

type BackfillOptions = {
  /** Do not write indexes when false; this makes the CLI safe to preview. */
  apply?: boolean;
};

const isRecord = (value: unknown): value is TrafficRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const minTimestamp = (left: string | undefined, right: string): string => (left && left < right ? left : right);

const maxTimestamp = (left: string | undefined, right: string): string => (left && left > right ? left : right);

const unique = (values: string[]): string[] => [...new Set(values)];

function readExistingIndex(indexPath: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  if (!fs.existsSync(indexPath)) return entries;

  let contents: string;
  try {
    contents = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return entries;
  }

  for (const line of contents.split('\n')) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed.sessionDir === 'string') {
        entries.set(parsed.sessionDir, parsed as IndexEntry);
      }
    } catch {
      // The running writer already recovers from malformed JSONL lines. A
      // backfill should do the same rather than make an old day unrepairable.
    }
  }
  return entries;
}

function scanSessionDirectory(sessionPath: string): { requests: ScannedRequest[]; skippedFiles: number } {
  const requests: ScannedRequest[] = [];
  let skippedFiles = 0;
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(sessionPath, { withFileTypes: true });
  } catch {
    return { requests, skippedFiles: 1 };
  }

  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    const filePath = path.join(sessionPath, file.name);
    try {
      const envelope: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const sent = isRecord(envelope) && isRecord(envelope.sent) ? envelope.sent : undefined;
      const timestamp = sent ? stringValue(sent.timestamp) : undefined;
      if (
        !sent ||
        !timestamp ||
        !stringValue(sent.sessionId) ||
        !stringValue(sent.provider) ||
        !stringValue(sent.model)
      ) {
        // Raw sidecars and incomplete files do not contain a sent envelope and
        // must not inflate the historical request count.
        skippedFiles += 1;
        continue;
      }
      requests.push({ sent, timestamp });
    } catch {
      skippedFiles += 1;
    }
  }

  return { requests, skippedFiles };
}

function entryFromRequests(sessionDir: string, requests: ScannedRequest[]): IndexEntry {
  const first = requests.reduce<string | undefined>(
    (current, request) => (current === undefined ? request.timestamp : minTimestamp(current, request.timestamp)),
    undefined,
  ) as string;
  const latest = requests.reduce((current, request) => (request.timestamp >= current.timestamp ? request : current));
  const providersSeen = unique(requests.map(({ sent }) => stringValue(sent.provider) as string));
  const modelsSeen = unique(requests.map(({ sent }) => stringValue(sent.model) as string));
  const modesSeen = unique(requests.map(({ sent }) => stringValue(sent.mode) ?? 'unknown'));

  return {
    sessionId: stringValue(requests[0]?.sent.sessionId) as string,
    sessionDir,
    firstRequestAt: first,
    lastRequestAt: requests.reduce<string>((current, request) => maxTimestamp(current, request.timestamp), first),
    requestCount: requests.length,
    firstUserMessagePreview: '',
    latestProvider: stringValue(latest.sent.provider) as string,
    latestModel: stringValue(latest.sent.model) as string,
    providersSeen,
    modelsSeen,
    latestMode: stringValue(latest.sent.mode) ?? 'unknown',
    modesSeen,
  };
}

function mergeEntry(existing: IndexEntry | undefined, rebuilt: IndexEntry): IndexEntry {
  if (!existing) return rebuilt;

  const existingLatestIsNewer = existing.lastRequestAt > rebuilt.lastRequestAt;
  return {
    ...existing,
    ...rebuilt,
    // Keep metadata that only the original index has (the sent artifact does
    // not duplicate the first-user-message preview).
    firstUserMessagePreview: existing.firstUserMessagePreview || rebuilt.firstUserMessagePreview,
    firstRequestAt: minTimestamp(existing.firstRequestAt, rebuilt.firstRequestAt),
    lastRequestAt: maxTimestamp(existing.lastRequestAt, rebuilt.lastRequestAt),
    latestProvider: existingLatestIsNewer ? existing.latestProvider : rebuilt.latestProvider,
    latestModel: existingLatestIsNewer ? existing.latestModel : rebuilt.latestModel,
    latestMode: existingLatestIsNewer ? existing.latestMode : rebuilt.latestMode,
    providersSeen: unique([...(existing.providersSeen ?? []), ...rebuilt.providersSeen]),
    modelsSeen: unique([...(existing.modelsSeen ?? []), ...rebuilt.modelsSeen]),
    modesSeen: unique([...(existing.modesSeen ?? []), ...rebuilt.modesSeen]),
  };
}

function writeIndex(indexPath: string, entries: IndexEntry[]): void {
  const contents = `${[...entries]
    .sort((left, right) => right.lastRequestAt.localeCompare(left.lastRequestAt))
    .map((entry) => JSON.stringify(entry))
    .join('\n')}\n`;
  const temporaryPath = `${indexPath}.backfill-${process.pid}`;
  fs.writeFileSync(temporaryPath, contents, 'utf8');
  fs.renameSync(temporaryPath, indexPath);
}

/**
 * Rebuilds the per-day session index's request counts from sent envelopes.
 * The live writer was corrected to count at request start, but old indexes
 * cannot be corrected without scanning their durable request artifacts.
 */
export function backfillProviderTrafficIndexes(
  rootDir: string,
  { apply = false }: BackfillOptions = {},
): BackfillProviderTrafficIndexResult {
  const dayEntries = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const changedDays: string[] = [];
  let sessionCount = 0;
  let requestCount = 0;
  let skippedFiles = 0;

  for (const day of dayEntries) {
    const dayPath = path.join(rootDir, day.name);
    const indexPath = path.join(dayPath, 'index.jsonl');
    const entries = readExistingIndex(indexPath);
    const sessionDirs = fs
      .readdirSync(dayPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const session of sessionDirs) {
      const scanned = scanSessionDirectory(path.join(dayPath, session.name));
      skippedFiles += scanned.skippedFiles;
      if (scanned.requests.length === 0) continue;
      sessionCount += 1;
      requestCount += scanned.requests.length;
      entries.set(
        session.name,
        mergeEntry(entries.get(session.name), entryFromRequests(session.name, scanned.requests)),
      );
    }

    if (entries.size === 0 && !fs.existsSync(indexPath)) continue;
    const nextContents = `${[...entries.values()]
      .sort((left, right) => right.lastRequestAt.localeCompare(left.lastRequestAt))
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`;
    const currentContents = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
    if (currentContents !== nextContents) {
      changedDays.push(day.name);
      if (apply) writeIndex(indexPath, [...entries.values()]);
    }
  }

  return { dayCount: dayEntries.length, sessionCount, requestCount, changedDays, skippedFiles };
}

function printUsage(): void {
  console.error('Usage: pnpm exec tsx scripts/backfill-provider-traffic-index.ts <provider-traffic-root> [--apply]');
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const roots = args.filter((arg) => arg !== '--apply');
  if (roots.length !== 1 || roots[0] === '--help' || roots[0] === '-h') {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const result = backfillProviderTrafficIndexes(path.resolve(roots[0]), { apply });
  console.log(
    `${apply ? 'Backfilled' : 'Would backfill'} ${result.requestCount} requests across ${
      result.sessionCount
    } sessions.`,
  );
  console.log(`Changed days: ${result.changedDays.length ? result.changedDays.join(', ') : 'none'}.`);
  if (result.skippedFiles > 0) {
    console.error(`Skipped ${result.skippedFiles} invalid or non-envelope JSON file(s).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
