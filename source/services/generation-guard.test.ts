import test from 'ava';
import { GenerationGuard } from './generation-guard.js';
import { ConversationSession } from './conversation-session.js';
import { createConversationSessionComposition } from './conversation-session-composition.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { MockStream } from './test-helpers/mock-stream.js';

test('capture returns a token and increments generation', (t) => {
  const guard = new GenerationGuard();
  const token = guard.capture();
  t.is(token, 1);
  t.is(guard.currentGeneration, 1);
});

test('isCurrent returns true for the latest token', (t) => {
  const guard = new GenerationGuard();
  const token = guard.capture();
  t.true(guard.isCurrent(token));
});

test('isCurrent returns false for an older token', (t) => {
  const guard = new GenerationGuard();
  const token1 = guard.capture();
  guard.capture();
  t.false(guard.isCurrent(token1));
});

test('isCurrent returns true for zero token when generation is zero', (t) => {
  const guard = new GenerationGuard();
  t.true(guard.isCurrent(0));
});

test('invalidate bumps generation and invalidates prior tokens', (t) => {
  const guard = new GenerationGuard();
  const token1 = guard.capture();
  guard.invalidate();
  t.false(guard.isCurrent(token1));
  t.is(guard.currentGeneration, 2);
});

test('runIfCurrent executes mutation when token is current', (t) => {
  const guard = new GenerationGuard();
  const token = guard.capture();
  let called = false;
  const result = guard.runIfCurrent(token, () => {
    called = true;
    return 'ok';
  });
  t.true(called);
  t.is(result, true);
});

test('runIfCurrent skips mutation when token is stale', (t) => {
  const guard = new GenerationGuard();
  const token = guard.capture();
  guard.invalidate();
  let called = false;
  const result = guard.runIfCurrent(token, () => {
    called = true;
  });
  t.false(called);
  t.is(result, false);
});

// ── Integration Tests for Invalidation Sources ────────────────────────────

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

const createSessionContextService = () => {
  let capturedContext = null;
  return {
    runWithContext: (context: any, fn: any) => {
      capturedContext = context;
      return fn();
    },
    getContext: () => capturedContext,
  };
};

const createApprovalState = () => ({
  approveCalls: [] as any[],
  rejectCalls: [] as any[],
  approve(interruption: any) {
    this.approveCalls.push(interruption);
  },
  reject(interruption: any) {
    this.rejectCalls.push(interruption);
  },
});

const createShellInterruption = ({ callId, command }: { callId?: string; command: string }) => ({
  name: 'shell',
  agent: { name: 'CLI Agent' },
  arguments: JSON.stringify({ command }),
  ...(callId ? { callId } : {}),
});

function setupSession(mockClient: any) {
  const composition = createConversationSessionComposition({
    sessionId: 'test-session',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
    turnAccumulator: new TurnItemAccumulator(),
  });
  const session = new ConversationSession('test-session', {
    startedAt: new Date().toISOString(),
    composition,
  });
  return { session, composition };
}

test('integration - undo during active stream work prevents mutation and aborts turn', async (t) => {
  let releaseGate: any;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  class GatedStream extends MockStream {
    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'part 1' };
      await gate;
      yield { type: 'response.output_text.delta', delta: 'part 2' };
    }
  }

  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async startStream() {
      const s = new GatedStream([]);
      s.finalOutput = 'part 1part 2';
      s.lastResponseId = 'resp-1';
      return s;
    },
  };

  const { session, composition } = setupSession(mockClient);

  const runPromise = (async () => {
    for await (const _ of session.run('hello')) {
    }
  })();

  await new Promise((r) => setTimeout(r, 10));

  // Trigger undo
  composition.stateFacade.undoLastUserTurn();

  releaseGate();
  await runPromise;

  // Assert mutation safety: history should not contain the assistant's response
  const state = composition.stateFacade.exportState();
  const assistantTurns = state.history.filter((h: any) => h.role === 'assistant');
  t.is(assistantTurns.length, 0, 'No assistant response should be committed');
  t.is(composition.appState.statusMachine.current, 'idle', 'Status should be idle');
});

test('integration - undo while approval is pending invalidates pending approval and prevents continuation', async (t) => {
  const interruption = createShellInterruption({ callId: 'call-1', command: 'echo hello' });
  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [interruption];
  interruptedStream.state = createApprovalState();

  const mockClient = {
    async startStream() {
      return interruptedStream;
    },
  };

  const { session, composition } = setupSession(mockClient);

  const emitted: any[] = [];
  for await (const event of session.run('trigger tool call')) {
    emitted.push(event);
  }

  t.is(composition.appState.statusMachine.current, 'awaiting_approval');
  t.truthy(composition.approvalState.getPending());

  // Trigger undo
  composition.stateFacade.undoLastUserTurn();

  // Verify pending approval is cleared and status machine is idle
  t.is(composition.approvalState.getPending(), null);
  t.is(composition.appState.statusMachine.current, 'idle');

  // Attempting to continue should fail
  await t.throwsAsync(
    async () => {
      for await (const _ of session.continueAfterApproval({ answer: 'y' })) {
      }
    },
    { message: 'No pending approval to continue.' },
  );
});

test.skip('integration - provider change during retry delay aborts retry', async (t) => {
  let startStreamCalls = 0;
  const mockClient = {
    getStreamMaxRetries() {
      return 1;
    },
    async startStream() {
      startStreamCalls++;
      throw new Error('WebSocket connection closed before response completed (code=1006)');
    },
    setProvider(_provider: string) {},
  };

  const { session, composition } = setupSession(mockClient);

  const iterator = session.run('hi')[Symbol.asyncIterator]();

  // Get the retry event
  const firstResult = await iterator.next();
  t.is(firstResult.value.type, 'retry');
  t.is(firstResult.value.retryType, 'upstream');

  // Trigger provider change during the delay
  composition.runtimeController.setProvider('another-provider');

  // Resume iterator: it should detect the stale generation and abort
  const secondResult = await iterator.next();
  t.true(secondResult.done);

  // Assert startStream was only called once
  t.is(startStreamCalls, 1);
});

test('integration - model change during active stream work prevents mutation and aborts turn', async (t) => {
  let releaseGate: any;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  class GatedStream extends MockStream {
    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'part 1' };
      await gate;
      yield { type: 'response.output_text.delta', delta: 'part 2' };
    }
  }

  const mockClient = {
    getProvider() {
      return 'openai';
    },
    setModel(_m: string) {},
    async startStream() {
      const s = new GatedStream([]);
      s.finalOutput = 'part 1part 2';
      s.lastResponseId = 'resp-1';
      return s;
    },
  };

  const { session, composition } = setupSession(mockClient);

  const runPromise = (async () => {
    for await (const _ of session.run('hello')) {
    }
  })();

  await new Promise((r) => setTimeout(r, 10));

  // Trigger model change
  composition.runtimeController.setModel('gpt-next');

  releaseGate();
  await runPromise;

  // Assert mutation safety
  const state = composition.stateFacade.exportState();
  const assistantTurns = state.history.filter((h: any) => h.role === 'assistant');
  t.is(assistantTurns.length, 0, 'No assistant response should be committed');
  t.is(composition.appState.statusMachine.current, 'idle');
});

test('integration - import during active stream work prevents mutation and aborts turn', async (t) => {
  let releaseGate: any;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  class GatedStream extends MockStream {
    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'part 1' };
      await gate;
      yield { type: 'response.output_text.delta', delta: 'part 2' };
    }
  }

  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async startStream() {
      const s = new GatedStream([]);
      s.finalOutput = 'part 1part 2';
      s.lastResponseId = 'resp-1';
      return s;
    },
  };

  const { session, composition } = setupSession(mockClient);

  const runPromise = (async () => {
    for await (const _ of session.run('hello')) {
    }
  })();

  await new Promise((r) => setTimeout(r, 10));

  // Trigger import
  composition.stateFacade.importState({
    history: [],
    previousResponseId: null,
    toolLedger: [],
  });

  releaseGate();
  await runPromise;

  // Assert mutation safety
  const state = composition.stateFacade.exportState();
  const assistantTurns = state.history.filter((h: any) => h.role === 'assistant');
  t.is(assistantTurns.length, 0, 'No assistant response should be committed');
  t.is(composition.appState.statusMachine.current, 'idle');
});

test('integration - session clear/reset during active stream work prevents mutation and aborts turn', async (t) => {
  let releaseGate: any;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  class GatedStream extends MockStream {
    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'part 1' };
      await gate;
      yield { type: 'response.output_text.delta', delta: 'part 2' };
    }
  }

  const mockClient = {
    getProvider() {
      return 'openai';
    },
    clearConversations() {},
    async startStream() {
      const s = new GatedStream([]);
      s.finalOutput = 'part 1part 2';
      s.lastResponseId = 'resp-1';
      return s;
    },
  };

  const { session, composition } = setupSession(mockClient);

  const runPromise = (async () => {
    for await (const _ of session.run('hello')) {
    }
  })();

  await new Promise((r) => setTimeout(r, 10));

  // Trigger reset/clear
  composition.stateFacade.reset();

  releaseGate();
  await runPromise;

  // Assert mutation safety
  const state = composition.stateFacade.exportState();
  const assistantTurns = state.history.filter((h: any) => h.role === 'assistant');
  t.is(assistantTurns.length, 0, 'No assistant response should be committed');
  t.is(composition.appState.statusMachine.current, 'idle');
});

test('integration - disposal during active stream work prevents mutation and aborts turn', async (t) => {
  let releaseGate: any;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  class GatedStream extends MockStream {
    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'part 1' };
      await gate;
      yield { type: 'response.output_text.delta', delta: 'part 2' };
    }
  }

  const mockClient = {
    getProvider() {
      return 'openai';
    },
    abort() {},
    async startStream() {
      const s = new GatedStream([]);
      s.finalOutput = 'part 1part 2';
      s.lastResponseId = 'resp-1';
      return s;
    },
  };

  const { session, composition } = setupSession(mockClient);

  const runPromise = (async () => {
    for await (const _ of session.run('hello')) {
    }
  })();

  await new Promise((r) => setTimeout(r, 10));

  // Trigger disposal
  composition.dispose();

  releaseGate();
  await runPromise;

  // Assert mutation safety
  const state = composition.stateFacade.exportState();
  const assistantTurns = state.history.filter((h: any) => h.role === 'assistant');
  t.is(assistantTurns.length, 0, 'No assistant response should be committed');
  t.is(composition.appState.statusMachine.current, 'idle');
});

test('integration - aborted-approval input with current token executes resolution continuation', async (t) => {
  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [createShellInterruption({ callId: 'c1', command: 'echo hello' })];
  interruptedStream.state = createApprovalState();

  const finalStream = new MockStream([{ type: 'response.output_text.delta', delta: 'continuation reply' }]);
  finalStream.finalOutput = 'continuation reply';

  const mockClient = {
    getProvider() {
      return 'openai';
    },
    abort() {},
    async startStream() {
      return interruptedStream;
    },
    async continueRunStream() {
      return finalStream;
    },
  };

  const { session, composition } = setupSession(mockClient);

  // Run a command that triggers approval requirement
  const events1: any[] = [];
  for await (const ev of session.run('run command')) {
    events1.push(ev);
  }
  t.is(composition.appState.statusMachine.current, 'awaiting_approval');

  // Verify pending approval context with a token is set
  const pending = composition.approvalState.getPending();
  t.truthy(pending);
  t.truthy(pending!.token);

  // Abort it correctly via session.abort()
  session.abort();
  t.is(composition.appState.statusMachine.current, 'idle');

  // Send resolution user input with the current token (which is in the aborted context)
  const events2: any[] = [];
  for await (const ev of session.run('resolution message')) {
    events2.push(ev);
  }

  // The resolution continuation should be executed, yielding user_message_consumed_for_abort
  t.true(events2.some((e: any) => e.type === 'user_message_consumed_for_abort'));
  t.true(events2.some((e: any) => e.type === 'text_delta' && e.delta === 'continuation reply'));
});

test('integration - aborted-approval input with stale token is discarded without mutation', async (t) => {
  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [createShellInterruption({ callId: 'c1', command: 'echo hello' })];
  interruptedStream.state = createApprovalState();

  const mockClient = {
    getProvider() {
      return 'openai';
    },
    abort() {},
    async startStream() {
      return interruptedStream;
    },
  };

  const { session, composition } = setupSession(mockClient);

  // Run a command that triggers approval requirement
  for await (const _ of session.run('run command')) {
  }
  t.is(composition.appState.statusMachine.current, 'awaiting_approval');

  // Abort it correctly via session.abort()
  session.abort();

  // Invalidate generation directly
  composition.generationGuard.invalidate();

  // Send new input
  const events: any[] = [];
  for await (const ev of session.run('resolution message')) {
    events.push(ev);
  }

  // It should be discarded immediately, yielding no events
  t.is(events.length, 0);
  t.is(composition.appState.statusMachine.current, 'idle');
});
