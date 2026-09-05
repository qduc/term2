import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgentDefinition } from '../../source/agent.js';
import { AgentClient } from '../../source/lib/agent-client.js';
import { createEditorImpl } from '../../source/lib/editor-impl.js';
import { buildAgentTools, type AgentFactoryDeps } from '../../source/lib/agent-factory.js';
import { registerProvider, unregisterProvider } from '../../source/providers/registry.js';
import type { ConversationAgentClient } from '../../source/services/conversation-agent-client.js';
import { ConversationService } from '../../source/services/conversation/conversation-service.js';
import type { StreamedModelTurnRequest } from '../../source/contracts/streamed-model-turn.js';
import { ExecutionContext } from '../../source/services/execution-context.js';
import { SessionAccessState } from '../../source/services/session/session-access-state.js';
import { createMockSettingsService } from '../../source/services/settings/settings-service.mock.js';
import { ToolApprovalPolicyRegistry } from '../../source/services/approval/tool-approval-policy-registry.js';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.js';
import { RUN_CODE_PROHIBITED_TOOLS } from '../../source/tools/system/run-code/run-code.js';
import { createScriptedNestedApprovalAdapter } from '../nested-approval/scripted-decision-adapter.js';

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

const HIDDEN_EDITORS = ['create_file', 'search_replace', 'read_file'] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('P1 nested hide result chain', () => {
  it('approves a hidden nested editor through the scripted adapter and preserves result-chain identity', async () => {
    const providerId = 'm4-hide-p1-provider';
    const workspace = mkdtempSync(join(tmpdir(), 'term2-m4-hide-p1-workspace-'));
    const outsideDir = mkdtempSync(join('/tmp', 'term2-m4-hide-p1-outside-'));
    const approvedPath = join(outsideDir, 'approved.txt');
    const settings = createMockSettingsService({
      'shell.autoApproveMode': 'off',
      'agent.provider': providerId,
      'agent.model': 'm4-hide-model',
      'app.searchViaShell': 'off',
    });
    const access = new SessionAccessState(settings);
    const toolOwnership = new ToolOwnershipRegistry();
    const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
    const executionContext = ExecutionContext.pin(workspace);
    const editor = createEditorImpl({
      loggingService: logger,
      settingsService: settings,
      executionContext,
    });
    const deps: AgentFactoryDeps = {
      settings,
      logger,
      editor,
      providerId: 'openai',
      serviceTierOverrideForNextRequest: null,
      approvalPolicyRegistry,
      executionContext,
      sessionAccess: access,
      createMentor: async () => 'mentor-response',
      runSubagent: async () => ({ finalText: 'subagent-response' }),
      runSubagentAsync: async () => ({ runId: 'run-1', status: 'running' }),
      getSubagentResult: async () => ({ status: 'completed', finalText: '' }),
      sendSubagentMessage: () => ({ ok: true, runId: 'run-1', status: 'running', delivery: 'queued' }),
      cancelSubagentRun: () => ({ ok: true, runId: 'run-1', status: 'cancelling' }),
      getAskUserAnswer: () => undefined,
      checkToolInterceptors: async () => null,
    };
    const raw = getAgentDefinition(
      {
        settingsService: settings,
        loggingService: logger,
        executionContext,
        sessionAccess: access,
        approvalPolicyRegistry,
      },
      'gpt-4o',
    );
    const tools = buildAgentTools({
      toolDefinitions: raw.tools,
      resolvedModel: 'gpt-4o',
      shouldUseNativePatchTool: true,
      deps,
    });
    const directNames = tools.map((tool) => tool.name);
    expect(directNames).toContain('run_code');
    expect(directNames.every((name) => RUN_CODE_PROHIBITED_TOOLS.has(name))).toBe(true);
    for (const name of HIDDEN_EDITORS) {
      expect(raw.tools.some((tool) => tool.name === name)).toBe(true);
      expect(directNames).not.toContain(name);
    }
    expect(directNames).not.toContain('apply_patch');

    const scriptCode =
      'return await tools.create_file(' +
      JSON.stringify({ path: approvedPath, content: 'approved', overwrite: false }) +
      ');';
    const providerRequests: StreamedModelTurnRequest[] = [];
    const outerCallId = 'm4-hide-outer-call';
    registerProvider({
      id: providerId,
      label: 'M4 hide P1 provider',
      capabilities: { supportsConversationChaining: false },
      fetchModels: async () => [],
      createStreamedModel: () => ({
        async *stream(request: StreamedModelTurnRequest) {
          providerRequests.push(request);
          if (providerRequests.length === 1) {
            yield {
              type: 'completion' as const,
              responseId: 'm4-hide-outer-response',
              output: [
                {
                  type: 'tool_call' as const,
                  id: outerCallId,
                  name: 'run_code',
                  arguments: JSON.stringify({ code: scriptCode }),
                },
              ],
            };
          } else {
            yield {
              type: 'completion' as const,
              responseId: 'm4-hide-final-response',
              output: [{ type: 'message' as const, content: [{ type: 'text' as const, text: 'turn complete' }] }],
            };
          }
        },
      }),
    });

    const providerClient = new AgentClient({
      model: 'm4-hide-model',
      providerOverride: providerId,
      approvalPolicyRegistry,
      deps: { logger, settings, executionContext, sessionContextService },
      toolOwnership,
      sessionAccess: access,
      agentOverride: {
        name: 'M4 hide P1 agent',
        model: 'm4-hide-model',
        instructions: 'Use the supplied tool call.',
        tools,
      },
    });
    const service = new ConversationService({
      agentClient: providerClient as ConversationAgentClient,
      toolOwnership,
      sessionId: 'm4-hide-p1-session',
      enableNestedApproval: true,
      deps: { logger, sessionContextService, settingsService: settings },
    });

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
      ],
      {
        onRequest: (snapshot) => seen.push(snapshot),
      },
    );

    try {
      const terminal = await service.sendMessage('run the hidden nested editor');
      expect(terminal.type).toBe('response');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        sessionId: service.sessionId,
        toolName: 'create_file',
        preparedArguments: { path: approvedPath, content: 'approved', overwrite: false },
      });
      expect(existsSync(approvedPath)).toBe(true);
      expect(readFileSync(approvedPath, 'utf8')).toBe('approved');

      expect(providerRequests).toHaveLength(2);
      const advertised = providerRequests[0]!.tools.map((tool) => tool.name);
      expect(advertised).toContain('run_code');
      for (const name of [...HIDDEN_EDITORS, 'apply_patch']) {
        expect(advertised).not.toContain(name);
      }
      expect(advertised.some((name) => !RUN_CODE_PROHIBITED_TOOLS.has(name))).toBe(false);
      expect(providerRequests[0]!.tools.some((tool) => tool.type === 'custom')).toBe(false);

      const toolResult = providerRequests[1]!.input.find((item) => item.type === 'tool_result');
      expect(toolResult?.type).toBe('tool_result');
      if (toolResult?.type === 'tool_result') {
        expect(toolResult.id).toBe(outerCallId);
        expect(String(toolResult.output)).toContain(`Created ${approvedPath}`);
        expect(String(toolResult.output)).not.toContain('approval_required');
        expect(String(toolResult.output)).not.toContain('call this directly');
      }
      expect(String(terminal.finalText ?? '')).toBe('turn complete');
    } finally {
      await adapter.dispose();
      await service.shutdown();
      providerClient.dispose();
      access.dispose();
      unregisterProvider(providerId);
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
