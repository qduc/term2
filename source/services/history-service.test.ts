import { it, expect } from 'vitest';
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

it('addMessage() stores multimodal turns and persists them', () => {
  const { dir, historyFile } = createTempHistoryFile();
  try {
    const service = new HistoryService(createDeps(historyFile));
    const turn: UserTurn = { text: 'Describe this', images: [image] };

    service.addMessage(turn);

    expect(service.getTurns()).toEqual([turn]);
    expect(service.getMessages()).toEqual(['Describe this']);

    const written = JSON.parse(fs.readFileSync(historyFile, 'utf-8')) as { messages: UserTurn[] };
    expect(written.messages).toEqual([turn]);

    const reloaded = new HistoryService(createDeps(historyFile));
    expect(reloaded.getTurns()).toEqual([turn]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('addMessage() stores image-only turns', () => {
  const { dir, historyFile } = createTempHistoryFile();
  try {
    const service = new HistoryService(createDeps(historyFile));

    service.addMessage({
      text: '',
      images: [image],
    });

    expect(service.getTurns().length).toBe(1);
    expect(service.getTurns()[0]).toEqual({ text: '', images: [image] });
    expect(service.getMessages()).toEqual(['']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('load() supports legacy string-only history files', () => {
  const { dir, historyFile } = createTempHistoryFile();
  try {
    fs.writeFileSync(historyFile, JSON.stringify({ messages: ['First', 'Second'] }, null, 2), 'utf-8');

    const service = new HistoryService(createDeps(historyFile));

    expect(service.getTurns()).toEqual([{ text: 'First' }, { text: 'Second' }]);
    expect(service.getMessages()).toEqual(['First', 'Second']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
