import { describe, it, expect } from 'vitest';
import {
  groupCommandRuns,
  summarizeCommandGroup,
  countFailedMembers,
  describeGroupFailures,
} from './command-grouping.js';

describe('groupCommandRuns', () => {
  it('leaves a lone command message ungrouped while the run may still grow', () => {
    const messages = [{ id: '1', sender: 'command', status: 'completed', toolName: 'grep' }];
    const result = groupCommandRuns(messages);
    expect(result).toEqual(messages);
  });

  it('leaves a lone settled call ungrouped in its original form once another kind of message closes the run', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'bot', status: 'finalized' },
    ];
    const result = groupCommandRuns(messages);
    expect(result).toEqual(messages);
  });

  it('merges a closed run of multiple terminal commands into one group', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'read_file' },
      { id: '3', sender: 'bot', status: 'finalized' },
    ];
    const result = groupCommandRuns(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ sender: 'command-group', status: 'completed' });
    expect((result[0] as any).members).toHaveLength(2);
    expect(result[1]).toEqual(messages[2]);
  });

  it('retains the last run tool separate in a trailing run that may still grow', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'read_file' },
    ];
    const result = groupCommandRuns(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ sender: 'command-group' });
    expect((result[0] as any).members.map((m: any) => m.id)).toEqual(['1']);
    expect(result[1]).toEqual(messages[1]);
  });

  it('grows the group while retaining the latest completed tool separate once 3 calls settle', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'read_file' },
      { id: '3', sender: 'command', status: 'completed', toolName: 'shell' },
    ];
    const result = groupCommandRuns(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ sender: 'command-group' });
    expect((result[0] as any).members.map((m: any) => m.id)).toEqual(['1', '2']);
    expect(result[1]).toEqual(messages[2]);
  });

  it('folds all tools in after another kind of message arrives', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'read_file' },
      { id: '3', sender: 'command', status: 'completed', toolName: 'shell' },
      { id: '4', sender: 'bot', status: 'finalized' },
    ];
    const result = groupCommandRuns(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ sender: 'command-group' });
    expect((result[0] as any).members.map((m: any) => m.id)).toEqual(['1', '2', '3']);
    expect(result[1]).toEqual(messages[3]);
  });

  it('leaves the last run tool and the running call on separate lines below the group', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'read_file' },
      { id: '3', sender: 'command', status: 'completed', toolName: 'glob' },
      { id: '4', sender: 'command', status: 'running', toolName: 'shell' },
    ];
    const result = groupCommandRuns(messages);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ sender: 'command-group' });
    expect((result[0] as any).members.map((m: any) => m.id)).toEqual(['1', '2']);
    expect(result[1]).toEqual(messages[2]);
    expect(result[2]).toEqual(messages[3]);
  });

  it('leaves every call from the first in-flight one onward unfolded', () => {
    // Parallel dispatch can settle out of order; folding past a running call
    // would hide it, which is the whole point of keeping it visible.
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '3', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '4', sender: 'command', status: 'running', toolName: 'shell' },
      { id: '5', sender: 'command', status: 'completed', toolName: 'read_file' },
    ];
    const result = groupCommandRuns(messages);
    expect(result.map((m: any) => m.id)).toEqual(['command-group:1', '3', '4', '5']);
  });

  it('folds nothing while fewer than two calls have settled', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'running', toolName: 'read_file' },
    ];
    expect(groupCommandRuns(messages)).toEqual(messages);
  });

  it('treats a pending call as in-flight too', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '3', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '4', sender: 'command', status: 'pending', toolName: 'shell' },
    ];
    expect(groupCommandRuns(messages).map((m: any) => m.id)).toEqual(['command-group:1', '3', '4']);
  });

  it('marks a run partial when only some members failed in a closed run', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'failed', toolName: 'read_file' },
      { id: '3', sender: 'bot', status: 'finalized' },
    ];
    const result = groupCommandRuns(messages);
    expect(result[0]).toMatchObject({ sender: 'command-group', status: 'partial' });
  });

  it('marks a run failed only when every member failed', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'failed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'read_file', success: false },
      { id: '3', sender: 'bot', status: 'finalized' },
    ];
    const result = groupCommandRuns(messages);
    expect(result[0]).toMatchObject({ sender: 'command-group', status: 'failed' });
  });

  it('keeps the same id as the run grows, so the summary line is one identity', () => {
    const grow = (ids: string[]) =>
      groupCommandRuns(ids.map((id) => ({ id, sender: 'command', status: 'completed', toolName: 'read_file' })));

    expect(grow(['a', 'b', 'c'])[0].id).toBe('command-group:a');
    expect(grow(['a', 'b', 'c', 'd'])[0].id).toBe('command-group:a');
  });

  it('groups multiple independent closed runs separately', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'read_file' },
      { id: '3', sender: 'bot', status: 'finalized' },
      { id: '4', sender: 'command', status: 'completed', toolName: 'shell' },
      { id: '5', sender: 'command', status: 'completed', toolName: 'shell' },
      { id: '6', sender: 'bot', status: 'finalized' },
    ];
    const result = groupCommandRuns(messages);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ sender: 'command-group' });
    expect(result[1]).toEqual(messages[2]);
    expect(result[2]).toMatchObject({ sender: 'command-group' });
    expect(result[3]).toEqual(messages[5]);
  });

  it('folds all settled calls when options.isClosed is explicitly set and >= 2 calls', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'read_file' },
    ];
    const result = groupCommandRuns(messages, { isClosed: true });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sender: 'command-group' });
    expect((result[0] as any).members).toHaveLength(2);
  });

  it('leaves a lone settled call ungrouped when options.isClosed is explicitly set', () => {
    const messages = [{ id: '1', sender: 'command', status: 'completed', toolName: 'grep' }];
    const result = groupCommandRuns(messages, { isClosed: true });
    expect(result).toEqual(messages);
  });

  it('merges adjacent CommandGroupMessages into a single unified group', () => {
    const group1 = {
      id: 'command-group:1',
      sender: 'command-group' as const,
      status: 'completed' as const,
      members: [
        { id: '1', sender: 'command', status: 'completed', toolName: 'read_file' },
        { id: '2', sender: 'command', status: 'completed', toolName: 'grep' },
      ],
    };
    const group2 = {
      id: 'command-group:3',
      sender: 'command-group' as const,
      status: 'completed' as const,
      members: [{ id: '3', sender: 'command', status: 'completed', toolName: 'shell', command: 'ls' }],
    };

    const result = groupCommandRuns([group1, group2], { isClosed: true });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sender: 'command-group', status: 'completed' });
    expect((result[0] as any).members).toHaveLength(3);
    expect(summarizeCommandGroup((result[0] as any).members)).toBe(
      'Read 1 file, searched for 1 pattern, ran 1 shell command',
    );
  });

  it('merges an existing CommandGroupMessage with trailing commands', () => {
    const group1 = {
      id: 'command-group:1',
      sender: 'command-group' as const,
      status: 'completed' as const,
      members: [{ id: '1', sender: 'command', status: 'completed', toolName: 'read_file' }],
    };
    const cmd2 = { id: '2', sender: 'command', status: 'completed', toolName: 'shell', command: 'pnpm test' };

    const result = groupCommandRuns([group1, cmd2], { isClosed: true });
    expect(result).toHaveLength(1);
    expect((result[0] as any).members.map((m: any) => m.id)).toEqual(['1', '2']);
  });
});

describe('summarizeCommandGroup', () => {
  it('leaves a lone completed subagent ungrouped once another message arrives', () => {
    const messages = [
      { id: '1', sender: 'subagent', status: 'completed', role: 'explorer', task: 'find file' },
      { id: '2', sender: 'bot', status: 'finalized' },
    ];
    const result = groupCommandRuns(messages);
    expect(result).toEqual(messages);
  });

  it('merges commands and completed subagents into one concise group', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'subagent', status: 'completed', role: 'explorer', task: 'find file' },
      { id: '3', sender: 'bot', status: 'finalized' },
    ];
    const result = groupCommandRuns(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ sender: 'command-group', status: 'completed' });
    expect((result[0] as any).members).toHaveLength(2);
    expect(summarizeCommandGroup((result[0] as any).members)).toBe('Searched for 1 pattern, delegated to 1 subagent');
  });

  it('summarizes multiple subagent delegates with plural noun', () => {
    const members = [
      { sender: 'subagent' as const, status: 'completed' },
      { sender: 'subagent' as const, status: 'completed' },
    ];
    expect(summarizeCommandGroup(members)).toBe('Delegated to 2 subagents');
  });

  it('summarizes memory and session tools with proper verbs and nouns', () => {
    expect(summarizeCommandGroup([{ toolName: 'memory_update' }, { toolName: 'memory_update' }])).toBe(
      'Updated 2 memories',
    );
    expect(summarizeCommandGroup([{ toolName: 'memory_create' }])).toBe('Saved 1 memory');
    expect(summarizeCommandGroup([{ toolName: 'session_search' }, { toolName: 'session_read' }])).toBe(
      'Searched 1 prior session, read 1 prior session',
    );
  });

  it('summarizes async subagents with distinct category', () => {
    const members = [{ sender: 'subagent' as const, status: 'completed', async: true }];
    expect(summarizeCommandGroup(members)).toBe('Delegated async to 1 subagent');
  });

  it('builds the reference phrase from mixed tool calls including subagents', () => {
    const members = [
      { toolName: 'grep' },
      { toolName: 'read_file' },
      { toolName: 'read_file' },
      { sender: 'subagent' as const, status: 'completed' },
      { toolName: undefined },
    ];
    expect(summarizeCommandGroup(members)).toBe(
      'Searched for 1 pattern, read 2 files, delegated to 1 subagent, ran 1 shell command',
    );
  });

  it('builds the reference phrase from mixed tool calls', () => {
    const members = [
      { toolName: 'grep' },
      { toolName: 'read_file' },
      { toolName: 'read_file' },
      { toolName: 'read_file' },
      { toolName: undefined },
      { toolName: undefined },
    ];
    expect(summarizeCommandGroup(members)).toBe('Searched for 1 pattern, read 3 files, ran 2 shell commands');
  });

  it('falls back to a generic tool-call phrase for unknown tools', () => {
    expect(summarizeCommandGroup([{ toolName: 'activate_skill' }])).toBe('Ran 1 tool call');
  });
});

describe('countFailedMembers', () => {
  it('counts members with failed status, aborted status, or success === false', () => {
    const members = [
      { id: '1', status: 'completed' },
      { id: '2', status: 'failed' },
      { id: '3', status: 'aborted' },
      { id: '4', status: 'completed', success: false },
    ];
    expect(countFailedMembers(members)).toBe(3);
  });
});

describe('describeGroupFailures', () => {
  const shell = (id: string, command: string) => ({ id, status: 'failed', command });

  it('is empty when nothing failed', () => {
    expect(describeGroupFailures([{ id: '1', status: 'completed', command: 'ls' }])).toBe('');
  });

  it('names the failing shell commands', () => {
    expect(describeGroupFailures([{ id: '1', status: 'completed', command: 'ls' }, shell('2', 'pnpm test')])).toBe(
      '1 failed: pnpm test',
    );
  });

  it('names non-shell failures by their formatted args', () => {
    const members = [{ id: '1', status: 'failed', toolName: 'read_file', toolArgs: { path: 'a.ts' } }];
    expect(describeGroupFailures(members)).toBe('1 failed: "a.ts"');
  });

  it('falls back to the tool name when a call has no args to show', () => {
    expect(describeGroupFailures([{ id: '1', status: 'failed', toolName: 'web_search' }])).toBe('1 failed: web_search');
  });

  it('caps the named failures so the line cannot grow into a paragraph', () => {
    const members = [shell('1', 'a'), shell('2', 'b'), shell('3', 'c'), shell('4', 'd'), shell('5', 'e')];
    expect(describeGroupFailures(members)).toBe('5 failed: a, b, c, +2 more');
  });

  it('truncates a long command to one short line', () => {
    const long = shell('1', `echo ${'x'.repeat(80)}\nsecond line`);
    const described = describeGroupFailures([long]);
    expect(described.startsWith('1 failed: echo xxx')).toBe(true);
    expect(described.endsWith('…')).toBe(true);
    expect(described.includes('second line')).toBe(false);
    expect(described.length).toBeLessThan(60);
  });
});
