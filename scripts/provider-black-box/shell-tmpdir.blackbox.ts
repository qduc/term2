import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

type Message = { role: string; content?: unknown };

// The shell tool exports TMPDIR=<tmpdir>/<home basename>/term2-nodejs. With the
// sandbox disabled nothing created that directory, so `mktemp` (and `go build`)
// failed with "No such file or directory" for every command.
it('gives shell commands a TMPDIR that exists, with the sandbox disabled', async () => {
  const requests: Array<{ messages: Message[] }> = [];
  const probe = 'mktemp -d';
  const calls = [
    ['shell', { command: probe }],
    ['run_code', { code: `return await tools.shell({ command: ${JSON.stringify(probe)} });`, description: 'mktemp' }],
  ] as const;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const next = calls[requests.length - 1];
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
      : { content: 'SHELL_TMPDIR_DONE' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({
        id: `response-${requests.length}`,
        object: 'chat.completion.chunk',
        model: 'meta/muse-ember',
        choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const hostTmp = await mkdtemp(join(tmpdir(), 'term2-shell-tmpdir-'));
  const lease = await createIsolatedWorkspaceLease({
    env: { TMPDIR: hostTmp },
    prepare: async (root, paths) => {
      await mkdir(join(root, 'project'));
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            modelSelection: { provider: 'openrouter', model: 'meta/muse-ember' },
            retryAttempts: 0,
            openrouter: { apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1` },
          },
          shell: { autoApproveMode: 'always' },
          sandbox: { enabled: false },
        }),
      );
    },
  });
  try {
    const result = await lease.runCli({
      cwd: join(lease.root, 'project'),
      args: ['--auto-approve', '--json', 'Check that a temp directory can be made.'],
      deadlineMs: 20000,
    });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(requests).toHaveLength(3);
    const toolText = (request: { messages: Message[] }) =>
      JSON.stringify(request.messages.filter((message) => message.role === 'tool').at(-1)?.content);
    const expected = join(hostTmp, lease.root.split('/').pop()!, 'term2-nodejs');
    for (const index of [1, 2]) {
      expect(toolText(requests[index]!)).toContain(`${expected}/tmp.`);
      expect(toolText(requests[index]!)).not.toMatch(/failed|No such file/i);
    }
    expect((await stat(expected)).mode & 0o777).toBe(0o700);
  } finally {
    await lease.cleanup();
    await rm(hostTmp, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
