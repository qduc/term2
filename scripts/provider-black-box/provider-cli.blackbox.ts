import { describe, expect, it } from 'vitest';
import { runIsolatedCli } from './provider-test-harness.js';

describe('assembled provider CLI black-box', () => {
  it.skipIf(process.env.RUN_PROVIDER_BLACKBOX !== '1')(
    'runs the shipped CLI against a redirected OpenAI endpoint',
    async () => {
      const result = await runIsolatedCli({
        cwd: process.cwd(),
        args: ['fixture prompt', '--provider', 'openai', '--model', 'fixture'],
        deadlineMs: 15_000,
      });
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello');
    },
  );
});
