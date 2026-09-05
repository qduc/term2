import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentClient } from '../../source/lib/agent-client.js';
import { registerProvider, unregisterProvider } from '../../source/providers/registry.js';
import type { ConversationAgentClient } from '../../source/services/conversation-agent-client.js';
import { ConversationService } from '../../source/services/conversation/conversation-service.js';
import type { ConversationEvent } from '../../source/services/conversation/conversation-events.js';
import { ExecutionContext } from '../../source/services/execution-context.js';
import { SessionAccessState } from '../../source/services/session/session-access-state.js';
import { createMockSettingsService } from '../../source/services/settings/settings-service.mock.js';
import { ToolApprovalPolicyRegistry } from '../../source/services/approval/tool-approval-policy-registry.js';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.js';
import { createCreateFileToolDefinition } from '../../source/tools/file/create-file.js';
import { bindRunCodeRegistry, createRunCodeToolDefinition } from '../../source/tools/system/run-code/run-code.js';
import type { ToolRegistry } from '../../source/tools/types.js';
import { createScriptedNestedApprovalAdapter } from './scripted-decision-adapter.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  security: vi.fn(),
  setCorrelationId: vi.fn(),
  getCorrelationId: () => undefined,
  clearCorrelationId: vi.fn(),
};

const sessionContextService = {
  runWithContext: <T>(_context: unknown, fn: () => T): T => fn(),
  getContext: () => null,
};

const client = (overrides: Record<string, unknown> = {}): ConversationAgentClient =>
  ({
    chat: async () => '',
    abort: vi.fn(),
    setModel: vi.fn(),
    addToolInterceptor: vi.fn(() => () => {}),
    startStream: vi.fn(),
    continueRunStream: vi.fn(),
    ...overrides,
  } as ConversationAgentClient);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('scripted nested approval acceptance entry point', () => {
  it('drives one real session turn through the outer run_code call and settles one terminal', async () => {
    const providerId = 'm2b-scripted-acceptance-provider';
    const workspace = mkdtempSync(join(tmpdir(), 'term2-nested-approval-workspace-'));
    const approvedDir = mkdtempSync(join(tmpdir(), 'term2-nested-approval-approved-'));
    const deniedDir = mkdtempSync(join(tmpdir(), 'term2-nested-approval-denied-'));
    const logPath = join(workspace, 'nested-calls.jsonl');
    const settings = createMockSettingsService({
      'shell.autoApproveMode': 'off',
      'agent.provider': providerId,
      'agent.model': 'm2b-model',
    });
    const access = new SessionAccessState(settings);
    const toolOwnership = new ToolOwnershipRegistry();
    const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
    const executionContext = ExecutionContext.pin(workspace);
    const createFile = createCreateFileToolDefinition({
      loggingService: logger,
      settingsService: settings,
      executionContext,
      sessionAccess: access,
    });
    approvalPolicyRegistry.register({
      toolName: createFile.name,
      parameters: createFile.parameters,
      needsApproval: createFile.needsApproval,
    });
    let tools: ToolRegistry = [createFile];
    const runCode = createRunCodeToolDefinition({
      loggingService: logger,
      getToolRegistry: () => tools,
      getCwd: () => workspace,
      executionContext,
      approvalPolicyRegistry,
      sessionAccess: access,
    });
    tools = [createFile, runCode];
    bindRunCodeRegistry(tools);

    const approvedPath = join(approvedDir, 'approved.txt');
    const deniedPath = join(deniedDir, 'denied.txt');
    const scriptCode =
      'const first = await tools.create_file(' +
      JSON.stringify({ path: approvedPath, content: 'approved', overwrite: false }) +
      '); let denied = "not caught"; try { await tools.create_file(' +
      JSON.stringify({ path: deniedPath, content: 'denied', overwrite: false }) +
      '); } catch { denied = "caught"; } return { first, denied };';
    const providerRequests: unknown[] = [];
    registerProvider({
      id: providerId,
      label: 'M2b scripted acceptance provider',
      capabilities: { supportsConversationChaining: false },
      fetchModels: async () => [],
      createStreamedModel: () => ({
        async *stream(request: unknown) {
          providerRequests.push(request);
          if (providerRequests.length === 1) {
            yield {
              type: 'completion' as const,
              responseId: 'm2b-outer-response',
              output: [
                {
                  type: 'tool_call' as const,
                  id: 'm2b-outer-call',
                  name: 'run_code',
                  arguments: JSON.stringify({ code: scriptCode }),
                },
              ],
            };
          } else {
            yield {
              type: 'completion' as const,
              responseId: 'm2b-final-response',
              output: [{ type: 'message' as const, content: [{ type: 'text' as const, text: 'turn complete' }] }],
            };
          }
        },
      }),
    });

    const providerClient = new AgentClient({
      model: 'm2b-model',
      providerOverride: providerId,
      approvalPolicyRegistry,
      deps: { logger, settings, executionContext, sessionContextService },
      toolOwnership,
      sessionAccess: access,
      agentOverride: {
        name: 'M2b acceptance agent',
        model: 'm2b-model',
        instructions: 'Use the supplied tool call.',
        tools,
      },
    });
    const service = new ConversationService({
      agentClient: providerClient,
      toolOwnership,
      sessionId: 'm2b-acceptance-session',
      enableNestedApproval: true,
      deps: { logger, sessionContextService, settingsService: settings },
    });

    const events: ConversationEvent[] = [];
    service.setEventSink((event) => events.push(event));
    vi.stubEnv('TERM2_NESTED_CALL_LOG', logPath);
    const seen: import('../../source/services/approval/nested-approval-owner.js').NestedApprovalSnapshot[] = [];
    const adapter = createScriptedNestedApprovalAdapter(
      {
        getSnapshot: service.getNestedApprovalSnapshot.bind(service),
        subscribe: (observer) => {
          service.setNestedApprovalObserver(observer);
          return () => service.setNestedApprovalObserver(null);
        },
        decide: service.decideNestedApproval.bind(service),
      },
      [
        {
          sessionId: service.sessionId,
          toolName: 'create_file',
          preparedArguments: { path: approvedPath, content: 'approved', overwrite: false },
          answer: 'y',
        },
        {
          sessionId: service.sessionId,
          toolName: 'create_file',
          preparedArguments: { path: deniedPath, content: 'denied', overwrite: false },
          answer: 'n',
          rejectionReason: 'not this time',
        },
      ],
      {
        onRequest: (snapshot) => seen.push(snapshot),
      },
    );

    const execute = vi.spyOn(createFile, 'execute');
    try {
      const terminal = await service.sendMessage('run the scripted acceptance turn');
      const terminalEvents = events.filter(
        (event) => event.type === 'final' || event.type === 'error' || event.type === 'approval_required',
      );

      expect(terminal.type).toBe('response');
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]?.type).toBe('final');
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({
        sessionId: service.sessionId,
        outerRunId: expect.stringMatching(/^run_code_bridge_/),
        nestedCallId: expect.stringMatching(/^run_code_bridge_.*:/),
        toolName: 'create_file',
        preparedArguments: { path: approvedPath, content: 'approved', overwrite: false },
      });
      expect(seen[0].approval.callId).toBe(seen[0].nestedCallId);
      expect(seen[1].preparedArguments).toEqual({
        path: deniedPath,
        content: 'denied',
        overwrite: false,
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(existsSync(approvedPath)).toBe(true);
      expect(readFileSync(approvedPath, 'utf8')).toBe('approved');
      expect(existsSync(deniedPath)).toBe(false);
      expect(providerRequests).toHaveLength(2);
      const toolResult = (providerRequests[1] as { input?: Array<{ type?: string; output?: unknown }> }).input?.find(
        (item) => item.type === 'tool_result',
      );
      expect(toolResult?.output).toContain('"denied":"caught"');
      expect(toolResult?.output).not.toContain('approval_required');
      expect(String(terminal.finalText ?? '')).toBe('turn complete');

      const records = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { tool: string; sessionId: string; timestamp: string; outcome: string });
      expect(records).toHaveLength(2);
      expect(records).toEqual([
        { tool: 'create_file', sessionId: service.sessionId, timestamp: expect.any(String), outcome: 'success' },
        {
          tool: 'create_file',
          sessionId: service.sessionId,
          timestamp: expect.any(String),
          outcome: 'denied-by-approval',
        },
      ]);
    } finally {
      await adapter.dispose();
      await service.shutdown();
      providerClient.dispose();
      access.dispose();
      unregisterProvider(providerId);
      rmSync(workspace, { recursive: true, force: true });
      rmSync(approvedDir, { recursive: true, force: true });
      rmSync(deniedDir, { recursive: true, force: true });
    }
  });

  it('does not expose a scripted-adapter selector in the production TUI construction', async () => {
    const setNestedApprovalOwner = vi.fn();
    const service = new ConversationService({
      agentClient: client({ setNestedApprovalOwner }),
      toolOwnership: new ToolOwnershipRegistry(),
      enableNestedApproval: true,
      deps: { logger, sessionContextService },
    });

    expect(setNestedApprovalOwner).toHaveBeenCalledTimes(1);
    expect(service.getNestedApprovalSnapshot()).toBeNull();
    expect('scriptedNestedApproval' in service).toBe(false);

    await service.shutdown();
  });
});
