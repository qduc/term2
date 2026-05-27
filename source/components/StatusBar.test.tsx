import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import StatusBar from './StatusBar.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';

test('StatusBar renders reasoning effort on the first row with the model', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'agent.reasoningEffort': 'low',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = render(<StatusBar settingsService={settingsService} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('gpt-4o'));
  t.true(output.includes('(low)'));
  t.false(output.includes('Reasoning:'));
  t.true(output.split('\n').some((line) => line.includes('gpt-4o') && line.includes('(low)')));
});

test('StatusBar renders cache usage in the footer', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = render(
    <StatusBar
      settingsService={settingsService}
      lastUsage={{ prompt_tokens: 1200, completion_tokens: 350, cache_read_tokens: 900, cache_creation_tokens: 120 }}
    />,
  );

  const output = lastFrame() ?? '';

  t.true(output.includes('Tok: 1,200 in (900 cached, 120 cache write) / 350 out'));
});

test('StatusBar renders Plan mode badge', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
    'app.planMode': true,
  });

  const { lastFrame } = render(<StatusBar settingsService={settingsService} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('Plan'));
  t.false(output.includes('Default'));
});

test('StatusBar renders Orchestrator mode badge instead of Standard', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
    'app.orchestratorMode': true,
  });

  const { lastFrame } = render(<StatusBar settingsService={settingsService} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('Orchestrator'));
  t.false(output.includes('Standard'));
});

test('StatusBar renders Codex rate limits when valid, but hides them when invalid or NaN', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  // 1. Valid case
  const { lastFrame: lastFrameValid } = render(
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
  t.true(outputValid.includes('5H: 11%'));
  t.true(outputValid.includes('7D: 14%'));
  t.false(outputValid.includes('undefined'));
  t.false(outputValid.includes('NaN'));

  // 2. Invalid/partial case (e.g. empty objects as fallback values)
  const { lastFrame: lastFrameInvalid } = render(
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
  t.false(outputInvalid.includes('H:'));
  t.false(outputInvalid.includes('D:'));
  t.false(outputInvalid.includes('undefined'));
  t.false(outputInvalid.includes('NaN'));
  t.false(outputInvalid.includes('Invalid Date'));
});

test('StatusBar renders large uncached prompt warning and confirmation warning', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  // Test dynamic warning
  const { lastFrame: lastFrameWarning } = render(
    <StatusBar settingsService={settingsService} largeUncachedWarning={{ estimatedTokens: 72_100 }} />,
  );
  const outputWarning = lastFrameWarning() ?? '';
  t.true(outputWarning.includes('⚠️ Cache Miss Risk: ~72k'));

  // Test pending confirmation warning
  const { lastFrame: lastFrameConfirm } = render(
    <StatusBar
      settingsService={settingsService}
      largeUncachedWarning={{ estimatedTokens: 72_100 }}
      hasPendingConfirmation={true}
    />,
  );
  const outputConfirm = lastFrameConfirm() ?? '';
  t.true(outputConfirm.includes('⚠️ Confirm Cache Miss: ~72k'));
});
