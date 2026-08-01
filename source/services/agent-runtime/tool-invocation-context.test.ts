import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApprovalLedger } from './tool-invocation-context.js';
import { ApplicationRunLoop } from './application-run-loop.js';
import { wrapNeedsApproval } from '../../lib/tool-invoke.js';
import { replayApprovals } from '../approval/approval-replay.js';
import type { ToolDefinition } from '../../tools/types.js';

describe('ApprovalLedger', () => {
  it('keys records by tool name and scopes decisions to call ids', () => {
    const ledger = new ApprovalLedger();
    expect(ledger.isToolApproved({ toolName: 'shell', callId: 'call-1' })).toBeUndefined();

    ledger.approveTool({ toolName: 'shell', callId: 'call-1' });
    expect(ledger.isToolApproved({ toolName: 'shell', callId: 'call-1' })).toBe(true);
    // A different call of the same tool is still undecided.
    expect(ledger.isToolApproved({ toolName: 'shell', callId: 'call-2' })).toBeUndefined();
    // A different tool is undecided.
    expect(ledger.isToolApproved({ toolName: 'read_file', callId: 'call-1' })).toBeUndefined();
  });

  it('supports blanket approval and rejection with SDK precedence', () => {
    const ledger = new ApprovalLedger();
    ledger.approveTool({ toolName: 'shell', callId: 'call-1' }, { alwaysApprove: true });
    expect(ledger.isToolApproved({ toolName: 'shell', callId: 'any-call' })).toBe(true);

    const rejected = new ApprovalLedger();
    rejected.rejectTool({ toolName: 'shell', callId: 'call-1' }, { alwaysReject: true, message: 'nope' });
    expect(rejected.isToolApproved({ toolName: 'shell', callId: 'any-call' })).toBe(false);
    expect(rejected.getRejectionMessage('shell', 'any-call')).toBe('nope');
  });

  it('keeps per-call rejection messages', () => {
    const ledger = new ApprovalLedger();
    ledger.rejectTool({ toolName: 'shell', callId: 'call-1' }, { message: 'too risky' });
    expect(ledger.isToolApproved({ toolName: 'shell', callId: 'call-1' })).toBe(false);
    expect(ledger.isToolApproved({ toolName: 'shell', callId: 'call-2' })).toBeUndefined();
    expect(ledger.getRejectionMessage('shell', 'call-1')).toBe('too risky');
    expect(ledger.getRejectionMessage('shell', 'call-2')).toBeUndefined();
  });

  it('snapshot replays into a fresh ledger (parent to child)', () => {
    const parent = new ApprovalLedger();
    parent.approveTool({ toolName: 'shell', callId: 'call-1' });
    parent.rejectTool({ toolName: 'grep', callId: 'call-2' }, { message: 'no' });

    const child = new ApprovalLedger();
    const snapshot = parent.snapshot();
    for (const [toolName, record] of Object.entries(snapshot)) {
      if (record.rejected === true || (Array.isArray(record.rejected) && record.rejected.length > 0)) {
        for (const callId of record.rejected === true ? ['__approval_replay_blanket_decision__'] : record.rejected) {
          child.rejectTool({ toolName, callId }, { message: record.messages?.[callId] });
        }
      }
      if (record.approved === true || (Array.isArray(record.approved) && record.approved.length > 0)) {
        for (const callId of record.approved === true ? ['__approval_replay_blanket_decision__'] : record.approved) {
          child.approveTool({ toolName, callId });
        }
      }
    }

    expect(child.isToolApproved({ toolName: 'shell', callId: 'call-1' })).toBe(true);
    expect(child.isToolApproved({ toolName: 'grep', callId: 'call-2' })).toBe(false);
    expect(child.getRejectionMessage('grep', 'call-2')).toBe('no');
    // snapshot is a copy: mutating the child must not leak into the parent.
    child.approveTool({ toolName: 'shell', callId: 'call-9' });
    expect(parent.isToolApproved({ toolName: 'shell', callId: 'call-9' })).toBeUndefined();
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

  it('honors parent approvals replayed into a seeded nested run (F5 pin)', async () => {
    const executed: string[] = [];
    const parentLedger = new ApprovalLedger();
    parentLedger.approveTool({ toolName: 'shell', callId: 'call-1' });

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

    // The parent already approved this exact call: no interruption, no re-prompt.
    expect(stream.interruptions).toHaveLength(0);
    expect(executed).toEqual(['call-1']);
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
