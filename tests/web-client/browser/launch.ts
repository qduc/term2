import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld, removeWorld, writeWorldSettings, type World } from '../../helpers/loopback-chat-world.js';

/**
 * Launches what a user gets from `term2-web` (the built gateway plus the built web UI, started by
 * `dist/web.js`) in an isolated world, against a loopback model double. Nothing here reaches a real
 * provider, and every path the product writes is under one per-launch temp directory.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const webLauncher = path.join(repoRoot, 'dist', 'web.js');
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;

/** One model response: assistant text, one tool call, or an HTTP error from the provider. */
export type ModelStep =
  | { readonly text: string }
  | { readonly call: { readonly tool: string; readonly args: Record<string, unknown> } }
  | { readonly error: { readonly status: number; readonly message: string } };

type WireMessage = { role: string; content?: unknown };
export type ModelRequest = { messages: WireMessage[]; tools?: { function: { name: string } }[] };

export type ModelDouble = {
  readonly baseUrl: string;
  /** Requests whose latest user message is `prompt`, in arrival order. */
  readonly turn: (prompt: string) => ModelRequest[];
  /** Requests that matched no script; a flow asserts this stays empty. */
  readonly unscripted: () => ModelRequest[];
  readonly close: () => Promise<void>;
};

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
    ? content.map((part) => (typeof part === 'string' ? part : (part as { text?: string }).text ?? '')).join('')
    : '';

function latestUserPrompt(request: ModelRequest): { prompt: string; toolResults: number } {
  const lastUser = request.messages.map((message) => message.role).lastIndexOf('user');
  return {
    prompt: textOf(request.messages[lastUser]?.content).trim(),
    toolResults: request.messages.slice(lastUser).filter((message) => message.role === 'tool').length,
  };
}

/**
 * An OpenAI-compatible model double. A request whose latest user message is a key of `scripts` gets that
 * script's next step: one step per tool result already returned after that message. Keying on the prompt,
 * not on arrival order, keeps a request the product makes on its own from consuming a scripted step.
 */
export async function startModelDouble(scripts: Record<string, readonly ModelStep[]>): Promise<ModelDouble> {
  const scripted: { prompt: string; request: ModelRequest }[] = [];
  const unscripted: ModelRequest[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = JSON.parse(body) as ModelRequest;
      const { prompt, toolResults } = latestUserPrompt(request);
      const step = scripts[prompt]?.[toolResults];
      if (!step) {
        unscripted.push(request);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `model double: no scripted step for "${prompt}"` } }));
        return;
      }
      scripted.push({ prompt, request });
      if ('error' in step) {
        res.writeHead(step.error.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: step.error.message, type: 'invalid_request_error' } }));
        return;
      }
      const id = `chatcmpl-${scripted.length}`;
      const delta =
        'call' in step
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${scripted.length}`,
                  type: 'function',
                  function: { name: step.call.tool, arguments: JSON.stringify(step.call.args) },
                },
              ],
            }
          : { role: 'assistant', content: step.text };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          `data: ${JSON.stringify({ id, choices: [{ delta }] })}`,
          `data: ${JSON.stringify({
            id,
            choices: [{ delta: {}, finish_reason: 'call' in step ? 'tool_calls' : 'stop' }],
          })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`,
    turn: (prompt) => scripted.filter((entry) => entry.prompt === prompt).map((entry) => entry.request),
    unscripted: () => [...unscripted],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type WebApp = {
  /** `http://127.0.0.1:<port>` of the web UI. */
  readonly origin: string;
  /** Name of the folder a flow picks as its workspace; it sits directly under the launch's isolated HOME. */
  readonly workspaceName: string;
  readonly model: ModelDouble;
  /** Everything the gateway and the web server printed, for a failure message. */
  readonly output: () => string;
  /** Stops the gateway, the web server and the model double, then removes the temp directory. */
  readonly close: () => Promise<void>;
};

/** Whether any process is left in the process group led by `group`. */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolves once `predicate` holds; the timer only bounds the wait, the condition ends it. */
function waitFor(predicate: () => boolean, timeoutMs: number, describe: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      try {
        if (predicate()) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(poll);
          reject(new Error(describe()));
        }
      } catch (error) {
        clearInterval(poll);
        reject(error);
      }
    }, 25);
  });
}

export async function launchWebApp(options: {
  readonly scripts: Record<string, readonly ModelStep[]>;
  /** Files to create in the workspace before the gateway starts, by relative path. */
  readonly files?: Record<string, string>;
}): Promise<WebApp> {
  if (!fs.existsSync(webLauncher) || !fs.existsSync(path.join(repoRoot, 'dist', 'web-client', '.next', 'BUILD_ID'))) {
    throw new Error('The built web UI is missing. Run `pnpm build && node scripts/build-web.mjs` first.');
  }
  const model = await startModelDouble(options.scripts);
  const world: World = createWorld('t2web');
  // The folder picker starts at HOME and the gateway admits folders under it, so the workspace is a
  // folder there. `world.workspace` is only the directory the launcher starts in.
  const workspaceName = 'flow-workspace';
  const workspace = path.join(world.home, workspaceName);
  fs.mkdirSync(workspace);
  for (const [name, content] of Object.entries(options.files ?? {})) {
    fs.writeFileSync(path.join(workspace, name), content);
  }
  // Product defaults, apart from the provider and `retryAttempts: 0` that the helper writes.
  writeWorldSettings(world, model.baseUrl);

  // Its own process group, so teardown can account for every descendant (gateway, Next server).
  const child = spawn(process.execPath, [webLauncher], {
    cwd: world.workspace,
    env: { ...world.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  let exit: string | undefined;
  const closed = new Promise<void>((resolve) =>
    child.once('close', (code, signal) => {
      exit = `code=${code} signal=${signal}`;
      resolve();
    }),
  );
  const group = child.pid!;

  const close = async (): Promise<void> => {
    // dist/web.js stops its children on SIGTERM; the group kill covers anything that outlives it.
    if (exit === undefined) child.kill('SIGTERM');
    const forced = setTimeout(() => {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    }, STOP_TIMEOUT_MS);
    await closed;
    clearTimeout(forced);
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      // No process is left in the group, which is the expected case.
    }
    try {
      await waitFor(
        () => !groupAlive(group),
        STOP_TIMEOUT_MS,
        () => `term2-web process group ${group} is still alive after teardown`,
      );
    } finally {
      await model.close();
      removeWorld(world);
    }
  };

  try {
    let origin: string | undefined;
    await waitFor(
      () => {
        if (exit !== undefined) throw new Error(`term2-web exited before it was ready (${exit})\n${output}`);
        origin = output.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        return origin !== undefined && /Ready in/.test(output);
      },
      READY_TIMEOUT_MS,
      () => `term2-web did not become ready within ${READY_TIMEOUT_MS} ms\n${output}`,
    );
    // The page's first request needs the signed gateway route, not only the Next listener.
    const probe = await fetch(`${origin}/api/agent/workspaces`, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
    if (!probe.ok) throw new Error(`Gateway route answered ${probe.status}: ${await probe.text()}\n${output}`);
    return { origin: origin!, workspaceName, model, output: () => output, close };
  } catch (error) {
    await close();
    throw error;
  }
}
