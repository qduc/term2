import { createServer } from 'node:http';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { normalizeUsage, formatFooterUsage } from '../../src/shared/utils/ai/token-usage.js';
import {
  normalizeUsage as normalizeTuiUsage,
  formatFooterUsage as formatTuiFooterUsage,
} from '../../src/clients/tui/presentation/utils/ai/token-usage.js';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

// Crosses native/SDK HTTP adapters, the public core Usage boundary, accepted
// cost facts, final rollup, the run_summary record and built CLI JSON. All token
// counts are synthetic. `reasoning` is what the provider reports; Anthropic's
// Messages usage has no reasoning count, so its summary must say null, not 0.
it('accounts for cache creation, whole-request context tiers and one-hour writes', async () => {
  const cases: {
    provider: string;
    model: string;
    input: number;
    read: number;
    write: number;
    long: number;
    micros: number;
    reasoning?: number;
  }[] = [
    {
      provider: 'openai',
      model: 'gpt-6-luna',
      input: 1000,
      read: 600,
      write: 300,
      long: 0,
      micros: 104,
      reasoning: 40,
    },
    {
      provider: 'chat-cost-fixture',
      model: 'gpt-6-luna',
      input: 200,
      read: 50,
      write: 100,
      long: 0,
      micros: 24,
      reasoning: 4,
    },
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
    const output = fixture.provider === 'chat-cost-fixture' ? 10 : 100;
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
      if (fixture.provider === 'chat-cost-fixture') {
        const usage = {
          prompt_tokens: fixture.input,
          completion_tokens: output,
          total_tokens: fixture.input + output,
          cache_write_tokens: fixture.write,
          prompt_tokens_details: { cached_tokens: fixture.read },
          completion_tokens_details: { reasoning_tokens: fixture.reasoning },
        };
        res.end(
          `data: ${JSON.stringify({
            id: 'chat_cost',
            model: fixture.model,
            choices: [{ delta: { role: 'assistant', content: 'COST_OK' }, finish_reason: null }],
          })}\n\ndata: ${JSON.stringify({
            id: 'chat_cost',
            model: fixture.model,
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage,
          })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
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
            output_tokens: output,
            total_tokens: fixture.input + output,
            input_tokens_details: { cached_tokens: fixture.read, cache_write_tokens: fixture.write },
            output_tokens_details: { reasoning_tokens: fixture.reasoning },
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
                : fixture.provider === 'chat-cost-fixture'
                ? [{ id: fixture.provider, name: 'Chat fixture', type: 'openai', baseUrl, apiKey: 'fixture' }]
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
      const fullInput = fixture.provider === 'anthropic' ? fixture.input + fixture.read + fixture.write : fixture.input;
      expect(cost?.usage.prompt_tokens + (cost?.usage.cache_creation_tokens ?? 0)).toBe(fullInput);
      expect(cost?.usage.total_tokens).toBe(fullInput + output);
      const final = events.find((event) => event.type === 'final');
      expect(final?.usage.prompt_tokens + (final?.usage.cache_creation_tokens ?? 0)).toBe(fullInput);
      expect(final?.usage.total_tokens).toBe(fullInput + output);
      // One run_summary per run, just before `completed`, from the same accepted records.
      const summaries = events.filter((event) => event.type === 'run_summary');
      expect(summaries).toHaveLength(1);
      expect(events.at(-2)).toBe(summaries[0]);
      expect(events.at(-1)?.type).toBe('completed');
      const read = fixture.read;
      expect(summaries[0]).toMatchObject({
        outcome: 'completed',
        cost: { usdMicros: fixture.micros, pricedRequests: 1, unpricedRequests: 0 },
        requests: { total: 1, completed: 1 },
        tokens: {
          input: fullInput,
          cacheRead: read,
          fresh: fullInput - read - fixture.write,
          output,
          reasoning: fixture.reasoning ?? null,
          requestsWithUsage: 1,
          requestsWithReasoning: fixture.reasoning === undefined ? 0 : 1,
        },
        cacheHitRatio: { overall: Number((read / fullInput).toFixed(4)), rootAfterFirst: null },
        contextGrowth: { rootRequests: 1, first: fullInput, last: fullInput, max: fullInput, inputTokens: [fullInput] },
        agents: [
          { agent: 'root', role: null, models: [{ provider: fixture.provider, model: fixture.model }], requests: 1 },
        ],
        tools: { calls: 0, errors: 0, repeatedReads: { sameRange: 0, otherRange: 0 }, repeatedShellCommands: 0 },
      });
      expect(summaries[0].tokens.cacheWrite ?? 0).toBe(fixture.write);
      if (fixture.provider === 'chat-cost-fixture') {
        // Consume the actual persisted provider response, rather than a hand-built
        // normalized object, through both presentation paths. This catches the raw
        // chat vs canonical split and ensures replay normalization is idempotent.
        const traffic = join(lease.paths.logDir, 'logs', 'provider-traffic');
        const files = await readdir(traffic, { recursive: true });
        const usages = [];
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const record = JSON.parse(await readFile(join(traffic, file), 'utf8'));
          const usage = record.received?.summary?.payload?.usage;
          if (usage?.cache_write_tokens === fixture.write) usages.push(usage);
        }
        expect(usages).toHaveLength(1);
        for (const [normalize, format] of [
          [normalizeUsage, formatFooterUsage],
          [normalizeTuiUsage, formatTuiFooterUsage],
        ] as const) {
          const once = normalize(usages[0]);
          const twice = normalize(once);
          // The raw response's reasoning count is not in the cost record: agent-core builds
          // that record from Usage fields only. run_summary carries it instead (above).
          expect(once).toEqual({ ...cost.usage, reasoning_tokens: fixture.reasoning });
          expect(twice).toEqual(once);
          expect(format(once)).toContain('200 in');
          expect(format(twice)).toBe(format(once));
        }
      }
    } finally {
      await lease.cleanup();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
