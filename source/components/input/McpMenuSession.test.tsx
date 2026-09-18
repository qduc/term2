import React, { act } from 'react';
import { expect, it, vi } from 'vitest';
import { InputProvider, useInputState } from '../../context/InputContext.js';
import type { McpConfigController } from '../../services/mcp/mcp-config-controller.js';
import type { McpConnectionManager } from '../../services/mcp/mcp-connection-manager.js';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import { MenuControllerImpl } from './menu-controller.js';
import { MenuStackHost } from './MenuStackHost.js';

it('opens MCP management and never renders stored header values', async () => {
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
        config: { type: 'http', url: 'https://example.test', headers: { Authorization: 'Bearer secret-value' } },
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
  expect(form).not.toContain('secret-value');
});
