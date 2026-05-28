import test from 'ava';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let testDir = '';

test.beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-cli-test-'));
});

test.afterEach.always(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('CLI --resume ls prints list of conversations and exits', (t) => {
  // Create a mock conversation file in the testDir
  const convId = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
  const filePath = path.join(testDir, `${convId}.jsonl`);
  const initEnvelope = {
    v: 1,
    seq: 1,
    ts: '2026-05-28T14:40:16.000Z',
    event: {
      type: 'session_init',
      id: convId,
      createdAt: '2026-05-28T14:40:16.000Z',
      projectPath: '/Users/qduc/src/term2',
      model: 'gpt-4o',
      appMode: {
        mentorMode: false,
        liteMode: true,
        planMode: false,
        orchestratorMode: false,
      },
    },
  };
  const userEnvelope = {
    v: 1,
    seq: 2,
    ts: '2026-05-28T14:40:20.000Z',
    event: {
      type: 'user_message',
      message: {
        id: 'user-msg-1',
        sender: 'user',
        text: 'hello this is a test prompt',
      },
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(initEnvelope) + '\n' + JSON.stringify(userEnvelope) + '\n', 'utf-8');

  // Also touch the file so listConversations gets mtime
  const now = new Date();
  fs.utimesSync(filePath, now, now);

  // Run the built CLI script with environment variable and --resume ls
  // We point to dist/cli.js. Since the test runner compiles TS, dist/cli.js is up to date.
  const cliPath = path.resolve('dist/cli.js');

  const stdout = execSync(`node ${cliPath} --resume ls`, {
    env: {
      ...process.env,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    },
  }).toString();

  t.true(stdout.includes('Recent Conversations (last 10):'));
  t.true(stdout.includes(convId));
  t.false(stdout.includes('/Users/qduc/src/term2'));
  t.true(stdout.includes('hello this is a test prompt'));
  t.true(stdout.includes('1 message'));
  t.true(stdout.includes('model: gpt-4o'));
  t.true(stdout.includes('mode: lite'));
  t.true(stdout.includes(`term2 --resume ${convId}`));
});

test('CLI --resume list also works', (t) => {
  // Create a mock conversation file in the testDir
  const convId = 'a12d4fae-7dec-11d0-a765-00a0c91e6bf6';
  const filePath = path.join(testDir, `${convId}.jsonl`);
  const initEnvelope = {
    v: 1,
    seq: 1,
    ts: '2026-05-28T14:40:16.000Z',
    event: {
      type: 'session_init',
      id: convId,
      createdAt: '2026-05-28T14:40:16.000Z',
      projectPath: '/Users/qduc/src/term2',
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(initEnvelope) + '\n', 'utf-8');

  const now = new Date();
  fs.utimesSync(filePath, now, now);

  const cliPath = path.resolve('dist/cli.js');

  const stdout = execSync(`node ${cliPath} --resume list`, {
    env: {
      ...process.env,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    },
  }).toString();

  t.true(stdout.includes('Recent Conversations (last 10):'));
  t.true(stdout.includes(convId));
});
