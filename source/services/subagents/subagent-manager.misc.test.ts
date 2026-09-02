import { it, expect } from 'vitest';
import {
  createMockLogger,
  createMockSettings,
  createSessionContextService,
} from './test-helpers/subagent-manager-fixtures.js';
import { SubagentManager as RealSubagentManager } from './subagent-manager.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';

it('run() returns failed result when createClient factory is not provided', async () => {
  const manager = new RealSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'openai',
    }),
    sessionContextService: createSessionContextService() as any,
    toolOwnership: new ToolOwnershipRegistry(),
  });

  const result = await manager.run({ role: 'explorer', task: 'some task' });
  expect(result.status).toBe('failed');
  expect(result.error).toBe('SubagentManager: createClient factory not provided');
});
