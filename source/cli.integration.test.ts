import { it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveSettingsDirectory } from './services/settings/settings-path.js';
import { createTestChildEnv } from './test-helpers/terminal-e2e.js';

const require = createRequire(import.meta.url);

// dist/ is a gitignored build artifact, so a fresh worktree has no compiled
// CLI and these tests would fail until someone runs `pnpm build`. Instead of
// spawning tsx per test (which pays a ~2s compile per process), compile the
// CLI once into a per-worktree cache with the same compiler and config as
// `pnpm build` (incremental, so unchanged work is a fast no-op) and spawn
// that for every test.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const typescriptDir = path.resolve(path.dirname(require.resolve('typescript-7')), '..');
const cliBuildDir = path.join(projectRoot, 'node_modules', '.cache', 'term2-cli-test-build');

let compiledCliPath: string | undefined;
function cliPath(): string {
  if (compiledCliPath) return compiledCliPath;
  fs.mkdirSync(cliBuildDir, { recursive: true });
  try {
    execFileSync(
      process.execPath,
      [
        path.join(typescriptDir, 'bin', 'tsc'),
        '--project',
        'tsconfig.build.json',
        '--outDir',
        cliBuildDir,
        '--incremental',
        '--tsBuildInfoFile',
        path.join(cliBuildDir, 'tsconfig.tsbuildinfo'),
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );
  } catch (error: any) {
    throw new Error(`Failed to build CLI for tests: ${error.stderr?.toString?.() ?? error}`);
  }
  // `pnpm build` copies the prompts next to the compiled output; do the same
  // so import.meta.dirname-based prompt resolution works from the cache dir.
  fs.cpSync(path.join(projectRoot, 'source', 'prompts'), path.join(cliBuildDir, 'prompts'), { recursive: true });
  compiledCliPath = path.join(cliBuildDir, 'cli.js');
  return compiledCliPath;
}

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
  const help = execFileSync('node', [cliPath(), '--help'], {
    env: createTestChildEnv({
      HOME: testDir,
      DISABLE_LOGGING: '1',
    }),
    encoding: 'utf8',
  });

  expect(help).toContain('$ term2 [options] [prompt...]');
  expect(help).toContain(
    '-m, --model <model>                  Model pattern or ID, supports provider/id and optional :<thinking>',
  );
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

  const stdout = execFileSync('node', [cliPath(), '--resume', 'ls'], {
    env: createTestChildEnv({
      HOME: testDir,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    }),
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

  const stdout = execFileSync('node', [cliPath(), '--resume', 'list'], {
    env: createTestChildEnv({
      HOME: testDir,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    }),
  }).toString();

  expect(stdout.includes('Recent Conversations (last 10):')).toBe(true);
  expect(stdout.includes(convId)).toBe(true);
});

it('CLI --resume prints message and exits when no conversation is found', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  let error: any;
  let stderr = '';
  try {
    execFileSync('node', [cliPath(), '--resume', 'dummy'], {
      env: createTestChildEnv({
        HOME: tempHome,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      }),
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
    try {
      execFileSync('node', [cliPath()], {
        env: createTestChildEnv({
          HOME: tempHome,
          TERM2_CONVERSATIONS_DIR: testDir,
          DISABLE_LOGGING: '1',
        }),
        cwd: tempHome,
        input: 'n\n',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      error = err;
      stderr = err.stderr.toString();
    }

    expect(error).toBeTruthy();
    expect(error.status).toBe(1);
    expect(stderr.includes('Warning: you are starting term2 in non-lite mode from your home directory.')).toBe(true);
    expect(stderr.includes('Cancelled.')).toBe(true);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('CLI prompts before starting in non-lite mode from root directory', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));

  let error: any;
  let stderr = '';
  try {
    try {
      execFileSync('node', [cliPath()], {
        env: createTestChildEnv({
          HOME: tempHome,
          TERM2_CONVERSATIONS_DIR: testDir,
          DISABLE_LOGGING: '1',
        }),
        cwd: '/',
        input: 'n\n',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      error = err;
      stderr = err.stderr.toString();
    }

    expect(error).toBeTruthy();
    expect(error.status).toBe(1);
    expect(stderr.includes('Warning: you are starting term2 in non-lite mode from your home directory.')).toBe(true);
    expect(stderr.includes('Cancelled.')).toBe(true);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
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
    execFileSync('node', [cliPath(), '--provider', providerName, 'hello'], {
      env: createTestChildEnv({
        HOME: tempHome,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      }),
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

it('CLI --model reports error and exits 1 when no models match pattern', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  let error: any;
  let stderr = '';
  try {
    execFileSync('node', [cliPath(), '--model', 'nonexistent-xyz-pattern', 'hello'], {
      env: createTestChildEnv({
        HOME: tempHome,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    error = err;
    stderr = err.stderr?.toString?.() ?? '';
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  expect(error).toBeTruthy();
  expect(error.status).toBe(1);
  expect(stderr).toContain('Error: No models match "nonexistent-xyz-pattern".');
});
