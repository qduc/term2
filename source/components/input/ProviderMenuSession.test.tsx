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
import { saveCodexTokens } from '../../providers/codex-auth.js';
import { listOAuthAccounts } from '../../providers/oauth-accounts.js';

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
  onSystemMessage,
}: {
  controller: MenuControllerImpl;
  settingsService: ReturnType<typeof createMockSettingsService>;
  onProviderSelected?: (provider: string) => void;
  onSystemMessage?: (message: string) => void;
}) => {
  const { input: _input } = useInputState();
  return (
    <MenuStackHost
      stack={controller.getSnapshot().stack}
      controller={controller}
      interactions={controller.getInteractionRegistry()}
      services={{ settingsService, onProviderSelected, onSystemMessage }}
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
  try {
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
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

it('records an account selection for the next session without touching this one', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-switcher-'));
  try {
    vi.stubEnv('TERM2_CONFIG_DIR', configDir);
    const jwt = (claims: Record<string, unknown>) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      return `${encode({ alg: 'none' })}.${encode(claims)}.sig`;
    };
    saveCodexTokens({ access_token: 'a', id_token: jwt({ sub: 'u1', email: 'work@example.com' }) });
    saveCodexTokens({ access_token: 'b', id_token: jwt({ sub: 'u2', email: 'personal@example.com' }) });

    const controller = new MenuControllerImpl();
    const settingsService = createMockSettingsService();
    const onSystemMessage = vi.fn();
    const view = await renderInAct(
      <InputProvider controller={controller}>
        <ControllerHost controller={controller} settingsService={settingsService} onSystemMessage={onSystemMessage} />
      </InputProvider>,
    );

    await act(async () => {
      controller.open({ kind: 'providers' });
      await Promise.resolve();
    });
    // Walk to Codex and open its account list.
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        controller.dispatchActiveEvent({ type: 'move', direction: 'down' });
        await Promise.resolve();
      });
    }
    await act(async () => {
      controller.dispatchActiveEvent({ type: 'accept', input: { kind: 'none' }, selected: undefined });
      await Promise.resolve();
    });

    const accountsFrame = toVisibleText(view.lastFrame() ?? '');
    expect(accountsFrame).toContain('work@example.com');
    expect(accountsFrame).toContain('personal@example.com');
    // Nothing has authenticated yet, so the most recent login shows only as
    // selected — not as in use.
    expect(accountsFrame).toContain('takes effect next session');
    expect(accountsFrame).not.toContain('in use');

    // Select the first account, which is not the active one.
    await act(async () => {
      controller.dispatchActiveEvent({ type: 'accept', input: { kind: 'none' }, selected: undefined });
      await Promise.resolve();
    });

    expect(listOAuthAccounts('codex').find((account) => account.isSelected)?.label).toBe('work@example.com');
    // The running conversation is untouched; the note says when it applies.
    expect(onSystemMessage).toHaveBeenCalledWith(expect.stringContaining('work@example.com'));
    expect(onSystemMessage).toHaveBeenCalledWith(expect.stringContaining('next term2 session'));
    // The menu stays open so the new state is visible.
    expect(toVisibleText(view.lastFrame() ?? '')).toContain('takes effect next session');
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

it('tells the user how to add an account when only the codex CLI credential exists', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-switcher-empty-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-switcher-cli-'));
  try {
    // Logged in through the codex CLI, but term2 holds no account of its own:
    // the import is access-token-only, so there is nothing to switch between.
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
    vi.stubEnv('TERM2_CONFIG_DIR', configDir);
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
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        controller.dispatchActiveEvent({ type: 'move', direction: 'down' });
        await Promise.resolve();
      });
    }
    await act(async () => {
      controller.dispatchActiveEvent({ type: 'accept', input: { kind: 'none' }, selected: undefined });
      await Promise.resolve();
    });

    const frame = toVisibleText(view.lastFrame() ?? '');
    expect(frame).toContain('Accounts:');
    expect(frame).toContain('No accounts stored');
    expect(frame).toContain('term2 --codex-login');
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
