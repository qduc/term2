import { it, expect } from 'vitest';
import { GenerationGuard } from './generation-guard.js';
import { createSessionRuntimeInternals } from './session/session-composition.js';
import { TurnItemAccumulator } from './session/turn-item-accumulator.js';
import { MockStream } from './test-helpers/mock-stream.js';

it('capture returns a token and increments generation', () => {
  const guard = new GenerationGuard();
  const token = guard.capture();
  expect(token).toBe(1);
  expect(guard.currentGeneration).toBe(1);
});

it('isCurrent returns true for the latest token', () => {
  const guard = new GenerationGuard();
  const token = guard.capture();
  expect(guard.isCurrent(token)).toBe(true);
});

it('isCurrent returns false for an older token', () => {
  const guard = new GenerationGuard();
  const token1 = guard.capture();
  guard.capture();
  expect(guard.isCurrent(token1)).toBe(false);
});

it('isCurrent returns true for zero token when generation is zero', () => {
  const guard = new GenerationGuard();
  expect(guard.isCurrent(0)).toBe(true);
});

it('invalidate bumps generation and invalidates prior tokens', () => {
  const guard = new GenerationGuard();
  const token1 = guard.capture();
  guard.invalidate();
  expect(guard.isCurrent(token1)).toBe(false);
  expect(guard.currentGeneration).toBe(2);
});

it('runIfCurrent executes mutation when token is current', () => {
  const guard = new GenerationGuard();
  const token = guard.capture();
  let called = false;
  const result = guard.runIfCurrent(token, () => {
    called = true;
    return 'ok';
  });
  expect(called).toBe(true);
  expect(result).toBe(true);
});

it('runIfCurrent skips mutation when token is stale', () => {
  const guard = new GenerationGuard();
  const token = guard.capture();
  guard.invalidate();
  let called = false;
  const result = guard.runIfCurrent(token, () => {
    called = true;
  });
  expect(called).toBe(false);
  expect(result).toBe(false);
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
  let capturedContext: any = null;
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
  const composition = createSessionRuntimeInternals({
    sessionId: 'test-session',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
    turnAccumulator: new TurnItemAccumulator(),
  });
  return { turnCoordinator: composition.turnCoordinator, composition };
}

it('integration - undo during active stream work prevents mutation and aborts turn', async () => {
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

  const { turnCoordinator, composition } = setupSession(mockClient);

  const runPromise = (async () => {
    for await (const _ of turnCoordinator.start('hello')) {
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
  expect(assistantTurns.length).toBe(0);
  expect(composition.appState.statusMachine.current).toBe('idle');
});

it('integration - undo while approval is pending invalidates pending approval and prevents continuation', async () => {
  const interruption = createShellInterruption({ callId: 'call-1', command: 'echo hello' });
  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [interruption];
  interruptedStream.state = createApprovalState();

  const mockClient = {
    async startStream() {
      return interruptedStream;
    },
  };

  const { turnCoordinator, composition } = setupSession(mockClient);

  const emitted: any[] = [];
  for await (const event of turnCoordinator.start('trigger tool call')) {
    emitted.push(event);
  }

  expect(composition.appState.statusMachine.current).toBe('awaiting_approval');
  expect(composition.approvalState.getPending()).toBeTruthy();

  // Trigger undo
  composition.stateFacade.undoLastUserTurn();

  // Verify pending approval is cleared and status machine is idle
  expect(composition.approvalState.getPending()).toBeNull();
  expect(composition.appState.statusMachine.current).toBe('idle');

  // Attempting to continue should fail
  await expect(async () => {
    for await (const _ of turnCoordinator.continueAfterApproval({ answer: 'y' })) {
    }
  }).rejects.toThrow('No pending approval to continue.');
});

it('integration - model change during active stream work prevents mutation and aborts turn', async () => {
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

  const { turnCoordinator, composition } = setupSession(mockClient);

  const runPromise = (async () => {
    for await (const _ of turnCoordinator.start('hello')) {
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
  expect(assistantTurns.length).toBe(0);
  expect(composition.appState.statusMachine.current).toBe('idle');
});

it('integration - import during active stream work prevents mutation and aborts turn', async () => {
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

  const { turnCoordinator, composition } = setupSession(mockClient);

  const runPromise = (async () => {
    for await (const _ of turnCoordinator.start('hello')) {
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
  expect(assistantTurns.length).toBe(0);
  expect(composition.appState.statusMachine.current).toBe('idle');
});

it('integration - session clear/reset during active stream work prevents mutation and aborts turn', async () => {
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

  const { turnCoordinator, composition } = setupSession(mockClient);

  const runPromise = (async () => {
    for await (const _ of turnCoordinator.start('hello')) {
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
  expect(assistantTurns.length).toBe(0);
  expect(composition.appState.statusMachine.current).toBe('idle');
});

it('integration - disposal during active stream work prevents mutation and aborts turn', async () => {
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

  const { turnCoordinator, composition } = setupSession(mockClient);

  const runPromise = (async () => {
    for await (const _ of turnCoordinator.start('hello')) {
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
  expect(assistantTurns.length).toBe(0);
  expect(composition.appState.statusMachine.current).toBe('idle');
});

it('integration - aborted-approval input with current token executes resolution continuation', async () => {
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

  const { turnCoordinator, composition } = setupSession(mockClient);

  // Run a command that triggers approval requirement
  const events1: any[] = [];
  for await (const ev of turnCoordinator.start('run command')) {
    events1.push(ev);
  }
  expect(composition.appState.statusMachine.current).toBe('awaiting_approval');

  // Verify pending approval context with a token is set
  const pending = composition.approvalState.getPending();
  expect(pending).toBeTruthy();
  expect(pending!.token).toBeTruthy();

  // Abort it correctly via turnCoordinator.abort()
  turnCoordinator.abort();
  expect(composition.appState.statusMachine.current).toBe('idle');

  // Send resolution user input with the current token (which is in the aborted context)
  const events2: any[] = [];
  for await (const ev of turnCoordinator.start('resolution message')) {
    events2.push(ev);
  }

  // The resolution continuation should be executed, yielding user_message_consumed_for_abort
  expect(events2.some((e: any) => e.type === 'user_message_consumed_for_abort')).toBe(true);
  expect(events2.some((e: any) => e.type === 'text_delta' && e.delta === 'continuation reply')).toBe(true);
});

it('integration - aborted-approval input with stale token is discarded without mutation', async () => {
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

  const { turnCoordinator, composition } = setupSession(mockClient);

  // Run a command that triggers approval requirement
  for await (const _ of turnCoordinator.start('run command')) {
  }
  expect(composition.appState.statusMachine.current).toBe('awaiting_approval');

  // Abort it correctly via turnCoordinator.abort()
  turnCoordinator.abort();

  // Invalidate generation directly
  composition.generationGuard.invalidate();

  // Send new input
  const events: any[] = [];
  for await (const ev of turnCoordinator.start('resolution message')) {
    events.push(ev);
  }

  // It should be discarded immediately, yielding no events
  expect(events.length).toBe(0);
  expect(composition.appState.statusMachine.current).toBe('idle');
});
