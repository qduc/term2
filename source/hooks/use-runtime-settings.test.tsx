import { it, expect } from 'vitest';
// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import React, { useEffect } from 'react';
import { Text } from 'ink';
import type { ConversationService } from '../services/conversation/conversation-service.js';
import { useRuntimeSettings } from './use-runtime-settings.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it.sequential('useRuntimeSettings routes agent.provider changes through switchProvider', async () => {
  const calls: string[] = [];
  const settingsService = createMockSettingsService({
    'agent.provider': 'openai',
  });
  const conversationService: Pick<ConversationService, 'switchProvider' | 'queueModeNotice'> = {
    switchProvider(provider: string) {
      calls.push(`switch:${provider}`);
    },
    queueModeNotice() {
      // no-op for this test
    },
  };

  const Harness = () => {
    const applyRuntimeSetting = useRuntimeSettings({
      setModel: () => {},
      setReasoningEffort: () => {},
      setTemperature: () => {},
      conversationService,
      settingsService,
    });

    useEffect(() => {
      applyRuntimeSetting('agent.provider', 'openrouter');
    }, [applyRuntimeSetting]);

    return <Text>runtime</Text>;
  };

  await renderInAct(<Harness />);
  await flushEffects();

  expect(calls).toEqual(['switch:openrouter']);
});
