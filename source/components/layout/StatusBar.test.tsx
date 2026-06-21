// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import StatusBar from './StatusBar.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { renderInAct } from '../../test-helpers/ink-testing.js';

it.sequential('StatusBar renders reasoning effort on the first row with the model', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'agent.reasoningEffort': 'low',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />);
  const output = lastFrame() ?? '';

  expect(output.includes('gpt-4o')).toBe(true);
  expect(output.includes('(low)')).toBe(true);
  expect(output.split('\n').some((line) => line.includes('gpt-4o') && line.includes('(low)'))).toBe(true);
});

it.sequential('StatusBar renders cache usage in the footer', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      lastUsage={{ prompt_tokens: 1200, completion_tokens: 350, cache_read_tokens: 900, cache_creation_tokens: 120 }}
    />,
  );

  const output = lastFrame() ?? '';

  expect(output.includes('Tok: 1,200 in (900 cached, 120 cache write) / 350 out')).toBe(true);
});

it.sequential('StatusBar renders Plan mode badge', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
    'app.planMode': true,
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />);
  const output = lastFrame() ?? '';

  expect(output.includes('Plan')).toBe(true);
  expect(output.includes('Default')).toBe(false);
});

it.sequential('StatusBar renders Orchestrator mode badge instead of Standard', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
    'app.orchestratorMode': true,
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />);
  const output = lastFrame() ?? '';

  expect(output.includes('Orchestrator')).toBe(true);
  expect(output.includes('Standard')).toBe(false);
});

it.sequential('StatusBar renders Codex rate limits when valid, but hides them when invalid or NaN', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  // 1. Valid case
  const { lastFrame: lastFrameValid } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      lastCodexRateLimit={{
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 11, window_minutes: 300, reset_after_seconds: 9697, reset_at: 1779703037 },
        secondary: { used_percent: 14, window_minutes: 10080, reset_after_seconds: 503937, reset_at: 1780197277 },
      }}
    />,
  );
  const outputValid = lastFrameValid() ?? '';
  expect(outputValid.includes('5H: 11%')).toBe(true);
  expect(outputValid.includes('7D: 14%')).toBe(true);
  expect(outputValid.includes('undefined')).toBe(false);
  expect(outputValid.includes('NaN')).toBe(false);

  // 2. Invalid/partial case (e.g. empty objects as fallback values)
  const { lastFrame: lastFrameInvalid } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      lastCodexRateLimit={{
        allowed: true,
        limit_reached: false,
        primary: {} as any,
        secondary: {} as any,
      }}
    />,
  );
  const outputInvalid = lastFrameInvalid() ?? '';
  expect(outputInvalid.includes('H:')).toBe(false);
  expect(outputInvalid.includes('D:')).toBe(false);
  expect(outputInvalid.includes('undefined')).toBe(false);
  expect(outputInvalid.includes('NaN')).toBe(false);
  expect(outputInvalid.includes('Invalid Date')).toBe(false);
});

it.sequential('StatusBar renders large uncached prompt warning and confirmation warning', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const lastUsage = {
    prompt_tokens: 63_561,
    completion_tokens: 856,
    cache_read_tokens: 62_000,
  };

  // Test dynamic warning
  const { lastFrame: lastFrameWarning } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      lastUsage={lastUsage}
      largeUncachedWarning={{ estimatedTokens: 72_100 }}
    />,
  );
  const outputWarning = lastFrameWarning() ?? '';
  expect(outputWarning.includes('Tok: 63,561 in (⚠️ 62,000 uncached) / 856 out')).toBe(true);
  expect(outputWarning.includes('Cache Miss Risk')).toBe(false);
  expect(outputWarning.includes('Confirm Cache Miss')).toBe(false);

  // Test pending confirmation warning
  const { lastFrame: lastFrameConfirm } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      lastUsage={lastUsage}
      largeUncachedWarning={{ estimatedTokens: 72_100 }}
      hasPendingConfirmation={true}
    />,
  );
  const outputConfirm = lastFrameConfirm() ?? '';
  expect(outputConfirm.includes('Tok: 63,561 in (⚠️ 62,000 uncached) / 856 out')).toBe(true);
  expect(outputConfirm.includes('Confirm Cache Miss')).toBe(false);
});

it.sequential('StatusBar renders Confirm Cache Miss using pendingLargeUncachedTokens', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      largeUncachedWarning={{ estimatedTokens: 100_000 }}
      hasPendingConfirmation={true}
      pendingLargeUncachedTokens={20_000}
    />,
  );

  const output = lastFrame() ?? '';
  // Math.round(20_000 / 1000) = 20
  expect(output.includes('Confirm Cache Miss: ~20k')).toBe(true);
});
