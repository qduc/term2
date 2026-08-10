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
