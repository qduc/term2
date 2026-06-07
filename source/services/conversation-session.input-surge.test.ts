import test from 'ava';
import { ConversationSession, type ConversationResult } from './conversation-session.js';

type ApprovalRequiredResult = Extract<ConversationResult, { type: 'approval_required' }>;
type ResponseResult = Extract<ConversationResult, { type: 'response' }>;

const createLogger = () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => 'trace-input-surge-test',
  clearCorrelationId: () => {},
});

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

const makeHistoryItems = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => ({
    role: 'assistant',
    type: 'message',
    content: `${prefix}-${index}`,
  }));

const createApprovalState = () => ({
  approveCalls: [] as unknown[],
  rejectCalls: [] as unknown[],
  approve(interruption: unknown) {
    this.approveCalls.push(interruption);
  },
  reject(interruption: unknown) {
    this.rejectCalls.push(interruption);
  },
});

const createApprovalInterruption = (callId = 'call-1') => ({
  name: 'apply_patch',
  agent: { name: 'CLI Agent' },
  arguments: JSON.stringify({ path: 'source/app.tsx' }),
  callId,
});

class MockStream {
  public readonly events: unknown[];
  public readonly history: unknown[];
  public readonly newItems: unknown[];
  public readonly interruptions: unknown[];
  public readonly state: unknown;
  public readonly lastResponseId: string | null;
  public readonly finalOutput: string;
  public readonly output: unknown[];
  public readonly error: Error | null;

  constructor({
    events = [],
    history = [],
    interruptions = [],
    state = {},
    lastResponseId = 'resp-test',
    finalOutput = 'Done.',
    output = history,
    error = null,
  }: {
    events?: unknown[];
    history?: unknown[];
    interruptions?: unknown[];
    state?: unknown;
    lastResponseId?: string | null;
    finalOutput?: string;
    output?: unknown[];
    error?: Error | null;
  } = {}) {
    this.events = events;
    this.history = history;
    this.newItems = history;
    this.interruptions = interruptions;
    this.state = state;
    this.lastResponseId = lastResponseId;
    this.finalOutput = finalOutput;
    this.output = output;
    this.error = error;
  }

  async *[Symbol.asyncIterator](): AsyncIterable<unknown> {
    for (const event of this.events) {
      yield event;
    }

    if (this.error) {
      throw this.error;
    }
  }
}

const createInterruptedStream = (callId = 'call-1') =>
  new MockStream({ interruptions: [createApprovalInterruption(callId)], state: createApprovalState() });

const createTerminalStream = (historySize: number, label: string) =>
  new MockStream({
    history: makeHistoryItems(historySize, label),
    interruptions: [],
    finalOutput: `${label}-final`,
    lastResponseId: `${label}-resp`,
  });

const createTerminalStreamWithLargeToolResult = (toolResultSize: number, extraItems: number, label: string) =>
  new MockStream({
    history: [
      {
        role: 'user',
        type: 'message',
        content: `${label}-prompt`,
      },
      {
        role: 'assistant',
        type: 'function_call_result',
        callId: `${label}-call`,
        output: 'x'.repeat(toolResultSize),
      },
      ...makeHistoryItems(extraItems, label),
    ],
    interruptions: [],
    finalOutput: `${label}-final`,
    lastResponseId: `${label}-resp`,
  });

const createErrorStream = (error: Error) =>
  new MockStream({
    interruptions: [],
    error,
    lastResponseId: 'resp-error',
  });

const createSessionHarness = ({
  startStreams,
  continuationStreams,
}: {
  startStreams: MockStream[];
  continuationStreams: MockStream[];
}) => {
  let startIndex = 0;
  let continuationIndex = 0;

  const agentClient = {
    getProvider: () => 'test-no-chain-provider',
    setAskUserAnswer: () => {},
    setSubagentEventSink: () => {},
    addToolInterceptor: () => () => {},
    abort: () => {},
    async startStream() {
      const stream = startStreams[startIndex++];
      if (!stream) {
        throw new Error(`Missing startStream stub at index ${String(startIndex - 1)}`);
      }
      return stream;
    },
    async continueRunStream() {
      const stream = continuationStreams[continuationIndex++];
      if (!stream) {
        throw new Error(`Missing continueRunStream stub at index ${String(continuationIndex - 1)}`);
      }
      return stream;
    },
  };

  const session = new ConversationSession('session-input-surge', {
    agentClient: agentClient as any,
    deps: {
      logger: createLogger() as any,
      sessionContextService: createSessionContextService() as any,
    },
  });

  return { session };
};

const seedInputSurgeBaseline = (session: ConversationSession, count = 65) => {
  (session as any).inputSurgeGuard.recordSuccessfulInput(makeHistoryItems(count, 'seed'), { kind: 'full_history' });
};

const expectApprovalRequired = (result: ConversationResult | null): ApprovalRequiredResult => {
  if (!result) {
    throw new Error('Expected approval_required, got null');
  }

  if (result.type !== 'approval_required') {
    throw new Error(`Expected approval_required, got ${result.type}`);
  }

  return result;
};

const expectResponse = (result: ConversationResult | null): ResponseResult => {
  if (!result) {
    throw new Error('Expected response, got null');
  }

  if (result.type !== 'response') {
    throw new Error(`Expected response, got ${result.type}`);
  }

  return result;
};

test('handleApprovalDecision updates the InputSurgeGuard baseline when approval triggers store growth', async (t) => {
  const { session } = createSessionHarness({
    startStreams: [createInterruptedStream(), createTerminalStream(5, 'follow-up')],
    continuationStreams: [createTerminalStream(800, 'approved')],
  });

  seedInputSurgeBaseline(session);

  const firstResult = expectApprovalRequired(await session.sendMessage('please review this patch'));
  t.truthy(firstResult.approval.callId);

  const approvedResult = expectResponse(await session.handleApprovalDecision('y'));
  t.is(approvedResult.finalText, 'approved-final');

  const followUpResult = expectResponse(await session.sendMessage('next turn after approval'));
  t.is(followUpResult.finalText, 'follow-up-final');
});

test('handleApprovalDecision preserves the next-turn pending block for a very large appended tool result', async (t) => {
  const { session } = createSessionHarness({
    startStreams: [createInterruptedStream()],
    continuationStreams: [createTerminalStreamWithLargeToolResult(120_000, 2, 'approved')],
  });

  const firstResult = expectApprovalRequired(await session.sendMessage('approve a tool that returns a huge payload'));
  t.truthy(firstResult.approval.callId);

  const approvedResult = expectResponse(await session.handleApprovalDecision('y'));
  t.is(approvedResult.finalText, 'approved-final');

  const followUpError = await t.throwsAsync(session.sendMessage('next turn after huge tool result'));
  t.regex(followUpError.message, /New tool result added/);
});

test('abort-resolution updates the InputSurgeGuard baseline when a new message resumes a pending approval', async (t) => {
  const { session } = createSessionHarness({
    startStreams: [createInterruptedStream(), createTerminalStream(6, 'follow-up')],
    continuationStreams: [createTerminalStream(800, 'abort-resolved')],
  });

  seedInputSurgeBaseline(session);

  const firstResult = expectApprovalRequired(await session.sendMessage('start a tool run'));
  t.truthy(firstResult.approval.callId);

  session.abort();

  const resolvedResult = expectResponse(await session.sendMessage('replace the pending approval with new input'));
  t.is(resolvedResult.finalText, 'abort-resolved-final');

  const followUpResult = expectResponse(await session.sendMessage('next turn after abort resolution'));
  t.is(followUpResult.finalText, 'follow-up-final');
});

test('abort-resolution preserves the next-turn pending block for a very large appended tool result', async (t) => {
  const { session } = createSessionHarness({
    startStreams: [createInterruptedStream()],
    continuationStreams: [createTerminalStreamWithLargeToolResult(120_000, 2, 'start a tool run that will be aborted')],
  });

  const firstResult = expectApprovalRequired(await session.sendMessage('start a tool run that will be aborted'));
  t.truthy(firstResult.approval.callId);

  session.abort();

  const resolvedResult = expectResponse(await session.sendMessage('replace the pending approval with new input'));
  t.is(resolvedResult.finalText, 'start a tool run that will be aborted-final');

  const followUpError = await t.throwsAsync(session.sendMessage('next turn after aborted huge tool result'));
  t.regex(followUpError.message, /New tool result added/);
});

test.serial(
  'MaxTurnsExceededError catch updates the InputSurgeGuard baseline after tool-led history reconciliation',
  async (t) => {
    // TODO: This path is covered by the production fix, but the synthetic stream
    // harness here does not reliably reproduce the SDK's max-turn reconciliation
    // behavior without additional integration scaffolding.
    const recoveredToolHistory = [
      { role: 'assistant', type: 'function_call', callId: 'call-reconcile', name: 'apply_patch', arguments: '{}' },
      {
        role: 'assistant',
        type: 'function_call_result',
        callId: 'call-reconcile',
        output: 'ok',
      },
      ...makeHistoryItems(198, 'reconciled'),
    ];

    const { session } = createSessionHarness({
      startStreams: [createErrorStream(new Error('Max turns (100) exceeded')), createTerminalStream(5, 'recovered')],
      continuationStreams: [],
    });

    seedInputSurgeBaseline(session, 201);
    (session as any).toolLedger.import([
      {
        turnId: 'turn-1',
        callId: 'call-reconcile',
        toolName: 'apply_patch',
        status: 'completed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        historyItems: recoveredToolHistory,
      },
    ]);

    await t.throwsAsync(session.sendMessage('run until the SDK max-turns limit is reached'));

    const followUpResult = expectResponse(await session.sendMessage('next turn after reconciliation'));
    t.is(followUpResult.finalText, 'recovered-final');
  },
);
