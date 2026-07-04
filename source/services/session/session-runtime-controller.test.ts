import { expect, it } from 'vitest';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { SessionLifecycle } from './session-lifecycle.js';
import { SessionRuntimeController } from './session-runtime-controller.js';

const makeAgentClient = (overrides: Partial<ConversationAgentClient> = {}): ConversationAgentClient =>
  ({
    startStream: async () => {
      throw new Error('not implemented');
    },
    continueRunStream: async () => {
      throw new Error('not implemented');
    },
    abort: () => {},
    setModel: () => {},
    addToolInterceptor: () => () => {},
    chat: async () => '',
    ...overrides,
  } as ConversationAgentClient);

const makeController = (agentClient: ConversationAgentClient, calls: string[]) =>
  new SessionRuntimeController({
    agentClient,
    state: {
      afterProviderChanged: () => {
        calls.push('afterProviderChanged');
      },
    } as SessionLifecycle,
  });

it('setReasoningEffort does not reset session state when unsupported', () => {
  const calls: string[] = [];
  const controller = makeController(makeAgentClient(), calls);

  controller.setReasoningEffort('low');

  expect(calls).toEqual([]);
});

it('setReasoningEffort resets session state before invoking supported setter', () => {
  const calls: string[] = [];
  const controller = makeController(
    makeAgentClient({
      setReasoningEffort: (effort) => {
        calls.push(`setReasoningEffort:${effort}`);
      },
    }),
    calls,
  );

  controller.setReasoningEffort('high');

  expect(calls).toEqual(['afterProviderChanged', 'setReasoningEffort:high']);
});

it('setTemperature does not reset session state when unsupported', () => {
  const calls: string[] = [];
  const controller = makeController(makeAgentClient(), calls);

  controller.setTemperature(0.7);

  expect(calls).toEqual([]);
});

it('setTemperature resets session state before invoking supported setter', () => {
  const calls: string[] = [];
  const controller = makeController(
    makeAgentClient({
      setTemperature: (temperature) => {
        calls.push(`setTemperature:${temperature ?? 'default'}`);
      },
    }),
    calls,
  );

  controller.setTemperature(undefined);

  expect(calls).toEqual(['afterProviderChanged', 'setTemperature:default']);
});

it('setProvider does not reset session state when unsupported', () => {
  const calls: string[] = [];
  const controller = makeController(makeAgentClient(), calls);

  controller.setProvider('openrouter');

  expect(calls).toEqual([]);
});

it('switchProvider uses setProvider behavior and resets before invoking supported setter', () => {
  const calls: string[] = [];
  const controller = makeController(
    makeAgentClient({
      setProvider: (provider) => {
        calls.push(`setProvider:${provider}`);
      },
    }),
    calls,
  );

  controller.switchProvider('openai');

  expect(calls).toEqual(['afterProviderChanged', 'setProvider:openai']);
});
