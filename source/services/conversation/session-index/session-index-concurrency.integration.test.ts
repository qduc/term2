import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConversationLogWriter } from '../../logging/conversation-log-writer.js';
import { setConversationsDirForTest } from '../conversation-persistence.js';
import { SessionIndexDatabase } from './session-index-database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const databaseTsPath = path.join(__dirname, 'session-index-database.ts');

let dir = '';
let dbPath = '';
const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, getCorrelationId: () => undefined } as any;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-sqi-concurrency-'));
  dbPath = path.join(dir, 'concurrent-index.db');
  setConversationsDirForTest(dir);
});

afterEach(() => {
  setConversationsDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeSession(id: string, projectPath: string, text = 'hello') {
  const writer = createConversationLogWriter({ sessionId: id, dir, logger });
  writer.init({
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    projectPath,
    model: 'model',
    provider: 'provider',
  });
  writer.append({ type: 'user_message', message: { id: `${id}-u`, sender: 'user', text } });
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: `reply ${text}` }] },
    state: { previousResponseId: null },
  });
  void writer.close();
}

function runChildProcessReconcile(
  dbFile: string,
  sourceDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const script = `
      const { createJiti } = require('jiti');
      const jiti = createJiti(process.argv[1]);
      const { SessionIndexDatabase } = jiti(process.argv[1]);
      const db = new SessionIndexDatabase(process.argv[2], process.argv[3]);
      try {
        const res = db.reconcile();
        process.stdout.write(JSON.stringify(res));
        db.close();
        process.exit(res.ok ? 0 : 1);
      } catch (err) {
        process.stderr.write(String(err));
        process.exit(2);
      }
    `;
    const child = spawn(process.execPath, ['-e', script, databaseTsPath, dbFile, sourceDir], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('SessionIndex Multi-Process Concurrency Integration', () => {
  it('handles two real concurrent processes reconciling against the same database without locks or crashes', async () => {
    // Generate 15 session files to ensure non-trivial reconciliation time
    const sessionCount = 15;
    for (let i = 0; i < sessionCount; i++) {
      writeSession(`session-${i}`, `/project-${i % 3}`, `question ${i}`);
    }

    // Launch two real OS child processes simultaneously against the same SQLite database
    const [proc1, proc2] = await Promise.all([
      runChildProcessReconcile(dbPath, dir),
      runChildProcessReconcile(dbPath, dir),
    ]);

    expect(proc1.stderr).toBe('');
    expect(proc2.stderr).toBe('');
    expect(proc1.code).toBe(0);
    expect(proc2.code).toBe(0);

    const res1 = JSON.parse(proc1.stdout);
    const res2 = JSON.parse(proc2.stdout);
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    // Together, either one process replayed all or both replayed a disjoint/overlapping subset,
    // but total replayed across both must be at least sessionCount
    expect(res1.replayedCount + res2.replayedCount).toBeGreaterThanOrEqual(sessionCount);

    // Verify index database consistency after concurrent execution
    const db = new SessionIndexDatabase(dbPath, dir);
    try {
      db.initialize();
      const inventory = db.database.prepare('SELECT COUNT(*) as count FROM source_inventory').get() as {
        count: number;
      };
      expect(inventory.count).toBe(sessionCount);

      const sessions = db.database.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
      expect(sessions.count).toBe(sessionCount);

      const messages = db.database.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
      expect(messages.count).toBe(sessionCount * 2);

      // Subsequent reconcile should see 0 new replays
      const third = db.reconcile();
      expect(third.ok).toBe(true);
      expect(third.replayedCount).toBe(0);
    } finally {
      db.close();
    }
  });
});
