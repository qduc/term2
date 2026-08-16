import { it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { resolveSettingsDirectory } from './services/settings/settings-path.js';

const require = createRequire(import.meta.url);

// Run the CLI from TypeScript source via tsx instead of spawning dist/cli.js:
// dist/ is a gitignored build artifact, so a fresh worktree has no compiled
// CLI and these tests would fail until someone runs `pnpm build`.
const cliArgs = ['--import', require.resolve('tsx'), path.resolve('source/cli.tsx')];

let testDir = '';

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-cli-test-'));
});

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

it('CLI --help documents the available command-line options', () => {
  const help = execFileSync('node', [...cliArgs, '--help'], {
    env: {
      ...process.env,
      DISABLE_LOGGING: '1',
    },
    encoding: 'utf8',
  });

  expect(help).toContain('$ term2 [options] [prompt...]');
  expect(help).toContain('-m, --model <model>');
  expect(help).toContain('-p, --provider <provider>');
  expect(help).toContain('-r, --reasoning <effort>');
  expect(help).toContain('-l, --lite');
  expect(help).toContain('--auto-approve');
  expect(help).toContain('--ssh <user@host>');
  expect(help).toContain('--remote-dir <path>');
  expect(help).toContain('--ssh-port <port>');
  expect(help).toContain('-R, --resume [conversation-id|ls]');
  expect(help).toContain('--fork');
});

it('CLI --resume ls prints list of conversations and exits', () => {
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

  const stdout = execFileSync('node', [...cliArgs, '--resume', 'ls'], {
    env: {
      ...process.env,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    },
  }).toString();

  expect(stdout.includes('Recent Conversations (last 10):')).toBe(true);
  expect(stdout.includes(convId)).toBe(true);
  expect(stdout.includes(otherConvId)).toBe(false);
  expect(stdout.includes(process.cwd())).toBe(false);
  expect(stdout.includes('hello this is a test prompt')).toBe(true);
  expect(stdout.includes('1 message')).toBe(true);
  expect(stdout.includes('model: gpt-4o')).toBe(true);
  expect(stdout.includes('mode: lite')).toBe(true);
  expect(stdout.includes(`term2 --resume ${convId}`)).toBe(true);
});

it('CLI --resume list also works', () => {
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

  const stdout = execFileSync('node', [...cliArgs, '--resume', 'list'], {
    env: {
      ...process.env,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    },
  }).toString();

  expect(stdout.includes('Recent Conversations (last 10):')).toBe(true);
  expect(stdout.includes(convId)).toBe(true);
});

it('CLI --resume prints message and exits when no conversation is found', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  let error: any;
  let stderr = '';
  try {
    execFileSync('node', [...cliArgs, '--resume', 'dummy'], {
      env: {
        ...process.env,
        HOME: tempHome,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    error = err;
    stderr = err.stderr.toString();
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  expect(error).toBeTruthy();
  expect(error.status).toBe(1);
  expect(stderr.includes('No conversation found to resume (dummy).')).toBe(true);
  expect(stderr.includes('Run "term2 --resume ls" to list available conversations.')).toBe(true);
});

it('CLI prompts before starting in non-lite mode from home directory', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));

  let error: any;
  let stderr = '';
  try {
    execFileSync('node', cliArgs, {
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

  expect(error).toBeTruthy();
  expect(error.status).toBe(1);
  expect(stderr.includes('Warning: you are starting term2 in non-lite mode from your home directory.')).toBe(true);
  expect(stderr.includes('Cancelled.')).toBe(true);
});

it('CLI prompts before starting in non-lite mode from root directory', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));

  let error: any;
  let stderr = '';
  try {
    execFileSync('node', cliArgs, {
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

  expect(error).toBeTruthy();
  expect(error.status).toBe(1);
  expect(stderr.includes('Warning: you are starting term2 in non-lite mode from your home directory.')).toBe(true);
  expect(stderr.includes('Cancelled.')).toBe(true);
});

it('CLI accepts a custom provider from settings.json in non-interactive mode', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const settingsDir = resolveSettingsDirectory({ homeDir: tempHome });
  fs.mkdirSync(settingsDir, { recursive: true });
  const providerName = 'my-custom-provider';

  const settingsFile = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        agent: {
          retryAttempts: 0,
        },
        providers: [
          {
            name: providerName,
            type: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:65535/v1',
            apiKey: 'test-key',
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );

  let error: any;
  let stderr = '';

  try {
    execFileSync('node', [...cliArgs, '--provider', providerName, 'hello'], {
      env: {
        ...process.env,
        HOME: tempHome,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    error = err;
    stderr = err.stderr?.toString?.() ?? '';
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  // The command may still fail due to missing upstream provider endpoint, but
  // it should not fail the early provider validation path.
  expect(stderr.includes(`Error: Unknown provider "${providerName}".`)).toBe(false);
  expect(error).toBeTruthy();
});
