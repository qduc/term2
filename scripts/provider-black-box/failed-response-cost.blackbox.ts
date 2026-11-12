import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

// Crosses native HTTP, core failure settlement, persisted cost facts, tool
// dispatch and the built CLI. The successful tool control proves the sentinel
// would be created if a failed response were accidentally treated as complete.
it.each(['failed', 'incomplete', 'completed'] as const)(
  'retains %s Responses usage without dispatching failed output',
  async (status) => {
    let requests = 0;
    const usage = {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 1100,
    };
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* consume the real SDK request */
      }
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      const output =
        requests === 1
          ? [
              {
                id: 'fc_cost',
                type: 'function_call',
                call_id: 'call_cost',
                name: 'apply_patch',
                status: 'completed',
                arguments: JSON.stringify({
                  patch: '*** Begin Patch\n*** Add File: failed-response-sentinel.txt\n+dispatched\n*** End Patch',
                }),
              },
            ]
          : [
              {
                id: 'msg_cost',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'COST_SETTLED' }],
              },
            ];
      const currentStatus = requests === 1 ? status : 'completed';
      const response = {
        id: `resp_cost_${requests}`,
        object: 'response',
        status: currentStatus,
        model: 'gpt-6.1-sol',
        output,
        usage: requests === 1 ? usage : { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        ...(currentStatus === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        ...(currentStatus === 'failed'
          ? { error: { code: 'server_error', message: 'Injected terminal failure' } }
          : {}),
      };
      emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
      emit({ type: 'response.output_item.added', output_index: 0, item: output[0] });
      emit({ type: 'response.output_item.done', output_index: 0, item: output[0] });
      emit({ type: `response.${currentStatus}`, response });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const lease = await createIsolatedWorkspaceLease({
      prepare: async (root, paths) => {
        await mkdir(join(root, 'project'));
        await mkdir(paths.logDir, { recursive: true });
        await writeFile(
          join(paths.logDir, 'settings.json'),
          JSON.stringify({
            agent: {
              modelSelection: { provider: 'openai', model: 'gpt-6.1-sol' },
              transport: 'http',
              retryAttempts: 0,
            },
          }),
        );
      },
    });
    try {
      const result = await lease.runCli({
        cwd: join(lease.root, 'project'),
        args: ['--auto-approve', '--json', 'Run the fixture and finish.'],
        deadlineMs: 15000,
        env: {
          OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          OPENAI_API_KEY: 'fixture',
          NODE_USE_ENV_PROXY: '0',
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          NO_PROXY: 'localhost,127.0.0.1',
        },
      });
      const events = result.stdout.split('\n').flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const costs = events.filter((event) => event.type === 'cost_update').map((event) => event.record);
      expect(result.exitCode, result.stderr + result.stdout).toBe(status === 'completed' ? 0 : 1);
      expect(requests).toBe(status === 'completed' ? 2 : 1);
      expect(costs).toHaveLength(status === 'completed' ? 2 : 1);
      expect(costs[0]).toMatchObject({
        outcome: status === 'completed' ? 'completed' : 'failed',
        source: 'catalog',
        usdMicros: 2010,
      });
      expect(costs[0].usage).toMatchObject({
        prompt_tokens: 700,
        completion_tokens: 100,
        cache_read_tokens: 600,
        cache_creation_tokens: 300,
        total_tokens: 1100,
      });
      const sentinel = await readFile(join(lease.root, 'project', 'failed-response-sentinel.txt'), 'utf8').catch(
        () => undefined,
      );
      expect(sentinel).toBe(status === 'completed' ? 'dispatched\n' : undefined);
      const final = events.find((event) => event.type === 'final');
      expect(final.costRecords).toHaveLength(costs.length);
      expect(final.usage.total_tokens).toBe(status === 'completed' ? 1115 : 1100);
      if (status !== 'completed') {
        expect(events.some((event) => event.type === 'error')).toBe(true);
        expect(events.some((event) => event.type === 'command_message')).toBe(false);
      }
    } finally {
      await lease.cleanup();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
