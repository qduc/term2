import { describe, it, expect } from 'vitest';
import { groupCommandRuns, summarizeCommandGroup, countFailedMembers } from './command-grouping.js';

describe('groupCommandRuns', () => {
  it('leaves a lone command message ungrouped', () => {
    const messages = [{ id: '1', sender: 'command', status: 'completed', toolName: 'grep' }];
    const result = groupCommandRuns(messages, { treatTrailingAsClosed: true });
    expect(result).toEqual(messages);
  });

  it('merges a closed run of terminal commands into one group', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'read_file' },
      { id: '3', sender: 'bot', status: 'finalized' },
    ];
    const result = groupCommandRuns(messages, { treatTrailingAsClosed: false });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ sender: 'command-group', status: 'completed' });
    expect((result[0] as any).members).toHaveLength(2);
    expect(result[1]).toEqual(messages[2]);
  });

  it('leaves a trailing multi-command run ungrouped when treatTrailingAsClosed is false', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'read_file' },
    ];
    const result = groupCommandRuns(messages, { treatTrailingAsClosed: false });
    expect(result).toEqual(messages);
  });

  it('groups a trailing multi-command run when treatTrailingAsClosed is true', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'read_file' },
    ];
    const result = groupCommandRuns(messages, { treatTrailingAsClosed: true });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sender: 'command-group' });
  });

  it('never groups a run containing a still-running member, even mid-array', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'running', toolName: 'read_file' },
      { id: '3', sender: 'bot', status: 'finalized' },
    ];
    const result = groupCommandRuns(messages, { treatTrailingAsClosed: true });
    expect(result).toEqual(messages);
  });

  it('marks the group failed when any member failed', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'failed', toolName: 'read_file' },
    ];
    const result = groupCommandRuns(messages, { treatTrailingAsClosed: true });
    expect(result[0]).toMatchObject({ sender: 'command-group', status: 'failed' });
  });

  it('produces a stable id from the first and last member ids', () => {
    const messages = [
      { id: 'a', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: 'b', sender: 'command', status: 'completed', toolName: 'read_file' },
    ];
    const result = groupCommandRuns(messages, { treatTrailingAsClosed: true });
    expect(result[0].id).toBe('command-group:a:b');
  });

  it('groups multiple independent closed runs separately', () => {
    const messages = [
      { id: '1', sender: 'command', status: 'completed', toolName: 'grep' },
      { id: '2', sender: 'command', status: 'completed', toolName: 'read_file' },
      { id: '3', sender: 'bot', status: 'finalized' },
      { id: '4', sender: 'command', status: 'completed', toolName: 'shell' },
      { id: '5', sender: 'command', status: 'completed', toolName: 'shell' },
    ];
    const result = groupCommandRuns(messages, { treatTrailingAsClosed: true });
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ sender: 'command-group' });
    expect(result[1]).toEqual(messages[2]);
    expect(result[2]).toMatchObject({ sender: 'command-group' });
  });
});

describe('summarizeCommandGroup', () => {
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
