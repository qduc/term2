// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { Text } from 'ink';
import { useGrokCreditUsage } from './use-grok-credit-usage.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { renderInAct } from '../test-helpers/ink-testing.js';
import { resetGrokCreditUsageServiceForTests } from '../services/grok/grok-credit-usage-service.js';

const refreshIfStale = vi.fn(async () => {});

vi.mock('../providers/grok-auth.js', () => ({
  GrokTokenManager: class {
    async getOrRefreshAccessToken() {
      return 'tok';
    }
    getPinnedAccountId() {
      return 'account-a';
    }
  },
}));

// useSyncExternalStore requires a stable snapshot identity; a fresh object per
// call spins React into an infinite re-render.
const STUB_SNAPSHOT = { usage: { creditUsagePercent: 29, productUsage: [] }, fetchedAtMs: 1 };
const STUB_SERVICE = {
  refreshIfStale,
  subscribe: () => () => {},
  getSnapshot: () => STUB_SNAPSHOT,
};

vi.mock('../services/grok/grok-credit-usage-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/grok/grok-credit-usage-service.js')>();
  return {
    ...actual,
    getGrokCreditUsageService: () => STUB_SERVICE,
  };
});

const Probe: React.FC<{ settingsService: ReturnType<typeof createMockSettingsService>; isProcessing: boolean }> = ({
  settingsService,
  isProcessing,
}) => {
  const snapshot = useGrokCreditUsage(settingsService, isProcessing);
  return <Text>{snapshot.usage ? `pct:${snapshot.usage.creditUsagePercent}` : 'none'}</Text>;
};

beforeEach(() => {
  refreshIfStale.mockClear();
  resetGrokCreditUsageServiceForTests();
});

afterEach(() => {
  resetGrokCreditUsageServiceForTests();
});

// Seeding on entry keeps the bar from being blank for the whole first turn.
it.sequential('seeds the value once when Grok is the active provider', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': 'grok' });

  const { rerender } = await renderInAct(<Probe settingsService={settingsService} isProcessing={false} />);
  expect(refreshIfStale).toHaveBeenCalledTimes(1);

  await rerender(<Probe settingsService={settingsService} isProcessing={false} />);
  expect(refreshIfStale).toHaveBeenCalledTimes(1);
});

// End-of-turn is both when the number can have changed and when it is visible.
it.sequential('refreshes on the busy to idle edge', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': 'grok' });

  const { rerender } = await renderInAct(<Probe settingsService={settingsService} isProcessing={false} />);
  refreshIfStale.mockClear();

  await rerender(<Probe settingsService={settingsService} isProcessing={true} />);
  expect(refreshIfStale).not.toHaveBeenCalled();

  await rerender(<Probe settingsService={settingsService} isProcessing={false} />);
  expect(refreshIfStale).toHaveBeenCalledTimes(1);
});

// A turn in flight must not trigger a fetch on every re-render.
it.sequential('does not refresh while a turn is still running', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': 'grok' });

  const { rerender } = await renderInAct(<Probe settingsService={settingsService} isProcessing={true} />);
  refreshIfStale.mockClear();

  await rerender(<Probe settingsService={settingsService} isProcessing={true} />);
  await rerender(<Probe settingsService={settingsService} isProcessing={true} />);

  expect(refreshIfStale).not.toHaveBeenCalled();
});

it.sequential('never fetches or reports for a non-Grok provider', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': 'openai' });

  const { lastFrame, rerender } = await renderInAct(<Probe settingsService={settingsService} isProcessing={true} />);
  await rerender(<Probe settingsService={settingsService} isProcessing={false} />);

  expect(refreshIfStale).not.toHaveBeenCalled();
  // A cached value from an earlier Grok session must not leak into another
  // provider's status bar.
  expect(lastFrame()).toContain('none');
});

it.sequential('reports the cached value for Grok', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': 'grok' });

  const { lastFrame } = await renderInAct(<Probe settingsService={settingsService} isProcessing={false} />);

  expect(lastFrame()).toContain('pct:29');
});

// `/usage` is the one case where asking again immediately is clearly wanted.
it.sequential('force refreshes on explicit request, and only for Grok', async () => {
  let capturedRefresh: (() => void) | null = null;
  const CaptureProbe: React.FC<{
    settingsService: ReturnType<typeof createMockSettingsService>;
  }> = ({ settingsService }) => {
    const handle = useGrokCreditUsage(settingsService, false);
    capturedRefresh = handle.refresh;
    return <Text>ok</Text>;
  };

  const grokSettings = createMockSettingsService({ 'agent.provider': 'grok' });
  await renderInAct(<CaptureProbe settingsService={grokSettings} />);
  refreshIfStale.mockClear();

  capturedRefresh!();
  expect(refreshIfStale).toHaveBeenCalledWith({ force: true });

  const openaiSettings = createMockSettingsService({ 'agent.provider': 'openai' });
  await renderInAct(<CaptureProbe settingsService={openaiSettings} />);
  refreshIfStale.mockClear();

  capturedRefresh!();
  expect(refreshIfStale).not.toHaveBeenCalled();
});
