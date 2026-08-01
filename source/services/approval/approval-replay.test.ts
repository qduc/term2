import { describe, it, expect } from 'vitest';
import type { ApplicationAgent } from '../agent-runtime/application-run-loop.js';
import { ApprovalLedger } from '../agent-runtime/tool-invocation-context.js';
import { replayApprovals, type ApprovalRecord } from './approval-replay.js';

const TOOL = 'shell_command';

function createAgent(): ApplicationAgent {
  return { name: 'approval-replay-test-agent', instructions: '', model: 'mock-model', tools: [] };
}

function createApprovalItem(toolName: string, callId: string): any {
  return {
    rawItem: { type: 'function_call', callId, name: toolName, arguments: '{}', status: 'completed' },
    toolName,
    callId,
  };
}

function replayInto(approvals: Record<string, ApprovalRecord>): ApprovalLedger {
  const nested = new ApprovalLedger();
  replayApprovals(nested, approvals, createAgent());
  return nested;
}

/**
 * These first tests are characterization tests: they pin down the SDK contract that
 * `replayApprovals` is built on, so a change to the application approval contract that changes the meaning of
 * `approvals` fails here rather than silently mis-granting approvals across the
 * parent/subagent boundary.
 */
describe('SDK approval-record contract', () => {
  it('keys the approvals record by tool name, not by call id', () => {
    const context = new ApprovalLedger();

    context.approveTool(createApprovalItem(TOOL, 'call_abc'));

    expect(Object.keys(context.snapshot())).toEqual([TOOL]);
  });

  it('records a per-call approval as an array of call ids', () => {
    const context = new ApprovalLedger();

    context.approveTool(createApprovalItem(TOOL, 'call_abc'));

    expect(context.snapshot()[TOOL].approved).toEqual(['call_abc']);
  });

  it('records a blanket approval as the boolean true', () => {
    const context = new ApprovalLedger();

    context.approveTool(createApprovalItem(TOOL, 'call_abc'), { alwaysApprove: true });

    expect(context.snapshot()[TOOL].approved).toBe(true);
  });

  it('grants only the listed call ids when approved is an array', () => {
    const context = new ApprovalLedger();

    context.approveTool(createApprovalItem(TOOL, 'call_abc'));

    expect(context.isToolApproved({ toolName: TOOL, callId: 'call_abc' })).toBe(true);
    expect(context.isToolApproved({ toolName: TOOL, callId: 'call_other' })).toBeUndefined();
  });

  it('grants every call id when approved is true', () => {
    const context = new ApprovalLedger();

    context.approveTool(createApprovalItem(TOOL, 'call_abc'), { alwaysApprove: true });

    expect(context.isToolApproved({ toolName: TOOL, callId: 'never_seen_before' })).toBe(true);
  });
});

describe('replayApprovals', () => {
  it('leaves the nested context untouched when there is nothing to replay', () => {
    const nested = replayInto({});

    expect(nested.snapshot()).toEqual({});
  });

  it('carries a per-call parent approval into the nested context so it does not re-prompt', () => {
    const nested = replayInto({ [TOOL]: { approved: ['call_approved'], rejected: [] } });

    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_approved' })).toBe(true);
  });

  it('does not widen a per-call approval into a blanket approval for the tool', () => {
    const nested = replayInto({ [TOOL]: { approved: ['call_approved'], rejected: [] } });

    // `undefined` means "ask the user" — an unapproved call must still prompt inside the
    // subagent. Replaying `string[]` as `alwaysApprove` would silently return `true` here.
    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_never_approved' })).toBeUndefined();
  });

  it('carries a blanket parent approval into the nested context for unseen call ids', () => {
    const nested = replayInto({ [TOOL]: { approved: true, rejected: [] } });

    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_raised_inside_subagent' })).toBe(true);
  });

  it('carries a per-call parent rejection into the nested context', () => {
    const nested = replayInto({ [TOOL]: { approved: [], rejected: ['call_denied'] } });

    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_denied' })).toBe(false);
  });

  it('does not widen a per-call rejection into a blanket rejection for the tool', () => {
    const nested = replayInto({ [TOOL]: { approved: [], rejected: ['call_denied'] } });

    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_unrelated' })).toBeUndefined();
  });

  it('carries a blanket parent rejection into the nested context for unseen call ids', () => {
    const nested = replayInto({ [TOOL]: { approved: false, rejected: true } });

    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_raised_inside_subagent' })).toBe(false);
  });

  it('preserves the per-call rejection message', () => {
    const nested = replayInto({
      [TOOL]: { approved: [], rejected: ['call_denied'], messages: { call_denied: 'not allowed here' } },
    });

    expect(nested.getRejectionMessage(TOOL, 'call_denied')).toBe('not allowed here');
  });

  it('preserves the sticky rejection message of a blanket rejection', () => {
    const nested = replayInto({
      [TOOL]: { approved: false, rejected: true, stickyRejectMessage: 'this tool is off limits' },
    });

    expect(nested.getRejectionMessage(TOOL, 'any_call_id')).toBe('this tool is off limits');
  });

  it('keeps per-call approvals and rejections of the same tool independent', () => {
    const nested = replayInto({ [TOOL]: { approved: ['call_yes'], rejected: ['call_no'] } });

    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_yes' })).toBe(true);
    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_no' })).toBe(false);
    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_unknown' })).toBeUndefined();
  });

  it('lets a blanket approval outrank per-call rejections, matching isToolApproved precedence', () => {
    const nested = replayInto({ [TOOL]: { approved: true, rejected: ['call_no'] } });

    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_no' })).toBe(true);
  });

  it('lets a blanket rejection outrank per-call approvals, matching isToolApproved precedence', () => {
    const nested = replayInto({ [TOOL]: { approved: ['call_yes'], rejected: true } });

    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_yes' })).toBe(false);
  });

  it('lets a blanket approval outrank a blanket rejection, matching isToolApproved precedence', () => {
    // The SDK resolves this record to `true` (runContext.js#isToolApproved logs and prefers
    // approval), so the replay has to land there too — replaying rejections last would
    // silently flip the answer.
    const nested = replayInto({ [TOOL]: { approved: true, rejected: true } });

    expect(nested.isToolApproved({ toolName: TOOL, callId: 'any_call_id' })).toBe(true);
  });

  it('replays every tool in the record independently', () => {
    const nested = replayInto({
      shell_command: { approved: ['call_a'], rejected: [] },
      write_file: { approved: [], rejected: ['call_b'] },
    });

    expect(nested.isToolApproved({ toolName: 'shell_command', callId: 'call_a' })).toBe(true);
    expect(nested.isToolApproved({ toolName: 'write_file', callId: 'call_b' })).toBe(false);
    expect(nested.isToolApproved({ toolName: 'write_file', callId: 'call_a' })).toBeUndefined();
  });

  it('does not mutate the parent approvals it reads from', () => {
    const parent = new ApprovalLedger();
    parent.approveTool(createApprovalItem(TOOL, 'call_abc'));
    const before = structuredClone(parent.snapshot());

    replayApprovals(new ApprovalLedger(), parent.snapshot(), createAgent());

    expect(parent.snapshot()).toEqual(before);
  });

  it('replays an approval decision made on a real parent context', () => {
    const parent = new ApprovalLedger();
    parent.approveTool(createApprovalItem(TOOL, 'call_from_parent'));

    const nested = replayInto(parent.snapshot());

    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_from_parent' })).toBe(true);
  });

  it('replays a rejection decision made on a real parent context', () => {
    const parent = new ApprovalLedger();
    parent.rejectTool(createApprovalItem(TOOL, 'call_from_parent'), { message: 'denied by user' });

    const nested = replayInto(parent.snapshot());

    expect(nested.isToolApproved({ toolName: TOOL, callId: 'call_from_parent' })).toBe(false);
    expect(nested.getRejectionMessage(TOOL, 'call_from_parent')).toBe('denied by user');
  });
});
