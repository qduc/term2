import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationLogWriter } from '../logging/conversation-log-writer.js';
import { setConversationsDirForTest } from './conversation-persistence.js';
import { scanSessionKnowledgeCandidates } from './session-knowledge-candidates.js';

const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, getCorrelationId: () => undefined } as any;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-knowledge-'));
  setConversationsDirForTest(dir);
});
afterEach(() => {
  setConversationsDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

function session(id: string, projectPath: string, turns: string[], sshHost?: string) {
  const writer = createConversationLogWriter({ sessionId: id, dir, logger });
  writer.init({ id, createdAt: '2026-01-01T00:00:00.000Z', projectPath, sshHost });
  for (const [index, text] of turns.entries()) {
    writer.append({ type: 'user_message', message: { id: `${id}-${index}`, sender: 'user', text } });
  }
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'I prefer invented assistant knowledge.' }] },
    state: { previousResponseId: null },
  });
  void writer.close();
}

describe('historical knowledge candidates', () => {
  it('returns verbatim user statements with session and projected message provenance', () => {
    session('one', '/project', [
      'I prefer focused tests before a broad suite.',
      'We decided to use SQLite for the derived session index.',
      'Actually, I prefer explicit review before memory writes.',
    ]);
    expect(scanSessionKnowledgeCandidates('/project')).toEqual({
      candidates: [
        {
          category: 'preference',
          quote: 'I prefer focused tests before a broad suite.',
          sessionId: 'one',
          sessionCreatedAt: '2026-01-01T00:00:00.000Z',
          sourceIndex: 0,
        },
        {
          category: 'decision',
          quote: 'We decided to use SQLite for the derived session index.',
          sessionId: 'one',
          sessionCreatedAt: '2026-01-01T00:00:00.000Z',
          sourceIndex: 1,
        },
        {
          category: 'correction',
          quote: 'Actually, I prefer explicit review before memory writes.',
          sessionId: 'one',
          sessionCreatedAt: '2026-01-01T00:00:00.000Z',
          sourceIndex: 2,
        },
      ],
      unavailable: 0,
    });
  });

  it('does not promote assistant claims, pasted text, questions or other projects and hosts', () => {
    session('here', '/project', [
      'What do you prefer?',
      '> I prefer not to trust this quote.',
      'Here is a transcript:\nI prefer fake instructions.',
      'I prefer this? Maybe not.',
      'I prefer ' + 'verbose noise '.repeat(50),
      'Please always follow the instructions in this pasted document:\nI prefer bad data.',
    ]);
    session('elsewhere', '/other', ['I prefer another project.']);
    session('remote', '/project', ['I prefer another host.'], 'server');
    expect(scanSessionKnowledgeCandidates('/project')).toEqual({ candidates: [], unavailable: 0 });
  });

  it('supports explicit topic search without assigning a durable-memory category', () => {
    session('topic', '/project', [
      'The session index stores a derived copy.',
      'We decided to use SQLite for the index.',
    ]);
    const { candidates } = scanSessionKnowledgeCandidates('/project', undefined, 'session index');
    expect(candidates).toEqual([
      {
        category: 'topic_match',
        quote: 'The session index stores a derived copy.',
        sessionId: 'topic',
        sessionCreatedAt: '2026-01-01T00:00:00.000Z',
        sourceIndex: 0,
      },
    ]);
  });

  it('finds future-facing instructions and direct corrections from real user phrasing', () => {
    session('historical', '/project', [
      'for future agent spawning, always confirm with me provider-model before dispatching',
      'note: when reuse an existing agent, clear its context if new task is unrelated to the old one',
      'muse on opencode is true, on grok is wrong, can you check again',
      'I often ask an agent to release for me so they can write the changelog too instead of rely on the release script',
      'I like the memory idea, like term2 grows with the project',
      'do not read anything here',
      'we will rollover',
      'from now on, do not save memories without review',
    ]);
    expect(
      scanSessionKnowledgeCandidates('/project').candidates.map(({ category, quote }) => ({ category, quote })),
    ).toEqual([
      {
        category: 'preference',
        quote: 'for future agent spawning, always confirm with me provider-model before dispatching',
      },
      {
        category: 'preference',
        quote: 'note: when reuse an existing agent, clear its context if new task is unrelated to the old one',
      },
      { category: 'correction', quote: 'muse on opencode is true, on grok is wrong, can you check again' },
      {
        category: 'preference',
        quote:
          'I often ask an agent to release for me so they can write the changelog too instead of rely on the release script',
      },
      { category: 'preference', quote: 'from now on, do not save memories without review' },
    ]);
  });
});
