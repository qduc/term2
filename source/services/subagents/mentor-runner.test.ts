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
    createRunner: () =>
      ({
        config: {},
        run: async (_agent: unknown, _input: unknown, options: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error('mentor provider aborted'), { name: 'AbortError' }));
            if (options.signal?.aborted) {
              abort();
              return;
            }
            options.signal?.addEventListener('abort', abort, { once: true });
          }),
        // The mentor settles the stream through runToCompletion; the abort must
        // propagate through it the same way it would through the live stream.
        runToCompletion: async (_agent: unknown, _input: unknown, options: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error('mentor provider aborted'), { name: 'AbortError' }));
            if (options.signal?.aborted) {
              abort();
              return;
            }
            options.signal?.addEventListener('abort', abort, { once: true });
          }),
      } as any),
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
    error: 'mentor provider aborted',
  });
});

it('returns final text and usage from a settled stream (F4 regression)', async () => {
  const providerId = registerTestProvider({
    label: 'Settling mentor provider',
    createRunner: () =>
      ({
        config: {},
        run: async () => {
          throw new Error('unexpected run(): the mentor must settle through runToCompletion');
        },
        runToCompletion: async () => ({
          finalOutput: 'Review summary: looks good.',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'Review summary: looks good.' }],
            },
          ],
          history: [],
          interruptions: [],
          rawResponses: [],
          usage: { input_tokens: 21, output_tokens: 6, total_tokens: 27 },
        }),
      } as any),
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
});
