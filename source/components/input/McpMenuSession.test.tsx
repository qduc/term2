import React, { act } from 'react';
import { expect, it, vi } from 'vitest';
import { InputProvider, useInputState } from '../../context/InputContext.js';
import type { McpConfigController } from '../../services/mcp/mcp-config-controller.js';
import type { McpConnectionManager } from '../../services/mcp/mcp-connection-manager.js';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import { MenuControllerImpl } from './menu-controller.js';
import { MenuStackHost } from './MenuStackHost.js';

it('never renders or preloads persisted MCP configuration values', async () => {
  const controller = new MenuControllerImpl();
  const manager = {
    snapshot: () => [{ name: 'remote', provenance: 'user', transport: 'streamable-http', state: 'ready', tools: [] }],
    onCatalogChanged: () => () => {},
    oauthTarget: () => undefined,
    reconnect: vi.fn(),
  } as unknown as McpConnectionManager;
  const configController = {
    listUserServers: async () => [
      {
        name: 'remote',
        config: {
          type: 'http',
          url: 'https://url-secret.example.test',
          command: 'command-secret',
          args: ['args-secret'],
          cwd: '/cwd-secret',
          env: { TOKEN: 'env-secret' },
          headers: { Authorization: 'Bearer header-secret' },
          clientId: 'client-secret',
          clientMetadataUrl: 'https://metadata-secret.example.test',
          redirectPorts: [45678],
        },
      },
    ],
  } as unknown as McpConfigController;
  const Host = () => {
    useInputState();
    return (
      <MenuStackHost
        stack={controller.getSnapshot().stack}
        controller={controller}
        interactions={controller.getInteractionRegistry()}
        services={{ mcpManager: manager, mcpConfigController: configController }}
      />
    );
  };
  const view = await renderInAct(
    <InputProvider controller={controller}>
      <Host />
    </InputProvider>,
  );
  await act(async () => {
    controller.open({ kind: 'mcp' });
    await Promise.resolve();
  });
  expect(toVisibleText(view.lastFrame() ?? '')).toContain('MCP Server Management');
  await act(async () => {
    controller.dispatchActiveEvent({ type: 'accept', input: { kind: 'none' }, selected: undefined });
    await Promise.resolve();
  });
  await act(async () => {
    controller.dispatchActiveEvent({ type: 'accept', input: { kind: 'none' }, selected: undefined });
    await Promise.resolve();
  });
  const form = toVisibleText(view.lastFrame() ?? '');
  expect(form).toContain('Edit MCP Server: remote');
  expect(form).toContain('<configured>');
  for (const secret of ['url-secret', 'header-secret', 'client-secret', 'metadata-secret', '45678']) {
    expect(form).not.toContain(secret);
  }

  for (const event of [
    { type: 'move', direction: 'down' } as const,
    { type: 'move', direction: 'down' } as const,
    { type: 'accept', input: { kind: 'none' }, selected: undefined } as const,
  ]) {
    await act(async () => {
      controller.dispatchActiveEvent(event);
      await Promise.resolve();
    });
  }
  expect(controller.getSnapshot().editor.text).toBe('');

  await act(async () => {
    controller.dispatchActiveEvent({ type: 'accept', input: { kind: 'none' }, selected: undefined });
    await Promise.resolve();
  });
  expect(toVisibleText(view.lastFrame() ?? '')).toContain('URL <configured>');

  await act(async () => {
    controller.dispatchActiveEvent({ type: 'accept', input: { kind: 'none' }, selected: undefined });
    await Promise.resolve();
  });
  await act(async () => {
    controller.dispatchActiveEvent({ type: 'input', text: '<clear>' });
    await Promise.resolve();
  });
  await act(async () => {
    const editor = controller.getSnapshot().editor;
    controller.dispatchActiveEvent({
      type: 'accept',
      input: { kind: 'composer', text: editor.text, cursor: editor.cursor },
      selected: undefined,
    });
    await Promise.resolve();
  });
  expect(toVisibleText(view.lastFrame() ?? '')).toContain('URL <none>');

  for (const event of [
    { type: 'move', direction: 'up' } as const,
    { type: 'accept', input: { kind: 'none' }, selected: undefined } as const,
    { type: 'accept', input: { kind: 'none' }, selected: undefined } as const,
  ]) {
    await act(async () => {
      controller.dispatchActiveEvent(event);
      await Promise.resolve();
    });
  }
  const stdioForm = toVisibleText(view.lastFrame() ?? '');
  for (const secret of ['command-secret', 'args-secret', 'cwd-secret', 'env-secret']) {
    expect(stdioForm).not.toContain(secret);
  }
});
