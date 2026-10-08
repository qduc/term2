import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApprovalLedger } from './tool-invocation-context.js';
import { ApplicationRunLoop } from './application-run-loop.js';
import { wrapNeedsApproval } from '../../lib/tool-invoke.js';
import { replayApprovals } from '../approval/approval-replay.js';
import type { ToolDefinition } from '../../tools/types.js';

describe('ApprovalLedger', () => {
  it('keys records by tool name and records one-time decisions per call id', () => {
    const ledger = new ApprovalLedger();
    expect(ledger.snapshot()).toEqual({});

    ledger.approveTool({ toolName: 'shell', callId: 'call-1' });
    expect(ledger.snapshot()).toEqual({ shell: { approved: ['call-1'], rejected: [] } });
    // A one-time decision is a record of that call, never a decision for the tool.
    expect(ledger.blanketDecision('shell')).toBeUndefined();
    expect(ledger.blanketDecision('read_file')).toBeUndefined();
  });

  it('supports blanket approval and rejection', () => {
    const ledger = new ApprovalLedger();
    ledger.approveTool({ toolName: 'shell', callId: 'call-1' }, { alwaysApprove: true });
    expect(ledger.blanketDecision('shell')).toBe(true);

    const rejected = new ApprovalLedger();
    rejected.rejectTool({ toolName: 'shell', callId: 'call-1' }, { alwaysReject: true, message: 'nope' });
    expect(rejected.blanketDecision('shell')).toBe(false);
    expect(rejected.blanketRejectionMessage('shell')).toBe('nope');
  });

  it('recording a one-time decision does not erase a blanket decision for the tool', () => {
    const rejected = new ApprovalLedger();
    rejected.rejectTool({ toolName: 'shell', callId: 'policy' }, { alwaysReject: true, message: 'off' });
    rejected.rejectTool({ toolName: 'shell', callId: 'call-1' }, { message: 'not this one' });
    expect(rejected.blanketDecision('shell')).toBe(false);
    expect(rejected.blanketRejectionMessage('shell')).toBe('off');

    const approved = new ApprovalLedger();
    approved.approveTool({ toolName: 'shell', callId: 'policy' }, { alwaysApprove: true });
    approved.approveTool({ toolName: 'shell', callId: 'call-1' });
    expect(approved.blanketDecision('shell')).toBe(true);
  });

  it('keeps no one-time rejection message: it belongs to the settled call, not the tool', () => {
    const ledger = new ApprovalLedger();
    ledger.rejectTool({ toolName: 'shell', callId: 'call-1' }, { message: 'too risky' });
    expect(ledger.snapshot()).toEqual({ shell: { approved: [], rejected: ['call-1'] } });
    expect(ledger.blanketDecision('shell')).toBeUndefined();
    expect(ledger.blanketRejectionMessage('shell')).toBeUndefined();

    // A later blanket rejection without a message does not pick up the one-time one.
    ledger.rejectTool({ toolName: 'shell', callId: 'call-1' }, { alwaysReject: true });
    expect(ledger.blanketRejectionMessage('shell')).toBeUndefined();
  });

  it('snapshot is a copy that replays its blanket decisions into a fresh ledger (parent to child)', () => {
    const parent = new ApprovalLedger();
    parent.approveTool({ toolName: 'shell', callId: 'call-1' }, { alwaysApprove: true });
    parent.rejectTool({ toolName: 'grep', callId: 'call-2' }, { alwaysReject: true, message: 'no' });
    parent.approveTool({ toolName: 'read_file', callId: 'call-3' });

    const child = new ApprovalLedger();
    replayApprovals(child, parent.snapshot(), { name: 'parent-agent' });

    expect(child.blanketDecision('shell')).toBe(true);
    expect(child.blanketDecision('grep')).toBe(false);
    expect(child.blanketRejectionMessage('grep')).toBe('no');
    expect(child.snapshot().read_file).toBeUndefined();
    // snapshot is a copy: mutating the child must not leak into the parent.
    child.approveTool({ toolName: 'write_file', callId: 'call-9' }, { alwaysApprove: true });
    expect(parent.blanketDecision('write_file')).toBeUndefined();
  });
});

describe('ApplicationRunLoop tool invocation context', () => {
  const probeTool = (
    needsApproval: () => boolean,
    calls: Array<{ context: unknown; approvals?: unknown }>,
  ): ToolDefinition => ({
    name: 'probe',
    description: 'Probe',
    parameters: z.object({}),
    needsApproval,
    execute: (_params, context, _details) => {
      calls.push({ context, approvals: (context as any)?.approvals });
      return 'ran';
    },
    formatCommandMessage: () => [],
  });

  it('delivers the run context from startStream options to tools (F2 pin at the loop)', async () => {
    const calls: Array<{ context: unknown; approvals: unknown }> = [];
    const userContext = { agentId: 'agent-1', filesChanged: ['a.txt'] };
    let first = true;
    const loop = new ApplicationRunLoop({
      resolveModel: async () =>
        first
          ? {
              async *stream() {
                first = false;
                yield { type: 'tool_call', id: 'call-1', name: 'probe', arguments: '{}' };
                yield { type: 'completion', responseId: 'resp-1', output: [] };
              },
            }
          : {
              async *stream() {
                yield {
                  type: 'completion',
                  responseId: 'resp-2',
                  output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
                };
              },
            },
    });
    const stream = loop.startStream(
      {
        name: 'ctx-agent',
        instructions: 'Use the tool.',
        model: 'm',
        tools: [probeTool(() => false, calls)],
      },
      'go',
      { context: userContext },
    );
    await stream.completed;

    expect(calls).toHaveLength(1);
    expect((calls[0].context as any).context).toBe(userContext);
    // The ledger accompanies every invocation and belongs to this run.
    expect((calls[0].approvals as any) instanceof ApprovalLedger).toBe(true);
  });

  it('preserves the context across an approval pause and continuation', async () => {
    const calls: Array<{ context: unknown; approvals?: unknown }> = [];
    const userContext = { agentId: 'agent-2', filesChanged: [] };
    let first = true;
    const loop = new ApplicationRunLoop({
      resolveModel: async () =>
        first
          ? {
              async *stream() {
                first = false;
                yield { type: 'tool_call', id: 'call-approve', name: 'probe', arguments: '{}' };
                yield { type: 'completion', responseId: 'resp-1', output: [] };
              },
            }
          : {
              async *stream() {
                yield {
                  type: 'completion',
                  responseId: 'resp-2',
                  output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
                };
              },
            },
    });
    const stream = loop.startStream(
      {
        name: 'ctx-agent',
        instructions: 'Use the tool.',
        model: 'm',
        tools: [probeTool(() => true, calls)],
      },
      'go',
      { context: userContext },
    );
    await stream.completed;
    expect(stream.interruptions).toHaveLength(1);

    const handle = stream.state!;
    handle.approve?.(stream.interruptions![0]);
    const resumed = loop.continueRunStream(handle);
    await resumed.completed;

    expect(calls).toHaveLength(1);
    expect((calls[0].context as any).context).toBe(userContext);
  });

  it.each([
    ['a blanket parent approval', true],
    ['a per-call parent approval of a different call that shares the id', false],
  ])('replays parent approvals into a seeded nested run (F5 pin): %s', async (_case, blanket) => {
    const executed: string[] = [];
    const parentLedger = new ApprovalLedger();
    // A blanket ("always allow") decision belongs to the tool and carries into
    // the child. A per-call decision belongs to the parent's call: the child's
    // provider numbers its own calls, so a matching id is a different call and
    // must prompt again.
    parentLedger.approveTool({ toolName: 'shell', callId: 'call-1' }, { alwaysApprove: blanket });

    // runAsTool replays the parent's snapshot into the nested run's ledger,
    // which it passes to the nested loop via the options seed.
    const nestedLedger = new ApprovalLedger();
    replayApprovals(nestedLedger, parentLedger.snapshot(), { name: 'parent-agent' });

    let first = true;
    const loop = new ApplicationRunLoop({
      resolveModel: async () => ({
        async *stream() {
          if (first) {
            first = false;
            yield { type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{"command":"ls"}' };
            yield { type: 'completion', responseId: 'resp-1', output: [] };
          } else {
            yield {
              type: 'completion',
              responseId: 'resp-2',
              output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
            };
          }
        },
      }),
    });
    const stream = loop.startStream(
      {
        name: 'nested-agent',
        instructions: 'Run the tool.',
        model: 'm',
        tools: [
          {
            name: 'shell',
            description: 'Shell',
            parameters: z.object({ command: z.string() }),
            needsApproval: () => true,
            execute: (_p, _c, details) => {
              executed.push((details as any)?.toolCall?.callId ?? '?');
              return 'ran';
            },
            formatCommandMessage: () => [],
          },
        ],
      },
      'go',
      { approvals: nestedLedger },
    );
    await stream.completed;

    if (blanket) {
      expect(stream.interruptions).toHaveLength(0);
      expect(executed).toEqual(['call-1']);
    } else {
      expect(stream.interruptions).toHaveLength(1);
      expect(executed).toEqual([]);
    }
  });

  it('records an approved decision and executes the same call without re-prompting (F5 mechanism at the loop)', async () => {
    const executed: string[] = [];
    let first = true;
    const loop = new ApplicationRunLoop({
      resolveModel: async () =>
        first
          ? {
              async *stream() {
                first = false;
                yield { type: 'tool_call', id: 'call-approve', name: 'probe', arguments: '{}' };
                yield { type: 'completion', responseId: 'resp-1', output: [] };
              },
            }
          : {
              async *stream() {
                yield {
                  type: 'completion',
                  responseId: 'resp-2',
                  output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
                };
              },
            },
    });
    const stream = loop.startStream(
      {
        name: 'ctx-agent',
        instructions: 'Use the tool.',
        model: 'm',
        tools: [
          {
            name: 'probe',
            description: 'Probe',
            parameters: z.object({}),
            needsApproval: () => true,
            execute: (_p, _c, details) => {
              executed.push((details as any)?.toolCall?.callId ?? '?');
              return 'ran';
            },
            formatCommandMessage: () => [],
          },
        ],
      },
      'go',
    );
    await stream.completed;
    expect(stream.interruptions).toHaveLength(1);
    expect(executed).toEqual([]);

    stream.state!.approve?.(stream.interruptions![0]);
    const resumed = loop.continueRunStream(stream.state!);
    await resumed.completed;
    expect(executed).toEqual(['call-approve']);
    expect(resumed.interruptions ?? []).toHaveLength(0);
  });
});

describe('wrapNeedsApproval argument order', () => {
  it('raises an interruption when the wrapped tool needs approval (regression: SDK (context, args) order silently suppressed approvals)', async () => {
    const original: ToolDefinition = {
      name: 'probe',
      description: 'Probe',
      parameters: z.object({ command: z.string() }),
      needsApproval: () => true,
      execute: () => 'ran',
      formatCommandMessage: () => [],
    };
    const wrapped: ToolDefinition = {
      ...original,
      needsApproval: wrapNeedsApproval(original as any),
    };
    let calls = 0;
    const loop = new ApplicationRunLoop({
      resolveModel: async () =>
        calls++ === 0
          ? {
              async *stream() {
                yield { type: 'tool_call', id: 'call-probe', name: 'probe', arguments: '{"command":"ls"}' };
                yield { type: 'completion', responseId: 'resp-1', output: [] };
              },
            }
          : {
              async *stream() {
                yield {
                  type: 'completion',
                  responseId: 'resp-2',
                  output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
                };
              },
            },
    });
    const stream = loop.startStream(
      {
        name: 'probe-agent',
        instructions: 'Use the tool.',
        model: 'm',
        tools: [wrapped],
      },
      'go',
    );
    await stream.completed;
    expect(stream.interruptions).toHaveLength(1);
  });
});
