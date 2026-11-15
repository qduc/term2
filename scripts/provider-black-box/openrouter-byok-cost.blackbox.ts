import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

// One built-CLI --json run through the OpenRouter provider against a scripted double. OpenRouter
// reports a bring-your-own-key request as `is_byok: true` with `cost` holding only its own fee
// (often 0) and the upstream provider's charge in `cost_details.upstream_inference_cost`; the
// request costs the sum. A non-BYOK frame reports both figures for the same charge and costs
// `cost` alone. Frame shapes follow sanitized OpenRouter traffic; all amounts are synthetic.
type Step = {
  readonly cost: number;
  readonly upstream: number;
  readonly byok: boolean;
  readonly micros: number | undefined;
  /** Replaces `cost_details` on the wire (`null` omits it). */
  readonly details?: Record<string, unknown> | null;
  /** Answers with text, ending the run, instead of a tool call. */
  readonly final?: boolean;
};
const STEPS: readonly Step[] = [
  { cost: 0.0004, upstream: 0.00041, byok: false, micros: 400 },
  { cost: 0.0001, upstream: 0.003, byok: true, micros: 3100 },
  { cost: 0, upstream: 0.002, byok: true, micros: 2000 },
];
// Crossed by the third request (5500) and not before it (3500): the run pauses there.
const MAX_USD_MICROS = 5000;

async function runOpenRouter(steps: readonly Step[]) {
  let served = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock/byok-model' }] }));
      return;
    }
    for await (const _chunk of req);
    const step = steps[served++];
    if (step === undefined) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unscripted request: the cost ceiling did not pause the run' } }));
      return;
    }
    const id = `gen-${served}`;
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 20,
      total_tokens: 1020,
      cost: step.cost,
      is_byok: step.byok,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      ...(step.details === null
        ? {}
        : {
            cost_details: step.details ?? {
              upstream_inference_cost: step.upstream,
              upstream_inference_prompt_cost: step.upstream / 2,
              upstream_inference_completions_cost: step.upstream / 2,
            },
          }),
    };
    const call = {
      index: 0,
      id: `call-${served}`,
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ path: `file-${served}.txt` }) },
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({
        id,
        provider: 'Upstream',
        choices: [
          { delta: step.final ? { role: 'assistant', content: 'Done.' } : { role: 'assistant', tool_calls: [call] } },
        ],
      })}\n\n` +
        `data: ${JSON.stringify({
          id,
          provider: 'Upstream',
          choices: [{ delta: {}, finish_reason: step.final ? 'stop' : 'tool_calls' }],
          usage,
        })}\n\n` +
        'data: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const lease = await createIsolatedWorkspaceLease({
    prepare: async (root, paths) => {
      await mkdir(join(root, 'project'));
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            retryAttempts: 0,
            modelSelection: { model: 'mock/byok-model', provider: 'openrouter' },
            openrouter: { apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1` },
            runBudget: {
              maxUsdMicros: MAX_USD_MICROS,
              warningHeadroomUsdMicros: 0,
              softHeadroomUsdMicros: 0,
              escalation: 'contain',
            },
          },
          sandbox: { enabled: false },
        }),
      );
    },
  });
  try {
    const result = await lease.runCli({
      cwd: join(lease.root, 'project'),
      args: ['--auto-approve', '--json', 'Read the files.'],
      deadlineMs: 30000,
    });
    const events = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>);
    return { result, events, served };
  } finally {
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

it('prices OpenRouter BYOK requests at fee plus upstream cost and enforces the cost ceiling', async () => {
  const { result, events, served } = await runOpenRouter(STEPS);
  expect(served, result.stderr + result.stdout).toBe(STEPS.length);
  expect(result.exitCode, result.stderr).toBe(2);

  const costs = events.filter((event) => event.type === 'cost_update').map((event) => event.record);
  expect(costs.map((record) => [record.provider, record.source, record.usdMicros])).toEqual(
    STEPS.map((step) => ['openrouter', 'provider', step.micros]),
  );
  const total = STEPS.reduce((sum, step) => sum + step.micros!, 0);
  expect(events.filter((event) => event.type === 'run_budget').map((event) => event.evidence)).toContainEqual(
    expect.objectContaining({
      type: 'budget_stage',
      stage: 'critical',
      evidence: expect.objectContaining({ dimension: 'usd', used: total, limit: MAX_USD_MICROS }),
    }),
  );
  expect(events.find((event) => event.type === 'run_summary')).toMatchObject({
    outcome: 'budget_paused',
    cost: { usdMicros: total, state: 'exact', pricedRequests: STEPS.length, unpricedRequests: 0 },
  });
});

// A BYOK frame whose upstream figure is missing or unusable carries only OpenRouter's fee, so it is
// not a provider-reported charge: it must not be recorded as an exact $0 (or a fee-only) price.
it('does not price a BYOK request without a usable upstream cost as exact', async () => {
  const steps: readonly Step[] = [
    { cost: 0, upstream: 0, byok: true, micros: undefined, details: null },
    { cost: 0, upstream: 0, byok: true, micros: undefined, details: { upstream_inference_cost: null } },
    { cost: 0.0001, upstream: 0, byok: true, micros: undefined, details: { upstream_inference_cost: -1 } },
    { cost: 0, upstream: 0, byok: true, micros: undefined, details: { upstream_inference_cost: 'n/a' }, final: true },
  ];
  const { result, events, served } = await runOpenRouter(steps);
  expect(served, result.stderr + result.stdout).toBe(steps.length);
  expect(result.exitCode, result.stderr).toBe(0);
  const costs = events.filter((event) => event.type === 'cost_update').map((event) => event.record);
  expect(costs).toHaveLength(steps.length);
  for (const record of costs) expect(record).not.toMatchObject({ source: 'provider' });
  expect(events.find((event) => event.type === 'run_summary')?.cost).not.toMatchObject({ state: 'exact' });
});
