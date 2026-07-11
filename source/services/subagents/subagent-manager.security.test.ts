import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TestSubagentManager,
  createMockLogger,
  createMockSettings,
  createSessionContextService,
  createMockExecutionContext,
  createTempDir,
  removeTempDir,
  registerTestProvider,
  wrapResultAsAgentStream,
  wrapErrorAsAgentStream,
  getAgentTool,
  ROLE_MENTOR,
  ROLE_EXPLORER,
  ROLE_WORKER,
  ROLE_RESEARCHER,
} from './test-helpers/subagent-manager-fixtures.js';
import { SubagentManager as RealSubagentManager } from './subagent-manager.js';
import { ModelBehaviorError } from '@openai/agents';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../retry/conversation-retry-policy.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { SubagentToolPolicy } from './tool-policy.js';
import type { ToolDefinition } from '../../tools/types.js';

const shellDefinition: ToolDefinition = {
  name: 'shell',
  description: 'shell',
  parameters: {} as any,
  needsApproval: async () => false,
  execute: async () => 'ran',
  formatCommandMessage: () => [],
};

function createToolPolicy(): SubagentToolPolicy {
  return new SubagentToolPolicy({
    settings: createMockSettings(),
    logger: createMockLogger(),
    sessionContextService: createSessionContextService(),
  });
}

describe('unsandboxed shell enforcement', () => {
  it('worker shell wrapper rejects unsandboxed execution', async () => {
    const tool = createToolPolicy().wrapShellTool(shellDefinition, process.cwd(), [], 'task');

    const result = await tool.execute({ command: 'curl https://example.com', sandbox: 'unsandboxed' });

    expect(result).toContain('unsandboxed shell execution is not available to subagents');
  });

  it('nested shell wrapper rejects unsandboxed execution', async () => {
    const tool = createToolPolicy().wrapNestedShellTool(shellDefinition, process.cwd());

    const result = await tool.execute({ command: 'curl https://example.com', sandbox: 'unsandboxed' });

    expect(result).toContain('unsandboxed shell execution is not available to subagents');
  });

  it('read-only shell wrapper rejects unsandboxed execution', async () => {
    const tool = createToolPolicy().wrapReadOnlyShellTool(shellDefinition);

    const result = await tool.execute({ command: 'curl https://example.com', sandbox: 'unsandboxed' });

    expect(result).toContain('unsandboxed shell execution is not available to subagents');
  });
});

// ========== Write boundary enforcement ==========

describe('write boundary enforcement', () => {
  let tmpDir: string;
  let boundaryWorkerCalls: any[];
  let providerId: string;

  beforeEach(() => {
    tmpDir = createTempDir('term2-test-boundary-');
    boundaryWorkerCalls = [];
    providerId = registerTestProvider({
      label: 'Mock Boundary Worker',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, _options: any) => {
            boundaryWorkerCalls.push({ agent: _agent });
            const result = {
              status: 'completed',
              finalOutput: 'Done.',
              history: [],
              messages: [],
            };
            return _options?.stream ? wrapResultAsAgentStream(result) : result;
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });
  });

  afterEach(() => {
    removeTempDir(tmpDir);
  });

  it('worker write tool rejects paths outside workspace', async () => {
    const mockExecutionContext = createMockExecutionContext(tmpDir);

    // 1. Test apply_patch tool under gpt-5 model
    const settingsGpt = createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': providerId,
    });
    const managerGpt = new TestSubagentManager({
      logger: createMockLogger(),
      settings: settingsGpt,
      executionContext: mockExecutionContext,
    });

    await managerGpt.run({
      role: 'worker',
      task: 'update a file',
    });

    expect(boundaryWorkerCalls.length).toBe(1);
    const agentGpt = boundaryWorkerCalls[0].agent;
    const applyPatch = agentGpt.tools.find((t: any) => t.name === 'apply_patch');
    expect(applyPatch).toBeTruthy();
    expect(agentGpt.tools.find((t: any) => t.name === 'search_replace')).toBeFalsy();

    // Call with a path inside the boundary — should NOT be rejected for boundary violation
    const insideResult = await applyPatch.invoke(
      {},
      JSON.stringify({
        type: 'create_file',
        path: 'newfile.ts',
        diff: '+hello\n',
      }),
      {},
    );
    const insideError = insideResult.startsWith('Error:') ? insideResult : undefined;
    expect(!insideError || !insideError.includes('outside the allowed write boundary')).toBe(true);

    // Call with a path outside the boundary — should be rejected
    const outsideResult = await applyPatch.invoke(
      {},
      JSON.stringify({
        type: 'create_file',
        path: '../outside/file.ts',
        diff: '+hello\n',
      }),
      {},
    );
    expect(outsideResult.includes('outside the allowed write boundary')).toBe(true);
    expect(outsideResult.startsWith('Error:')).toBe(true);

    const outsideNeedsApproval = await applyPatch.needsApproval(
      {},
      {
        type: 'create_file',
        path: '../outside/file.ts',
        diff: '+hello\n',
      },
    );
    expect(outsideNeedsApproval).toBe(false);

    // 2. Test search_replace tool under non-gpt model
    const settingsNonGpt = createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': providerId,
    });
    const managerNonGpt = new TestSubagentManager({
      logger: createMockLogger(),
      settings: settingsNonGpt,
      executionContext: mockExecutionContext,
    });

    boundaryWorkerCalls = []; // reset calls
    await managerNonGpt.run({
      role: 'worker',
      task: 'update a file',
    });

    expect(boundaryWorkerCalls.length).toBe(1);
    const agentNonGpt = boundaryWorkerCalls[0].agent;
    const searchReplace = agentNonGpt.tools.find((t: any) => t.name === 'search_replace');
    expect(searchReplace).toBeTruthy();
    expect(agentNonGpt.tools.find((t: any) => t.name === 'apply_patch')).toBeFalsy();

    const batchOutsideResult = await searchReplace.invoke(
      {},
      JSON.stringify({
        path: '../outside.ts',
        replacements: [
          {
            search_content: '',
            replace_content: 'no',
          },
        ],
      }),
      {},
    );
    expect(batchOutsideResult.includes('outside the allowed write boundary')).toBe(true);
    expect(batchOutsideResult.startsWith('Error:')).toBe(true);
  });

  it('worker writes are auto-approved within the workspace', async () => {
    const mockExecutionContext = createMockExecutionContext(tmpDir);

    const settings = createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': providerId,
      'app.editMode': false,
    });
    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings,
      executionContext: mockExecutionContext,
    });

    await manager.run({
      role: 'worker',
      task: 'update files',
    });

    expect(boundaryWorkerCalls.length).toBe(1);
    const agent = boundaryWorkerCalls[0].agent;
    const createFile = agent.tools.find((tool: any) => tool.name === 'create_file');
    expect(createFile).toBeTruthy();

    // In-boundary writes require no interactive approval (there is no foreground
    // approval channel for a subagent running inside a blocked parent tool call).
    // Standard mode is off but the write still does not need approval.
    const inBoundaryNeedsApproval = await createFile.needsApproval({}, { path: 'a.ts', content: 'x' });
    expect(inBoundaryNeedsApproval).toBe(false);

    // Out-of-boundary writes are also not surfaced for approval; they are
    // rejected deterministically by execute() instead.
    const outBoundaryNeedsApproval = await createFile.needsApproval({}, { path: '../escape.ts', content: 'x' });
    expect(outBoundaryNeedsApproval).toBe(false);
  });

  it('worker cannot write outside the workspace', async () => {
    const mockExecutionContext = createMockExecutionContext(tmpDir);

    const settings = createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': providerId,
    });
    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings,
      executionContext: mockExecutionContext,
    });

    // Writes default to the workspace root.
    await manager.run({ role: 'worker', task: 'update a file' });

    const agent = boundaryWorkerCalls[boundaryWorkerCalls.length - 1].agent;
    const createFile = agent.tools.find((tool: any) => tool.name === 'create_file');
    expect(createFile).toBeTruthy();

    const outsideResult = await createFile.invoke({}, JSON.stringify({ path: '../outside.ts', content: 'x' }), {});
    expect(outsideResult.includes('outside the allowed write boundary')).toBe(true);
    expect(outsideResult.startsWith('Error:')).toBe(true);
  });

  it('worker filesChanged tracks only successful writes for batch operations', async () => {
    const filesChangedProviderId = registerTestProvider({
      label: 'Mock Worker Files Changed Provider',
      createRunner: () =>
        ({
          run: async (agent: any) => {
            const applyPatch = agent.tools.find((tool: any) => tool.name === 'apply_patch');
            const searchReplace = agent.tools.find((tool: any) => tool.name === 'search_replace');

            if (applyPatch) {
              await applyPatch.invoke(
                {},
                JSON.stringify({
                  operations: [
                    { type: 'create_file', path: 'a.txt', diff: '+hello\n' },
                    { type: 'update_file', path: 'missing.txt', diff: '-x\n+y\n' },
                  ],
                }),
                {},
              );
            }

            if (searchReplace) {
              await searchReplace.invoke(
                {},
                JSON.stringify({
                  path: 'b.txt',
                  replacements: [{ search_content: '', replace_content: 'created' }],
                }),
                {},
              );
              await searchReplace.invoke(
                {},
                JSON.stringify({
                  path: 'missing2.txt',
                  replacements: [{ search_content: 'x', replace_content: 'y' }],
                }),
                {},
              );
            }

            const result = {
              status: 'completed',
              finalOutput: 'Done.',
              history: [],
              messages: [],
            };
            return wrapResultAsAgentStream(result);
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    // 1. Test with GPT-5 model (using apply_patch)
    const managerGpt = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'gpt-5',
        'agent.provider': filesChangedProviderId,
      }),
      executionContext: createMockExecutionContext(tmpDir),
    });

    const resultGpt = await managerGpt.run({ role: 'worker', task: 'do mixed writes' });
    expect(new Set(resultGpt.filesChanged)).toEqual(new Set(['a.txt']));

    // 2. Test with non-GPT-5 model (using search_replace)
    const managerNonGpt = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'mock-model',
        'agent.provider': filesChangedProviderId,
      }),
      executionContext: createMockExecutionContext(tmpDir),
    });

    const resultNonGpt = await managerNonGpt.run({ role: 'worker', task: 'do mixed writes' });
    expect(new Set(resultNonGpt.filesChanged)).toEqual(new Set(['b.txt']));
  });

  it('worker write lock rejects concurrent create_file for same path without waiting', async () => {
    const lockProviderId = registerTestProvider({
      label: 'Mock Worker Lock Provider',
      createRunner: () =>
        ({
          run: async (agent: any) => {
            const createFile = agent.tools.find((tool: any) => tool.name === 'create_file');

            const [first, second] = await Promise.all([
              createFile.invoke(
                {},
                JSON.stringify({
                  path: 'locked.txt',
                  content: 'one',
                }),
                {},
              ),
              createFile.invoke(
                {},
                JSON.stringify({
                  path: 'locked.txt',
                  content: 'two',
                }),
                {},
              ),
            ]);

            const result = {
              status: 'completed',
              finalOutput: JSON.stringify({ first, second }),
              history: [],
              messages: [],
            };
            return wrapResultAsAgentStream(result);
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'mock-model',
        'agent.provider': lockProviderId,
      }),
      executionContext: createMockExecutionContext(tmpDir),
    });

    const result = await manager.run({ role: 'worker', task: 'concurrent writes' });
    const parsed = JSON.parse(result.finalText);
    const first = parsed.first;
    const second = parsed.second;

    const allErrors = [first, second]
      .filter((text: string) => typeof text === 'string' && text.startsWith('Error:'))
      .join(' ');
    expect(allErrors.includes('already being modified')).toBe(true);
  });
});

// ========== Worker shell tool — safety gating ==========

describe('worker shell tool safety gating', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir('term2-test-worker-shell-');
  });

  afterEach(() => {
    removeTempDir(tmpDir);
  });

  it('worker shell tool executes safe command without triggering approval UI', async () => {
    let shellResult: string | null = null;

    const providerId = registerTestProvider({
      label: 'Mock Worker Shell Safe Provider',
      createRunner: () =>
        ({
          run: async (agent: any, _input: any, _options: any) => {
            const shellTool = agent.tools.find((tool: any) => tool.name === 'shell');
            // needsApproval must be false for safe commands — no approval UI in workers
            const needsApproval = await shellTool.needsApproval({}, { command: 'ls .' });
            expect(needsApproval, 'worker shell tool must never require approval').toBe(false);

            shellResult = await shellTool.invoke({}, JSON.stringify({ command: 'echo hello' }), {});
            const result = {
              status: 'completed',
              finalOutput: 'done',
              history: [],
              messages: [],
            };
            return _options?.stream ? wrapResultAsAgentStream(result) : result;
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'mock-model',
        'agent.provider': providerId,
      }),
      sessionContextService: createSessionContextService() as any,
      executionContext: createMockExecutionContext(tmpDir),
    });

    await manager.run({ role: 'worker', task: 'list files' });

    // The shell tool should have executed and returned output (not an error block)
    expect(shellResult).toBeTruthy();
    expect(shellResult!.includes('blocked for safety')).toBe(false);
  });

  it('worker shell tool blocks dangerous/destructive commands and returns error string', async () => {
    let shellResult: string | null = null;

    const providerId = registerTestProvider({
      label: 'Mock Worker Shell Dangerous Provider',
      createRunner: () =>
        ({
          run: async (agent: any, _input: any, _options: any) => {
            const shellTool = agent.tools.find((tool: any) => tool.name === 'shell');
            // needsApproval must always be false — dangerous commands are blocked by execute(), not approval
            const needsApproval = await shellTool.needsApproval({}, { command: 'rm -rf /tmp/something' });
            expect(needsApproval, 'worker shell must never trigger approval UI even for dangerous commands').toBe(
              false,
            );

            shellResult = await shellTool.invoke({}, JSON.stringify({ command: 'rm -rf /tmp/something' }), {});
            const result = {
              status: 'completed',
              finalOutput: 'done',
              history: [],
              messages: [],
            };
            return _options?.stream ? wrapResultAsAgentStream(result) : result;
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'mock-model',
        'agent.provider': providerId,
      }),
      sessionContextService: createSessionContextService() as any,
      executionContext: createMockExecutionContext(tmpDir),
    });

    await manager.run({ role: 'worker', task: 'delete stuff' });

    // The shell tool should have returned a blocked-for-safety error string, not executed
    expect(shellResult).toBeTruthy();
    expect(shellResult!.includes('blocked for safety')).toBe(true);
    expect(shellResult!.includes('exit 0')).toBe(false);
  });

  it('worker shell tool allows YELLOW command when auto-approval evaluator approves', async () => {
    let shellResult: string | null = null;
    let chatCalls = 0;
    let evaluatorPrompt = '';

    const providerId = registerTestProvider({
      label: 'Mock Worker Shell Yellow Approved Provider',
      createRunner: () =>
        ({
          run: async (agent: any, _input: any, _options: any) => {
            const shellTool = agent.tools.find((tool: any) => tool.name === 'shell');
            shellResult = await shellTool.invoke({}, JSON.stringify({ command: 'npm run test:verbose -- --help' }), {});
            const result = {
              status: 'completed',
              finalOutput: 'done',
              history: [],
              messages: [],
            };
            return _options?.stream ? wrapResultAsAgentStream(result) : result;
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'mock-model',
        'agent.provider': providerId,
        'shell.autoApproveMode': 'auto',
        'agent.autoApproveModel': 'mock-auto-approve-model',
        'agent.autoApproveProvider': providerId,
      }),
      sessionContextService: createSessionContextService() as any,
      agentClient: {
        chat: async (message: string) => {
          chatCalls++;
          evaluatorPrompt = message;
          return '{"results":[{"approved":true,"reasoning":"Looks related and low risk."}]}';
        },
      } as any,
      executionContext: createMockExecutionContext(tmpDir),
    });

    await manager.run({ role: 'worker', task: 'run help for tests in this repository' });

    expect(chatCalls).toBe(1);
    expect(evaluatorPrompt.includes('run help for tests in this repository')).toBe(true);
    expect(shellResult).toBeTruthy();
    expect(shellResult!.includes('blocked for safety')).toBe(false);
  });

  it('worker shell tool blocks YELLOW command when auto-approval evaluator rejects', async () => {
    let shellResult: string | null = null;
    let chatCalls = 0;

    const providerId = registerTestProvider({
      label: 'Mock Worker Shell Yellow Rejected Provider',
      createRunner: () =>
        ({
          run: async (agent: any, _input: any, _options: any) => {
            const shellTool = agent.tools.find((tool: any) => tool.name === 'shell');
            shellResult = await shellTool.invoke({}, JSON.stringify({ command: 'npm run test:verbose -- --help' }), {});
            const result = {
              status: 'completed',
              finalOutput: 'done',
              history: [],
              messages: [],
            };
            return _options?.stream ? wrapResultAsAgentStream(result) : result;
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'mock-model',
        'agent.provider': providerId,
        'shell.autoApproveMode': 'auto',
        'agent.autoApproveModel': 'mock-auto-approve-model',
        'agent.autoApproveProvider': providerId,
      }),
      sessionContextService: createSessionContextService() as any,
      agentClient: {
        chat: async () => {
          chatCalls++;
          return '{"results":[{"approved":false,"reasoning":"Not safe."}]}';
        },
      } as any,
      executionContext: createMockExecutionContext(tmpDir),
    });

    await manager.run({ role: 'worker', task: 'run help for tests' });

    expect(chatCalls).toBe(1);
    expect(shellResult).toBeTruthy();
    expect(shellResult!.includes('blocked for safety')).toBe(true);
  });

  it('run() extracts usage from error.state.usage when subagent run fails', async () => {
    const providerId = registerTestProvider({
      label: 'Mock Failed Usage Provider',
      createRunner: () =>
        ({
          run: async () => {
            const err = new Error('Run failed due to some reason');
            (err as any).state = {
              usage: {
                inputTokens: 15,
                outputTokens: 25,
              },
            };
            throw err;
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    const settings = createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': providerId,
    });
    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings,
      sessionContextService: createSessionContextService() as any,
    });
    const result = await manager.run({
      role: 'explorer',
      task: 'find files',
    });

    expect(result.status).toBe('failed');
    expect(result.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 25,
      total_tokens: 40,
    });
  });
});

// ── Redirect safety for scoped web_fetch ──────────────────────────

describe('network tool redirect safety', () => {
  const fetchDefinition: ToolDefinition = {
    name: 'web_fetch',
    description: 'fetch a page',
    parameters: {} as any,
    needsApproval: async () => false,
    execute: async () => 'ok',
    formatCommandMessage: () => [],
  };

  const searchDefinition: ToolDefinition = {
    name: 'web_search',
    description: 'search the web',
    parameters: {} as any,
    needsApproval: async () => false,
    execute: async () => 'ok',
    formatCommandMessage: () => [],
  };

  it('web_fetch with undefined host scope passes through unchanged', async () => {
    const tp = createToolPolicy();
    const wrapped = tp.wrapNetworkToolWithScope(fetchDefinition, undefined, (p: any) => p?.url);
    expect(wrapped).toBe(fetchDefinition);
  });

  it('web_fetch with wildcard host scope is allowed', async () => {
    const tp = createToolPolicy();
    const wrapped = tp.wrapNetworkToolWithScope(fetchDefinition, ['*'], (p: any) => p?.url);
    expect(wrapped).not.toBe(fetchDefinition);
    const result = await wrapped.execute({ url: 'https://example.com' });
    expect(result).toBe('ok');
  });

  it('web_fetch with finite host scope is rejected with typed permission error', async () => {
    const tp = createToolPolicy();
    const wrapped = tp.wrapNetworkToolWithScope(fetchDefinition, ['api.example.com'], (p: any) => p?.url);
    const result = await wrapped.execute({ url: 'https://api.example.com' });
    expect(result).toContain('Error: Permission denied');
    expect(result).toContain('web_fetch cannot be used with finite host scopes');
    expect(result).toContain("hosts: ['*']");
  });

  it('web_search with finite host scope is NOT blocked (no redirects)', async () => {
    const tp = createToolPolicy();
    const wrapped = tp.wrapNetworkToolWithScope(searchDefinition, ['api.example.com'], (p: any) => p?.url);
    expect(wrapped).not.toBe(searchDefinition);
    // web_search has no extractable URL for query-only calls; requires wildcard
    const result = await wrapped.execute({ query: 'test' });
    expect(result).toContain("requires the '*' wildcard");
  });

  it('web_search with finite host scope and URL param validates host', async () => {
    const tp = createToolPolicy();
    const wrapped = tp.wrapNetworkToolWithScope(searchDefinition, ['api.example.com'], (p: any) => p?.url);
    const result = await wrapped.execute({ url: 'https://other.example.com' });
    expect(result).toContain('not in the allowed network hosts');
  });

  it('empty host patterns deny all network access for both tools', async () => {
    const tp = createToolPolicy();
    const wrappedFetch = tp.wrapNetworkToolWithScope(fetchDefinition, [], (p: any) => p?.url);
    const result = await wrappedFetch.execute({ url: 'https://example.com' });
    expect(result).toContain('no allowed hosts configured');

    const wrappedSearch = tp.wrapNetworkToolWithScope(searchDefinition, [], (p: any) => p?.url);
    const result2 = await wrappedSearch.execute({ query: 'test' });
    expect(result2).toContain('no allowed hosts configured');
  });
});
