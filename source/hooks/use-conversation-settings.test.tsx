// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { useConversationSettings } from './use-conversation-settings.js';
import type { ConversationService } from '../services/conversation/conversation-service.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

type HookResult = ReturnType<typeof useConversationSettings>;

function createMockConversationService() {
  return {
    setModel: (_model: string) => {},
    setReasoningEffort: (_effort: any) => {},
    setTemperature: (_temperature?: number) => {},
  } as unknown as ConversationService;
}

let outerBox: { current: HookResult | null } = { current: null };

const Harness = ({ service }: { service: ConversationService }) => {
  outerBox.current = useConversationSettings({ conversationService: service });
  return null;
};

const renderHarness = async (conversationService: ConversationService, context: Parameters<typeof renderInAct>[1]) => {
  outerBox.current = null;
  const { rerender } = await renderInAct(<Harness service={conversationService} />, context);
  if (!outerBox.current) {
    throw new Error('Hook did not mount');
  }
  return { rerender };
};

test.serial('setModel delegates to conversationService.setModel', async (t) => {
  const service = createMockConversationService();
  let calledWith: any = '';
  service.setModel = (m) => {
    calledWith = m;
  };

  await renderHarness(service, t);
  outerBox.current!.setModel('gpt-4o');
  t.is(calledWith, 'gpt-4o');
});

test.serial('setReasoningEffort delegates to conversationService.setReasoningEffort', async (t) => {
  const service = createMockConversationService();
  let calledWith: any = '';
  service.setReasoningEffort = (e) => {
    calledWith = e;
  };

  await renderHarness(service, t);
  outerBox.current!.setReasoningEffort('high');
  t.is(calledWith, 'high');
});

test.serial('setTemperature delegates to conversationService.setTemperature', async (t) => {
  const service = createMockConversationService();
  let calledWith: any = undefined;
  service.setTemperature = (temp) => {
    calledWith = temp;
  };

  await renderHarness(service, t);
  outerBox.current!.setTemperature(0.7);
  t.is(calledWith, 0.7);
});

test.serial('callback identity is stable across rerenders with the same conversationService', async (t) => {
  const service = createMockConversationService();
  const { rerender } = await renderHarness(service, t);

  const initialSetModel = outerBox.current!.setModel;
  const initialSetReasoningEffort = outerBox.current!.setReasoningEffort;
  const initialSetTemperature = outerBox.current!.setTemperature;

  // Rerender with the same service instance
  await act(async () => {
    rerender(<Harness service={service} />);
  });

  t.is(outerBox.current!.setModel, initialSetModel);
  t.is(outerBox.current!.setReasoningEffort, initialSetReasoningEffort);
  t.is(outerBox.current!.setTemperature, initialSetTemperature);
});

test.serial('callbacks are updated when a new conversationService is provided', async (t) => {
  const service1 = createMockConversationService();
  const service2 = createMockConversationService();
  const { rerender } = await renderHarness(service1, t);

  const initialSetModel = outerBox.current!.setModel;

  // Rerender with a new service instance
  await act(async () => {
    rerender(<Harness service={service2} />);
  });

  t.not(outerBox.current!.setModel, initialSetModel);
});
