import { expect, it } from 'vitest';
import { MentorRunner } from './mentor-runner.js';
import {
  createMockLogger,
  createMockSettings,
  createSessionContextService,
  registerTestProvider,
} from './test-helpers/subagent-manager-fixtures.js';

it('returns a cancelled result when its provider run aborts', async () => {
  const providerId = registerTestProvider({
    label: 'Aborting mentor provider',
    createStreamedModel: () => ({
      async *stream(request: { signal?: AbortSignal }) {
        await new Promise((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('mentor provider aborted'), { name: 'AbortError' }));
          if (request.signal?.aborted) return abort();
          request.signal?.addEventListener('abort', abort, { once: true });
        });
      },
    }),
    fetchModels: async () => [{ id: 'mentor-model' }],
  });
  const runner = new MentorRunner({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.mentorModel': 'mentor-model',
      'agent.mentorProvider': providerId,
    }),
    sessionContextService: createSessionContextService(),
  });
  const controller = new AbortController();
  const resultPromise = runner.run('mentor-run', 'Review this change.', controller.signal);

  controller.abort();

  await expect(resultPromise).resolves.toMatchObject({
    agentId: 'mentor-run',
    role: 'mentor',
    status: 'cancelled',
    filesChanged: [],
    toolsUsed: [],
    error: 'Operation aborted',
  });
});

it('returns final text and usage from a settled stream (F4 regression)', async () => {
  const providerId = registerTestProvider({
    label: 'Settling mentor provider',
    createStreamedModel: () => ({
      async *stream() {
        yield {
          type: 'completion',
          responseId: 'mentor-response',
          output: [{ type: 'message', content: [{ type: 'text', text: 'Review summary: looks good.' }] }],
          usage: { inputTokens: 21, outputTokens: 6 },
        };
      },
    }),
    fetchModels: async () => [{ id: 'mentor-model' }],
  });
  const received: any[] = [];
  const runner = new MentorRunner({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.mentorModel': 'mentor-model',
      'agent.mentorProvider': providerId,
    }),
    sessionContextService: createSessionContextService(),
    onEvent: (event) => received.push(event),
  });

  const result = await runner.run('mentor-run', 'Review this change.');

  expect(result).toMatchObject({
    agentId: 'mentor-run',
    role: 'mentor',
    status: 'completed',
    finalText: 'Review summary: looks good.',
    filesChanged: [],
    toolsUsed: [],
  });
  expect(result.usage?.prompt_tokens).toBe(21);
  expect(result.usage?.completion_tokens).toBe(6);
  expect(received).toContainEqual({
    type: 'usage_update',
    agentId: 'mentor-run',
    usage: { prompt_tokens: 21, completion_tokens: 6, total_tokens: 27 },
  });
});

/**
 * Sampling exists to get independent opinions. A shared session would let each
 * sample read the previous one's answer and anchor on it, which is the one
 * outcome that makes the feature worse than a single consultation.
 */
it('samples the mentor N times without letting samples see each other', async () => {
  const seenInputs: unknown[][] = [];
  let answer = 0;
  const providerId = registerTestProvider({
    label: 'Sampling mentor provider',
    createStreamedModel: () => ({
      async *stream(request: any) {
        // Snapshot: the run loop appends output to the same array afterwards.
        seenInputs.push(structuredClone(request.input ?? []));
        answer += 1;
        yield {
          type: 'completion',
          responseId: `mentor-response-${answer}`,
          output: [{ type: 'message', content: [{ type: 'text', text: `Opinion ${answer}` }] }],
          usage: { inputTokens: 10, outputTokens: 3 },
        };
      },
    }),
    fetchModels: async () => [{ id: 'mentor-model' }],
  });
  const runner = new MentorRunner({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.mentorModel': 'mentor-model',
      'agent.mentorProvider': providerId,
      'agent.mentorSamples': 3,
    }),
    sessionContextService: createSessionContextService(),
  });

  const result = await runner.run('mentor-run', 'Is this design sound?');

  expect(result.status).toBe('completed');
  expect(result.finalText).toContain('Opinion 1');
  expect(result.finalText).toContain('Opinion 2');
  expect(result.finalText).toContain('Opinion 3');
  expect(seenInputs).toHaveLength(3);
  // No sample carries a prior sample's answer in its input.
  for (const input of seenInputs) {
    expect(JSON.stringify(input)).not.toContain('Opinion');
  }
  // Usage is summed across samples, not reported per sample.
  expect(result.usage?.prompt_tokens).toBe(30);
  expect(result.usage?.completion_tokens).toBe(9);
});

it('returns the samples that succeeded when one fails', async () => {
  let call = 0;
  const providerId = registerTestProvider({
    label: 'Flaky mentor provider',
    createStreamedModel: () => ({
      async *stream() {
        call += 1;
        if (call === 2) throw new Error('mentor sample exploded');
        yield {
          type: 'completion',
          responseId: `mentor-response-${call}`,
          output: [{ type: 'message', content: [{ type: 'text', text: `Opinion ${call}` }] }],
          usage: { inputTokens: 10, outputTokens: 3 },
        };
      },
    }),
    fetchModels: async () => [{ id: 'mentor-model' }],
  });
  const runner = new MentorRunner({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.mentorModel': 'mentor-model',
      'agent.mentorProvider': providerId,
      'agent.mentorSamples': 3,
    }),
    sessionContextService: createSessionContextService(),
  });

  const result = await runner.run('mentor-run', 'Is this design sound?');

  expect(result.status).toBe('completed');
  expect(result.finalText).toContain('Opinion 1');
  expect(result.finalText).toContain('Opinion 3');
  expect(result.finalText).toMatch(/1 of 3 .*(failed|unavailable)/i);
});

it('fails only when every sample fails', async () => {
  const providerId = registerTestProvider({
    label: 'Broken mentor provider',
    createStreamedModel: () => ({
      async *stream() {
        throw new Error('mentor is down');
      },
    }),
    fetchModels: async () => [{ id: 'mentor-model' }],
  });
  const runner = new MentorRunner({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.mentorModel': 'mentor-model',
      'agent.mentorProvider': providerId,
      'agent.mentorSamples': 2,
    }),
    sessionContextService: createSessionContextService(),
  });

  await expect(runner.run('mentor-run', 'Is this design sound?')).rejects.toThrow('mentor is down');
});

/**
 * Default must stay byte-for-byte the old behavior, including the persistent
 * session that mentorMode's ongoing relationship depends on.
 */
it('keeps the persistent session when sampling is not configured', async () => {
  const seenInputs: unknown[][] = [];
  let answer = 0;
  const providerId = registerTestProvider({
    label: 'Persistent mentor provider',
    createStreamedModel: () => ({
      async *stream(request: any) {
        seenInputs.push(structuredClone(request.input ?? []));
        answer += 1;
        yield {
          type: 'completion',
          responseId: `mentor-response-${answer}`,
          output: [{ type: 'message', content: [{ type: 'text', text: `Opinion ${answer}` }] }],
          usage: { inputTokens: 10, outputTokens: 3 },
        };
      },
    }),
    fetchModels: async () => [{ id: 'mentor-model' }],
  });
  const runner = new MentorRunner({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.mentorModel': 'mentor-model',
      'agent.mentorProvider': providerId,
    }),
    sessionContextService: createSessionContextService(),
  });

  const first = await runner.run('mentor-run', 'First question.');
  const second = await runner.run('mentor-run', 'Second question.');

  expect(first.finalText).toBe('Opinion 1');
  expect(second.finalText).toBe('Opinion 2');
  // The second consultation still sees the first exchange.
  expect(JSON.stringify(seenInputs[1])).toContain('Opinion 1');
});
