import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SubagentToolPolicy } from '../../../src/delegation/subagents/tool-policy.js';
import type { ScriptedToolDefinition } from '../../../src/tools/types.js';

it('reports that a worker command was not reviewed when review is disabled', async () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), security: vi.fn() };
  const settings = { get: (key: string) => (key === 'shell.autoApproveMode' ? 'off' : undefined) };
  const policy = new SubagentToolPolicy({
    settings: settings as never,
    logger: logger as never,
    sessionContextService: {} as never,
  });
  const parameters = z.object({ command: z.string() });
  const execute = vi.fn(() => 'executed');
  const shell = {
    name: 'shell',
    description: '',
    parameters,
    scriptedReturnSchema: z.string(),
    needsApproval: () => true,
    execute,
    formatCommandMessage: () => [],
  } as unknown as ScriptedToolDefinition<typeof parameters, 'shell'>;
  const wrapped = policy.wrapShellTool(shell, '/private/tmp', [], '');
  const result = await wrapped.execute({ command: 'node -v' });
  expect(result).toContain('Workers cannot run commands that require interactive approval');
  expect(result).toContain('Not reviewed automatically.');
  expect(result).not.toContain('review unavailable');
  expect(result).not.toContain('manual approval required');
  expect(execute).not.toHaveBeenCalled();
});
