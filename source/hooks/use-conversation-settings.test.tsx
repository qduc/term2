// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { useConversationSettings } from './use-conversation-settings.js';
import type { ConversationService } from '../services/conversation/conversation-service.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

type HookResult = ReturnType<typeof useConversationSettings>;

function createMockConversationService() {
  return {
    setModelSelection: (_selection: { model: string; provider: string }) => {},
    setReasoningEffort: (_effort: any) => {},
    setTemperature: (_temperature?: number) => {},
  } as unknown as ConversationService;
}

const outerBox: { current: HookResult | null } = { current: null };

const Harness = ({ service }: { service: ConversationService }) => {
  outerBox.current = useConversationSettings({ conversationService: service });
  return null;
};

const renderHarness = async (conversationService: ConversationService) => {
  outerBox.current = null;
  const { rerender } = await renderInAct(<Harness service={conversationService} />);
  if (!outerBox.current) {
    throw new Error('Hook did not mount');
  }
  return { rerender };
};

it.sequential('setModelSelection delegates to conversationService.setModelSelection', async () => {
  const service = createMockConversationService();
  let calledWith: any = '';
  service.setModelSelection = (m) => {
    calledWith = m;
  };

  await renderHarness(service);
  outerBox.current!.setModelSelection({ model: 'gpt-4o', provider: 'openai' });
  expect(calledWith).toEqual({ model: 'gpt-4o', provider: 'openai' });
});

it.sequential('setReasoningEffort delegates to conversationService.setReasoningEffort', async () => {
  const service = createMockConversationService();
  let calledWith: any = '';
  service.setReasoningEffort = (e) => {
    calledWith = e;
  };

  await renderHarness(service);
  outerBox.current!.setReasoningEffort('high');
  expect(calledWith).toBe('high');
});

it.sequential('setTemperature delegates to conversationService.setTemperature', async () => {
  const service = createMockConversationService();
  let calledWith: any = undefined;
  service.setTemperature = (temp) => {
    calledWith = temp;
  };

  await renderHarness(service);
  outerBox.current!.setTemperature(0.7);
  expect(calledWith).toBe(0.7);
});

it.sequential('callback identity is stable across rerenders with the same conversationService', async () => {
  const service = createMockConversationService();
  const { rerender } = await renderHarness(service);

  const initialSetModel = outerBox.current!.setModelSelection;
  const initialSetReasoningEffort = outerBox.current!.setReasoningEffort;
  const initialSetTemperature = outerBox.current!.setTemperature;

  // Rerender with the same service instance
  await act(async () => {
    rerender(<Harness service={service} />);
  });

  expect(outerBox.current!.setModelSelection).toBe(initialSetModel);
  expect(outerBox.current!.setReasoningEffort).toBe(initialSetReasoningEffort);
  expect(outerBox.current!.setTemperature).toBe(initialSetTemperature);
});

it.sequential('callbacks are updated when a new conversationService is provided', async () => {
  const service1 = createMockConversationService();
  const service2 = createMockConversationService();
  const { rerender } = await renderHarness(service1);

  const initialSetModel = outerBox.current!.setModelSelection;

  // Rerender with a new service instance
  await act(async () => {
    rerender(<Harness service={service2} />);
  });

  expect(outerBox.current!.setModelSelection).not.toBe(initialSetModel);
});
