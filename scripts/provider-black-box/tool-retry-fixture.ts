import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

type ChatRequest = { model?: string; tools?: unknown[]; messages: Array<{ role: string; content?: unknown }> };

export type ScriptedToolCall = readonly [name: string, args: unknown];

export interface ScriptedToolRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly requests: ChatRequest[];
  /** Tool-result texts the model saw, in call order (taken from the final request). */
  readonly toolResults: string[];
  /** Result of `options.inspect`, run before the isolated workspace is cleaned up. */
  readonly inspected: unknown;
  /** Final contents of `options.readBack` files (empty string when absent), captured before cleanup. */
  readonly files: Readonly<Record<string, string>>;
}

const textOf = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content));

/**
 * Black-box scenario driver for harness result text: a scripted OpenAI-compatible model issues
 * `calls` one per request (then answers `DONE`), the built CLI runs them in an isolated project
 * holding `files`, and the tool results the model was shown are returned.
 */
export async function runScriptedToolCalls(options: {
  files?: Readonly<Record<string, string>>;
  readBack?: readonly string[];
  /** Runs after the CLI exits and before cleanup, with the tool results the model saw. */
  inspect?: (toolResults: string[]) => Promise<unknown>;
  calls: readonly ScriptedToolCall[];
  /** Model id sent through the fixture provider (default `meta/muse-ember`). GPT-5 ids select the patch editing surface. */
  model?: string;
  settings?: Record<string, unknown>;
  args?: string[];
}): Promise<ScriptedToolRun> {
  const { readFile } = await import('node:fs/promises');
  const requests: ChatRequest[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const next = options.calls[requests.length - 1];
    const delta = next
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call-${requests.length}`,
              type: 'function',
              function: { name: next[0], arguments: JSON.stringify(next[1]) },
            },
          ],
        }
      : { content: 'DONE' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({
        id: `response-${requests.length}`,
        object: 'chat.completion.chunk',
        model: options.model ?? 'meta/muse-ember',
        choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const lease = await createIsolatedWorkspaceLease({
    prepare: async (root, paths) => {
      await mkdir(join(root, 'project'));
      for (const [name, content] of Object.entries(options.files ?? {})) {
        await mkdir(dirname(join(root, 'project', name)), { recursive: true });
        await writeFile(join(root, 'project', name), content);
      }
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            modelSelection: { provider: 'openrouter', model: options.model ?? 'meta/muse-ember' },
            retryAttempts: 0,
            openrouter: { apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1` },
          },
          sandbox: { enabled: false },
          ...options.settings,
        }),
      );
    },
  });
  try {
    const result = await lease.runCli({
      cwd: join(lease.root, 'project'),
      args: options.args ?? ['--auto-approve', '--json', 'Run the scripted calls.'],
      deadlineMs: 20000,
    });
    const last = requests.at(-1);
    const toolResults = (last?.messages ?? []).filter((m) => m.role === 'tool').map((m) => textOf(m.content));
    const files: Record<string, string> = {};
    for (const name of options.readBack ?? []) {
      files[name] = await readFile(join(lease.root, 'project', name), 'utf8').catch(() => '');
    }
    const inspected = await options.inspect?.(toolResults);
    return {
      inspected,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      requests,
      toolResults,
      files,
    };
  } finally {
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
