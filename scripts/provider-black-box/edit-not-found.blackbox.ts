import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

/**
 * The direct CLI has no nested-run driver, so edit healing is unavailable in every
 * entry point. A search_replace whose search text is absent must therefore return
 * the plain not-found guidance: no helper-model request, no healing wording and no
 * internal "nested run driver" error leaking to the model.
 */
it('returns plain actionable guidance when search_replace text is not found, without attempting healing', async () => {
  const requests: Array<{
    model?: string;
    messages: Array<{ role: string; content?: unknown }>;
  }> = [];
  const original = 'alpha\nbeta\n';
  const calls = [
    ['search_replace', { path: 'target.txt', replacements: [{ search_content: 'gamma', replace_content: 'delta' }] }],
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
      : { content: 'NOT_FOUND_OK' };
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
  const lease = await createIsolatedWorkspaceLease({
    prepare: async (root, paths) => {
      await mkdir(join(root, 'project'));
      await writeFile(join(root, 'project/target.txt'), original);
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
    const result = await lease.runCli({
      cwd: join(lease.root, 'project'),
      args: ['--auto-approve', '--json', 'Edit target.txt.'],
      deadlineMs: 15000,
    });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('NOT_FOUND_OK');
    expect(await readFile(join(lease.root, 'project/target.txt'), 'utf8')).toBe(original);
    // Exactly the two root requests: no helper-model healing request in between.
    expect(requests).toHaveLength(2);
    const toolResult = JSON.stringify(requests[1]!.messages.filter((message) => message.role === 'tool').at(-1));
    expect(toolResult).toContain('Search content not found');
    expect(toolResult).not.toMatch(/heal/i);
    expect(toolResult).not.toContain('nested run driver');
    expect(toolResult).not.toContain('Reason:');
  } finally {
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
