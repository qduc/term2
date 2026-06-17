import { it, expect } from 'vitest';
import { SubagentSession } from './subagent-session.js';

it('SubagentSession initializes with id and role', () => {
  const session = new SubagentSession('test-id', 'mentor');
  expect(session.id).toBe('test-id');
  expect(session.role).toBe('mentor');
});

it('SubagentSession provider starts null', () => {
  const session = new SubagentSession('id', 'explorer');
  expect(session.provider).toBe(null);
  expect(session.runner).toBe(null);
  expect(session.agent).toBe(null);
  expect(session.previousResponseId).toBe(null);
});

it('SubagentSession switchProvider resets state on provider change', () => {
  const session = new SubagentSession('id', 'mentor');
  const fakeAgent: any = { name: 'Mentor' };
  let agentCreated = false;

  session.switchProvider('openai');
  session.ensureAgent(() => {
    agentCreated = true;
    return fakeAgent;
  });
  expect(agentCreated).toBe(true);
  expect(session.agent).toBe(fakeAgent);

  // Switching to the same provider does NOT reset
  session.switchProvider('openai');
  expect(session.agent).toBe(fakeAgent);

  // Switching to a different provider resets
  session.switchProvider('openrouter');
  expect(session.agent).toBe(null);
});

it('SubagentSession ensureAgent is idempotent', () => {
  const session = new SubagentSession('id', 'mentor');
  const fakeAgent: any = { name: 'Mentor' };
  let callCount = 0;

  session.switchProvider('openai');
  session.ensureAgent(() => {
    callCount++;
    return fakeAgent;
  });
  session.ensureAgent(() => {
    callCount++;
    return { name: 'Second' } as any;
  });

  expect(callCount).toBe(1);
  expect(session.agent).toBe(fakeAgent);
});

it('SubagentSession ensureRunner skips runner for openai', () => {
  const session = new SubagentSession('id', 'mentor');
  let factoryCalled = false;

  const runner = session.ensureRunner('openai', () => {
    factoryCalled = true;
    return {} as any;
  });

  expect(factoryCalled).toBe(false);
  expect(runner).toBe(null);
});

it('SubagentSession ensureRunner creates runner for non-openai provider', () => {
  const session = new SubagentSession('id', 'mentor');
  const fakeRunner: any = { run: () => {} };

  const runner = session.ensureRunner('openrouter', () => fakeRunner);
  expect(runner).toBe(fakeRunner);
});

it('SubagentSession reset clears all state', () => {
  const session = new SubagentSession('id', 'mentor');
  const fakeAgent: any = { name: 'Mentor' };

  session.switchProvider('openai');
  session.ensureAgent(() => fakeAgent);
  expect(session.agent).toBe(fakeAgent);

  session.reset();
  expect(session.provider).toBe(null);
  expect(session.agent).toBe(null);
  expect(session.runner).toBe(null);
  expect(session.previousResponseId).toBe(null);
});

it('SubagentSession getRunOptions includes maxTurns', () => {
  const session = new SubagentSession('id', 'mentor');

  const opts = session.getRunOptions(false, 5);
  expect(opts.maxTurns).toBe(5);
  expect(opts.stream).toBe(false);
  expect('previousResponseId' in opts).toBe(false);
});

it('SubagentSession getRunOptions omits previousResponseId when chaining is unsupported', () => {
  const session = new SubagentSession('id', 'mentor');
  session.switchProvider('openai');
  session.ensureAgent(() => ({ name: 'Mentor' } as any));
  session.addUserMessage('hello');
  session.appendOutput({ responseId: 'resp-1', output: [] });

  const opts = session.getRunOptions(false, 1);
  expect('previousResponseId' in opts).toBe(false);
});

it('SubagentSession appendOutput tracks previousResponseId', () => {
  const session = new SubagentSession('id', 'mentor');
  session.switchProvider('openai');
  session.ensureAgent(() => ({ name: 'Mentor' } as any));
  session.addUserMessage('hello');

  session.appendOutput({ responseId: 'resp-abc', output: [] });
  expect(session.previousResponseId).toBe('resp-abc');
});

it('SubagentSession getInput returns task string when chaining is supported', () => {
  const session = new SubagentSession('id', 'mentor');
  session.switchProvider('openai');
  session.ensureAgent(() => ({ name: 'Mentor' } as any));
  session.addUserMessage('test question');

  const input = session.getInput('test question', true);
  expect(input).toBe('test question');
});

it('SubagentSession getInput returns history array when chaining is unsupported', () => {
  const session = new SubagentSession('id', 'mentor');
  session.switchProvider('openrouter');
  session.ensureAgent(() => ({ name: 'Mentor' } as any));
  session.addUserMessage('test question');

  const input = session.getInput('test question', false);
  expect(Array.isArray(input)).toBe(true);
  expect(input.length).toBe(1);
});
