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
 * These first tests pin the record shape `replayApprovals` consumes, so a change to the
 * ledger that changes the meaning of `approvals` fails here rather than silently
 * mis-granting approvals across the parent/subagent boundary.
 */
describe('approval-record shape', () => {
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

  it('a per-call approval is not a decision for the tool', () => {
    const context = new ApprovalLedger();

    context.approveTool(createApprovalItem(TOOL, 'call_abc'));

    expect(context.blanketDecision(TOOL)).toBeUndefined();
  });

  it('a blanket approval decides every call of the tool', () => {
    const context = new ApprovalLedger();

    context.approveTool(createApprovalItem(TOOL, 'call_abc'), { alwaysApprove: true });

    expect(context.blanketDecision(TOOL)).toBe(true);
  });
});

describe('replayApprovals', () => {
  it('leaves the nested context untouched when there is nothing to replay', () => {
    const nested = replayInto({});

    expect(nested.snapshot()).toEqual({});
  });

  it('does not carry one-time parent approvals or rejections into the nested context', () => {
    // A one-time decision belongs to the parent's call. The nested run's provider numbers its
    // own calls, so the same id there is a different call and must be presented again.
    const nested = replayInto({
      [TOOL]: { approved: ['call_approved'], rejected: ['call_denied'] },
      write_file: { approved: [], rejected: ['call_b'] },
    });

    expect(nested.snapshot()).toEqual({});
    expect(nested.blanketDecision(TOOL)).toBeUndefined();
    expect(nested.blanketDecision('write_file')).toBeUndefined();
  });

  it('carries a blanket parent approval into the nested context', () => {
    const nested = replayInto({ [TOOL]: { approved: true, rejected: [] } });

    expect(nested.blanketDecision(TOOL)).toBe(true);
  });

  it('carries a blanket parent rejection into the nested context', () => {
    const nested = replayInto({ [TOOL]: { approved: false, rejected: true } });

    expect(nested.blanketDecision(TOOL)).toBe(false);
  });

  it('preserves the sticky rejection message of a blanket rejection', () => {
    const nested = replayInto({
      [TOOL]: { approved: false, rejected: true, stickyRejectMessage: 'this tool is off limits' },
    });

    expect(nested.blanketRejectionMessage(TOOL)).toBe('this tool is off limits');
  });

  it('lets a blanket approval outrank per-call rejections', () => {
    const nested = replayInto({ [TOOL]: { approved: true, rejected: ['call_no'] } });

    expect(nested.blanketDecision(TOOL)).toBe(true);
  });

  it('lets a blanket rejection outrank per-call approvals', () => {
    const nested = replayInto({ [TOOL]: { approved: ['call_yes'], rejected: true } });

    expect(nested.blanketDecision(TOOL)).toBe(false);
  });

  it('lets a blanket approval outrank a blanket rejection', () => {
    const nested = replayInto({ [TOOL]: { approved: true, rejected: true } });

    expect(nested.blanketDecision(TOOL)).toBe(true);
  });

  it('replays every tool in the record independently', () => {
    const nested = replayInto({
      shell_command: { approved: true, rejected: [] },
      write_file: { approved: [], rejected: true },
      read_file: { approved: ['call_a'], rejected: [] },
    });

    expect(nested.blanketDecision('shell_command')).toBe(true);
    expect(nested.blanketDecision('write_file')).toBe(false);
    expect(nested.blanketDecision('read_file')).toBeUndefined();
  });

  it('does not mutate the parent approvals it reads from', () => {
    const parent = new ApprovalLedger();
    parent.approveTool(createApprovalItem(TOOL, 'call_abc'), { alwaysApprove: true });
    const before = structuredClone(parent.snapshot());

    replayApprovals(new ApprovalLedger(), parent.snapshot(), createAgent());

    expect(parent.snapshot()).toEqual(before);
  });

  it('replays a blanket rejection made on a real parent ledger, message included', () => {
    const parent = new ApprovalLedger();
    parent.rejectTool(createApprovalItem(TOOL, 'call_from_parent'), { alwaysReject: true, message: 'denied by user' });

    const nested = replayInto(parent.snapshot());

    expect(nested.blanketDecision(TOOL)).toBe(false);
    expect(nested.blanketRejectionMessage(TOOL)).toBe('denied by user');
  });

  it('does not replay a one-time decision made on a real parent ledger', () => {
    const parent = new ApprovalLedger();
    parent.approveTool(createApprovalItem(TOOL, 'call_from_parent'));
    parent.rejectTool(createApprovalItem('write_file', 'call_from_parent'), { message: 'denied by user' });

    const nested = replayInto(parent.snapshot());

    expect(nested.snapshot()).toEqual({});
  });
});
