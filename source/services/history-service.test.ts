import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryService } from './history-service.js';
import type { UserTurn } from '../types/user-turn.js';

const createDeps = (historyFile: string) => ({
  historyFile,
  loggingService: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
  } as any,
  settingsService: {
    get: () => 1000,
  } as any,
});

const createTempHistoryFile = (): { dir: string; historyFile: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-history-'));
  return { dir, historyFile: path.join(dir, 'history.json') };
};

const image = {
  id: 'img-1',
  data: 'abc123',
  mimeType: 'image/png',
  byteSize: 3,
  displayNumber: 1,
} as const;

test('addMessage() stores multimodal turns and persists them', (t) => {
  const { dir, historyFile } = createTempHistoryFile();
  try {
    const service = new HistoryService(createDeps(historyFile));
    const turn: UserTurn = { text: 'Describe this', images: [image] };

    service.addMessage(turn);

    t.deepEqual(service.getTurns(), [turn]);
    t.deepEqual(service.getMessages(), ['Describe this']);

    const written = JSON.parse(fs.readFileSync(historyFile, 'utf-8')) as { messages: UserTurn[] };
    t.deepEqual(written.messages, [turn]);

    const reloaded = new HistoryService(createDeps(historyFile));
    t.deepEqual(reloaded.getTurns(), [turn]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addMessage() stores image-only turns', (t) => {
  const { dir, historyFile } = createTempHistoryFile();
  try {
    const service = new HistoryService(createDeps(historyFile));

    service.addMessage({
      text: '',
      images: [image],
    });

    t.is(service.getTurns().length, 1);
    t.deepEqual(service.getTurns()[0], { text: '', images: [image] });
    t.deepEqual(service.getMessages(), ['']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load() supports legacy string-only history files', (t) => {
  const { dir, historyFile } = createTempHistoryFile();
  try {
    fs.writeFileSync(historyFile, JSON.stringify({ messages: ['First', 'Second'] }, null, 2), 'utf-8');

    const service = new HistoryService(createDeps(historyFile));

    t.deepEqual(service.getTurns(), [{ text: 'First' }, { text: 'Second' }]);
    t.deepEqual(service.getMessages(), ['First', 'Second']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
