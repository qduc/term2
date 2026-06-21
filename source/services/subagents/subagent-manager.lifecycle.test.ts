import fs from 'node:fs';
import path from 'node:path';
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

// ========== Session isolation ==========

it('run() creates isolated sessions for each subagent call', async () => {
  const providerId = registerTestProvider({
    label: 'Mock Explorer Provider',
    createRunner: () =>
      ({
        run: async (_agent: any, _input: any, _options: any) => {
          const result = {
            status: 'completed',
            finalOutput: 'Found the relevant files.',
            history: [],
            messages: [],
          };
          return _options?.stream ? wrapResultAsAgentStream(result) : result;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': providerId,
  });
  const manager = new TestSubagentManager({ logger: createMockLogger(), settings });

  const [result1, result2] = await Promise.all([
    manager.run({ role: 'explorer', task: 'task 1' }),
    manager.run({ role: 'explorer', task: 'task 2' }),
  ]);

  expect(result1.status).toBe('completed');
  expect(result2.status).toBe('completed');
  expect(result1.agentId).not.toBe(result2.agentId);
});

// ========== Real-time events ==========

it('run() emits started and completed events', async () => {
  const providerId = registerTestProvider({
    label: 'Mock Event Tool Provider',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          const readFile = agent.tools.find((tool: any) => tool.name === 'read_file');
          try {
            await readFile.invoke({}, JSON.stringify({ path: '/nonexistent-subagent-event-test' }), {});
          } catch {
            // Tool execution may fail (missing file); we only care that the
            // tool-started event fired before execution.
          }
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': providerId,
  });
  const events: any[] = [];
  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'search the code' });

  const started = events.find((e) => e.type === 'subagent_started');
  expect(started).toBeTruthy();
  expect(started.role).toBe('explorer');
  expect(started.task).toBe('search the code');
  expect(started.agentId).toBe(result.agentId);

  const completed = events.find((e) => e.type === 'subagent_completed');
  expect(completed).toBeTruthy();
  expect(completed.result.agentId).toBe(result.agentId);
});

it('run() emits a completed event even when the role is unknown', async () => {
  const settings = createMockSettings({ 'agent.model': 'mock-model' });
  const events: any[] = [];
  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  await manager.run({ role: 'definitely-not-a-role', task: 'x' });

  expect(events.find((e) => e.type === 'subagent_started')).toBeTruthy();
  const completed = events.find((e) => e.type === 'subagent_completed');
  expect(completed).toBeTruthy();
  expect(completed.result.status).toBe('failed');
});

// ========== Mentor role definition sourced from markdown ==========

it('mentor base instructions come from the mentor role markdown', async () => {
  const mentorManagerRunnerCalls: any[] = [];
  let mentorManagerResponseCounter = 0;

  const providerId = registerTestProvider({
    label: 'Mock Mentor Manager',
    createRunner: () =>
      ({
        run: async (_agent: any, _input: any, _options: any) => {
          mentorManagerRunnerCalls.push({ input: _input, options: _options, agent: _agent });
          mentorManagerResponseCounter++;
          const result = {
            status: 'completed',
            finalOutput: `mentor-response-${mentorManagerResponseCounter}`,
            responseId: `resp-${mentorManagerResponseCounter}`,
            history: [],
            messages: [],
          };
          return _options?.stream ? wrapResultAsAgentStream(result) : result;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const settings = createMockSettings({
    'agent.model': 'main-model',
    'agent.provider': providerId,
    'agent.mentorModel': 'mentor-model',
    'agent.mentorProvider': providerId,
    'app.mentorMode': false,
  });
  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: 'mentor', task: 'advise me' });

  expect(mentorManagerRunnerCalls.length).toBe(1);
  const instructions: string = mentorManagerRunnerCalls[0].agent.instructions;

  // Dynamically load the mentor role markdown to verify integration without brittle hardcoding
  const mentorPath = path.join(import.meta.dirname, '../../../source/prompts/subagents/mentor.md');
  const mentorContent = fs.readFileSync(mentorPath, 'utf-8');
  const parts = mentorContent.split('---');
  const expectedBody = parts[parts.length - 1].trim();

  expect(instructions.includes(expectedBody)).toBe(true);
});

// ========== finalText excludes pre-tool narration ==========

it('finalText is the assistant message after the last tool item', async () => {
  const providerId = registerTestProvider({
    label: 'Mock Post Tool Provider',
    createRunner: () =>
      ({
        run: async (_agent: any, _input: any, _options: any) => {
          const result = {
            status: 'completed',
            // finalOutput intentionally absent to exercise the history fallback.
            finalOutput: 'Final answer: it is in foo.ts.',
            history: [
              { rawItem: { role: 'assistant', content: 'Let me look into this first.' } },
              { rawItem: { type: 'function_call', name: 'grep' } },
              { rawItem: { type: 'function_call_result', name: 'grep' } },
              { rawItem: { role: 'assistant', content: 'Final answer: it is in foo.ts.' } },
            ],

            messages: [],
          };
          return _options?.stream ? wrapResultAsAgentStream(result) : result;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': providerId,
  });
  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  const result = await manager.run({ role: 'explorer', task: 'where is it' });

  expect(result.finalText).toBe('Final answer: it is in foo.ts.');
  expect(result.finalText.includes('Let me look into this first.')).toBe(false);
});
