// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import StatusBar from './StatusBar.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import {
  configureDockerHostControlGrants,
  grantDockerHostControl,
  resetDockerHostControlGrantsForTests,
} from '../../utils/shell/sandbox/docker-host-control-grants.js';

it.sequential('StatusBar displays an active persistent Docker host-control project grant', async () => {
  const settingsService = createMockSettingsService();
  configureDockerHostControlGrants(settingsService);
  grantDockerHostControl({ command: 'docker ps', cwd: process.cwd(), scope: 'project', sessionId: 'session-a' });
  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />);
  expect(lastFrame()).toContain('Docker host access: project');
  resetDockerHostControlGrantsForTests();
});

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
  expect(output.includes('· low')).toBe(true);
  expect(output.split('\n').some((line) => line.includes('gpt-4o') && line.includes('· low'))).toBe(true);
});

it.sequential('StatusBar renders the compact two-row configuration and usage layout', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5.6-luna',
    'agent.provider': 'codex',
    'agent.reasoningEffort': 'high',
    'shell.autoApproveMode': 'auto',
    'sandbox.enabled': false,
  });

  const resetAt = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      lastUsage={{ prompt_tokens: 11_778, completion_tokens: 13, cache_read_tokens: 0 }}
      lastCodexRateLimit={{
        allowed: true,
        limit_reached: false,
        secondary: { used_percent: 78, window_minutes: 10080, reset_after_seconds: 259200, reset_at: resetAt },
      }}
    />,
  );

  const lines = (lastFrame() ?? '').split('\n');
  expect(lines.some((line) => line.includes('Standard │ Codex/gpt-5.6-luna · high │ Auto'))).toBe(true);
  expect(lines.some((line) => line.includes('7D 78% · reset '))).toBe(true);
  expect(lines.some((line) => line.includes('Tok 11,778 in / 13 out │ Ctx 12k / 272k'))).toBe(true);
  expect(lines.some((line) => line.includes('Cache 0'))).toBe(false);
  expect(lines.some((line) => line.includes('(0 cached)'))).toBe(false);
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

  expect(output.includes('Tok 1,200 in (900 cached) / 350 out')).toBe(true);
  expect(output.includes('│ Cache')).toBe(false);
});

it.sequential('StatusBar renders context usage as used/window in the footer', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'claude-sonnet-4-6',
    'agent.provider': 'anthropic',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(
    <StatusBar settingsService={settingsService} lastUsage={{ prompt_tokens: 100_000, completion_tokens: 350 }} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Ctx 100k / 1.0M')).toBe(true);
});

it.sequential('StatusBar renders context usage for an OpenAI model with a k-scale window', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5.6-sol',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(
    <StatusBar settingsService={settingsService} lastUsage={{ prompt_tokens: 100_000 }} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Ctx 100k / 272k')).toBe(true);
});

it.sequential('StatusBar renders an exact session cost', async () => {
  const settingsService = createMockSettingsService();
  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      costSummary={{ knownUsdMicros: 420_000, pricedRequests: 1, unpricedRequests: 0, state: 'exact' }}
    />,
  );

  expect(lastFrame()).toContain('Cost $0.42');
});

it.sequential('StatusBar renders an estimated session cost', async () => {
  const settingsService = createMockSettingsService();
  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      costSummary={{ knownUsdMicros: 420_000, pricedRequests: 1, unpricedRequests: 0, state: 'estimated' }}
    />,
  );

  expect(lastFrame()).toContain('Est $0.42');
});

it.sequential('StatusBar renders a partial session cost as a lower bound', async () => {
  const settingsService = createMockSettingsService();
  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      costSummary={{ knownUsdMicros: 420_000, pricedRequests: 1, unpricedRequests: 1, state: 'partial' }}
    />,
  );

  expect(lastFrame()).toContain('Est $0.42+');
});

it.sequential('StatusBar omits unavailable and missing session cost', async () => {
  const settingsService = createMockSettingsService();
  const { lastFrame: unavailableFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      costSummary={{ knownUsdMicros: 0, pricedRequests: 0, unpricedRequests: 1, state: 'unavailable' }}
    />,
  );
  const { lastFrame: nullFrame } = await renderInAct(
    <StatusBar settingsService={settingsService} costSummary={null} />,
  );
  const { lastFrame: undefinedFrame } = await renderInAct(<StatusBar settingsService={settingsService} />);

  expect(unavailableFrame()).not.toContain('$');
  expect(nullFrame()).not.toContain('$');
  expect(undefinedFrame()).not.toContain('$');
});

it.sequential('StatusBar preserves non-zero precision for sub-cent session costs', async () => {
  const settingsService = createMockSettingsService();
  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      costSummary={{ knownUsdMicros: 28, pricedRequests: 1, unpricedRequests: 0, state: 'exact' }}
    />,
  );

  expect(lastFrame()).toContain('Cost $0.000028');
});

it.sequential('StatusBar places session cost beside token and context usage', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5.6-sol',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });
  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      lastUsage={{ prompt_tokens: 1_200, completion_tokens: 350 }}
      costSummary={{ knownUsdMicros: 420_000, pricedRequests: 1, unpricedRequests: 0, state: 'exact' }}
    />,
  );

  expect(lastFrame()).toContain('Tok 1,200 in / 350 out │ Ctx 1k / 272k │ Cost $0.42');
});

it.sequential('StatusBar hides context usage when the model is not in the catalog', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'model-that-does-not-exist',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(
    <StatusBar settingsService={settingsService} lastUsage={{ prompt_tokens: 100_000, completion_tokens: 350 }} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('k/')).toBe(false);
});

it.sequential('StatusBar hides context usage when lastUsage has no prompt tokens', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(
    <StatusBar settingsService={settingsService} lastUsage={{ completion_tokens: 350 }} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('k/')).toBe(false);
});

it.sequential('StatusBar resolves the context window by model id for providers not in the catalog', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'claude-sonnet-4-6',
    'agent.provider': 'custom-local-llm',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(
    <StatusBar settingsService={settingsService} lastUsage={{ prompt_tokens: 100_000 }} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Ctx 100k / 1.0M')).toBe(true);
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
  expect(outputValid.includes('5H 11% · reset ')).toBe(true);
  expect(outputValid.includes('7D 14% · reset ')).toBe(true);
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

it.sequential('StatusBar labels a Codex window by its length, not by which slot carries it', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const resetAt = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;

  // Codex may send a single weekly window in the `primary` slot.
  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      lastCodexRateLimit={{
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 58, window_minutes: 10080, reset_after_seconds: 259200, reset_at: resetAt },
      }}
    />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('7D 58% · reset ')).toBe(true);
  expect(output.includes('168H')).toBe(false);
});

it.sequential('StatusBar shows a date for a Codex reset more than a day away', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const resetAt = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;

  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      lastCodexRateLimit={{
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 58, window_minutes: 10080, reset_after_seconds: 259200, reset_at: resetAt },
      }}
    />,
  );

  expect(lastFrame() ?? '').toMatch(/7D 58% · reset \d{1,2}[./-]\d{1,2}/);
});

it.sequential('StatusBar shows a clock time for a Codex reset within 24 hours', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const resetAt = Math.floor(Date.now() / 1000) + 60 * 60;

  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      lastCodexRateLimit={{
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 11, window_minutes: 300, reset_after_seconds: 3600, reset_at: resetAt },
      }}
    />,
  );

  const output = lastFrame() ?? '';
  expect(output).toMatch(/5H 11% · reset \d{1,2}:\d{2}/);
  // A sub-day window resetting today needs no date to disambiguate.
  expect(output).not.toMatch(/5H 11% · reset \d{1,2}[./-]\d{1,2}/);
});

it.sequential('StatusBar dates a day-scale Codex window that resets within 24 hours', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const resetAt = Math.floor(Date.now() / 1000) + 60 * 60;

  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      lastCodexRateLimit={{
        allowed: true,
        limit_reached: false,
        secondary: { used_percent: 58, window_minutes: 10080, reset_after_seconds: 3600, reset_at: resetAt },
      }}
    />,
  );

  expect(lastFrame() ?? '').toMatch(/7D 58% · reset \d{1,2}[./-]\d{1,2}\D{1,2}\d{1,2}:\d{2}/);
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
  expect(outputWarning.includes('Tok 63,561 in (⚠️ 62,000 uncached) / 856 out')).toBe(true);
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
  expect(outputConfirm.includes('Tok 63,561 in (⚠️ 62,000 uncached) / 856 out')).toBe(true);
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

it.sequential('StatusBar shows Sandbox: ON when sandbox.enabled is true, replacing Auto: ...', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'auto',
    'sandbox.enabled': true,
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />);
  const output = lastFrame() ?? '';

  expect(output.includes('Sandbox ON')).toBe(true);
  expect(output.includes('Approve:')).toBe(false);
});

it.sequential('StatusBar shows compact auto approval without the model name', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'auto',
    'agent.choreModel': 'very-long-auto-approval-model-name',
    'sandbox.enabled': false,
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />);
  const output = lastFrame() ?? '';

  expect(output.includes('Auto')).toBe(true);
  expect(output.includes('very-long-auto-approval-model-name')).toBe(false);
  expect(output.includes('Sandbox ON')).toBe(false);
});

it.sequential('StatusBar renders a static commit blocker warning', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      staticCommitBlocker={{
        id: 'cmd-1',
        index: 4,
        sender: 'command',
        status: 'running',
        reason: 'command_running',
        dynamicMessageCount: 24,
        dynamicTextLength: 18_432,
      }}
    />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Static blocked: command/running')).toBe(true);
  expect(output.includes('24 msgs')).toBe(true);
  expect(output.includes('18k chars')).toBe(true);
});

it.sequential('StatusBar shows queue badge when queueLength > 0', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} queueLength={3} />);

  const output = lastFrame() ?? '';
  expect(output.includes('[Q:3]')).toBe(true);
});

it.sequential('StatusBar hides queue badge when queueLength is 0', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} queueLength={0} />);

  const output = lastFrame() ?? '';
  expect(output.includes('[Q:')).toBe(false);
});

it.sequential('StatusBar hides queue badge when queueLength is undefined', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />);

  const output = lastFrame() ?? '';
  expect(output.includes('[Q:')).toBe(false);
});
