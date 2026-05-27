import test from 'ava';
import { SubagentSession } from './subagent-session.js';

test('SubagentSession initializes with id and role', (t) => {
  const session = new SubagentSession('test-id', 'mentor');
  t.is(session.id, 'test-id');
  t.is(session.role, 'mentor');
});

test('SubagentSession provider starts null', (t) => {
  const session = new SubagentSession('id', 'explorer');
  t.is(session.provider, null);
  t.is(session.runner, null);
  t.is(session.agent, null);
  t.is(session.previousResponseId, null);
});

test('SubagentSession switchProvider resets state on provider change', (t) => {
  const session = new SubagentSession('id', 'mentor');
  const fakeAgent: any = { name: 'Mentor' };
  let agentCreated = false;

  session.switchProvider('openai');
  session.ensureAgent(() => {
    agentCreated = true;
    return fakeAgent;
  });
  t.true(agentCreated);
  t.is(session.agent, fakeAgent);

  // Switching to the same provider does NOT reset
  session.switchProvider('openai');
  t.is(session.agent, fakeAgent);

  // Switching to a different provider resets
  session.switchProvider('openrouter');
  t.is(session.agent, null);
});

test('SubagentSession ensureAgent is idempotent', (t) => {
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

  t.is(callCount, 1);
  t.is(session.agent, fakeAgent);
});

test('SubagentSession ensureRunner skips runner for openai', (t) => {
  const session = new SubagentSession('id', 'mentor');
  let factoryCalled = false;

  const runner = session.ensureRunner('openai', () => {
    factoryCalled = true;
    return {} as any;
  });

  t.false(factoryCalled);
  t.is(runner, null);
});

test('SubagentSession ensureRunner creates runner for non-openai provider', (t) => {
  const session = new SubagentSession('id', 'mentor');
  const fakeRunner: any = { run: () => {} };

  const runner = session.ensureRunner('openrouter', () => fakeRunner);
  t.is(runner, fakeRunner);
});

test('SubagentSession reset clears all state', (t) => {
  const session = new SubagentSession('id', 'mentor');
  const fakeAgent: any = { name: 'Mentor' };

  session.switchProvider('openai');
  session.ensureAgent(() => fakeAgent);
  t.is(session.agent, fakeAgent);

  session.reset();
  t.is(session.provider, null);
  t.is(session.agent, null);
  t.is(session.runner, null);
  t.is(session.previousResponseId, null);
});

test('SubagentSession getRunOptions includes maxTurns', (t) => {
  const session = new SubagentSession('id', 'mentor');

  const opts = session.getRunOptions(false, 5);
  t.is(opts.maxTurns, 5);
  t.is(opts.stream, false);
  t.is('previousResponseId' in opts, false);
});

test('SubagentSession getRunOptions omits previousResponseId when chaining is unsupported', (t) => {
  const session = new SubagentSession('id', 'mentor');
  session.switchProvider('openai');
  session.ensureAgent(() => ({ name: 'Mentor' } as any));
  session.addUserMessage('hello');
  session.appendOutput({ responseId: 'resp-1', output: [] });

  const opts = session.getRunOptions(false, 1);
  t.false('previousResponseId' in opts);
});

test('SubagentSession appendOutput tracks previousResponseId', (t) => {
  const session = new SubagentSession('id', 'mentor');
  session.switchProvider('openai');
  session.ensureAgent(() => ({ name: 'Mentor' } as any));
  session.addUserMessage('hello');

  session.appendOutput({ responseId: 'resp-abc', output: [] });
  t.is(session.previousResponseId, 'resp-abc');
});

test('SubagentSession getInput returns task string when chaining is supported', (t) => {
  const session = new SubagentSession('id', 'mentor');
  session.switchProvider('openai');
  session.ensureAgent(() => ({ name: 'Mentor' } as any));
  session.addUserMessage('test question');

  const input = session.getInput('test question', true);
  t.is(input, 'test question');
});

test('SubagentSession getInput returns history array when chaining is unsupported', (t) => {
  const session = new SubagentSession('id', 'mentor');
  session.switchProvider('openrouter');
  session.ensureAgent(() => ({ name: 'Mentor' } as any));
  session.addUserMessage('test question');

  const input = session.getInput('test question', false);
  t.true(Array.isArray(input));
  t.is(input.length, 1);
});
