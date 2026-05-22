import test from 'ava';
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

test('streams text_delta events to stdout and appends newline', async (t) => {
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
      t.fail('handleApprovalDecision should not be called');
      return null;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'hi',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  t.is(exitCode, 0);
  t.is(stdout.getOutput(), 'Hello world\n');
  t.is(stderr.getOutput(), 'Hello world\n');
});

test('streams reasoning_delta events to stderr only', async (t) => {
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
      t.fail('handleApprovalDecision should not be called');
      return null;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'hi',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  t.is(exitCode, 0);
  t.is(stdout.getOutput(), 'OK\n');
  t.is(stderr.getOutput(), 'Thinking hardOK\n');
});

test('returns exit code 1 on error event', async (t) => {
  const stdout = createStringWritable();
  const stderr = createStringWritable();

  const session: any = {
    async sendMessage(_prompt: string, { onEvent }: any) {
      onEvent?.({ type: 'error', message: 'boom' });
      throw new Error('boom');
    },
    async handleApprovalDecision() {
      t.fail('handleApprovalDecision should not be called');
      return null;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'hi',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  t.is(exitCode, 1);
  t.is(stdout.getOutput(), '');
  t.true(stderr.getOutput().includes('boom'));
});

test('with autoApprove=true: approves on approval_required', async (t) => {
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

  t.is(exitCode, 0);
  t.deepEqual(calls, [{ answer: 'y', rejectionReason: undefined }]);
  t.true(stderr.getOutput().toLowerCase().includes('auto-approve'));
});

test('with autoApprove=false: rejects on approval_required with explanation', async (t) => {
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

  t.is(exitCode, 0);
  t.deepEqual(calls, [
    {
      answer: 'n',
      rejectionReason: 'Non-interactive mode: use --auto-approve to allow tool execution',
    },
  ]);
  t.is(stdout.getOutput(), '\n');
});

test('writes tool_started and command_message summaries to stderr only', async (t) => {
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
      t.fail('handleApprovalDecision should not be called');
      return null;
    },
  };

  const exitCode = await runWithSession(session, {
    prompt: 'hi',
    autoApprove: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  t.is(exitCode, 0);
  t.is(stdout.getOutput(), 'OK\n');

  const err = stderr.getOutput();
  t.true(err.includes('tool_started'));
  t.true(err.includes('bash'));
  t.true(err.includes('command_message'));
  t.true(err.includes('ls'));
  t.true(err.includes('OK\n'));
});

test('handles multiple consecutive approval rounds', async (t) => {
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
      t.is(answer, 'y');
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

  t.is(exitCode, 0);
  t.is(approvals, 2);
});

test('with autoApprove=true: auto-approves GREEN commands without LLM check', async (t) => {
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

  t.is(exitCode, 0);
  t.deepEqual(calls, [{ answer: 'y', rejectionReason: undefined }]);
});

test('with autoApprove=true: strictly rejects RED commands', async (t) => {
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

  t.is(exitCode, 0);
  t.is(calls.length, 1);
  t.is(calls[0].answer, 'n');
  t.regex(calls[0].rejectionReason ?? '', /RED/);
});

test('createNonInteractiveSessionId returns unique invocation-scoped ids', (t) => {
  const first = createNonInteractiveSessionId();
  const second = createNonInteractiveSessionId();

  t.not(first, second);
  t.true(first.startsWith('non-interactive-'));
  t.true(second.startsWith('non-interactive-'));
});

test('with autoApprove=true: rejects YELLOW command if no auto-approve model configured', async (t) => {
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

  t.is(exitCode, 0);
  t.is(calls.length, 1);
  t.is(calls[0].answer, 'n');
  t.regex(calls[0].rejectionReason ?? '', /YELLOW/);
});

test('with autoApprove=true: uses LLM to evaluate YELLOW commands', async (t) => {
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

  t.is(exitCode, 0);
  t.true(chatCalled);
  t.deepEqual(calls, [{ answer: 'y', rejectionReason: undefined }]);
});
