// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { renderToString } from 'ink';
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

it.sequential('StatusBar puts all configuration on the first row and quota on the alert row', async () => {
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
  // Row 1 is configuration + this turn's numbers. Safety belongs beside the
  // model it governs, so it sits here too rather than on a row of its own.
  expect(lines.some((line) => line.includes('Standard │ Codex/gpt-5.6-luna · high │ Auto'))).toBe(true);
  expect(
    lines.some((line) => line.includes('Standard │ Codex/gpt-5.6-luna · high │ Auto') && line.includes('↓13')),
  ).toBe(true);
  // Row 2 carries alerts and quota only, so it is absent in the steady state.
  expect(lines.some((line) => line.includes('7D 78% · reset ') && !line.includes('Standard'))).toBe(true);
  expect(lines.some((line) => line.includes('↓13 · Ctx 12k/272k'))).toBe(true);
  expect(lines.some((line) => line.includes('Cache 0'))).toBe(false);
  expect(lines.some((line) => line.includes('(0 cached)'))).toBe(false);
});

it.sequential('StatusBar renders cache usage', async () => {
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

  expect(output.includes('↑1.2k ↓350 · 75% cached')).toBe(true);
  expect(output.includes('│ Cache')).toBe(false);
});

it.sequential('StatusBar renders cache usage as a percentage of prompt tokens', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(
    <StatusBar settingsService={settingsService} lastUsage={{ prompt_tokens: 79_697, cache_read_tokens: 79_360 }} />,
  );

  expect(lastFrame()).toContain('100% cached');
});

it.sequential('StatusBar renders context usage as used/window', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'claude-sonnet-4-6',
    'agent.provider': 'anthropic',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(
    <StatusBar settingsService={settingsService} lastUsage={{ prompt_tokens: 100_000, completion_tokens: 350 }} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Ctx 100k/1.0M')).toBe(true);
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
  expect(output.includes('Ctx 100k/272k')).toBe(true);
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

  expect(lastFrame()).toContain('↓350 · Ctx 1k/272k · Cost $0.42');
});

it.sequential('StatusBar warns about run-budget evidence instead of the run stopping', async () => {
  // In warn mode the run continues past its envelope, so this line is the only
  // signal the human gets that the budget is running out.
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5.6-sol',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });
  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      runBudgetNotice={{
        type: 'budget_stage',
        stage: 'critical',
        evidence: { dimension: 'unpriced_tokens', used: 500_000, limit: 500_000, headroom: 0 },
      }}
    />,
  );

  expect(lastFrame()).toContain('Run tokens: 500.0k / 500.0k (100%)');
});

it.sequential('StatusBar formats USD run-budget evidence clearly', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5.6-sol',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });
  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      runBudgetNotice={{
        type: 'budget_stage',
        stage: 'warning',
        evidence: { dimension: 'usd', used: 4_050_000, limit: 5_000_000, headroom: 950_000 },
      }}
    />,
  );

  expect(lastFrame()).toContain('Run cost: $4.05 / $5.00 (81%)');
});

it.sequential('StatusBar renders known context used without window when the model is not in the catalog', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'model-that-does-not-exist',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = await renderInAct(
    <StatusBar settingsService={settingsService} lastUsage={{ prompt_tokens: 100_000, completion_tokens: 350 }} />,
  );

  const output = lastFrame() ?? '';
  expect(output).toContain('Ctx 100k');
  expect(output).not.toContain('Ctx 100k /');
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
  expect(output.includes('Ctx 100k/1.0M')).toBe(true);
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
  expect(outputWarning.includes('↑63.6k ↓856 · ▲ 62.0k uncached')).toBe(true);
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
  expect(outputConfirm.includes('↑63.6k ↓856 · ▲ 62.0k uncached')).toBe(true);
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

it.sequential('StatusBar shows Sandboxed when sandbox.enabled is true, replacing Auto: ...', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'auto',
    'sandbox.enabled': true,
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />);
  const output = lastFrame() ?? '';

  expect(output.includes('Sandboxed')).toBe(true);
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
  expect(output.includes('Sandboxed')).toBe(false);
});

it.sequential(
  'StatusBar shows Sandboxed, not always, when a sandbox-on + always config is normalized on load',
  async () => {
    // SettingsService enforces sandbox/auto-approve exclusivity: an 'always'
    // mode alongside an enabled sandbox is demoted to 'auto' at load time, so
    // the status bar must reflect the normalized state (sandbox on -> Sandboxed).
    const settingsService = createMockSettingsService({
      'agent.model': 'gpt-4o',
      'agent.provider': 'openai',
      'shell.autoApproveMode': 'always',
      'sandbox.enabled': true,
    });
    expect(settingsService.get('shell.autoApproveMode')).toBe('auto');

    const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />);
    const output = lastFrame() ?? '';

    expect(output.includes('Sandboxed')).toBe(true);
    expect(output.includes('always')).toBe(false);
  },
);

it.sequential('StatusBar shows YOLO when mode is always and the sandbox is off', async () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'always',
    'sandbox.enabled': false,
  });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} />);
  const output = lastFrame() ?? '';

  expect(output.includes('YOLO')).toBe(true);
  expect(output.includes('always')).toBe(false);
  expect(output.includes('Auto')).toBe(false);
  expect(output.includes('Sandboxed')).toBe(false);
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

// Grok's meter is one weekly percentage, not the used/reset windows Codex
// reports, so it renders through its own formatter in the same slot.
it.sequential('StatusBar renders Grok credit usage with its period reset', async () => {
  const settingsService = createMockSettingsService({
    'agent.provider': 'grok',
    'agent.model': 'grok-4.6',
  });

  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      grokCreditUsage={{
        creditUsagePercent: 29,
        periodEndMs: Date.parse('2026-08-24T06:13:52Z'),
        productUsage: [{ product: 'GrokBuild', usagePercent: 19 }],
      }}
    />,
  );

  expect(lastFrame()).toContain('Credits 29% · reset 08/24');
});

it.sequential('StatusBar renders Grok credit usage without a period end', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': 'grok' });

  const { lastFrame } = await renderInAct(
    <StatusBar settingsService={settingsService} grokCreditUsage={{ creditUsagePercent: 4.4, productUsage: [] }} />,
  );

  const output = lastFrame() ?? '';
  expect(output).toContain('Credits 4%');
  expect(output).not.toContain('reset');
});

// Nothing to show must show nothing, not a zero.
it.sequential('StatusBar omits the credit slot when there is no Grok usage', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': 'grok' });

  const { lastFrame } = await renderInAct(<StatusBar settingsService={settingsService} grokCreditUsage={null} />);

  expect(lastFrame() ?? '').not.toContain('Credits');
});

it.sequential('StatusBar renders all OpenCode Go usage limits with countdown resets', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': 'opencode go' });
  const { lastFrame } = await renderInAct(
    <StatusBar
      settingsService={settingsService}
      openCodeGoUsage={{
        useBalance: false,
        rollingUsage: { usagePercent: 42, resetInSec: 1234 },
        weeklyUsage: { usagePercent: 27, resetInSec: 345600 },
        monthlyUsage: { usagePercent: 18, resetInSec: 1414800 },
      }}
    />,
  );
  expect(lastFrame()).toContain('Roll 42% · reset 20m / Week 27% · reset 4d / Month 18% · reset 16d');
});

// Regression test for a bug where, at ~85 columns, Ink's row-level flexWrap
// reflowed text character-by-character inside each segment because the right
// (metrics) group held its full width and the left (config) group absorbed
// all the overflow: "Standard" split into "Stan"/"ard", "medium" into
// "me"/"dium", "YOLO" into "YOL"/"O". The fix computes an explicit column
// budget and drops whole segments instead, so no segment should ever be cut
// mid-word — only whole-segment drops or an explicit "…" truncation.
// renderInAct always lays out against ink-testing-library's fixed 100-column
// mock stdout, so it cannot prove anything about narrow-width wrapping — the
// `columns` prop only steers this component's own drop/truncate decisions,
// not Yoga's actual box width. renderToString's `{ columns }` option, by
// contrast, drives the real layout width (see BackgroundTasksPanel.test.tsx
// for the same pattern), so only it can catch a real reflow.
it.sequential('StatusBar never breaks a word across lines at a narrow width', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5.6-luna',
    'agent.provider': 'codex',
    'agent.reasoningEffort': 'medium',
    'shell.autoApproveMode': 'always',
    'sandbox.enabled': false,
  });

  const columns = 44;
  let output = '';
  act(() => {
    output = renderToString(
      <StatusBar
        settingsService={settingsService}
        columns={columns}
        queueLength={2}
        lastUsage={{ prompt_tokens: 29_400, completion_tokens: 269, cache_read_tokens: 24_355 }}
        costSummary={{ knownUsdMicros: 8_205, pricedRequests: 1, unpricedRequests: 0, state: 'estimated' }}
        lastCodexRateLimit={{
          allowed: true,
          limit_reached: false,
          secondary: {
            used_percent: 8,
            window_minutes: 10080,
            reset_after_seconds: 259200,
            reset_at: Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60,
          },
        }}
      />,
      { columns },
    );
  });

  const lines = output.split('\n');
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(columns);
  }

  // Each word must appear whole or not at all — never as the fragment the
  // old character-wrapping bug produced.
  if (output.includes('Stan') || output.includes('ard')) expect(output).toContain('Standard');
  if (output.includes('YOL')) expect(output).toContain('YOLO');
  if (output.includes(' me') || output.includes('dium')) expect(output).toContain('medium');
});

it.sequential('StatusBar drops cost and cache before dropping the mode label or provider/model', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5.6-luna',
    'agent.provider': 'codex',
    'agent.reasoningEffort': 'medium',
    'agent.smartModel': 'claude-sonnet-4-6',
    'app.mentorMode': true,
    'shell.autoApproveMode': 'always',
    'sandbox.enabled': false,
  });

  const columns = 38;
  let output = '';
  act(() => {
    output = renderToString(
      <StatusBar
        settingsService={settingsService}
        columns={columns}
        sshInfo={{ user: 'root', host: 'build-host', remoteDir: '/srv/app' }}
        queueLength={2}
        lastUsage={{ prompt_tokens: 29_400, completion_tokens: 269, cache_read_tokens: 24_355 }}
        costSummary={{ knownUsdMicros: 8_205, pricedRequests: 1, unpricedRequests: 0, state: 'estimated' }}
      />,
      { columns },
    );
  });

  for (const line of output.split('\n')) {
    expect(line.length).toBeLessThanOrEqual(columns);
  }

  // mentorMode makes the mode label itself read 'Mentor' rather than
  // 'Standard' — that substitution is unrelated to dropping, so what this
  // asserts is that the (always-shown) mode label and provider/model survive
  // while the droppable mentor-model, cost, and cache segments do not.
  expect(output).toContain('Mentor');
  expect(output).toContain('Codex/gpt-5.6-luna');
  expect(output).not.toContain('Cost');
  expect(output).not.toContain('Est $');
  expect(output).not.toContain('cached');
  // Tokens are the last metric to go, so they and context still fit even
  // though cost and cache — dropped first and second — do not.
  expect(output).toContain('↑29.4k');
  expect(output).toContain('Ctx 29k/272k');
});

it.sequential('StatusBar renders config and metrics on a single line at a wide width', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5.6-luna',
    'agent.provider': 'codex',
    'agent.reasoningEffort': 'medium',
    'shell.autoApproveMode': 'always',
    'sandbox.enabled': false,
  });

  const columns = 200;
  let output = '';
  act(() => {
    output = renderToString(
      <StatusBar
        settingsService={settingsService}
        columns={columns}
        queueLength={2}
        lastUsage={{ prompt_tokens: 29_400, completion_tokens: 269, cache_read_tokens: 24_355 }}
        costSummary={{ knownUsdMicros: 8_205, pricedRequests: 1, unpricedRequests: 0, state: 'estimated' }}
      />,
      { columns },
    );
  });

  const configAndMetricsLine = output.split('\n').find((line) => line.includes('Standard') && line.includes('Est $'));
  expect(configAndMetricsLine).toBeDefined();
  expect(configAndMetricsLine).toContain('Codex/gpt-5.6-luna');
  expect(configAndMetricsLine).toContain('cached');
  expect(configAndMetricsLine).toContain('Ctx');
});
