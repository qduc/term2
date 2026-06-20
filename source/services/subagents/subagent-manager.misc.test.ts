import { it, expect, beforeEach, afterEach } from 'vitest';
import {
  TestSubagentManager,
  createMockLogger,
  createMockSettings,
  createSessionContextService,
  createMockExecutionContext,
  createTempDir,
  removeTempDir,
  registerTestProvider,
  wrapResultAsAgentStream,
  wrapErrorAsAgentStream,
  getAgentTool,
  ROLE_MENTOR,
  ROLE_EXPLORER,
  ROLE_WORKER,
  ROLE_RESEARCHER,
} from './test-helpers/subagent-manager-fixtures.js';
import { SubagentManager as RealSubagentManager } from './subagent-manager.js';
import { ModelBehaviorError } from '@openai/agents';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../retry/conversation-retry-policy.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

it('run() returns failed result when createClient factory is not provided', async () => {
  const manager = new RealSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'openai',
    }),
    sessionContextService: createSessionContextService() as any,
  });

  const result = await manager.run({ role: 'explorer', task: 'some task' });
  expect(result.status).toBe('failed');
  expect(result.error).toBe('SubagentManager: createClient factory not provided');
});
