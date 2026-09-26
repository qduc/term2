import { describe, expect, it, vi } from 'vitest';
import { AutomaticMemoryCanary } from './automatic-memory-canary.js';

const preference = 'Remember for future sessions: I prefer short test reports.';

function setup(created: boolean = true) {
  const store = {
    createAutomatic: vi.fn(async (input: { id: string; title: string; summary: string; content: string }) =>
      created ? input : null,
    ),
  };
  return { store, canary: new AutomaticMemoryCanary(store) };
}

describe('AutomaticMemoryCanary', () => {
  it('persists an exact first-party durable preference with source and undo receipt', async () => {
    const { store, canary } = setup();
    const receipt = await canary.record(preference, 'session-1');
    expect(store.createAutomatic).toHaveBeenCalledWith(
      expect.objectContaining({
        title: preference,
        summary: preference,
        content: preference,
      }),
      'session-1',
    );
    expect(receipt).toEqual(
      expect.objectContaining({ scope: 'project', sourceSessionId: 'session-1', quote: preference }),
    );
    expect(receipt?.undo).toContain(receipt?.id);
  });

  it('accepts a natural explicit future preference without a command keyword', async () => {
    const { store, canary } = setup();
    expect(await canary.record('For future sessions, I prefer short test reports.', 'session-1')).not.toBeNull();
    expect(store.createAutomatic).toHaveBeenCalledOnce();
  });

  it.each([
    'I prefer short test reports.',
    'Remember for future sessions: the assistant said I prefer short test reports.',
    'Remember for future sessions: I prefer short test reports for this task.',
    'Remember for future sessions: I prefer short test reports? ',
    'Remember for future sessions: I prefer token sk-123456789012345678901234567890.',
    'Here is an example:\nRemember for future sessions: I prefer short test reports.',
    'Remember for future sessions: Actually, I meant short test reports.',
    'Remember for future sessions: We decided to use test reports.',
    '"Remember for future sessions: I prefer short test reports."',
  ])('rejects untrusted, temporary, unsafe or unsupported input: %s', async (text) => {
    const { store, canary } = setup();
    expect(await canary.record(text, 'session-1')).toBeNull();
    expect(store.createAutomatic).not.toHaveBeenCalled();
  });

  it('does not repeat an existing quote', async () => {
    const { store, canary } = setup(false);
    expect(await canary.record(preference, 'session-1')).toBeNull();
    expect(store.createAutomatic).toHaveBeenCalledOnce();
  });

  it('limits a live canary to one automatic write per session', async () => {
    const { store, canary } = setup();
    expect(await canary.record(preference, 'session-1')).not.toBeNull();
    expect(await canary.record('For future sessions, I prefer concise answers.', 'session-1')).toBeNull();
    expect(store.createAutomatic).toHaveBeenCalledOnce();
    expect(await canary.record('For future sessions, I prefer concise answers.', 'session-2')).not.toBeNull();
  });

  it('stops across session resets after the first ambiguous storage failure', async () => {
    const { store, canary } = setup();
    store.createAutomatic.mockRejectedValueOnce(new Error('storage failure'));
    await expect(canary.record(preference, 'session-1')).rejects.toThrow('storage failure');
    expect(await canary.record(preference, 'session-2')).toBeNull();
    expect(store.createAutomatic).toHaveBeenCalledOnce();
  });
});
