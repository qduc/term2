import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

// Crosses native/SDK HTTP adapters, the public core Usage boundary, accepted
// cost facts, final rollup and built CLI JSON. All token counts are synthetic.
it('accounts for cache creation, whole-request context tiers and one-hour writes', async () => {
  const cases = [
    { provider: 'openai', model: 'gpt-6-luna', input: 1000, read: 600, write: 300, long: 0, micros: 104 },
    { provider: 'anthropic', model: 'claude-haiku-5-5', input: 3, read: 99997, write: 0, long: 0, micros: 1050 },
    { provider: 'anthropic', model: 'claude-haiku-5-5', input: 3, read: 99998, write: 0, long: 0, micros: 5252 },
    {
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      input: 3,
      read: 90000,
      write: 10000,
      long: 1000,
      micros: 11377,
    },
  ];
  for (const fixture of cases) {
    let requests = 0;
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: fixture.model }] }));
        return;
      }
      for await (const _ of req) {
        /* drain request */
      }
      ++requests;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (event: Record<string, unknown>) =>
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (fixture.provider === 'openai') {
        const item = {
          type: 'message',
          id: 'msg_cost',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'COST_OK', annotations: [] }],
        };
        const response = {
          id: 'resp_cost',
          object: 'response',
          status: 'completed',
          model: fixture.model,
          output: [item],
          usage: {
            input_tokens: fixture.input,
            output_tokens: 100,
            total_tokens: fixture.input + 100,
            input_tokens_details: { cached_tokens: fixture.read, cache_write_tokens: fixture.write },
          },
        };
        emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
        emit({ type: 'response.output_item.added', output_index: 0, item });
        emit({ type: 'response.output_item.done', output_index: 0, item });
        emit({ type: 'response.completed', response });
      } else {
        const usage = {
          input_tokens: fixture.input,
          output_tokens: 0,
          cache_read_input_tokens: fixture.read,
          cache_creation_input_tokens: fixture.write,
          cache_creation: {
            ephemeral_5m_input_tokens: fixture.write - fixture.long,
            ephemeral_1h_input_tokens: fixture.long,
          },
        };
        emit({
          type: 'message_start',
          message: {
            id: 'msg_cost',
            type: 'message',
            role: 'assistant',
            model: fixture.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage,
          },
        });
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'COST_OK' } });
        emit({ type: 'content_block_stop', index: 0 });
        emit({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { ...usage, output_tokens: 100 },
        });
        emit({ type: 'message_stop' });
      }
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const lease = await createIsolatedWorkspaceLease({
      prepare: async (root, paths) => {
        await mkdir(join(root, 'project'));
        await mkdir(paths.logDir, { recursive: true });
        await writeFile(
          join(paths.logDir, 'settings.json'),
          JSON.stringify({
            agent: {
              modelSelection: { provider: fixture.provider, model: fixture.model },
              transport: 'http',
              retryAttempts: 0,
              [fixture.provider]: { apiKey: 'fixture', baseUrl },
            },
            sandbox: { enabled: false },
            providers:
              fixture.provider === 'anthropic'
                ? [{ id: 'anthropic', name: 'Anthropic', type: 'anthropic', baseUrl, apiKey: 'fixture' }]
                : [],
          }),
        );
      },
    });
    try {
      const result = await lease.runCli({
        cwd: join(lease.root, 'project'),
        args: ['--auto-approve', '--json', 'Return the fixture response.'],
        deadlineMs: 15000,
        env: {
          OPENAI_BASE_URL: baseUrl,
          OPENAI_API_KEY: 'fixture',
          ANTHROPIC_API_KEY: 'fixture',
          NODE_USE_ENV_PROXY: '0',
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          NO_PROXY: 'localhost,127.0.0.1',
        },
      });
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      expect(requests).toBe(1);
      const events = result.stdout.split('\n').flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const cost = events.find((event) => event.type === 'cost_update')?.record;
      expect(cost?.source).toBe('catalog');
      expect(cost?.usdMicros).toBe(fixture.micros);
      expect(cost?.usage.cache_creation_tokens ?? 0).toBe(fixture.write);
      if (fixture.provider === 'anthropic') expect(cost?.usage.cache_creation_1h_tokens).toBe(fixture.long);
      const fullInput = fixture.provider === 'openai' ? fixture.input : fixture.input + fixture.read + fixture.write;
      expect(cost?.usage.prompt_tokens + (cost?.usage.cache_creation_tokens ?? 0)).toBe(fullInput);
      expect(cost?.usage.total_tokens).toBe(fullInput + 100);
      const final = events.find((event) => event.type === 'final');
      expect(final?.usage.prompt_tokens + (final?.usage.cache_creation_tokens ?? 0)).toBe(fullInput);
      expect(final?.usage.total_tokens).toBe(fullInput + 100);
    } finally {
      await lease.cleanup();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
