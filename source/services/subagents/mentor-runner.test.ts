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
        run: async (_agent: unknown, _input: unknown, options: { signal?: AbortSignal }) =>
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
