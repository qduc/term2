import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApplicationRunLoop, type ApplicationAgent } from './application-run-loop.js';
import { ApprovalLedger } from './tool-invocation-context.js';
import type { StreamedModelTurn, StreamedModelTurnRequest } from '../../contracts/streamed-model-turn.js';
import type { ToolDefinition } from '../../tools/types.js';

/**
 * An approval authorizes exactly the call the user saw. Call ids are not
 * unique: OpenAI-compatible chat providers that omit ids get `call_${index}`
 * (so the first call of every response is `call_0`), and providers may repeat
 * their own ids. A later call must prompt again whatever its id.
 */

type Step = { text?: string; calls?: Array<{ id: string; args?: Record<string, unknown> }> };

function scripted(steps: Step[]) {
  const requests: StreamedModelTurnRequest[] = [];
  const model: StreamedModelTurn = {
    async *stream(request) {
      requests.push(request);
      const step = steps[requests.length - 1] ?? { text: 'script exhausted' };
      yield {
        type: 'completion',
        responseId: `response-${requests.length}`,
        output: [
          ...(step.text ? [{ type: 'message' as const, content: [{ type: 'text' as const, text: step.text }] }] : []),
          ...(step.calls ?? []).map((call) => ({
            type: 'tool_call' as const,
            id: call.id,
            name: 'danger',
            arguments: JSON.stringify(call.args ?? { target: 'a' }),
          })),
        ],
      };
    },
  };
  return { model, requests };
}

function setup(steps: Step[], approvals?: ApprovalLedger) {
  const executed: string[] = [];
  const danger: ToolDefinition = {
    name: 'danger',
    description: 'Approval-gated side effect.',
    parameters: z.object({ target: z.string() }),
    needsApproval: () => true,
    execute: (params) => {
      const { target } = params as { target: string };
      executed.push(target);
      return `ran ${target}`;
    },
    formatCommandMessage: () => [],
  };
  const agent: ApplicationAgent = { name: 'root', instructions: 'test', model: 'test-model', tools: [danger] };
  const { model, requests } = scripted(steps);
  const loop = new ApplicationRunLoop({ resolveModel: () => model });
  const start = () => loop.startStream(agent, 'go', approvals ? { approvals } : {});
  return { loop, start, executed, requests };
}

const resultsFor = (history: readonly unknown[]) =>
  history.filter((item: any) => item.type === 'function_call_result').map((item: any) => item.output);

describe('approval binds to the exact call instance', () => {
  it.each([
    ['the call_${index} fallback id', 'call_0'],
    ['a provider-supplied id the provider repeats', 'toolu_repeated'],
  ])('a later call reusing %s prompts again after the first was approved', async (_case, id) => {
    const t = setup([
      { calls: [{ id, args: { target: 'first' } }] },
      { calls: [{ id, args: { target: 'second' } }] },
      { text: 'done' },
    ]);

    const first = t.start();
    await first.completed;
    expect(first.interruptions).toHaveLength(1);
    (first.state as any).approve(first.interruptions![0]);

    const second = t.loop.continueRunStream(first.state!);
    await second.completed;

    // The second call is a new call: it must be presented, not inherited.
    expect(t.requests).toHaveLength(2);
    expect(second.interruptions).toHaveLength(1);
    expect(second.interruptions![0]).toMatchObject({ callId: id, arguments: JSON.stringify({ target: 'second' }) });
    expect(t.executed).toEqual(['first']);

    (second.state as any).approve(second.interruptions![0]);
    const third = t.loop.continueRunStream(second.state!);
    await third.completed;

    expect(t.executed).toEqual(['first', 'second']);
    expect(third.finalOutput).toBe('done');
    expect(resultsFor(third.history)).toEqual(['ran first', 'ran second']);
  });

  it('repro (a): approving `ls` as call_0 does not let a later call_0 `rm -rf build` run', async () => {
    const t = setup([
      { calls: [{ id: 'call_0', args: { target: 'ls' } }] },
      { calls: [{ id: 'call_0', args: { target: 'rm -rf build' } }] },
      { text: 'done' },
    ]);
    const first = t.start();
    await first.completed;
    (first.state as any).approve(first.interruptions![0]);
    const second = t.loop.continueRunStream(first.state!);
    await second.completed;

    expect(t.executed).toEqual(['ls']);
    expect(second.interruptions).toHaveLength(1);
    expect(second.interruptions![0]).toMatchObject({ arguments: JSON.stringify({ target: 'rm -rf build' }) });
  });

  it('repro (b): empty-string ids do not let an approval carry to a later call', async () => {
    const t = setup([
      { calls: [{ id: '', args: { target: 'ls' } }] },
      { calls: [{ id: '', args: { target: 'rm -rf build' } }] },
      { text: 'done' },
    ]);
    const first = t.start();
    await first.completed;
    expect(first.interruptions).toHaveLength(1);
    (first.state as any).approve(first.interruptions![0]);
    const second = t.loop.continueRunStream(first.state!);
    await second.completed;

    expect(t.executed).toEqual(['ls']);
    expect(second.interruptions).toHaveLength(1);
  });

  it('repro (c): approving call_0 and call_1 does not pre-approve the next response call_0 and call_1', async () => {
    const t = setup([
      {
        calls: [
          { id: 'call_0', args: { target: 'one' } },
          { id: 'call_1', args: { target: 'two' } },
        ],
      },
      {
        calls: [
          { id: 'call_0', args: { target: 'three' } },
          { id: 'call_1', args: { target: 'four' } },
        ],
      },
      { text: 'done' },
    ]);
    const first = t.start();
    await first.completed;
    (first.state as any).approve(first.interruptions![0]);
    const second = t.loop.continueRunStream(first.state!);
    await second.completed;
    (second.state as any).approve(second.interruptions![0]);
    const third = t.loop.continueRunStream(second.state!);
    await third.completed;

    expect(t.executed).toEqual(['one', 'two']);
    expect(third.interruptions).toHaveLength(2);
    expect(third.interruptions!.map((item: any) => item.arguments)).toEqual([
      JSON.stringify({ target: 'three' }),
      JSON.stringify({ target: 'four' }),
    ]);
  });

  it('same-call approve and resume runs the approved call exactly once and pairs its result', async () => {
    const t = setup([{ calls: [{ id: 'call_0' }] }, { text: 'done' }]);

    const first = t.start();
    await first.completed;
    expect(first.interruptions).toHaveLength(1);
    expect(t.executed).toEqual([]);
    (first.state as any).approve(first.interruptions![0]);
    const resumed = t.loop.continueRunStream(first.state!);
    await resumed.completed;

    expect(t.executed).toEqual(['a']);
    expect(resumed.finalOutput).toBe('done');
    const history = resumed.history as any[];
    const callIndex = history.findIndex((item) => item.type === 'function_call' && item.callId === 'call_0');
    const resultIndex = history.findIndex((item) => item.type === 'function_call_result' && item.callId === 'call_0');
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(callIndex);
    expect(history[resultIndex].output).toBe('ran a');
  });

  it('repro (d): a rejection blocks only that call, and a later different call_0 prompts again', async () => {
    const t = setup([
      { calls: [{ id: 'call_0', args: { target: 'first' } }] },
      { calls: [{ id: 'call_0', args: { target: 'second' } }] },
      { text: 'done' },
    ]);

    const first = t.start();
    await first.completed;
    (first.state as any).reject(first.interruptions![0], { message: 'Not that one.' });
    const second = t.loop.continueRunStream(first.state!);
    await second.completed;

    expect(t.executed).toEqual([]);
    expect(resultsFor(second.history)).toEqual(['Not that one.']);
    // Not silently rejected on the strength of the earlier decision.
    expect(second.interruptions).toHaveLength(1);
    expect(second.interruptions![0]).toMatchObject({ arguments: JSON.stringify({ target: 'second' }) });

    (second.state as any).approve(second.interruptions![0]);
    const third = t.loop.continueRunStream(second.state!);
    await third.completed;
    expect(t.executed).toEqual(['second']);
  });

  it('two gated calls in one response are approved one at a time, each running once', async () => {
    const t = setup([
      {
        calls: [
          { id: 'call_0', args: { target: 'left' } },
          { id: 'call_1', args: { target: 'right' } },
        ],
      },
      { text: 'done' },
    ]);

    const first = t.start();
    await first.completed;
    expect(first.interruptions).toHaveLength(2);
    (first.state as any).approve(first.interruptions![0]);
    const second = t.loop.continueRunStream(first.state!);
    await second.completed;
    expect(t.executed).toEqual(['left']);
    expect(second.interruptions).toHaveLength(1);
    expect(second.interruptions![0]).toMatchObject({ callId: 'call_1' });

    (second.state as any).approve(second.interruptions![0]);
    const third = t.loop.continueRunStream(second.state!);
    await third.completed;
    expect(t.executed).toEqual(['left', 'right']);
    expect(third.finalOutput).toBe('done');
  });

  it('approving the second interruption first settles that call, not the first pending one', async () => {
    const t = setup([
      {
        calls: [
          { id: 'call_0', args: { target: 'left' } },
          { id: 'call_1', args: { target: 'right' } },
        ],
      },
      { text: 'done' },
    ]);

    const first = t.start();
    await first.completed;
    expect(first.interruptions).toHaveLength(2);
    (first.state as any).approve(first.interruptions![1]);
    const second = t.loop.continueRunStream(first.state!);
    await second.completed;

    // `right` is approved but waits behind `left`, which is still the user's to decide.
    expect(t.executed).toEqual([]);
    expect(second.interruptions).toHaveLength(1);
    expect(second.interruptions![0]).toMatchObject({ callId: 'call_0', arguments: JSON.stringify({ target: 'left' }) });

    (second.state as any).reject(second.interruptions![0], { message: 'Not left.' });
    const third = t.loop.continueRunStream(second.state!);
    await third.completed;
    expect(t.executed).toEqual(['right']);
    expect(resultsFor(third.history)).toEqual(['Not left.', 'ran right']);
    expect(third.finalOutput).toBe('done');
  });

  it('three calls sharing one provider id: approving one settles only that call', async () => {
    const t = setup([
      {
        calls: [
          { id: 'toolu_shared', args: { target: 'a' } },
          { id: 'toolu_shared', args: { target: 'b' } },
          { id: 'toolu_shared', args: { target: 'c' } },
        ],
      },
      { text: 'done' },
    ]);

    const first = t.start();
    await first.completed;
    expect(first.interruptions).toHaveLength(3);
    (first.state as any).approve(first.interruptions![1]);
    const second = t.loop.continueRunStream(first.state!);
    await second.completed;

    // The other two calls with the same id are still the user's to decide.
    expect(t.executed).toEqual([]);
    expect(second.interruptions!.map((item: any) => item.arguments)).toEqual([
      JSON.stringify({ target: 'a' }),
      JSON.stringify({ target: 'c' }),
    ]);

    (second.state as any).reject(second.interruptions![0], { message: 'Not a.' });
    const third = t.loop.continueRunStream(second.state!);
    await third.completed;
    expect(third.interruptions!.map((item: any) => item.arguments)).toEqual([JSON.stringify({ target: 'c' })]);
    (third.state as any).reject(third.interruptions![0], { message: 'Not c.' });
    const fourth = t.loop.continueRunStream(third.state!);
    await fourth.completed;

    expect(t.executed).toEqual(['b']);
    expect(resultsFor(fourth.history)).toEqual(['Not a.', 'ran b', 'Not c.']);
    expect(fourth.finalOutput).toBe('done');
  });

  it('a per-call decision carried into a run (parent replay) does not authorize a different call with the same id', async () => {
    const seeded = new ApprovalLedger();
    seeded.approveTool({ toolName: 'danger', callId: 'call_0' });
    const t = setup([{ calls: [{ id: 'call_0' }] }, { text: 'done' }], seeded);

    const stream = t.start();
    await stream.completed;

    expect(stream.interruptions).toHaveLength(1);
    expect(t.executed).toEqual([]);
  });

  it('blanket decisions still apply to every call of the tool', async () => {
    const always = new ApprovalLedger();
    always.approveTool({ toolName: 'danger', callId: 'any' }, { alwaysApprove: true });
    const approved = setup([{ calls: [{ id: 'call_0' }] }, { calls: [{ id: 'call_0' }] }, { text: 'done' }], always);
    const stream = approved.start();
    await stream.completed;
    expect(stream.interruptions ?? []).toEqual([]);
    expect(approved.executed).toEqual(['a', 'a']);

    const never = new ApprovalLedger();
    never.rejectTool({ toolName: 'danger', callId: 'any' }, { alwaysReject: true, message: 'Blocked by policy.' });
    const rejected = setup([{ calls: [{ id: 'call_0' }] }, { text: 'done' }], never);
    const rejectedStream = rejected.start();
    await rejectedStream.completed;
    expect(rejectedStream.interruptions ?? []).toEqual([]);
    expect(rejected.executed).toEqual([]);
    expect(resultsFor(rejectedStream.history)).toEqual(['Blocked by policy.']);
  });

  it('a blanket rejection gives its own message, never a stale one-time rejection message for the same id', async () => {
    const ledger = new ApprovalLedger();
    const t = setup(
      [
        { calls: [{ id: 'call_0', args: { target: 'first' } }] },
        { calls: [{ id: 'call_0', args: { target: 'second' } }] },
      ],
      ledger,
    );
    const first = t.start();
    await first.completed;
    (first.state as any).reject(first.interruptions![0], { message: 'Not that one.' });
    // The tool is turned off for every call while the run is paused at the next prompt.
    ledger.rejectTool({ toolName: 'danger', callId: 'policy' }, { alwaysReject: true });
    const second = t.loop.continueRunStream(first.state!);
    await second.completed;

    expect(t.executed).toEqual([]);
    expect(second.interruptions ?? []).toEqual([]);
    // The one-time message stays with the call it was given for.
    expect(resultsFor(second.history)).toEqual(['Not that one.', 'Tool execution was not approved.']);
  });

  it('records the approved call in the ledger for the executing call', async () => {
    const ledger = new ApprovalLedger();
    const t = setup([{ calls: [{ id: 'call_0' }] }, { text: 'done' }], ledger);
    const first = t.start();
    await first.completed;
    (first.state as any).approve(first.interruptions![0]);
    await t.loop.continueRunStream(first.state!).completed;

    // A record of the call the decision was made for; it authorizes nothing later.
    expect(ledger.snapshot()).toEqual({ danger: { approved: ['call_0'], rejected: [] } });
    expect(ledger.blanketDecision('danger')).toBeUndefined();
  });
});
