import { it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { runNonInteractive, runWithSession, createNonInteractiveSessionId } from './non-interactive.js';
import { MockStream, createMockStream } from './services/test-helpers/mock-stream.js';
import { ToolOwnershipRegistry } from './services/approval/tool-ownership-registry.js';
import { AgentClient } from './lib/agent-client.js';
import { registerProvider, unregisterProvider } from './providers/registry.js';
import { z } from 'zod';

const createStringWritable = () => {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      callback();
    },
  });

  return {
    stream,
    getOutput: () => output,
  };
};

const createNoopLogger = () => ({
  info() {},
  warn() {},
  error() {},
  debug() {},
  security() {},
  getCorrelationId() {
    return undefined;
  },
  setCorrelationId() {},
  clearCorrelationId() {},
});

it('streams text_delta events to stdout and appends newline', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();

  const session: any = {
    async sendMessage(_prompt: string, { onEvent }: any) {
      onEvent?.({ type: 'text_delta', delta: 'Hello' });
      onEvent?.({ type: 'text_delta', delta: ' world' });
      onEvent?.({ type: 'final', finalText: 'Hello world' });
      return { type: 'response', finalText: 'Hello world', commandMessages: [] };
    },
    async handleApprovalDecision() {
      expect(true).toBe(false);
      return null;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'hi',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(0);
  expect(stdout.getOutput()).toBe('Hello world\n');
  expect(stderr.getOutput()).toBe('');
});

it('writes finalText to stdout when no text_delta events were streamed', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();

  const session: any = {
    async sendMessage(_prompt: string, { onEvent }: any) {
      onEvent?.({ type: 'final', finalText: 'Done.' });
      return { type: 'response', finalText: 'Done.', commandMessages: [] };
    },
    async handleApprovalDecision() {
      expect(true).toBe(false);
      return null;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'hi',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(0);
  expect(stdout.getOutput()).toBe('Done.\n');
  expect(stderr.getOutput()).toBe('');
});

it('uses a persistent event sink when the session supports one', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();

  const setEventSinkCalls: Array<((event: any) => void) | null> = [];
  let sink: ((event: any) => void) | null = null;

  const session: any = {
    setEventSink(next: ((event: any) => void) | null) {
      setEventSinkCalls.push(next);
      sink = next;
    },
    async sendMessage(_prompt: string) {
      sink?.({ type: 'text_delta', delta: 'Hello' });
      sink?.({ type: 'final', finalText: 'Hello' });
      return { type: 'response', finalText: 'Hello', commandMessages: [] };
    },
    async handleApprovalDecision() {
      expect(true).toBe(false);
      return null;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'hi',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(0);
  expect(stdout.getOutput()).toBe('Hello\n');
  expect(stderr.getOutput()).toBe('');
  expect(setEventSinkCalls.length).toBeGreaterThanOrEqual(2);
  expect(typeof setEventSinkCalls[0]).toBe('function');
  expect(setEventSinkCalls[setEventSinkCalls.length - 1]).toBeNull();
});

it('suppresses reasoning_delta events by default but streams them when showReasoning=true', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();

  const session: any = {
    async sendMessage(_prompt: string, { onEvent }: any) {
      onEvent?.({ type: 'reasoning_delta', delta: 'Thinking' });
      onEvent?.({ type: 'reasoning_delta', delta: ' hard' });
      onEvent?.({ type: 'text_delta', delta: 'OK' });
      return { type: 'response', finalText: 'OK', commandMessages: [] };
    },
    async handleApprovalDecision() {
      expect(true).toBe(false);
      return null;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'hi',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(0);
  expect(stdout.getOutput()).toBe('OK\n');
  expect(stderr.getOutput()).toBe('');

  const stdout2 = createStringWritable();
  const stderr2 = createStringWritable();
  const exitCode2 = await runWithSession(session, {
    prompt: 'hi',
    autoApprove: false,
    showReasoning: true,
    stdout: stdout2.stream,
    stderr: stderr2.stream,
  });

  expect(exitCode2).toBe(0);
  expect(stdout2.getOutput()).toBe('OK\n');
  expect(stderr2.getOutput()).toBe('Thinking hard');
});

it('returns exit code 1 on error event', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();

  const session: any = {
    async sendMessage(_prompt: string, { onEvent }: any) {
      onEvent?.({ type: 'error', message: 'boom' });
      throw new Error('boom');
    },
    async handleApprovalDecision() {
      expect(true).toBe(false);
      return null;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'hi',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(1);
  expect(stdout.getOutput()).toBe('');
  expect(stderr.getOutput().includes('boom')).toBe(true);
});

it('with autoApprove=true: approves on approval_required', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();

  const calls: any[] = [];
  let exportStateCalls = 0;

  const session: any = {
    async sendMessage(_prompt: string) {
      return {
        type: 'approval_required',
        approval: {
          agentName: 'CLI Agent',
          toolName: 'apply_patch',
          argumentsText: '{"patch":"..."}',
        },
      };
    },
    async handleApprovalDecision(answer: string, rejectionReason?: string) {
      calls.push({ answer, rejectionReason });
      return { type: 'response', finalText: 'done', commandMessages: [] };
    },
    exportState() {
      exportStateCalls += 1;
      return { history: [] };
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'run',
    autoApprove: true,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(0);
  expect(calls).toEqual([{ answer: 'y', rejectionReason: undefined }]);
  expect(exportStateCalls).toBe(0);
  expect(stderr.getOutput()).toBe('');
});

it('with autoApprove=false: rejects on approval_required with explanation', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();

  const calls: any[] = [];
  let exportStateCalls = 0;

  const session: any = {
    async sendMessage(_prompt: string) {
      return {
        type: 'approval_required',
        approval: {
          agentName: 'CLI Agent',
          toolName: 'bash',
          argumentsText: 'echo hi',
        },
      };
    },
    async handleApprovalDecision(answer: string, rejectionReason?: string) {
      calls.push({ answer, rejectionReason });
      return { type: 'response', finalText: 'done', commandMessages: [] };
    },
    exportState() {
      exportStateCalls += 1;
      return { history: [] };
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'run',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(0);
  expect(calls).toEqual([
    {
      answer: 'n',
      rejectionReason: 'Non-interactive mode: use --auto-approve to allow tool execution',
    },
  ]);
  expect(exportStateCalls).toBe(0);
  expect(stdout.getOutput()).toBe('\n');
  expect(stderr.getOutput()).toBe('');
});

it('writes parent and subagent tool summaries to stderr only', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();

  const session: any = {
    async sendMessage(_prompt: string, { onEvent }: any) {
      onEvent?.({
        type: 'tool_started',
        toolCallId: 'call-1',
        toolName: 'bash',
        arguments: { command: 'ls' },
      });
      onEvent?.({
        type: 'subagent_tool_started',
        agentId: 'worker-1',
        role: 'worker',
        toolCallId: 'nested-call-1',
        toolName: 'bash',
        arguments: { command: 'pwd' },
      });
      onEvent?.({
        type: 'command_message',
        message: {
          id: 'cmd-1',
          sender: 'command',
          status: 'running',
          command: 'ls',
          output: '',
        },
      });
      onEvent?.({ type: 'text_delta', delta: 'OK' });
      return { type: 'response', finalText: 'OK', commandMessages: [] };
    },
    async handleApprovalDecision() {
      expect(true).toBe(false);
      return null;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'hi',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(0);
  expect(stdout.getOutput()).toBe('OK\n');

  const err = stderr.getOutput();
  expect(err).toContain('[tool] bash: ls');
  expect(err).toContain('[subagent: worker] bash: pwd');
  expect(err.includes('command_message')).toBe(false);
  expect(err.includes('OK')).toBe(false);
});

it('suppresses tool summaries on stderr when quiet=true', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();

  const session: any = {
    async sendMessage(_prompt: string, { onEvent }: any) {
      onEvent?.({
        type: 'tool_started',
        toolCallId: 'call-1',
        toolName: 'bash',
        arguments: { command: 'ls' },
      });
      onEvent?.({ type: 'text_delta', delta: 'OK' });
      return { type: 'response', finalText: 'OK', commandMessages: [] };
    },
    async handleApprovalDecision() {
      return null;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'hi',
    autoApprove: false,
    quiet: true,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(0);
  expect(stdout.getOutput()).toBe('OK\n');
  expect(stderr.getOutput()).toBe('');
});

it('handles multiple consecutive approval rounds', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();

  let approvals = 0;
  const session: any = {
    async sendMessage(_prompt: string) {
      return {
        type: 'approval_required',
        approval: {
          agentName: 'CLI Agent',
          toolName: 'bash',
          argumentsText: 'do thing',
        },
      };
    },
    async handleApprovalDecision(answer: string) {
      expect(answer).toBe('y');
      approvals++;
      if (approvals === 1) {
        return {
          type: 'approval_required',
          approval: {
            agentName: 'CLI Agent',
            toolName: 'bash',
            argumentsText: 'do second thing',
          },
        };
      }
      return { type: 'response', finalText: 'done', commandMessages: [] };
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'run',
    autoApprove: true,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(0);
  expect(approvals).toBe(2);
});

it('with autoApprove=true: auto-approves GREEN commands without LLM check', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();
  const calls: any[] = [];

  const session: any = {
    async sendMessage(_prompt: string) {
      return {
        type: 'approval_required',
        approval: {
          agentName: 'CLI Agent',
          toolName: 'bash',
          argumentsText: 'ls -la',
        },
      };
    },
    async handleApprovalDecision(answer: string, rejectionReason?: string) {
      calls.push({ answer, rejectionReason });
      return { type: 'response', finalText: 'done', commandMessages: [] };
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'run',
    autoApprove: true,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(0);
  expect(calls).toEqual([{ answer: 'y', rejectionReason: undefined }]);
});

it('with autoApprove=true: strictly rejects RED commands', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();
  const calls: any[] = [];

  const session: any = {
    async sendMessage(_prompt: string) {
      return {
        type: 'approval_required',
        approval: {
          agentName: 'CLI Agent',
          toolName: 'bash',
          argumentsText: 'rm -rf /',
        },
      };
    },
    async handleApprovalDecision(answer: string, rejectionReason?: string) {
      calls.push({ answer, rejectionReason });
      return { type: 'response', finalText: 'done', commandMessages: [] };
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'run',
    autoApprove: true,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(0);
  expect(calls.length).toBe(1);
  expect(calls[0].answer).toBe('n');
  expect(calls[0].rejectionReason ?? '').toMatch(/RED/);
});

it('createNonInteractiveSessionId returns unique invocation-scoped ids', () => {
  const first = createNonInteractiveSessionId();
  const second = createNonInteractiveSessionId();

  expect(first).not.toBe(second);
  expect(first.startsWith('non-interactive-')).toBe(true);
  expect(second.startsWith('non-interactive-')).toBe(true);
});

it('with autoApprove=true: rejects YELLOW command if no auto-approve model configured', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();
  const calls: any[] = [];

  const session: any = {
    async sendMessage(_prompt: string) {
      return {
        type: 'approval_required',
        approval: {
          agentName: 'CLI Agent',
          toolName: 'bash',
          argumentsText: 'npm install',
        },
      };
    },
    async handleApprovalDecision(answer: string, rejectionReason?: string) {
      calls.push({ answer, rejectionReason });
      return { type: 'response', finalText: 'done', commandMessages: [] };
    },
  };

  const settingsService: any = {
    get(key: string) {
      if (key === 'agent.autoApproveModel') return undefined;
      return undefined;
    },
    getDynamic() {
      return undefined;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'run',
    autoApprove: true,
    stdout: stdout.stream,
    stderr: stderr.stream,
    settingsService,
  });

  expect(exitCode).toBe(0);
  expect(calls.length).toBe(1);
  expect(calls[0].answer).toBe('n');
  expect(calls[0].rejectionReason ?? '').toMatch(/YELLOW/);
});

it('with autoApprove=true: exits without continuing when configured YELLOW history export fails', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();
  let continuationCalls = 0;
  let chatCalls = 0;

  const session: any = {
    async sendMessage(_prompt: string) {
      return {
        type: 'approval_required',
        approval: {
          agentName: 'CLI Agent',
          toolName: 'bash',
          argumentsText: 'npm install',
          callId: 'call-yellow-history-error',
        },
      };
    },
    async handleApprovalDecision() {
      continuationCalls += 1;
      return { type: 'response', finalText: 'done', commandMessages: [] };
    },
    exportState() {
      throw new Error('history unavailable');
    },
  };

  const settingsService: any = {
    get(key: string) {
      if (key === 'agent.autoApproveModel') return 'gpt-4o-mini';
      return undefined;
    },
    getDynamic() {
      return undefined;
    },
  };
  const agentClient: any = {
    async chat() {
      chatCalls += 1;
      return '{"results":[{"approved":true,"reasoning":"safe"}]}';
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'run',
    autoApprove: true,
    stdout: stdout.stream,
    stderr: stderr.stream,
    settingsService,
    agentClient,
  });

  expect(exitCode).toBe(1);
  expect(continuationCalls).toBe(0);
  expect(chatCalls).toBe(0);
  expect(stderr.getOutput()).toContain('error history unavailable');
});

it('with autoApprove=true: uses LLM to evaluate YELLOW commands', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();
  const calls: any[] = [];

  const session: any = {
    async sendMessage(_prompt: string) {
      return {
        type: 'approval_required',
        approval: {
          agentName: 'CLI Agent',
          toolName: 'bash',
          argumentsText: 'npm install',
          callId: 'call-yellow-1',
        },
      };
    },
    async handleApprovalDecision(answer: string, rejectionReason?: string) {
      calls.push({ answer, rejectionReason });
      return { type: 'response', finalText: 'done', commandMessages: [] };
    },
    exportState() {
      return { history: [] };
    },
  };

  const settingsService: any = {
    get(key: string) {
      if (key === 'agent.autoApproveModel') return 'gpt-4o-mini';
      return undefined;
    },
    getDynamic(key: string) {
      if (key === 'agent.autoApproveModel') return 'gpt-4o-mini';
      return undefined;
    },
  };

  let chatCalled = false;
  const agentClient: any = {
    async chat() {
      chatCalled = true;
      return '{ "results": [ { "approved": true, "reasoning": "Safe command" } ] }';
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'run',
    autoApprove: true,
    stdout: stdout.stream,
    stderr: stderr.stream,
    settingsService,
    agentClient,
  });

  expect(exitCode).toBe(0);
  expect(chatCalled).toBe(true);
  expect(calls).toEqual([{ answer: 'y', rejectionReason: undefined }]);
});

it('runNonInteractive exposes configured provider and model through its session lifecycle', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();
  const lifecycleEvents: any[] = [];
  const logger: any = createNoopLogger();
  const settingsService: any = {
    get(key: string) {
      if (key === 'agent.provider') return 'configured-provider';
      if (key === 'agent.model') return 'configured-model';
      return undefined;
    },
    getDynamic() {
      return undefined;
    },
  };
  const hookLifecycle: any = {
    async emit(event: unknown) {
      lifecycleEvents.push(event);
    },
    async shutdown() {},
  };
  const hookEvents: any = {
    create(type: string, payload: unknown) {
      return { type, ...(payload as object) };
    },
  };

  const exitCode = await runNonInteractive({
    prompt: 'hello',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
    logger,
    settingsService,
    hookLifecycle,
    sessionClientFactory: {
      create() {
        return {
          agentClient: {
            chat: async () => '',
            abort() {},
            setModel() {},
            addToolInterceptor() {
              return () => {};
            },
            startStream: async () => createMockStream([]),
            continueRunStream: async () => createMockStream([]),
          },
          continuationProjectionMode: 'legacy',
          toolOwnership: new ToolOwnershipRegistry(),
          hookEvents,
          dispose() {},
        };
      },
    },
  });

  expect(exitCode).toBe(0);
  expect(lifecycleEvents[0]).toMatchObject({
    type: 'session.start',
    mode: 'non-interactive',
    providerName: 'configured-provider',
    modelName: 'configured-model',
  });
});

it('runNonInteractive prefixes Plan Mode workflow onto the first turn when planMode is already on', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();
  const streamInputs: unknown[] = [];
  const logger: any = createNoopLogger();
  const settingsService: any = {
    get(key: string) {
      if (key === 'app.planMode') return true;
      return undefined;
    },
    getDynamic() {
      return undefined;
    },
  };

  const exitCode = await runNonInteractive({
    prompt: 'plan the auth refactor',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
    logger,
    settingsService,
    sessionClientFactory: {
      create() {
        return {
          agentClient: {
            chat: async () => '',
            abort() {},
            setModel() {},
            addToolInterceptor() {
              return () => {};
            },
            startStream: async (input: unknown) => {
              streamInputs.push(input);
              return createMockStream([]);
            },
            continueRunStream: async () => createMockStream([]),
          },
          continuationProjectionMode: 'legacy',
          toolOwnership: new ToolOwnershipRegistry(),
          dispose() {},
        };
      },
    },
  });

  expect(exitCode).toBe(0);
  expect(JSON.stringify(streamInputs)).toContain('plan the auth refactor');
  expect(JSON.stringify(streamInputs)).toContain('Plan Mode Workflow');
  expect(JSON.stringify(streamInputs)).toContain('You are currently in **Plan Mode**');
});

it('runNonInteractive() disposes its factory-owned client after the runtime', async () => {
  const disposed: string[] = [];
  const createOptions: unknown[] = [];
  const toolInterceptors: Array<(name: string, params: unknown) => Promise<string | null>> = [];
  let removedInterceptors = 0;
  const stdout = createStringWritable();
  const stderr = createStringWritable();
  const logger: any = createNoopLogger();
  const settingsService: any = {
    get() {
      return undefined;
    },
    getDynamic() {
      return undefined;
    },
  };

  const exitCode = await runNonInteractive({
    prompt: 'hello',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
    logger,
    settingsService,
    sessionClientFactory: {
      create(_sessionId, options) {
        createOptions.push(options);
        const agentClient: any = {
          chat: async () => '',
          abort() {},
          setModel() {},
          addToolInterceptor(interceptor: (name: string, params: unknown) => Promise<string | null>) {
            toolInterceptors.push(interceptor);
            return () => {
              removedInterceptors += 1;
            };
          },
          startStream: async () => new MockStream([]),
          continueRunStream: async () => new MockStream([]),
        };
        return {
          agentClient,
          continuationProjectionMode: 'legacy',
          toolOwnership: new ToolOwnershipRegistry(),
          dispose: () => disposed.push('client'),
        };
      },
    },
  });

  expect(stderr.getOutput()).toBe('');
  expect(exitCode).toBe(0);
  expect(createOptions).toEqual([{ allowBackgroundShell: false, allowAskUser: false }]);
  expect(await toolInterceptors[0]?.('shell', { command: 'safe', background: true })).toBe(
    'Error: Background shell execution is unavailable in non-interactive mode.',
  );
  expect(await toolInterceptors[0]?.('ask_user', { questions: [{ question: 'why?' }] })).toBe(
    'Error: ask_user is unavailable in non-interactive mode.',
  );
  expect(await toolInterceptors[0]?.('shell', { command: 'safe' })).toBeNull();
  expect(removedInterceptors).toBe(1);
  expect(disposed).toEqual(['client']);
});

it('runNonInteractive() blocks background shell and ask_user execution for caller-owned clients only', async () => {
  const toolInterceptors: Array<(name: string, params: unknown) => Promise<string | null>> = [];
  let removedInterceptors = 0;
  const stdout = createStringWritable();
  const stderr = createStringWritable();
  const logger: any = createNoopLogger();
  const settingsService: any = {
    get() {
      return undefined;
    },
    getDynamic() {
      return undefined;
    },
  };
  const agentClient: any = {
    chat: async () => '',
    abort() {},
    setModel() {},
    addToolInterceptor(interceptor: (name: string, params: unknown) => Promise<string | null>) {
      toolInterceptors.push(interceptor);
      return () => {
        removedInterceptors += 1;
      };
    },
    startStream: async () => new MockStream([]),
    continueRunStream: async () => new MockStream([]),
  };

  const exitCode = await runNonInteractive({
    prompt: 'hello',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
    logger,
    settingsService,
    agentClient,
    toolOwnership: new ToolOwnershipRegistry(),
  });

  expect(exitCode).toBe(0);
  expect(await toolInterceptors[0]?.('shell', { command: 'safe', background: true })).toBe(
    'Error: Background shell execution is unavailable in non-interactive mode.',
  );
  expect(await toolInterceptors[0]?.('run_subagent_async', { role: 'explorer', task: 'search' })).toBe(
    'Error: Asynchronous subagent execution is unavailable in non-interactive mode. Use synchronous run_subagent instead.',
  );
  expect(await toolInterceptors[0]?.('ask_user', { questions: [{ question: 'why?' }] })).toBe(
    'Error: ask_user is unavailable in non-interactive mode.',
  );
  expect(await toolInterceptors[0]?.('shell', { command: 'safe' })).toBeNull();
  expect(removedInterceptors).toBe(1);
});

it('runNonInteractive auto-approves only the finite parent run-budget extensions', async () => {
  const provider = 'non-interactive-run-budget-boundary';
  const stdout = createStringWritable();
  const stderr = createStringWritable();
  const toolOwnership = new ToolOwnershipRegistry();
  const requests: unknown[] = [];
  let toolExecutions = 0;
  const logger: any = createNoopLogger();
  const values: Record<string, unknown> = {
    'agent.provider': provider,
    'agent.model': 'budget-model',
    'agent.retryAttempts': 0,
    'agent.reasoningEffort': 'default',
    'agent.maxParallelToolCalls': 1,
    'agent.contextCompaction.enabled': false,
    'agent.runBudget.maxUsdMicros': 1_000_000,
    'agent.runBudget.maxUnpricedTokens': 1_000_000,
    'agent.runBudget.maxActiveTimeMs': 1_000_000,
    'agent.runBudget.warningHeadroomUsdMicros': 0,
    'agent.runBudget.warningHeadroomUnpricedTokens': 0,
    'agent.runBudget.warningHeadroomActiveTimeMs': 0,
    'agent.runBudget.softHeadroomUsdMicros': 0,
    'agent.runBudget.softHeadroomUnpricedTokens': 0,
    'agent.runBudget.softHeadroomActiveTimeMs': 0,
    'agent.runBudget.turnBackstop': 1,
    'agent.runBudget.escalation': 'pause',
    'agent.runBudget.extensionPercent': 100,
    'agent.runBudget.maxParentExtensions': 2,
    'agent.runBudget.identicalToolCallThreshold': 10,
  };
  const settingsService: any = {
    get(key: string) {
      return values[key];
    },
    getDynamic(key: string) {
      return values[key];
    },
    set(key: string, value: unknown) {
      values[key] = value;
    },
    setDynamic(key: string, value: unknown) {
      values[key] = value;
    },
    setPersistent(key: string, value: unknown) {
      values[key] = value;
    },
    setPersistentDynamic(key: string, value: unknown) {
      values[key] = value;
    },
  };
  const sessionContextService: any = {
    runWithContext(_context: unknown, fn: () => unknown) {
      return fn();
    },
    getContext() {
      return null;
    },
  };

  unregisterProvider(provider);
  registerProvider({
    id: provider,
    label: 'Non-interactive run-budget test provider',
    createStreamedModel: () => ({
      async *stream(request: unknown) {
        requests.push(request);
        const call = requests.length;
        yield { type: 'tool_call' as const, id: `call-${call}`, name: 'read_file', arguments: '{"path":"test"}' };
        yield { type: 'completion' as const, responseId: `response-${call}`, output: [] };
      },
    }),
    fetchModels: async () => [],
  });

  const agentClient = new AgentClient({
    maxTurns: 100,
    agentOverride: {
      name: 'budget-test',
      model: 'budget-model',
      instructions: 'test',
      tools: [
        {
          name: 'read_file',
          description: 'read',
          parameters: z.object({ path: z.string() }),
          needsApproval: () => false,
          execute: () => {
            toolExecutions += 1;
            return 'ok';
          },
          formatCommandMessage: () => [],
        },
      ],
    },
    deps: { logger, settings: settingsService, sessionContextService },
    toolOwnership,
  });

  try {
    const exitCode = await runNonInteractive({
      prompt: 'continue until the budget stops you',
      autoApprove: true,
      stdout: stdout.stream,
      stderr: stderr.stream,
      logger,
      settingsService,
      sessionContextService,
      sessionClientFactory: {
        create() {
          return {
            agentClient,
            continuationProjectionMode: 'legacy',
            toolOwnership,
            dispose: () => agentClient.dispose(),
          };
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(toolExecutions).toBe(3);
    expect(requests).toHaveLength(3);
    expect(stdout.getOutput()).toBe('Done.\n');
    expect(stderr.getOutput()).toContain('[tool] read_file');
    expect(stderr.getOutput()).not.toContain('--auto-approve enabled');
  } finally {
    unregisterProvider(provider);
  }
});

it('returns non-zero and prints the hard-fit diagnostic when local compaction cannot fit', async () => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();
  const error = Object.assign(
    new Error('The protected recent conversation is too large to fit the configured context window'),
    {
      code: 'context_compaction_hard_fit',
    },
  );
  const session: any = {
    async sendMessage() {
      throw error;
    },
    async handleApprovalDecision() {
      return null;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'oversized prompt',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(1);
  expect(stdout.getOutput()).toBe('');
  expect(stderr.getOutput()).toContain('error The protected recent conversation is too large');
});
