import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

export type ScriptedCall =
  | { readonly code: string; readonly inputs?: Record<string, unknown> }
  /** A direct (non-run_code) tool call, for failure text the direct tool shares with its scripted use. */
  | { readonly tool: string; readonly args: Record<string, unknown> };

/**
 * Drives the built CLI with a mock model that issues one `run_code` call per
 * entry of `scripts`, in order, then answers `DONE`. Returns the text of each
 * tool result exactly as the next provider request carried it, so scenarios
 * assert on what the model would have read.
 */
export async function runScriptedRunCode(options: {
  readonly scripts: readonly ScriptedCall[];
  readonly files?: Readonly<Record<string, string>>;
  /** Runs while the isolated workspace still exists, e.g. to read a spooled file the result names. */
  readonly beforeCleanup?: (results: string[], workspaceRoot: string) => Promise<void>;
}): Promise<string[]> {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: 'meta/muse-ember', created: Math.floor(Date.now() / 1000), supported_parameters: ['tools'] }],
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const ordinal = requests.length;
    const script = options.scripts[ordinal - 1];
    const delta = script
      ? {
          tool_calls: [
            {
              index: 0,
              id: `script-${ordinal}`,
              type: 'function',
              function:
                'tool' in script
                  ? { name: script.tool, arguments: JSON.stringify(script.args) }
                  : {
                      name: 'run_code',
                      arguments: JSON.stringify({
                        description: `Scripted failure scenario ${ordinal}`,
                        code: script.code,
                        ...(script.inputs ? { inputs: script.inputs } : {}),
                      }),
                    },
            },
          ],
        }
      : { content: 'DONE' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = [
      { id: `reply-${ordinal}`, choices: [{ index: 0, delta }] },
      { id: `reply-${ordinal}`, choices: [{ index: 0, delta: {}, finish_reason: script ? 'tool_calls' : 'stop' }] },
    ];
    res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n'].join(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const workspace = await createIsolatedWorkspaceLease({
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
            modelSelection: { provider: 'openrouter', model: 'meta/muse-ember' },
            retryAttempts: 0,
            openrouter: { apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1` },
          },
          sandbox: { enabled: false },
        }),
      );
    },
  });
  try {
    const result = await workspace.runCli({
      cwd: join(workspace.root, 'project'),
      args: ['--auto-approve', '--json', 'Run the scripted run_code scenarios.'],
      deadlineMs: 30000,
    });
    if (result.exitCode !== 0) throw new Error(`CLI exited ${result.exitCode}: ${result.stderr}${result.stdout}`);
    const last = requests[requests.length - 1];
    if (!last) throw new Error('No provider request was made');
    const results = last.messages
      .filter((message) => message.role === 'tool')
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : (message.content as Array<{ text?: string }>).map((part) => part.text ?? '').join(''),
      );
    await options.beforeCleanup?.(results, workspace.root);
    return results;
  } finally {
    await workspace.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
