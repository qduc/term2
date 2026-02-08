import test from 'ava';
import { Writable } from 'node:stream';
import { runWithSession } from './non-interactive.js';

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
  t.is(stderr.getOutput(), '');
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
