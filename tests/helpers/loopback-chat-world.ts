import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import { createTestChildEnv } from './terminal-e2e.js';

/**
 * Fixtures for tests that run the built CLI against a loopback chat-completions
 * provider that plays the model: an isolated world (HOME, XDG, config,
 * conversations, scratch), a scripted provider, and helpers that read back what
 * the CLI sent to the model.
 *
 * Isolation rule (AGENTS.md, "Shell safety for agents"): the child's
 * TMPDIR/TEMP/TMP is a directory of its own (`scratch`, named with the app
 * suffix so the CLI adopts it as its sandbox temp dir). It is distinct from the
 * workspace and from `outside`, so an inherited scratch path cannot change how a
 * target is classified.
 */

export type World = {
  /** Parent of everything below; removed by `removeWorld`. */
  readonly root: string;
  readonly home: string;
  /** The launch directory. */
  readonly workspace: string;
  /** A sibling directory the launch directory does not contain. */
  readonly outside: string;
  /** The child's TMPDIR/TEMP/TMP. */
  readonly scratch: string;
  readonly conversations: string;
  readonly env: NodeJS.ProcessEnv;
};

export function createWorld(prefix: string): World {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  const dir = (...segments: string[]) => {
    const target = path.join(root, ...segments);
    fs.mkdirSync(target, { recursive: true });
    return target;
  };
  const home = dir('home');
  const scratch = dir('scratch', 'term2-nodejs');
  const conversations = dir('conversations');
  const env = createTestChildEnv({
    HOME: home,
    TMPDIR: scratch,
    TEMP: scratch,
    TMP: scratch,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_RUNTIME_DIR: dir('runtime'),
    TERM2_CONFIG_DIR: path.join(home, '.term2'),
    TERM2_CACHE_DIR: path.join(home, '.cache', 'term2'),
    TERM2_CONVERSATIONS_DIR: conversations,
    DISABLE_LOGGING: '1',
    CI: 'false',
  });
  return { root, home, workspace: dir('workspace'), outside: dir('outside'), scratch, conversations, env };
}

export function removeWorld(world: World | undefined): void {
  if (!world) return;
  const runtimeRoot = path.join(world.root, 'runtime');
  const pids: number[] = [];
  try {
    for (const entry of fs.readdirSync(runtimeRoot)) {
      const adPath = path.join(runtimeRoot, entry, 'daemon.json');
      if (!fs.existsSync(adPath)) continue;
      const ad = JSON.parse(fs.readFileSync(adPath, 'utf8')) as { pid?: number };
      if (typeof ad.pid === 'number' && Number.isSafeInteger(ad.pid) && ad.pid > 1) {
        pids.push(ad.pid);
        try {
          process.kill(ad.pid, 'SIGTERM');
        } catch {
          // Process already exited.
        }
      }
    }
  } catch {
    // Best-effort cleanup when no daemon ran in this world.
  }
  if (pids.length > 0) {
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 2_000;
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (Date.now() < deadline && pids.some(isAlive)) {
      Atomics.wait(sleeper, 0, 0, 20);
    }
    for (const pid of pids) {
      if (!isAlive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
    const killDeadline = Date.now() + 500;
    while (Date.now() < killDeadline && pids.some(isAlive)) {
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  fs.rmSync(world.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Write the world's settings with the loopback provider selected; `extra` is merged over the defaults. */
export function writeWorldSettings(world: World, baseUrl: string, extra: Record<string, unknown> = {}): void {
  const directory = resolveSettingsDirectory({ homeDir: world.home, env: world.env });
  fs.mkdirSync(directory, { recursive: true });
  const { agent, ...rest } = extra as { agent?: Record<string, unknown> };
  fs.writeFileSync(
    path.join(directory, 'settings.json'),
    JSON.stringify({
      ...rest,
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' }, ...agent },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
    }),
  );
}

export type ScriptedTurn = {
  /** Assistant text, delivered in one frame. */
  readonly text?: string;
  /** Assistant text delivered as one frame per entry. */
  readonly deltas?: readonly string[];
  /** Reasoning text (`reasoning_content`), sent before any text. */
  readonly reasoning?: string;
  /** A tool call that ends the response. */
  readonly call?: { readonly tool: string; readonly args: Record<string, unknown> };
};

/** What the approval reviewer model answers when the CLI asks it about a tool call. */
export type ReviewerVerdict = { readonly approve: boolean; readonly reasoning: string };

export type WireMessage = { role: string; content?: unknown; tool_call_id?: string };
export type WireRequest = { model?: string; messages: WireMessage[]; tools?: { function: { name: string } }[] };

export type LoopbackProvider = {
  readonly baseUrl: string;
  /** Chat requests from the agent, in order (reviewer requests excluded). */
  readonly requests: () => WireRequest[];
  /** Chat requests the approval reviewer made. */
  readonly reviews: () => WireRequest[];
  readonly close: () => Promise<void>;
};

const REVIEWER_PROMPT_PREFIX = 'You decide whether tool actions';

function frameBody(turn: ScriptedTurn, n: number): unknown[] {
  const id = `chatcmpl-${n}`;
  const frames: unknown[] = [];
  if (turn.reasoning !== undefined) {
    frames.push({ id, choices: [{ delta: { role: 'assistant', reasoning_content: turn.reasoning } }] });
  }
  for (const piece of turn.deltas ?? (turn.text !== undefined ? [turn.text] : [])) {
    frames.push({ id, choices: [{ delta: { role: 'assistant', content: piece } }] });
  }
  if (turn.call) {
    const { tool, args } = turn.call;
    frames.push({
      id,
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_${n}`,
                type: 'function',
                function: { name: tool, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    });
  }
  frames.push({ id, choices: [{ delta: {}, finish_reason: turn.call ? 'tool_calls' : 'stop' }] });
  return frames;
}

function sse(frames: unknown[]): string {
  return [...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n');
}

/**
 * A loopback OpenAI-compatible provider. Agent request n gets `turns[n - 1]`; past the end of the script
 * it answers `DONE`. `onRequest` runs synchronously when agent request n arrives, before the reply is
 * written, so a test can observe the machine at the moment the model would see a tool result.
 */
export async function startLoopbackProvider(options: {
  readonly turns: readonly ScriptedTurn[];
  readonly reviewer?: ReviewerVerdict;
  readonly onRequest?: (n: number, request: WireRequest) => void;
}): Promise<LoopbackProvider> {
  const requests: WireRequest[] = [];
  const reviews: WireRequest[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const request = JSON.parse(body) as WireRequest;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const first = request.messages[0]?.content;
      if (typeof first === 'string' && first.startsWith(REVIEWER_PROMPT_PREFIX)) {
        reviews.push(request);
        const verdict = options.reviewer ?? { approve: false, reasoning: 'no reviewer scripted' };
        const evaluation = {
          results: [
            {
              reasoning: verdict.reasoning,
              riskLevel: verdict.approve ? 'low' : 'high',
              authorization: verdict.approve ? 'explicit' : 'weak',
              confidence: 'high',
            },
          ],
        };
        res.end(sse(frameBody({ text: JSON.stringify(evaluation) }, 0)));
        return;
      }
      requests.push(request);
      const n = requests.length;
      options.onRequest?.(n, request);
      res.end(sse(frameBody(options.turns[n - 1] ?? { text: 'DONE' }, n)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => [...requests],
    reviews: () => [...reviews],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Run the built CLI headlessly. Async on purpose: the provider lives in this process, so a synchronous
 * spawn would block the event loop the provider needs. stdin is closed at once.
 */
export function runCli(
  world: World,
  cliPath: string,
  args: string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn('node', [cliPath, ...args], {
    env: world.env,
    cwd: options.cwd ?? world.workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 60_000,
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : (part as { text?: string }).text ?? '')).join('');
  }
  return JSON.stringify(content);
}

/** The tool results the CLI sent back in a request, in order, as plain text with the call id each answers. */
export function toolResults(request: WireRequest | undefined): { id: string | undefined; text: string }[] {
  return (request?.messages ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) => ({ id: message.tool_call_id, text: text(message.content) }));
}

/** Whether a process is still running. A zombie that nothing reaped counts as gone. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  // `ps` prints no state for a pid that vanished between the two calls and `Z` for a zombie.
  const state = spawnSyncPsState(pid);
  return state !== '' && !state.startsWith('Z');
}

function spawnSyncPsState(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
