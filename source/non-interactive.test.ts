import { it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { runWithSession, createNonInteractiveSessionId } from './non-interactive.js';

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

it('streams reasoning_delta events to stderr only', async () => {
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
  expect(stderr.getOutput()).toBe('Thinking hard');
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
  };

  const exitCode = await runWithSession(session, {
    prompt: 'run',
    autoApprove: true,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(0);
  expect(calls).toEqual([{ answer: 'y', rejectionReason: undefined }]);
  expect(stderr.getOutput().toLowerCase().includes('auto-approve')).toBe(true);
});

it('with autoApprove=false: rejects on approval_required with explanation', async () => {
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
          argumentsText: 'echo hi',
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
  expect(stdout.getOutput()).toBe('\n');
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
  expect(err.includes('tool_started')).toBe(true);
  expect(err.includes('subagent_tool_started worker')).toBe(true);
  expect(err.includes('bash')).toBe(true);
  expect(err.includes('command_message')).toBe(true);
  expect(err.includes('ls')).toBe(true);
  expect(err.includes('OK')).toBe(false);
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
