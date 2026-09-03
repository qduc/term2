import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { backfillProviderTrafficIndexes } from './backfill-provider-traffic-index.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const makeTrafficRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-traffic-index-'));
  temporaryRoots.push(root);
  return root;
};

const writeEnvelope = (
  root: string,
  sessionDir: string,
  fileName: string,
  sent: Record<string, unknown>,
  received: Record<string, unknown> = {},
): void => {
  const directory = path.join(root, '2026-09-01', sessionDir);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, fileName), JSON.stringify({ sent, received }), 'utf8');
};

it('backfills request counts from historical sent envelopes and preserves index metadata', () => {
  const root = makeTrafficRoot();
  const sessionDir = '12-00-00_0bf2d';
  const sentBase = {
    sessionId: '0bf2d563-1234-5678-9012-abcdefabcdef',
    mode: 'standard',
  };

  writeEnvelope(root, sessionDir, '12-00-01_req-1.json', {
    ...sentBase,
    requestId: 'req-1',
    timestamp: '2026-09-01T12:00:01.000Z',
    provider: 'deepseek',
    model: 'deepseek-chat',
  });
  writeEnvelope(root, sessionDir, '12-00-02_req-2.json', {
    ...sentBase,
    requestId: 'req-2',
    timestamp: '2026-09-01T12:00:02.000Z',
    provider: 'openrouter',
    model: 'deepseek/deepseek-chat',
    mode: 'mentor',
  });
  const sessionPath = path.join(root, '2026-09-01', sessionDir);
  fs.writeFileSync(path.join(sessionPath, '12-00-03_req-3.raw.json'), JSON.stringify({ requestId: 'req-3' }), 'utf8');
  fs.writeFileSync(path.join(sessionPath, '12-00-04_req-4.json'), '{not an envelope', 'utf8');

  const dayDir = path.join(root, '2026-09-01');
  fs.writeFileSync(
    path.join(dayDir, 'index.jsonl'),
    `${JSON.stringify({
      sessionId: sentBase.sessionId,
      sessionDir,
      firstRequestAt: '2026-09-01T12:00:01.000Z',
      lastRequestAt: '2026-09-01T12:00:02.000Z',
      requestCount: 1,
      firstUserMessagePreview: 'existing preview',
      latestProvider: 'deepseek',
      latestModel: 'deepseek-chat',
      providersSeen: ['deepseek'],
      modelsSeen: ['deepseek-chat'],
      latestMode: 'standard',
      modesSeen: ['standard'],
    })}\n`,
    'utf8',
  );

  const result = backfillProviderTrafficIndexes(root, { apply: true });
  const entries = fs
    .readFileSync(path.join(dayDir, 'index.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  expect(result.requestCount).toBe(2);
  expect(result.skippedFiles).toBe(2);
  expect(result.changedDays).toEqual(['2026-09-01']);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    sessionId: sentBase.sessionId,
    sessionDir,
    requestCount: 2,
    firstUserMessagePreview: 'existing preview',
    providersSeen: ['deepseek', 'openrouter'],
    modelsSeen: ['deepseek-chat', 'deepseek/deepseek-chat'],
    modesSeen: ['standard', 'mentor'],
    latestProvider: 'openrouter',
    latestModel: 'deepseek/deepseek-chat',
    latestMode: 'mentor',
  });
});

it('supports dry runs and adds an index entry for a session missing from the index', () => {
  const root = makeTrafficRoot();
  const sessionDir = '13-00-00_abcde';
  const sessionId = 'abcdef01-1234-5678-9012-abcdefabcdef';
  writeEnvelope(root, sessionDir, '13-00-01_req-1.json', {
    sessionId,
    requestId: 'req-1',
    timestamp: '2026-09-01T13:00:01.000Z',
    provider: 'openai',
    model: 'gpt-5',
    mode: 'standard',
  });

  const indexPath = path.join(root, '2026-09-01', 'index.jsonl');
  const result = backfillProviderTrafficIndexes(root, { apply: false });

  expect(result.changedDays).toEqual(['2026-09-01']);
  expect(fs.existsSync(indexPath)).toBe(false);

  backfillProviderTrafficIndexes(root, { apply: true });
  const [entry] = fs
    .readFileSync(indexPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(entry).toMatchObject({
    sessionId,
    sessionDir,
    firstRequestAt: '2026-09-01T13:00:01.000Z',
    lastRequestAt: '2026-09-01T13:00:01.000Z',
    requestCount: 1,
    firstUserMessagePreview: '',
    latestProvider: 'openai',
    latestModel: 'gpt-5',
    providersSeen: ['openai'],
    modelsSeen: ['gpt-5'],
    latestMode: 'standard',
    modesSeen: ['standard'],
  });
});
