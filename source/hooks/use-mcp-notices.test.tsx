// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useMcpNotices } from './use-mcp-notices.js';
import type { McpConnectionManager } from '../services/mcp/mcp-connection-manager.js';
import type { McpServerSnapshot } from '../services/mcp/mcp-tool-source.js';

const server = (name: string, state: McpServerSnapshot['state'], error?: string): McpServerSnapshot => ({
  name,
  provenance: 'user',
  transport: 'streamable-http',
  state,
  tools: [],
  ...(error !== undefined ? { error } : {}),
});

/** A manager whose catalog can be driven, like a server settling after launch. */
function stubManager(initial: McpServerSnapshot[]) {
  let snapshots = initial;
  const listeners = new Set<() => void>();
  const manager = {
    snapshot: () => snapshots,
    onCatalogChanged: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as McpConnectionManager;
  return {
    manager,
    async settle(next: McpServerSnapshot[]) {
      snapshots = next;
      await act(async () => {
        for (const fn of listeners) fn();
      });
    },
    listenerCount: () => listeners.size,
  };
}

const Probe = (props: Parameters<typeof useMcpNotices>[0]) => {
  useMcpNotices(props);
  return <Text>probe</Text>;
};

const mount = async (props: Parameters<typeof useMcpNotices>[0]) => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Probe {...props} />);
  });
  return view;
};

describe('useMcpNotices', () => {
  it('surfaces a server that needs a login after it settles post-mount', async () => {
    const addSystemMessage = vi.fn();
    const stub = stubManager([server('linear', 'connecting')]);
    await mount({ manager: stub.manager, addSystemMessage });
    expect(addSystemMessage).not.toHaveBeenCalled();

    await stub.settle([server('linear', 'needs-auth', 'requires OAuth login — run /mcp-login linear')]);

    expect(addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/mcp-login linear'));
  });

  it('reports a server that already settled before mount', async () => {
    // Servers connect concurrently with startup, so the interesting state can
    // land before the first render and fire no further change event.
    const addSystemMessage = vi.fn();
    const stub = stubManager([server('linear', 'failed', 'process exited')]);
    await mount({ manager: stub.manager, addSystemMessage });
    expect(addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('process exited'));
  });

  it('announces a problem once, not on every catalog rebuild', async () => {
    const addSystemMessage = vi.fn();
    const failed = [server('linear', 'failed', 'process exited')];
    const stub = stubManager(failed);
    await mount({ manager: stub.manager, addSystemMessage });
    await stub.settle([...failed]);
    await stub.settle([...failed]);
    expect(addSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('stays silent for healthy servers', async () => {
    const addSystemMessage = vi.fn();
    const stub = stubManager([server('fs', 'connecting')]);
    await mount({ manager: stub.manager, addSystemMessage });
    await stub.settle([server('fs', 'ready')]);
    expect(addSystemMessage).not.toHaveBeenCalled();
  });

  it('re-announces when a recovered server breaks again', async () => {
    const addSystemMessage = vi.fn();
    const stub = stubManager([server('linear', 'needs-auth', 'needs login')]);
    await mount({ manager: stub.manager, addSystemMessage });
    await stub.settle([server('linear', 'ready')]);
    await stub.settle([server('linear', 'failed', 'dropped')]);
    expect(addSystemMessage).toHaveBeenCalledTimes(2);
    expect(addSystemMessage).toHaveBeenLastCalledWith(expect.stringContaining('dropped'));
  });

  it('flushes config-load notices once', async () => {
    const addSystemMessage = vi.fn();
    const stub = stubManager([]);
    const props = { manager: stub.manager, startupNotices: ['bad.json was ignored'], addSystemMessage };
    const view = await mount(props);
    await act(async () => {
      view.rerender(<Probe {...props} />);
    });
    expect(addSystemMessage).toHaveBeenCalledTimes(1);
    expect(addSystemMessage).toHaveBeenCalledWith('MCP: bad.json was ignored');
  });

  it('does nothing without a manager', async () => {
    const addSystemMessage = vi.fn();
    await mount({ manager: null, addSystemMessage });
    expect(addSystemMessage).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount so a closed session stops announcing', async () => {
    const stub = stubManager([server('fs', 'connecting')]);
    const view = await mount({ manager: stub.manager, addSystemMessage: vi.fn() });
    expect(stub.listenerCount()).toBe(1);
    await act(async () => {
      view.unmount();
    });
    expect(stub.listenerCount()).toBe(0);
  });
});
