// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import StatusBar from './StatusBar.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { renderInAct } from '../../test-helpers/ink-testing.js';

test.serial('StatusBar renders reasoning effort on the first row with the model', async (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'agent.reasoningEffort': 'low',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />, t);
  const output = lastFrame() ?? '';

  t.true(output.includes('gpt-4o'));
  t.true(output.includes('(low)'));
  t.true(output.split('\n').some((line) => line.includes('gpt-4o') && line.includes('(low)')));
});

test.serial('StatusBar renders cache usage in the footer', async (t) => {
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
    t,
  );

  const output = lastFrame() ?? '';

  t.true(output.includes('Tok: 1,200 in (900 cached, 120 cache write) / 350 out'));
});

test.serial('StatusBar renders Plan mode badge', async (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
    'app.planMode': true,
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />, t);
  const output = lastFrame() ?? '';

  t.true(output.includes('Plan'));
  t.false(output.includes('Default'));
});

test.serial('StatusBar renders Orchestrator mode badge instead of Standard', async (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
    'app.orchestratorMode': true,
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />, t);
  const output = lastFrame() ?? '';

  t.true(output.includes('Orchestrator'));
  t.false(output.includes('Standard'));
});

test.serial('StatusBar renders Codex rate limits when valid, but hides them when invalid or NaN', async (t) => {
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
    t,
  );
  const outputValid = lastFrameValid() ?? '';
  t.true(outputValid.includes('5H: 11%'));
  t.true(outputValid.includes('7D: 14%'));
  t.false(outputValid.includes('undefined'));
  t.false(outputValid.includes('NaN'));

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
    t,
  );
  const outputInvalid = lastFrameInvalid() ?? '';
  t.false(outputInvalid.includes('H:'));
  t.false(outputInvalid.includes('D:'));
  t.false(outputInvalid.includes('undefined'));
  t.false(outputInvalid.includes('NaN'));
  t.false(outputInvalid.includes('Invalid Date'));
});

test.serial('StatusBar renders large uncached prompt warning and confirmation warning', async (t) => {
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
    t,
  );
  const outputWarning = lastFrameWarning() ?? '';
  t.true(outputWarning.includes('Tok: 63,561 in (⚠️ 62,000 uncached) / 856 out'));
  t.false(outputWarning.includes('Cache Miss Risk'));
  t.false(outputWarning.includes('Confirm Cache Miss'));

  // Test pending confirmation warning
  const { lastFrame: lastFrameConfirm } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      lastUsage={lastUsage}
      largeUncachedWarning={{ estimatedTokens: 72_100 }}
      hasPendingConfirmation={true}
    />,
    t,
  );
  const outputConfirm = lastFrameConfirm() ?? '';
  t.true(outputConfirm.includes('Tok: 63,561 in (⚠️ 62,000 uncached) / 856 out'));
  t.false(outputConfirm.includes('Confirm Cache Miss'));
});

test.serial('StatusBar renders Confirm Cache Miss using pendingLargeUncachedTokens', async (t) => {
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
    t,
  );

  const output = lastFrame() ?? '';
  // Math.round(20_000 / 1000) = 20
  t.true(output.includes('Confirm Cache Miss: ~20k'));
});
