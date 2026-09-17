import { describe, expect, it } from 'vitest';
import { TurnStableMcpToolSource } from './turn-stable-mcp-tool-source.js';
import type { McpServerSnapshot, McpToolSource } from './mcp-tool-source.js';
import { AgentConfiguration, type AgentConfigurationDeps } from '../../lib/agent-configuration.js';
import { createRunCodeToolDefinition } from '../../tools/system/run-code/run-code.js';
import { ToolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';

const server = (name: string): McpServerSnapshot => ({
  name,
  provenance: 'user',
  transport: 'stdio',
  state: 'ready',
  tools: [],
});

const serverWithTool = (name: string, toolName: string): McpServerSnapshot => ({
  name,
  provenance: 'user',
  transport: 'stdio',
  state: 'ready',
  tools: [
    {
      name: toolName,
      description: `server-authored description for ${toolName}`,
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
});

const createMockLogger = (): ILoggingService =>
  ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    getCorrelationId: () => undefined,
    log: () => {},
  } as any);

const createMockSettings = (
  values: Record<string, any> = {},
): ISettingsService & { _listeners: Array<(key?: string) => void>; _triggerChange: (key?: string) => void } => {
  const store: Record<string, any> = {
    'agent.provider': 'mock-provider-for-config',
    'agent.model': 'mock-model',
    'agent.maxTurns': 20,
    'agent.temperature': undefined,
    ...values,
  };
  const listeners: Array<(key?: string) => void> = [];
  return {
    _listeners: listeners,
    _triggerChange: (key?: string) => {
      listeners.forEach((fn) => fn(key));
    },
    get: (key: any) => store[key] as any,
    getDynamic: (key: string) => store[key],
    set: (key: string, value: any) => {
      store[key] = value;
    },
    setDynamic: (key: string, value: unknown) => {
      store[key] = value;
    },
    setPersistent: (key: string, value: unknown) => {
      store[key] = value;
    },
    setPersistentDynamic: (key: string, value: unknown) => {
      store[key] = value;
    },
    onChange(listener: (key?: string) => void) {
      this._listeners.push(listener);
      return () => {
        const idx = this._listeners.indexOf(listener);
        if (idx >= 0) this._listeners.splice(idx, 1);
      };
    },
  };
};

/**
 * Creates a fake live McpToolSource whose snapshot can be swapped and whose
 * onCatalogChanged listeners can be fired on demand.
 */
const createFakeLiveSource = (
  initialSnapshots: readonly McpServerSnapshot[],
): {
  live: McpToolSource;
  setSnapshots: (snapshots: readonly McpServerSnapshot[]) => void;
  fireCatalogChanged: () => void;
  dispose: () => void;
} => {
  let current = initialSnapshots;
  const listeners = new Set<() => void>();
  let unsubscribed = false;
  const live: McpToolSource = {
    snapshot: () => current,
    callTool: async () => ({ content: [], isError: false }),
    onCatalogChanged: (listener) => {
      if (unsubscribed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribed = true;
      };
    },
  };
  return {
    live,
    setSnapshots: (snapshots) => {
      current = snapshots;
    },
    fireCatalogChanged: () => {
      for (const listener of listeners) listener();
    },
    dispose: () => {
      unsubscribed = true;
      listeners.clear();
    },
  };
};

describe('TurnStableMcpToolSource', () => {
  it('freezes a catalog within a turn and refreshes at the next boundary', () => {
    let current = [server('first')];
    const listeners = new Set<() => void>();
    const live: McpToolSource = {
      snapshot: () => current,
      callTool: async () => ({ content: [], isError: false }),
      onCatalogChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const source = new TurnStableMcpToolSource(live);
    current = [server('second')];
    listeners.forEach((listener) => listener());
    expect(source.snapshot()[0]?.name).toBe('first');
    source.beginTurn();
    expect(source.snapshot()[0]?.name).toBe('second');
    source.dispose();
  });

  it('MCP catalog turn stability through the real boundary: description is prompt-cache-stable within a turn and advances only on beginTurn()', () => {
    // --- Setup: fake live source + AgentConfiguration wraps it in TurnStableMcpToolSource ---
    const initialSnapshots: McpServerSnapshot[] = [serverWithTool('initial-server', 'greet')];
    const { live, setSnapshots, fireCatalogChanged, dispose } = createFakeLiveSource(initialSnapshots);

    const logger = createMockLogger();
    const settings = createMockSettings();
    const config = new AgentConfiguration(
      { agentOverride: { name: 'test', model: 'test', tools: [], clone: () => ({}) } as any, model: 'test' },
      {
        logger,
        settings,
        sessionContextService: { runWithContext: (_ctx: any, fn: () => any) => fn(), getContext: () => null } as any,
        toolInterceptorRegistry: { check: () => ({ kind: 'allow' }) } as any,
        askUserAnswerStore: { consume: () => undefined } as any,
        getSubagentBridge: () => null,
        mcpToolSource: live,
      },
    );

    // The AgentConfiguration wraps the live source in TurnStableMcpToolSource.
    // Get the wrapped source so the run_code tool definition uses the same instance.
    const turnStableSource = config.getBuildFactoryDeps().mcpToolSource!;
    expect(turnStableSource).toBeInstanceOf(TurnStableMcpToolSource);

    const approval = new ToolApprovalPolicyRegistry();
    const runCode = createRunCodeToolDefinition({
      loggingService: logger,
      approvalPolicyRegistry: approval,
      getCwd: () => process.cwd(),
      mcpToolSource: turnStableSource,
    });

    // --- Phase 1: Read description during a "turn" ---
    const descBefore = String(runCode.description);
    expect(descBefore).toContain('initial_server__greet');
    expect(descBefore).toContain('initial-server: ready, 1 tool');

    // --- Phase 2: Mutate live source and fire catalog change mid-turn ---
    setSnapshots([...initialSnapshots, serverWithTool('new-server', 'compute')]);
    fireCatalogChanged();

    // The snapshot must NOT have advanced yet (pending, not applied).
    const descAfterChange = String(runCode.description);
    expect(descAfterChange).toBe(descBefore); // prompt-cache guarantee

    // An incidental getAgent() must not advance the turn either.
    config.getAgent();
    const descAfterGetAgent = String(runCode.description);
    expect(descAfterGetAgent).toBe(descBefore);

    // getApplicationAgent() must not advance the turn either.
    config.getApplicationAgent();
    const descAfterGetAppAgent = String(runCode.description);
    expect(descAfterGetAppAgent).toBe(descBefore);

    // --- Phase 3: Start the next turn via the real path ---
    config.beginTurn();

    const descAfterBeginTurn = String(runCode.description);
    expect(descAfterBeginTurn).toContain('new_server__compute');
    expect(descAfterBeginTurn).toContain('new-server: ready, 1 tool');
    // The initial server is still present.
    expect(descAfterBeginTurn).toContain('initial_server__greet');

    // --- Cleanup ---
    dispose();
    config.dispose();
  });
});
