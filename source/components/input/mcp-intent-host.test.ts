import { describe, expect, it, vi } from 'vitest';
import type { McpConfigController } from '../../services/mcp/mcp-config-controller.js';
import type { McpConnectionManager } from '../../services/mcp/mcp-connection-manager.js';
import { handleMcpIntent } from './mcp-intent-host.js';
import type { IntentRequest } from './menu-types.js';

const request = (intent: IntentRequest['intent']): IntentRequest => ({
  id: 'intent-1',
  sourceFrameId: 'frame-1',
  intent,
});

describe('handleMcpIntent', () => {
  it('executes MCP mutations at the application intent boundary', async () => {
    const reconnect = vi.fn(async () => {});
    const saveUserServer = vi.fn(async () => {});
    const deleteUserServer = vi.fn(async () => {});
    const login = vi.fn();
    const deps = {
      manager: { reconnect } as unknown as McpConnectionManager,
      configController: { saveUserServer, deleteUserServer } as unknown as McpConfigController,
      login,
    };

    await expect(handleMcpIntent(request({ type: 'mcp-reconnect', serverName: 'alpha' }), deps)).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    await expect(
      handleMcpIntent(
        request({ type: 'mcp-save', originalName: 'alpha', name: 'beta', config: { type: 'stdio', command: 'x' } }),
        deps,
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(handleMcpIntent(request({ type: 'mcp-delete', serverName: 'beta' }), deps)).resolves.toMatchObject({
      ok: true,
    });
    await expect(handleMcpIntent(request({ type: 'mcp-login', serverName: 'beta' }), deps)).resolves.toMatchObject({
      ok: true,
    });

    expect(reconnect).toHaveBeenCalledWith('alpha');
    expect(saveUserServer).toHaveBeenCalledWith('alpha', 'beta', { type: 'stdio', command: 'x' });
    expect(deleteUserServer).toHaveBeenCalledWith('beta');
    expect(login).toHaveBeenCalledWith('beta');
  });

  it('returns correlated failures and ignores non-MCP intents', async () => {
    const deps = {
      manager: {
        reconnect: vi.fn(async () => Promise.reject(new Error('offline'))),
      } as unknown as McpConnectionManager,
      configController: {} as McpConfigController,
    };

    await expect(handleMcpIntent(request({ type: 'mcp-reconnect', serverName: 'alpha' }), deps)).resolves.toEqual({
      id: 'intent-1',
      sourceFrameId: 'frame-1',
      ok: false,
      message: 'offline',
    });
    await expect(handleMcpIntent(request({ type: 'submit-prompt', text: 'hello' }), deps)).resolves.toBeUndefined();
  });
});
