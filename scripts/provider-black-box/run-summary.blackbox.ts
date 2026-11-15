import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

// One built-CLI --json run against a scripted chat-completions double: several tools, a same-range
// and a different-range re-read, a repeated shell command (differing only in surrounding spaces), a
// schema rejection, a failing read and a background explorer subagent, with cached and reasoning
// usage and a provider cost on every response. Expected numbers come from the fixture tables, not
// from the implementation. All counts are synthetic.
const CHILD_TASK = 'RUN_SUMMARY_CHILD_TASK: read a.txt then reply done.';
type Step = {
  readonly call?: readonly [string, Record<string, unknown>];
  readonly text?: string;
  /** prompt (incl. cached), completion, cached, reasoning, provider cost in USD. */
  readonly usage: readonly [number, number, number, number, string];
};
const ROOT: readonly Step[] = [
  { call: ['read_file', { path: 'a.txt' }], usage: [1000, 50, 0, 10, '0.001'] },
  { call: ['read_file', { path: './a.txt' }], usage: [1200, 40, 900, 0, '0.0005'] },
  { call: ['read_file', { path: 'a.txt', start_line: 1, end_line: 1 }], usage: [1300, 30, 1000, 0, '0.0004'] },
  { call: ['shell', { command: 'ls', description: 'List' }], usage: [1400, 30, 1100, 20, '0.0005'] },
  { call: ['shell', { command: '  ls ', description: 'List again' }], usage: [1500, 30, 1300, 0, '0.0004'] },
  { call: ['read_file', { path: 7 }], usage: [1600, 20, 1400, 5, '0.0004'] },
  { call: ['read_file', { path: 'missing.txt' }], usage: [1700, 20, 1500, 0, '0.0004'] },
  {
    call: ['run_subagent', { execution: 'background', role: 'explorer', task: CHILD_TASK }],
    usage: [1800, 60, 1600, 30, '0.0006'],
  },
  { text: 'All done.', usage: [2000, 10, 1700, 0, '0.0003'] },
  // The silent turn that delivers the explorer's completion.
  { text: 'Noted the explorer result.', usage: [2400, 8, 1900, 0, '0.0002'] },
];
const CHILD: readonly Step[] = [
  { call: ['read_file', { path: 'a.txt' }], usage: [500, 15, 0, 0, '0.0002'] },
  { text: 'done', usage: [600, 5, 400, 3, '0.0001'] },
];

const sum = (steps: readonly Step[], index: number) =>
  steps.reduce((total, step) => total + (step.usage[index] as number), 0);
const micros = (steps: readonly Step[]) =>
  steps.reduce((total, step) => total + Math.round(Number(step.usage[4]) * 1_000_000), 0);

it('summarizes a multi-request run with tools, repeats, rejections and a subagent', async () => {
  const served = { root: 0, child: 0 };
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content: unknown }[] };
    const child = body.messages.some(
      (message) => message.role === 'user' && JSON.stringify(message.content).includes(CHILD_TASK),
    );
    const who = child ? 'child' : 'root';
    const step = (child ? CHILD : ROOT)[served[who]++];
    if (step === undefined) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unscripted ${who} request` } }));
      return;
    }
    const [prompt, completion, cached, reasoning, cost] = step.usage;
    const usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: cached },
      ...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
      cost,
    };
    const id = `${who}-${served[who]}`;
    const delta = step.call
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: { name: step.call[0], arguments: JSON.stringify(step.call[1]) },
            },
          ],
        }
      : { role: 'assistant', content: step.text };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ id, choices: [{ delta }] })}\n\n` +
        `data: ${JSON.stringify({
          id,
          choices: [{ delta: {}, finish_reason: step.call ? 'tool_calls' : 'stop' }],
          usage,
        })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const lease = await createIsolatedWorkspaceLease({
    prepare: async (root, paths) => {
      await mkdir(join(root, 'project'));
      await writeFile(join(root, 'project', 'a.txt'), 'alpha\n');
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
          providers: [
            {
              name: 'mockprov',
              type: 'openai-compatible',
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: 'fixture',
            },
          ],
          sandbox: { enabled: false },
        }),
      );
    },
  });
  try {
    const result = await lease.runCli({
      cwd: join(lease.root, 'project'),
      args: ['--auto-approve', '--json', 'Inspect a.txt.'],
      deadlineMs: 30000,
    });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(served).toEqual({ root: ROOT.length, child: CHILD.length });
    const events = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>);
    const summaries = events.filter((event) => event.type === 'run_summary');
    expect(summaries).toHaveLength(1);
    expect(events.at(-2)).toBe(summaries[0]);
    expect(events.at(-1)).toMatchObject({ type: 'completed', finalText: 'Noted the explorer result.' });
    const summary = summaries[0]!;

    const all = [...ROOT, ...CHILD];
    const rootAfterFirst = ROOT.slice(1);
    expect(summary).toMatchObject({
      outcome: 'completed',
      cost: { usdMicros: micros(all), state: 'exact', pricedRequests: all.length, unpricedRequests: 0 },
      requests: { total: all.length, completed: all.length, failed: 0, cancelled: 0, compaction: 0 },
      tokens: {
        input: sum(all, 0),
        cacheRead: sum(all, 2),
        fresh: sum(all, 0) - sum(all, 2),
        cacheWrite: null,
        output: sum(all, 1),
        reasoning: sum(all, 3),
        requestsWithUsage: all.length,
        requestsWithReasoning: all.filter((step) => step.usage[3] > 0).length,
      },
      cacheHitRatio: {
        overall: Number((sum(all, 2) / sum(all, 0)).toFixed(4)),
        rootAfterFirst: Number((sum(rootAfterFirst, 2) / sum(rootAfterFirst, 0)).toFixed(4)),
      },
      contextGrowth: {
        rootRequests: ROOT.length,
        first: ROOT[0]!.usage[0],
        last: ROOT.at(-1)!.usage[0],
        max: Math.max(...ROOT.map((step) => step.usage[0])),
        inputTokens: ROOT.map((step) => step.usage[0]),
      },
      tools: {
        // 8 root calls and the explorer's one read.
        calls: 9,
        byName: { read_file: 6, shell: 2, run_subagent: 1 },
        // The schema-rejected read and the missing file.
        errors: 2,
        rejections: { invalidInput: 1, unknownTool: 0 },
        // './a.txt' after 'a.txt', and the explorer's 'a.txt'; the line-1 read is another range.
        repeatedReads: { sameRange: 2, otherRange: 1 },
        repeatedShellCommands: 1,
      },
    });
    expect(summary.agents).toHaveLength(2);
    expect(summary.agents[0]).toMatchObject({
      agent: 'root',
      role: null,
      models: [{ provider: 'mockprov', model: 'mock-alpha' }],
      requests: ROOT.length,
      cost: { usdMicros: micros(ROOT) },
      tokens: { input: sum(ROOT, 0), cacheRead: sum(ROOT, 2), reasoning: sum(ROOT, 3) },
      toolCalls: 8,
    });
    expect(summary.agents[1]).toMatchObject({
      role: 'explorer',
      mode: 'background',
      models: [{ provider: 'mockprov', model: 'mock-alpha' }],
      requests: CHILD.length,
      cost: { usdMicros: micros(CHILD) },
      tokens: { input: sum(CHILD, 0), cacheRead: sum(CHILD, 2), reasoning: sum(CHILD, 3) },
      toolCalls: 1,
    });
  } finally {
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
