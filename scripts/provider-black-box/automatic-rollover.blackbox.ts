import { createServer, type Server } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIsolatedWorkspaceLease,
  exitInteractive,
  writePtyTextAndSubmit,
  type IsolatedWorkspaceLease,
  type PtyChildDriver,
} from './provider-test-harness.js';

/**
 * The unprompted half of session rollover and context compaction, through the built TUI against a loopback
 * chat-completions provider.
 *
 * "Automatic" rollover is a prompt, not an action. `agent.sessionRollover.milestones` makes the engine admit a
 * `[Mode Notice]` reminder before the next request once the provider's reported input tokens reach a milestone
 * (`ContextMilestoneReminder`); the session only rotates if the model answers with a `session_rollover` call,
 * and that tool exists only in the interactive TUI. These cases drive both halves, so the fixture plays the
 * model: it reports usage, reads the reminder off the wire and hands off when it sees one.
 */

const MILESTONE = 'crossed rollover milestone';
const SUMMARY_MARKER = 'SUMMARY_MARKER_R4';
const SUMMARY_REQUEST = '[Host context-compaction request]';
const BRIEF = 'BRIEF_MARKER_R4: the user asked for alpha one, bravo two and charlie three; continue from there.';

type Wire = { role: string; content?: unknown; tool_calls?: { id: string }[]; tool_call_id?: string };
type Body = { messages: Wire[] };
type Reply =
  | { text: string; inputTokens: number }
  | { tool: 'session_rollover' | 'read_file'; args: object; inputTokens: number };
type Seen = { n: number; kind: 'main' | 'summary'; body: Body; wire: string };
type Fact = Record<string, any>;

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

let server: Server | undefined;
let workspace: IsolatedWorkspaceLease | undefined;
let child: PtyChildDriver | undefined;
afterEach(async () => {
  await child?.cleanup();
  await workspace?.cleanup();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  child = workspace = server = undefined;
});

async function scenario(options: {
  agent: Record<string, unknown>;
  /** The model: given the n-th main request, what to say. Summary requests are answered by the fixture. */
  respond(main: number, body: Body, wire: string): Reply;
  files?: Record<string, string>;
}) {
  const seen: Seen[] = [];
  let mains = 0;
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const wire = Buffer.concat(chunks).toString();
    const body = JSON.parse(wire) as Body;
    const summary = wire.includes(SUMMARY_REQUEST);
    seen.push({ n: seen.length + 1, kind: summary ? 'summary' : 'main', body, wire });
    const n = seen.length;
    const reply: Reply = summary ? { text: SUMMARY_MARKER, inputTokens: 300 } : options.respond(++mains, body, wire);
    const frame = (delta: object, finish: string | null, usage?: object) => ({
      id: `r${n}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });
    const delta =
      'tool' in reply
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${n}`,
                type: 'function',
                function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
              },
            ],
          }
        : { role: 'assistant', content: reply.text };
    const usage = { prompt_tokens: reply.inputTokens, completion_tokens: 5, total_tokens: reply.inputTokens + 5 };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(
      `data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(
        frame({}, 'tool' in reply ? 'tool_calls' : 'stop', usage),
      )}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  workspace = await createIsolatedWorkspaceLease({ prefix: 'term2-auto-rollover-' });
  await mkdir(workspace.paths.logDir, { recursive: true });
  await writeFile(
    join(workspace.paths.logDir, 'settings.json'),
    JSON.stringify({
      app: { activeProfileId: 'builtin:bare' },
      agent: {
        modelSelection: { provider: 'fixture', model: 'fixture-model' },
        retryAttempts: 0,
        transport: 'http',
        ...options.agent,
      },
      providers: [
        { id: 'fixture', name: 'Fixture', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k' },
      ],
      sandbox: { enabled: false },
    }),
  );
  // HOME is the lease root, and the CLI asks for confirmation when started from the home directory.
  const project = join(workspace.root, 'project');
  await mkdir(project);
  for (const [name, content] of Object.entries(options.files ?? {})) await writeFile(join(project, name), content);

  const lease = workspace;
  const args = [join(process.cwd(), 'dist/src/app/cli.js'), '--provider', 'fixture', '--model', 'fixture-model'];
  const launch = async (extra: string[] = []) => {
    const options = { command: process.execPath, cwd: project, args: [...args, ...extra], cols: 120, rows: 40 };
    child = extra.length ? await lease.relaunch(options) : await lease.start(options);
    return { child, idle: await child.waitForIdleInput() };
  };
  let session = await launch();
  /** Type a prompt and wait for the reply whose token the fixture will print, then for the composer. */
  const say = async (prompt: string, reply: string) => {
    await writePtyTextAndSubmit(session.child, prompt);
    await session.child.waitForOutput(reply);
    session.idle = await session.child.waitForIdleInput({ after: session.idle });
  };
  const logs = async (): Promise<{ name: string; id: string; facts: Fact[] }[]> =>
    Promise.all(
      (await readdir(lease.paths.conversationsDir))
        .filter((name) => name.endsWith('.jsonl'))
        .map(async (name) => ({
          name,
          id: name.replace(/\.jsonl$/, ''),
          facts: (await readFile(join(lease.paths.conversationsDir, name), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line).fact),
        })),
    );
  const resume = async (id: string) => {
    await exitInteractive(session.child);
    session = await launch(['--resume', id]);
  };
  /** Wait until the fixture has received `total` requests, so a missing request fails an assertion, not a wait. */
  const requestsReach = async (total: number) => {
    try {
      await session.child.waitForState(() => seen.length >= total, 15_000);
    } catch (error) {
      throw new Error(
        `expected ${total} provider requests, saw ${seen.length} (${seen.map((r) => r.kind).join(', ')}): ${error}`,
      );
    }
  };
  return {
    seen,
    mains: () => seen.filter((r) => r.kind === 'main'),
    say,
    requestsReach,
    logs,
    resume,
    child: () => session.child,
  };
}

const hasType = (facts: Fact[], type: string) => facts.some((fact) => fact.type === type);

describe('automatic session rollover', () => {
  it(
    'reminds the model once usage reaches a milestone and, when the model hands off, continues the same logical session with its brief',
    { timeout: 80_000 },
    async () => {
      const run = await scenario({
        agent: {
          sessionRollover: { enabled: true, milestones: [1000], autoBrief: true },
          contextCompaction: { enabled: false },
        },
        respond: (n, _body, wire) => {
          // Turn 2's reply reports 1,500 input tokens; the next request is the first prepared past the milestone.
          if (count(wire, MILESTONE) > 0 && n === 3) {
            return { tool: 'session_rollover', args: { brief: BRIEF, reason: 'task_boundary' }, inputTokens: 1_600 };
          }
          return { text: `REPLY_${n}`, inputTokens: n === 2 ? 1_500 : 400 };
        },
      });
      await run.say('alpha one', 'REPLY_1');
      await run.say('bravo two', 'REPLY_2');
      // Under the first milestone nothing was said and nothing rotated.
      expect(run.mains().map((r) => count(r.wire, MILESTONE))).toEqual([0, 0]);
      expect(await run.logs()).toHaveLength(1);

      // Turn 3's request is the one that carries the reminder; the model answers it with the handoff, and the
      // successor's own first turn follows without anyone typing.
      const idle = run.child().readIdleGeneration();
      await writePtyTextAndSubmit(run.child(), 'charlie three');
      await run.requestsReach(3);
      const reminded = run.mains()[2]!;
      expect(
        count(reminded.wire, MILESTONE),
        'turn 3 request carries no rollover reminder although turn 2 reported 1,500 input tokens against a 1,000 milestone',
      ).toBe(1);
      await run.requestsReach(4);
      await run.child().waitForOutput('REPLY_4');
      await run.child().waitForIdleInput({ after: idle });
      const reminder = JSON.stringify(
        reminded.body.messages.filter((m) => JSON.stringify(m.content).includes(MILESTONE)),
      );
      expect(reminder).toContain('crossed rollover milestone: 1000');
      expect(reminder).toContain('provider reported 1500 input tokens');
      // autoBrief asks the model to externalise state before handing off; the handoff stays optional.
      expect(reminder).toContain('externalize the necessary state in a durable artifact');
      expect(reminder).toContain('call session_rollover');
      expect(reminder).toContain('Rollover remains optional');
      // Everything before the crossing was still in the predecessor's own context.
      expect(reminded.wire).toContain('alpha one');
      expect(reminded.wire).toContain('bravo two');

      // Two physical logs, linked: the successor names the predecessor, and the logical id is the first log's.
      const [predecessor, successor, ...rest] = (await run.logs()).sort(
        (a, b) => Number(hasType(a.facts, 'session_rotated')) - Number(hasType(b.facts, 'session_rotated')),
      );
      expect(rest).toHaveLength(0);
      expect(predecessor!.facts[0]!.type).toBe('session_started');
      expect(successor!.facts[0]).toMatchObject({
        type: 'session_rotated',
        logicalSessionId: predecessor!.id,
        sessionId: successor!.id,
        predecessor: { sessionId: predecessor!.id },
      });
      const requested = predecessor!.facts.find((fact) => fact.type === 'rollover_requested');
      expect(requested).toMatchObject({ request: { brief: BRIEF, reason: 'task_boundary' } });
      // Nothing the user said is lost: every prompt is in the predecessor's log, and the brief carries them.
      const said = JSON.stringify(predecessor!.facts.filter((fact) => fact.type === 'item'));
      for (const prompt of ['alpha one', 'bravo two', 'charlie three']) expect(said).toContain(prompt);
      expect(successor!.facts.find((fact) => fact.type === 'command_finished')).toMatchObject({
        outcome: { kind: 'rolled_over', sessionId: predecessor!.id },
      });

      // The user sees the briefing arrive as the successor's first message.
      expect(run.child().getVisibleOutput()).toContain('Continuation briefing');

      // The successor starts empty except for the continuation briefing, which holds the model's brief and
      // names the predecessor. The earlier replies and the reminder do not cross.
      await run.requestsReach(4);
      const first = run.mains()[3]!;
      const wire = first.body.messages.filter((m) => m.role !== 'system');
      expect(wire, 'successor starts with more than the briefing').toHaveLength(1);
      const briefing = JSON.stringify(wire[0]!.content);
      expect(briefing, 'successor request lacks the continuation briefing').toContain('Continuation briefing');
      expect(briefing, 'successor request lacks the brief').toContain(BRIEF);
      expect(briefing).toContain(predecessor!.id.replace(/^conv_/, ''));
      for (const left of ['REPLY_1', 'REPLY_2', MILESTONE]) expect(first.wire).not.toContain(left);

      // Later turns of the successor keep carrying the briefing.
      await run.say('delta four', 'REPLY_5');
      const delta = JSON.stringify(run.mains()[4]!.body.messages);
      for (const kept of ['Continuation briefing', BRIEF, 'REPLY_4', 'delta four']) expect(delta).toContain(kept);
      // The predecessor's replies stay behind (its prompts survive only as the brief's wording).
      expect(delta).not.toContain('REPLY_1');

      // The user resumes by the conversation they know, the first log's id; that continues the successor.
      await run.resume(predecessor!.id);
      await run.say('echo five', 'REPLY_6');
      const resumed = JSON.stringify(run.mains()[5]!.body.messages);
      for (const kept of ['Continuation briefing', BRIEF, 'REPLY_4', 'delta four', 'REPLY_5', 'echo five']) {
        expect(resumed).toContain(kept);
      }
      expect(resumed).not.toContain('REPLY_2');
      const after = await run.logs();
      expect(after.map((log) => log.id).sort()).toEqual([predecessor!.id, successor!.id].sort());
      expect(JSON.stringify(after.find((log) => log.id === successor!.id)!.facts)).toContain('echo five');
    },
  );

  it.each([
    { label: 'stays under the first milestone', usage: 900, rollover: { enabled: true, milestones: [1000, 2000] } },
    {
      label: 'is disabled with agent.sessionRollover.enabled',
      usage: 5_000,
      rollover: { enabled: false, milestones: [1000] },
    },
  ])('says nothing and rotates nothing when usage $label', { timeout: 60_000 }, async ({ usage, rollover }) => {
    const run = await scenario({
      agent: { sessionRollover: { autoBrief: true, ...rollover }, contextCompaction: { enabled: false } },
      respond: (n) => ({ text: `REPLY_${n}`, inputTokens: usage }),
    });
    await run.say('alpha one', 'REPLY_1');
    await run.say('bravo two', 'REPLY_2');
    await run.say('charlie three', 'REPLY_3');
    expect(run.mains().map((r) => count(r.wire, MILESTONE))).toEqual([0, 0, 0]);
    const logs = await run.logs();
    expect(logs).toHaveLength(1);
    expect(hasType(logs[0]!.facts, 'rollover_requested')).toBe(false);
  });

  it(
    'admits each milestone reminder once, and leaves the session in place when the model carries on',
    { timeout: 60_000 },
    async () => {
      // Reported usage per reply: turn 1 crosses 1,000; turn 2 stays between the milestones; turn 3 crosses 2,000.
      const usage = [1_200, 1_200, 2_500, 400];
      const run = await scenario({
        agent: {
          sessionRollover: { enabled: true, milestones: [1000, 2000], autoBrief: true },
          contextCompaction: { enabled: false },
        },
        respond: (n) => ({ text: `REPLY_${n}`, inputTokens: usage[n - 1]! }),
      });
      for (const [i, prompt] of ['alpha one', 'bravo two', 'charlie three', 'delta four'].entries()) {
        await run.say(prompt, `REPLY_${i + 1}`);
      }
      // A reminder stays in the history once admitted, so the count is cumulative, not repeated per request.
      expect(run.mains().map((r) => count(r.wire, MILESTONE))).toEqual([0, 1, 1, 2]);
      const last = run.mains()[3]!.wire;
      expect(last).toContain('crossed rollover milestone: 1000');
      expect(last).toContain('crossed rollover milestone: 2000');
      // Declining is allowed: no rollover happened and the conversation is one physical log.
      const logs = await run.logs();
      expect(logs).toHaveLength(1);
      expect(hasType(logs[0]!.facts, 'rollover_requested')).toBe(false);
      for (const text of ['alpha one', 'bravo two', 'charlie three', 'delta four']) expect(last).toContain(text);
    },
  );

  it(
    'keeps the reminder but stops asking the model to externalise state when autoBrief is off',
    { timeout: 60_000 },
    async () => {
      const run = await scenario({
        agent: {
          sessionRollover: { enabled: true, milestones: [1000], autoBrief: false },
          contextCompaction: { enabled: false },
        },
        respond: (n) => ({ text: `REPLY_${n}`, inputTokens: 1_500 }),
      });
      await run.say('alpha one', 'REPLY_1');
      await run.say('bravo two', 'REPLY_2');
      const reminder = JSON.stringify(
        run.mains()[1]!.body.messages.filter((m) => JSON.stringify(m.content).includes(MILESTONE)),
      );
      expect(reminder).toContain('call session_rollover with a bounded handoff brief');
      expect(reminder).not.toContain('externalize');
      expect(reminder).not.toContain('durable artifact');
    },
  );
});

describe('automatic compaction and rollover in one conversation', () => {
  // Both fire on the same request: turn 2's second read_file response reports 60,000 input tokens, over the
  // compaction threshold (40,000) and the rollover milestone (1,000). A custom provider has no catalogued
  // context window, so the reminder cannot defer compaction (`TurnCompaction.canDefer`); each happens.
  it(
    "admits the milestone reminder first, compacts in the same request, and the model's rollover then leaves the summary behind",
    { timeout: 80_000 },
    async () => {
      const run = await scenario({
        agent: {
          sessionRollover: { enabled: true, milestones: [1000], autoBrief: true },
          contextCompaction: { enabled: true, mode: 'auto', compactThreshold: 0.8, compactThresholdTokens: 40_000 },
          maxRequestInputTokens: 200_000,
        },
        files: {
          'one.txt': `ONE_FILE_MARKER_R4\n${'filler filler filler filler\n'.repeat(600)}`,
          'two.txt': 'TWO_FILE_MARKER_R4\n',
        },
        respond: (n, _body, wire) => {
          if (n === 1) return { text: 'REPLY_1', inputTokens: 400 };
          if (n === 2) return { tool: 'read_file', args: { path: 'one.txt' }, inputTokens: 400 };
          if (n === 3) return { tool: 'read_file', args: { path: 'two.txt' }, inputTokens: 60_000 };
          if (n === 4 && wire.includes(MILESTONE)) {
            return { tool: 'session_rollover', args: { brief: BRIEF, reason: 'context_pressure' }, inputTokens: 700 };
          }
          return { text: `REPLY_${n}`, inputTokens: 400 };
        },
      });
      await run.say('alpha one', 'REPLY_1');
      await writePtyTextAndSubmit(run.child(), 'bravo two');
      await run.requestsReach(5);

      // Requests, in order: alpha, bravo's two tool rounds, the summariser, bravo's request after both
      // thresholds were crossed (the model hands off), the successor's first turn.
      const kinds = (n: number) => run.seen.slice(0, n).map((r) => r.kind);
      expect(
        kinds(5),
        'compaction and the milestone reminder should both fire on the request after 60,000 tokens',
      ).toEqual(['main', 'main', 'main', 'summary', 'main']);
      const [, , , summariser, crossing] = run.seen;
      // The reminder was in the history before compaction ran, so the summariser was shown it.
      expect(count(summariser!.wire, MILESTONE), 'summariser input lacks the reminder').toBe(1);
      // The request that follows carries both: the summary in place of the cold span, and the reminder.
      expect(crossing!.wire, 'no summary in the request after compaction').toContain(SUMMARY_MARKER);
      expect(count(crossing!.wire, MILESTONE), 'no reminder in the request after compaction').toBe(1);
      expect(crossing!.wire).not.toContain('ONE_FILE_MARKER_R4');
      expect(crossing!.wire).toContain('TWO_FILE_MARKER_R4');
      for (const prompt of ['alpha one', 'bravo two']) expect(crossing!.wire).toContain(prompt);

      // Rollover leaves the compacted context behind and starts from the brief alone.
      await run.requestsReach(6);
      const successor = run.seen[5]!;
      expect(successor.kind).toBe('main');
      const wire = successor!.body.messages.filter((m) => m.role !== 'system');
      expect(wire, 'successor starts with more than the briefing').toHaveLength(1);
      expect(JSON.stringify(wire[0]!.content), 'successor request lacks the brief').toContain(BRIEF);
      for (const left of [SUMMARY_MARKER, MILESTONE, 'TWO_FILE_MARKER_R4']) expect(successor!.wire).not.toContain(left);

      // The log orders the events the same way: compaction is accepted before the handoff is requested.
      const logs = await run.logs();
      const predecessor = logs.find((log) => !hasType(log.facts, 'session_rotated'))!;
      const order = predecessor.facts.map((fact) => fact.type);
      expect(order.indexOf('compaction_started')).toBeGreaterThan(-1);
      expect(order.indexOf('compaction_completed')).toBeGreaterThan(order.indexOf('compaction_started'));
      expect(order.indexOf('compaction_completed')).toBeLessThan(order.indexOf('rollover_requested'));
      expect(predecessor.facts.filter((fact) => fact.type === 'compaction_started')).toMatchObject([
        { trigger: 'automatic', strategy: 'local', lastCompletedInputTokens: 60_000 },
      ]);
      expect(logs).toHaveLength(2);
    },
  );
});
