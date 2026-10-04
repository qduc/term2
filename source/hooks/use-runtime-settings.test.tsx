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

it.sequential('useRuntimeSettings publishes a complete selection after settings commit', async () => {
  const calls: string[] = [];
  const settingsService = createMockSettingsService({
    'agent.modelSelection': { model: 'initial', provider: 'openai' },
  });
  const conversationService: Pick<ConversationService, 'queueModeNotice'> = {
    queueModeNotice() {
      // no-op for this test
    },
  };

  const Harness = () => {
    const applyRuntimeSetting = useRuntimeSettings({
      setModelSelection: (selection) => {
        expect(settingsService.get('agent.modelSelection')).toEqual(selection);
        calls.push(`${selection.provider}:${selection.model}`);
      },
      setReasoningEffort: () => {},
      setTemperature: () => {},
      conversationService,
      settingsService,
    });

    useEffect(() => {
      settingsService.set('agent.modelSelection', { model: 'next', provider: 'openrouter' });
      applyRuntimeSetting('agent.modelSelection', { model: 'next', provider: 'openrouter' });
    }, [applyRuntimeSetting]);

    return <Text>runtime</Text>;
  };

  await renderInAct(<Harness />);
  await flushEffects();

  expect(calls).toEqual(['openrouter:next']);
});
