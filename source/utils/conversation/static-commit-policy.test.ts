import { describe, expect, it } from 'vitest';
import {
  classifyStaticCommitBlocker,
  isBlockingStaticCommit,
  turnEndSettlement,
  type StaticCommitBlockerReason,
  type StaticCommitSubject,
} from './static-commit-policy.js';

// Every (sender, status) combination the Message union can produce. A new
// variant or status must be added here AND classified in the policy; the
// exhaustive switch in the policy makes the reverse direction a type error.
const SUBJECTS: Array<{ subject: StaticCommitSubject; expected: StaticCommitBlockerReason | null }> = [
  { subject: { sender: 'bot', status: 'streaming' }, expected: 'bot_streaming' },
  { subject: { sender: 'bot', status: 'finalized' }, expected: null },
  { subject: { sender: 'bot' }, expected: null },

  { subject: { sender: 'reasoning', status: 'streaming' }, expected: 'reasoning_streaming' },
  { subject: { sender: 'reasoning' }, expected: 'reasoning_streaming' },
  { subject: { sender: 'reasoning', status: 'finalized' }, expected: null },

  { subject: { sender: 'command', status: 'pending' }, expected: 'command_pending' },
  { subject: { sender: 'command', status: 'running' }, expected: 'command_running' },
  { subject: { sender: 'command', status: 'completed' }, expected: null },
  { subject: { sender: 'command', status: 'failed' }, expected: null },
  { subject: { sender: 'command', status: 'aborted' }, expected: null },

  { subject: { sender: 'subagent', status: 'running' }, expected: 'subagent_activity' },
  { subject: { sender: 'subagent', status: 'completed' }, expected: null },
  { subject: { sender: 'subagent', status: 'failed' }, expected: null },
  { subject: { sender: 'subagent', status: 'cancelled' }, expected: null },
  { subject: { sender: 'subagent', status: 'interrupted' }, expected: null },
  { subject: { sender: 'subagent', status: 'backgrounded' }, expected: null },

  { subject: { sender: 'user' }, expected: null },
  { subject: { sender: 'system' }, expected: null },
  { subject: { sender: 'command-group' }, expected: null },
];

describe('classifyStaticCommitBlocker', () => {
  it.each(SUBJECTS)('classifies $sender/$status as $expected', ({ subject, expected }) => {
    expect(classifyStaticCommitBlocker(subject)).toBe(expected);
    expect(isBlockingStaticCommit(subject)).toBe(expected !== null);
  });

  it('degrades an unrecognized runtime row to committable instead of crashing the renderer', () => {
    // The renderer feeds looser MessageLike rows through the policy; a rogue
    // sender or status string must fall back to the pre-policy behavior
    // (renderable), never throw inside the render loop.
    const rogue = { sender: 'command', status: 'banana' } as unknown as StaticCommitSubject;
    expect(classifyStaticCommitBlocker(rogue)).toBeNull();
    const rogueSender = { sender: 'banana' } as unknown as StaticCommitSubject;
    expect(classifyStaticCommitBlocker(rogueSender)).toBeNull();
  });

  it('covers every status of every sender variant', () => {
    // Parity guard for this table: each sender in the union must have all of
    // its legal statuses represented above, or a new status could ship
    // unclassified in the table while the exhaustive switch still compiles.
    const statusesBySender = new Map<string, Set<string | undefined>>();
    for (const { subject } of SUBJECTS) {
      const set = statusesBySender.get(subject.sender) ?? new Set<string | undefined>();
      set.add((subject as { status?: string }).status);
      statusesBySender.set(subject.sender, set);
    }
    expect(statusesBySender.get('bot')).toEqual(new Set(['streaming', 'finalized', undefined]));
    expect(statusesBySender.get('reasoning')).toEqual(new Set(['streaming', 'finalized', undefined]));
    expect(statusesBySender.get('command')).toEqual(new Set(['pending', 'running', 'completed', 'failed', 'aborted']));
    expect(statusesBySender.get('subagent')).toEqual(
      new Set(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'backgrounded']),
    );
    expect(statusesBySender.get('user')).toEqual(new Set([undefined]));
    expect(statusesBySender.get('system')).toEqual(new Set([undefined]));
    expect(statusesBySender.get('command-group')).toEqual(new Set([undefined]));
  });
});

describe('turnEndSettlement', () => {
  const ALL_REASONS: StaticCommitBlockerReason[] = [
    'bot_streaming',
    'reasoning_streaming',
    'command_pending',
    'command_running',
    'subagent_activity',
  ];

  it('names a settlement rule for every blocking classification', () => {
    for (const reason of ALL_REASONS) {
      expect(['finalize', 'abort', 'leave']).toContain(turnEndSettlement(reason));
    }
  });

  it('finalizes turn-owned streaming rows', () => {
    expect(turnEndSettlement('bot_streaming')).toBe('finalize');
    expect(turnEndSettlement('reasoning_streaming')).toBe('finalize');
  });

  it('aborts stranded command rows', () => {
    expect(turnEndSettlement('command_pending')).toBe('abort');
    expect(turnEndSettlement('command_running')).toBe('abort');
  });

  it('leaves background subagent activity to its own lifecycle events', () => {
    // A running background subagent legitimately outlives the turn; settling
    // it at turn end would freeze live work into Static irreversibly.
    expect(turnEndSettlement('subagent_activity')).toBe('leave');
  });
});
