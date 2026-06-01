import test from 'ava';
import { execFileSync, execSync } from 'child_process';
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
      projectPath: process.cwd(),
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

  // Create a second mock conversation from a different project path
  const otherConvId = 'b22d4fae-7dec-11d0-a765-00a0c91e6bf6';
  const otherFilePath = path.join(testDir, `${otherConvId}.jsonl`);
  const otherInitEnvelope = {
    v: 1,
    seq: 1,
    ts: '2026-05-28T14:40:16.000Z',
    event: {
      type: 'session_init',
      id: otherConvId,
      createdAt: '2026-05-28T14:40:16.000Z',
      projectPath: '/Users/qduc/src/other-project',
    },
  };
  fs.writeFileSync(otherFilePath, JSON.stringify(otherInitEnvelope) + '\n', 'utf-8');

  // Also touch the files so listConversations gets mtime
  const now = new Date();
  fs.utimesSync(filePath, now, now);
  fs.utimesSync(otherFilePath, now, now);

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
  t.false(stdout.includes(otherConvId));
  t.false(stdout.includes(process.cwd()));
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
      projectPath: process.cwd(),
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

test('CLI --resume prints message and exits when no conversation is found', (t) => {
  const cliPath = path.resolve('dist/cli.js');

  let error: any;
  let stderr = '';
  try {
    execSync(`node ${cliPath} --resume dummy`, {
      env: {
        ...process.env,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    error = err;
    stderr = err.stderr.toString();
  }

  t.truthy(error);
  t.is(error.status, 1);
  t.true(stderr.includes('No conversation found to resume (dummy).'));
  t.true(stderr.includes('Run "term2 --resume ls" to list available conversations.'));
});

test('CLI prompts before starting in non-lite mode from home directory', (t) => {
  const cliPath = path.resolve('dist/cli.js');
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));

  let error: any;
  let stderr = '';
  try {
    execFileSync('node', [cliPath], {
      env: {
        ...process.env,
        HOME: tempHome,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      },
      cwd: tempHome,
      input: 'n\n',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    error = err;
    stderr = err.stderr.toString();
  }

  fs.rmSync(tempHome, { recursive: true, force: true });

  t.truthy(error);
  t.is(error.status, 1);
  t.true(stderr.includes('Warning: you are starting term2 in non-lite mode from your home directory.'));
  t.true(stderr.includes('Cancelled.'));
});

test('CLI prompts before starting in non-lite mode from root directory', (t) => {
  const cliPath = path.resolve('dist/cli.js');
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));

  let error: any;
  let stderr = '';
  try {
    execFileSync('node', [cliPath], {
      env: {
        ...process.env,
        HOME: tempHome,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      },
      cwd: '/',
      input: 'n\n',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    error = err;
    stderr = err.stderr.toString();
  }

  fs.rmSync(tempHome, { recursive: true, force: true });

  t.truthy(error);
  t.is(error.status, 1);
  t.true(stderr.includes('Warning: you are starting term2 in non-lite mode from your home directory.'));
  t.true(stderr.includes('Cancelled.'));
});
