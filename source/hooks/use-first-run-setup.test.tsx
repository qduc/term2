// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { useEffect } from 'react';
import os from 'node:os';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { getProvider } from '../providers/index.js';
import { renderInAct } from '../test-helpers/ink-testing.js';
import { useFirstRunSetupGate } from './use-first-run-setup.js';

const Probe = ({ onState }: { onState: (state: ReturnType<typeof useFirstRunSetupGate>) => void }) => {
  const state = useFirstRunSetupGate({
    settingsService: stateSettings,
    controller: useInputContext().controller,
  });
  useEffect(() => onState(state), [onState, state]);
  return null;
};

let stateSettings = createMockSettingsService();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.sequential('bypasses the gate when the effective provider has credentials', async () => {
  stateSettings = createMockSettingsService({ 'agent.openai.apiKey': 'configured' });
  const onState = vi.fn();

  await renderInAct(
    <InputProvider>
      <Probe onState={onState} />
    </InputProvider>,
  );

  expect(onState).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
});

it.sequential('opens provider management and rechecks into model selection after credential setup', async () => {
  stateSettings = createMockSettingsService();
  const onState = vi.fn();
  const fetchModels = vi.spyOn(getProvider('openai')!, 'fetchModels');
  vi.stubEnv('CHATGPT_LOCAL_HOME', '');
  vi.stubEnv('CODEX_HOME', '/tmp/term2-test-no-codex-auth');
  vi.spyOn(os, 'homedir').mockReturnValue('/tmp/term2-test-no-codex-home');
  let latest: ReturnType<typeof useFirstRunSetupGate> | undefined;

  await renderInAct(
    <InputProvider>
      <Probe
        onState={(state) => {
          latest = state;
          onState(state);
        }}
      />
    </InputProvider>,
  );

  expect(latest).toEqual(expect.objectContaining({ active: true, phase: 'provider' }));

  await act(async () => {
    stateSettings.setPersistentDynamic('agent.openai.apiKey', 'configured');
    await Promise.resolve();
  });

  expect(latest).toEqual(expect.objectContaining({ active: true, phase: 'model' }));
  expect(fetchModels).not.toHaveBeenCalled();

  await act(async () => {
    stateSettings.setPersistentDynamic('agent.openai.apiKey', undefined);
    await Promise.resolve();
  });
  expect(latest).toEqual(expect.objectContaining({ active: true, phase: 'provider', provider: 'openai' }));

  await act(async () => {
    stateSettings.setPersistentDynamic('agent.openrouter.apiKey', 'configured');
    stateSettings.setPersistentDynamic('agent.provider', 'openrouter');
    await Promise.resolve();
  });
  expect(latest).toEqual(expect.objectContaining({ active: true, phase: 'model', provider: 'openrouter' }));

  await act(async () => {
    stateSettings.setPersistentDynamic('agent.provider', 'codex');
    await Promise.resolve();
  });
  expect(latest).toEqual(expect.objectContaining({ active: true, phase: 'provider', provider: 'codex' }));

  await act(async () => {
    stateSettings.setPersistentDynamic('agent.provider', 'openrouter');
    await Promise.resolve();
  });
  expect(latest).toEqual(expect.objectContaining({ active: true, phase: 'model', provider: 'openrouter' }));

  await act(async () => {
    latest!.completeModelSelection();
    await Promise.resolve();
  });
  expect(latest).toEqual(expect.objectContaining({ active: false, phase: null }));

  await act(async () => {
    latest!.requestSetup('openrouter');
    await Promise.resolve();
  });
  expect(latest).toEqual(expect.objectContaining({ active: true, phase: 'model', provider: 'openrouter' }));
});
