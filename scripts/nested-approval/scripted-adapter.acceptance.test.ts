import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationAgentClient } from '../../source/services/conversation-agent-client.js';
import { ConversationService } from '../../source/services/conversation/conversation-service.js';
import { ExecutionContext } from '../../source/services/execution-context.js';
import { SessionAccessState } from '../../source/services/session/session-access-state.js';
import { createMockSettingsService } from '../../source/services/settings/settings-service.mock.js';
import { ToolApprovalPolicyRegistry } from '../../source/services/approval/tool-approval-policy-registry.js';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.js';
import { createCreateFileToolDefinition } from '../../source/tools/file/create-file.js';
import {
  bindRunCodeNestedApprovalOwner,
  bindRunCodeRegistry,
  createRunCodeToolDefinition,
} from '../../source/tools/system/run-code/run-code.js';
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
  it('approves once, denies once, and settles one real script outcome without a provider continuation', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'term2-nested-approval-workspace-'));
    const approvedDir = mkdtempSync(join(tmpdir(), 'term2-nested-approval-approved-'));
    const deniedDir = mkdtempSync(join(tmpdir(), 'term2-nested-approval-denied-'));
    const logPath = join(workspace, 'nested-calls.jsonl');
    const settings = createMockSettingsService({ 'shell.autoApproveMode': 'off' });
    const access = new SessionAccessState(settings);
    let nestedOwner: import('../../source/services/approval/nested-approval-owner.js').NestedApprovalOwner | undefined;
    const providerClient = client({
      setNestedApprovalOwner: (owner: typeof nestedOwner) => {
        nestedOwner = owner;
      },
    });
    const service = new ConversationService({
      agentClient: providerClient,
      toolOwnership: new ToolOwnershipRegistry(),
      sessionId: 'm2b-acceptance-session',
      enableNestedApproval: true,
      deps: { logger, sessionContextService, settingsService: settings },
    });
    const createFile = createCreateFileToolDefinition({
      loggingService: logger,
      settingsService: settings,
      executionContext: ExecutionContext.pin(workspace),
      sessionAccess: access,
    });
    const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
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
      approvalPolicyRegistry,
      sessionAccess: access,
    });
    tools = [createFile, runCode];
    bindRunCodeRegistry(tools);
    bindRunCodeNestedApprovalOwner(tools, nestedOwner!);

    const approvedPath = join(approvedDir, 'approved.txt');
    const deniedPath = join(deniedDir, 'denied.txt');
    vi.stubEnv('TERM2_NESTED_CALL_LOG', logPath);
    let scriptSettled = false;
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
          answer: 'allow-edit-file-session',
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
        onRequest: (snapshot) => {
          seen.push(snapshot);
          expect(scriptSettled).toBe(false);
        },
      },
    );

    const execute = vi.spyOn(createFile, 'execute');
    const script = runCode
      .execute(
        {
          code:
            'const first = await tools.create_file(' +
            JSON.stringify({ path: approvedPath, content: 'approved', overwrite: false }) +
            '); let denied = "not caught"; try { await tools.create_file(' +
            JSON.stringify({ path: deniedPath, content: 'denied', overwrite: false }) +
            '); } catch { denied = "caught"; } return { first, denied };',
        },
        { context: { sessionId: service.sessionId }, signal: new AbortController().signal },
      )
      .then((result) => {
        scriptSettled = true;
        return String(result);
      });

    const terminalOutcomes = [await script];
    adapter.dispose();

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
    expect(terminalOutcomes).toHaveLength(1);
    expect(terminalOutcomes[0]).toContain('"denied":"caught"');
    expect(terminalOutcomes[0]).not.toContain('approval_required');
    expect(providerClient.startStream).not.toHaveBeenCalled();
    expect(providerClient.continueRunStream).not.toHaveBeenCalled();

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

    await service.shutdown();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(approvedDir, { recursive: true, force: true });
    rmSync(deniedDir, { recursive: true, force: true });
  });

  it('does not make the scripted adapter selectable through ordinary production construction', async () => {
    const setNestedApprovalOwner = vi.fn();
    const service = new ConversationService({
      agentClient: client({ setNestedApprovalOwner }),
      toolOwnership: new ToolOwnershipRegistry(),
      deps: { logger, sessionContextService },
    });

    expect(setNestedApprovalOwner).not.toHaveBeenCalled();
    expect(service.getNestedApprovalSnapshot()).toBeNull();
    expect('scriptedNestedApproval' in service).toBe(false);

    await service.shutdown();
  });
});
