import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryService } from './history-service.js';
import type { UserTurn } from '../types/user-turn.js';
import type { LoggingService } from './logging/logging-service.js';
import type { SettingsService } from './settings/settings-service.js';

const createDeps = (historyFile: string, maxHistorySize = 1000) => ({
  historyFile,
  loggingService: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
  } as unknown as LoggingService,
  settingsService: {
    get: () => maxHistorySize,
  } as unknown as SettingsService,
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

it('trims history to maxHistorySize keeping newest entries', () => {
  const { dir, historyFile } = createTempHistoryFile();
  try {
    const service = new HistoryService(createDeps(historyFile, 3));
    service.addMessage('item 1');
    service.addMessage('item 2');
    service.addMessage('item 3');
    service.addMessage('item 4');
    service.addMessage('item 5');

    expect(service.getMessages()).toEqual(['item 3', 'item 4', 'item 5']);
    const written = JSON.parse(fs.readFileSync(historyFile, 'utf-8')) as { messages: UserTurn[] };
    expect(written.messages.map((m) => m.text)).toEqual(['item 3', 'item 4', 'item 5']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('clear() empties in-memory turns and persists empty history', () => {
  const { dir, historyFile } = createTempHistoryFile();
  try {
    const service = new HistoryService(createDeps(historyFile));
    service.addMessage('persisted message');
    expect(service.getMessages()).toEqual(['persisted message']);

    service.clear();
    expect(service.getMessages()).toEqual([]);
    expect(service.getTurns()).toEqual([]);

    const written = JSON.parse(fs.readFileSync(historyFile, 'utf-8')) as { messages: UserTurn[] };
    expect(written.messages).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('load() logs Failed to load history with filePath when history file is corrupt', () => {
  const { dir, historyFile } = createTempHistoryFile();
  const mockLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    security: vi.fn(),
    setCorrelationId: vi.fn(),
    clearCorrelationId: vi.fn(),
  };
  try {
    fs.writeFileSync(historyFile, 'invalid-json-{', 'utf-8');
    const service = new HistoryService({
      historyFile,
      loggingService: mockLogger as unknown as LoggingService,
      settingsService: { get: () => 1000 } as unknown as SettingsService,
    });

    expect(service.getMessages()).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to load history',
      expect.objectContaining({
        filePath: historyFile,
      }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('swallowed save failure logs Failed to save history and retains in-memory turns', () => {
  const { dir, historyFile } = createTempHistoryFile();
  const mockLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    security: vi.fn(),
    setCorrelationId: vi.fn(),
    clearCorrelationId: vi.fn(),
  };
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
    throw new Error('EACCES: permission denied');
  });
  try {
    const service = new HistoryService({
      historyFile,
      loggingService: mockLogger as unknown as LoggingService,
      settingsService: { get: () => 1000 } as unknown as SettingsService,
    });
    expect(() => service.addMessage('failed write item')).not.toThrow();
    expect(service.getMessages()).toEqual(['failed write item']);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to save history',
      expect.objectContaining({
        filePath: historyFile,
        messageCount: 1,
      }),
    );
  } finally {
    spy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Retained red defect proofs:

it('preserves or quarantines corrupt history file on write instead of destroying it', () => {
  const { dir, historyFile } = createTempHistoryFile();
  const corruptPayload = 'not-valid-json { [corrupted';
  try {
    fs.writeFileSync(historyFile, corruptPayload, 'utf-8');

    const service = new HistoryService(createDeps(historyFile));
    service.addMessage('surviving new prompt');

    // D5 invariant: after addMessage, canonical history.json must be parseable with the new prompt,
    // and a distinct quarantine/backup file must preserve the corrupt prior bytes.
    const canonical = JSON.parse(fs.readFileSync(historyFile, 'utf-8')) as { messages: UserTurn[] };
    expect(canonical.messages.some((m) => m.text === 'surviving new prompt')).toBe(true);

    const otherFiles = fs.readdirSync(dir).filter((file) => file !== 'history.json');
    const quarantineContents = otherFiles.map((file) => fs.readFileSync(path.join(dir, file), 'utf-8'));
    expect(quarantineContents.some((content) => content.includes(corruptPayload))).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('atomic save preserves prior durable history when write fails mid-operation', () => {
  const { dir, historyFile } = createTempHistoryFile();
  try {
    const initialPayload = { messages: [{ text: 'prior durable prompt' }] };
    fs.writeFileSync(historyFile, JSON.stringify(initialPayload), 'utf-8');

    const service = new HistoryService(createDeps(historyFile));

    const origWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((targetPath, data, ...args) => {
      // Simulate non-atomic write that truncates/partially writes target before throwing
      origWrite(targetPath, '{"messages": [{"text": "partially wr', 'utf-8');
      throw new Error('ENOSPC: no space left on device mid-write');
    });

    try {
      service.addMessage('second prompt');
    } finally {
      writeSpy.mockRestore();
    }

    // D6 invariant: atomic save (temp + rename) ensures that a failed/interrupted write
    // leaves the prior durable file intact on disk rather than truncated.
    const content = fs.readFileSync(historyFile, 'utf-8');
    const parsed = JSON.parse(content) as { messages: Array<{ text: string }> };
    expect(parsed.messages).toEqual([expect.objectContaining({ text: 'prior durable prompt' })]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
