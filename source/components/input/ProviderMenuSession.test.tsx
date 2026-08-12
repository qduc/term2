import React, { act } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InputProvider, useInputState } from '../../context/InputContext.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import { MenuStackHost } from './MenuStackHost.js';
import { MenuControllerImpl } from './menu-controller.js';

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ControllerHost = ({
  controller,
  settingsService,
  onProviderSelected,
}: {
  controller: MenuControllerImpl;
  settingsService: ReturnType<typeof createMockSettingsService>;
  onProviderSelected?: (provider: string) => void;
}) => {
  const { input: _input } = useInputState();
  return (
    <MenuStackHost
      stack={controller.getSnapshot().stack}
      controller={controller}
      interactions={controller.getInteractionRegistry()}
      services={{ settingsService, onProviderSelected }}
    />
  );
};

it('mounts the controller-opened provider frame and routes Escape through its session', async () => {
  const controller = new MenuControllerImpl();
  const settingsService = createMockSettingsService();
  const view = await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.open({ kind: 'providers' });
    await Promise.resolve();
  });

  expect(toVisibleText(view.lastFrame() ?? '')).toContain('Provider Management');
  expect(controller.getSnapshot().stack.at(-1)?.kind).toBe('providers');

  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      controller.escape();
      await Promise.resolve();
    });
  }

  expect(controller.getSnapshot().stack).toHaveLength(0);
});

it('directly opens credential setup for a missing provider', async () => {
  const controller = new MenuControllerImpl();
  const settingsService = createMockSettingsService();
  const onProviderSelected = vi.fn();
  const view = await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost
        controller={controller}
        settingsService={settingsService}
        onProviderSelected={onProviderSelected}
      />
    </InputProvider>,
  );

  await act(async () => {
    controller.open({ kind: 'providers' });
    await Promise.resolve();
  });
  await act(async () => {
    controller.dispatchActiveEvent({
      type: 'accept',
      input: { kind: 'none' },
      selected: undefined,
    });
    await Promise.resolve();
  });

  expect(onProviderSelected).toHaveBeenCalledWith('openai');
  expect(toVisibleText(view.lastFrame() ?? '')).toContain('Step 4: API Key');
});

it('does not block logged-in Codex in ordinary provider management', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-codex-auth-'));
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
  vi.stubEnv('CHATGPT_LOCAL_HOME', '');
  vi.stubEnv('CODEX_HOME', codexHome);

  const controller = new MenuControllerImpl();
  const settingsService = createMockSettingsService();
  const view = await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.open({ kind: 'providers' });
    await Promise.resolve();
  });
  await act(async () => {
    controller.dispatchActiveEvent({ type: 'move', direction: 'down' });
    await Promise.resolve();
  });
  await act(async () => {
    controller.dispatchActiveEvent({ type: 'move', direction: 'down' });
    await Promise.resolve();
  });
  await act(async () => {
    controller.dispatchActiveEvent({ type: 'accept', input: { kind: 'none' }, selected: undefined });
    await Promise.resolve();
  });

  expect(controller.getSnapshot().stack.at(-1)?.kind).toBe('providers');
  expect(toVisibleText(view.lastFrame() ?? '')).not.toContain('Not logged in on this host');
  vi.unstubAllEnvs();
});
