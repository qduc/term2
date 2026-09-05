// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputProvider } from './context/InputContext.js';
import BottomArea from './components/layout/BottomArea.js';
import { renderInAct } from './test-helpers/ink-testing.js';
import { useConversation } from './hooks/use-conversation.js';
import { getAgentDefinition } from './agent.js';
import { AgentClient } from './lib/agent-client.js';
import { createEditorImpl } from './lib/editor-impl.js';
import { buildAgentTools, type AgentFactoryDeps } from './lib/agent-factory.js';
import { registerProvider, unregisterProvider } from './providers/registry.js';
import type { ConversationAgentClient } from './services/conversation-agent-client.js';
import { ConversationService } from './services/conversation/conversation-service.js';
import type { StreamedModelTurnRequest } from './contracts/streamed-model-turn.js';
import { ExecutionContext } from './services/execution-context.js';
import { SessionAccessState } from './services/session/session-access-state.js';
import { createMockSettingsService } from './services/settings/settings-service.mock.js';
import { ToolApprovalPolicyRegistry } from './services/approval/tool-approval-policy-registry.js';
import { ToolOwnershipRegistry } from './services/approval/tool-ownership-registry.js';
import { RUN_CODE_PROHIBITED_TOOLS } from './tools/system/run-code/run-code.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  security: vi.fn(),
  setCorrelationId: vi.fn(),
  getCorrelationId: () => undefined,
  clearCorrelationId: vi.fn(),
} as any;

const sessionContextService = {
  runWithContext: (_context: unknown, fn: () => unknown) => fn(),
  getContext: () => null,
} as any;

const historyService = {
  getMessages: () => [],
  addMessage: () => {},
  clear: () => {},
} as any;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const NestedHideHarness = ({
  service,
  settings,
}: {
  service: ConversationService;
  settings: ReturnType<typeof createMockSettingsService>;
}) => {
  const conversation = useConversation({
    conversationService: service,
    loggingService: logger,
    historyService,
    settingsService: settings,
  });
  const pendingApproval = conversation.pendingApproval ?? conversation.nestedApproval?.approval ?? null;
  const waitingForApproval = conversation.nestedApproval ? true : conversation.waitingForApproval;
  const isProcessing = conversation.nestedApproval ? false : conversation.isProcessing;
  return (
    <InputProvider>
      <BottomArea
        pendingApproval={pendingApproval}
        waitingForApproval={waitingForApproval}
        waitingForRejectionReason={conversation.waitingForRejectionReason}
        isProcessing={isProcessing}
        onSubmit={async () => {}}
        slashCommands={[]}
        settingsService={settings}
        loggingService={logger}
        historyService={historyService}
        onApprove={(answer) => {
          void conversation.resolveNestedApproval({ answer: answer ?? 'y' });
        }}
        onReject={() => {
          conversation.setWaitingForRejectionReason(true);
        }}
        onCancel={() => {
          conversation.stopProcessing();
        }}
        queuePaused={false}
        queueLength={0}
        backgroundTaskManagerOpen={false}
        onBackgroundTaskManagerOpenChange={() => {}}
      />
    </InputProvider>
  );
};

it.sequential(
  'approves a hidden nested editor from a real Ink keyboard after hide',
  async () => {
    const providerId = 'm4-hide-k1-provider';
    const workspace = mkdtempSync(join(tmpdir(), 'term2-m4-hide-k1-workspace-'));
    const outsideDir = mkdtempSync(join('/tmp', 'term2-m4-hide-k1-outside-'));
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
    expect(tools.map((tool) => tool.name)).not.toContain('create_file');
    expect(tools.every((tool) => RUN_CODE_PROHIBITED_TOOLS.has(tool.name))).toBe(true);

    const scriptCode =
      'return await tools.create_file(' +
      JSON.stringify({ path: approvedPath, content: 'approved', overwrite: false }) +
      ');';
    const providerRequests: StreamedModelTurnRequest[] = [];
    registerProvider({
      id: providerId,
      label: 'M4 hide K1 provider',
      capabilities: { supportsConversationChaining: false },
      fetchModels: async () => [],
      createStreamedModel: () => ({
        async *stream(request: StreamedModelTurnRequest) {
          providerRequests.push(request);
          if (providerRequests.length === 1) {
            yield {
              type: 'completion' as const,
              responseId: 'm4-hide-k1-outer-response',
              output: [
                {
                  type: 'tool_call' as const,
                  id: 'm4-hide-k1-outer-call',
                  name: 'run_code',
                  arguments: JSON.stringify({ code: scriptCode }),
                },
              ],
            };
          } else {
            yield {
              type: 'completion' as const,
              responseId: 'm4-hide-k1-final-response',
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
        name: 'M4 hide K1 agent',
        model: 'm4-hide-model',
        instructions: 'Use the supplied tool call.',
        tools,
      },
    });
    const service = new ConversationService({
      agentClient: providerClient as ConversationAgentClient,
      toolOwnership,
      sessionId: 'm4-hide-k1-session',
      enableNestedApproval: true,
      deps: { logger, sessionContextService, settingsService: settings },
    });

    const view = await renderInAct(<NestedHideHarness service={service} settings={settings} />);
    try {
      const pending = service.sendMessage('run the hidden nested editor');
      try {
        await vi.waitFor(() => {
          const frame = view.lastFrame() ?? '';
          expect(frame).toContain('create_file');
          expect(frame).toContain('Allow permission to edit this file outside the workspace?');
        });
        expect(existsSync(approvedPath)).toBe(false);
        await act(async () => {
          view.stdin.write('\r');
        });
        const terminal = await pending;
        expect(terminal.type).toBe('response');
        if (terminal.type !== 'response') throw new Error(`expected response, got ${terminal.type}`);
        expect(existsSync(approvedPath)).toBe(true);
        expect(readFileSync(approvedPath, 'utf8')).toBe('approved');
        expect(providerRequests[0]?.tools.map((tool) => tool.name)).not.toContain('create_file');
        expect(String(terminal.finalText ?? '')).toBe('turn complete');
      } catch (error) {
        service.abort();
        await pending.catch(() => undefined);
        throw error;
      }
    } finally {
      await act(async () => {
        view.unmount();
      });
      await service.shutdown();
      providerClient.dispose();
      access.dispose();
      unregisterProvider(providerId);
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  },
  20_000,
);
