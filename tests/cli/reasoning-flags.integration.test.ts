import { describe, expect, it } from 'vitest';
import { integrationCliPath } from '../helpers/integration-cli.js';
import {
  createWorld,
  removeWorld,
  runCli,
  startLoopbackProvider,
  writeWorldSettings,
  type ScriptedTurn,
} from '../helpers/loopback-chat-world.js';

// The two reasoning flags of a headless run, through the built CLI against a loopback provider that plays
// the model:
//   -r, --reasoning <effort>   sets the reasoning effort the model request carries (`reasoning_effort` on the
//                              chat-completions wire), over the saved agent.reasoningEffort setting
//   --show-reasoning           streams the model's reasoning deltas to stderr (the help text says "in
//                              non-interactive mode"); the answer stays on stdout
// Observed: the effort on the wire, and which stream the streamed reasoning arrives on.

const REASONING = 'REASONING-SENTINEL-the-model-thinks-about-it';
const ANSWER = 'ANSWER-SENTINEL';
const TURN: ScriptedTurn = { reasoning: REASONING, text: ANSWER };

/** One headless run of the built CLI; returns what the model request carried and what each stream received. */
async function run(args: string[], settings: Record<string, unknown> = {}) {
  const world = createWorld('term2-reasoning');
  const provider = await startLoopbackProvider({ turns: [TURN] });
  try {
    writeWorldSettings(world, provider.baseUrl, { sandbox: { enabled: false }, ...settings });
    const result = await runCli(world, integrationCliPath(), ['--profile', 'bare', ...args, 'Say something']);
    const requests = provider.requests();
    expect(result.status, result.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    const effort = (requests[0] as unknown as { reasoning_effort?: string }).reasoning_effort;
    return { ...result, effort };
  } finally {
    await provider.close();
    removeWorld(world);
  }
}

/** A headless run that must fail before any model request; returns the status, stderr and request count. */
async function runRejected(args: string[]) {
  const world = createWorld('term2-reasoning');
  const provider = await startLoopbackProvider({ turns: [TURN] });
  try {
    writeWorldSettings(world, provider.baseUrl, { sandbox: { enabled: false } });
    const result = await runCli(world, integrationCliPath(), ['--profile', 'bare', ...args, 'Say something']);
    return { ...result, requestCount: provider.requests().length };
  } finally {
    await provider.close();
    removeWorld(world);
  }
}

describe.concurrent('-r, --reasoning <effort>', () => {
  it.each([['bogus'], ['HIGH'], ['hi gh']])(
    '-r %s fails before any model request, naming the value and the valid efforts',
    async (value) => {
      const result = await runRejected(['-r', value]);
      expect(result.status).toBe(1);
      expect(result.requestCount).toBe(0);
      expect(result.stderr).toContain(`Unknown reasoning effort "${value}"`);
      expect(result.stderr).toContain('default, none, minimal, low, medium, high, xhigh');
      expect(result.stdout).toBe('');
    },
  );

  it('sends no effort when neither the flag nor a setting names one', async () => {
    const { effort, stdout } = await run([]);
    expect(effort).toBeUndefined();
    expect(stdout).toContain(ANSWER);
  });

  it.each([
    { args: ['-r', 'high'], effort: 'high' },
    { args: ['--reasoning', 'high'], effort: 'high' },
    { args: ['-r', 'low'], effort: 'low' },
    { args: ['-r', 'xhigh'], effort: 'xhigh' },
    { args: ['-r', 'none'], effort: 'none' },
    { args: ['--reasoning=medium'], effort: 'medium' },
  ])('$args puts reasoning_effort $effort on the model request', async ({ args, effort }) => {
    const result = await run(args);
    expect(result.effort).toBe(effort);
    expect(result.stdout).toContain(ANSWER);
  });

  it('beats the saved agent.reasoningEffort, which applies when the flag is absent', async () => {
    const saved = { agent: { reasoningEffort: 'low' } };
    expect((await run([], saved)).effort).toBe('low');
    expect((await run(['-r', 'high'], saved)).effort).toBe('high');
  });

  it('"default" asks for the model default: no effort is sent, even over a saved one', async () => {
    const result = await run(['-r', 'default'], { agent: { reasoningEffort: 'low' } });
    expect(result.effort).toBeUndefined();
  });
});

describe.concurrent('--show-reasoning', () => {
  it('without the flag, plain mode shows the answer and none of the reasoning', async () => {
    const { stdout, stderr } = await run([]);
    expect(stdout).toBe(`${ANSWER}\n`);
    expect(stdout + stderr).not.toContain(REASONING);
  });

  it('with the flag, plain mode streams the reasoning to stderr and keeps stdout to the answer', async () => {
    const { stdout, stderr } = await run(['--show-reasoning']);
    expect(stderr).toContain(REASONING);
    expect(stdout).toBe(`${ANSWER}\n`);
    expect(stdout).not.toContain(REASONING);
  });

  it('still streams the reasoning when stderr diagnostics are quieted with -q', async () => {
    const { stdout, stderr } = await run(['--show-reasoning', '-q']);
    expect(stderr).toContain(REASONING);
    expect(stdout).toBe(`${ANSWER}\n`);
  });

  it.each([[[]], [['--show-reasoning']]])(
    'in --json mode the reasoning is a stdout event with or without the flag (%j), and stderr stays empty',
    async (flag) => {
      const { stdout, stderr } = await run(['--json', ...flag]);
      const events = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; delta?: string; reasoningText?: string });
      expect(events.filter((event) => event.type === 'reasoning_delta').map((event) => event.delta)).toEqual([
        REASONING,
      ]);
      expect(events.find((event) => event.type === 'final')?.reasoningText).toBe(REASONING);
      expect(stderr).not.toContain(REASONING);
    },
  );
});
