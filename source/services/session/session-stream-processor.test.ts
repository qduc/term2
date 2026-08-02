import { it, expect } from 'vitest';
import { z } from 'zod';
import type { ProviderInputItem as AgentInputItem } from '../../contracts/provider-input.js';
import type { StreamedModelTurn } from '../../contracts/streamed-model-turn.js';
import { ApplicationRunLoop, type ApplicationAgent } from '../agent-runtime/application-run-loop.js';
import { LoggingService } from '../logging/logging-service.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationLogger } from '../logging/conversation-logger.js';
import { ProviderContinuity } from '../provider-continuity.js';
import { OpenAICandidateObserver } from '../openai-candidate-observer.js';
import { DefaultOpenAIRootCheckpointLifecycleObserver } from '../openai-root-checkpoint-lifecycle-observer.js';
import type { AgentStream } from '../agent-stream.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { GenerationGuard } from '../generation-guard.js';
import { DefaultRecoveryExecutor } from '../retry/recovery-executor.js';

const logger = new LoggingService({ disableLogging: true });

const makeJournal = () =>
  ({
    recordTextDelta: () => {},
    recordReasoningDelta: () => {},
    recordRunItem: () => [],
    resetForNewTurn: () => {},
    getEvents: () => [],
    getItems: () => [],
    getCurrentTurnEvents: () => [],
    getCurrentTurnItems: () => [],
    setSink: () => {},
  } as any);

const makeStream = (events: unknown[], extras: Partial<AgentStream> = {}): AgentStream => {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    completed: Promise.resolve(extras.completed ?? null),
    ...extras,
  } as unknown as AgentStream;
};

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

it.each(['delta', 'full_history'] as const)(
  'SessionStreamProcessor.finalize() persists only canonical ApplicationRunLoop items in %s mode',
  async (inputMode) => {
    const conversationStore = new ConversationStore();
    conversationStore.addUserMessage('Use the lookup tool');
    const generationGuard = new GenerationGuard();
    const processor = new SessionStreamProcessor({
      logger,
      sessionId: 'test-session',
      toolTracker: new SessionToolTracker(conversationStore),
      conversationStore,
      conversationLogger: { hasSink: () => false } as ConversationLogger,
      providerContinuity: new ProviderContinuity(),
      generationGuard,
      journal: makeJournal(),
    });
    const agent: ApplicationAgent = {
      name: 'test-agent',
      instructions: 'Be concise.',
      model: 'test-model',
      tools: [
        {
          name: 'lookup',
          description: 'Looks up a fixture.',
          parameters: z.object({}),
          needsApproval: async () => false,
          execute: async () => 'fixture result',
          formatCommandMessage: () => [],
        },
      ] as any,
    };
    const replayInputs: unknown[] = [];
    let modelCalls = 0;
    const loop = new ApplicationRunLoop({
      resolveModel: (): StreamedModelTurn => {
        modelCalls++;
        if (modelCalls === 1) {
          return {
            async *stream() {
              yield {
                type: 'reasoning_delta',
                id: 'rs_fixture',
                text: 'Use the lookup tool.',
                providerMetadata: { codex: { encrypted_content: 'fixture-ciphertext' } },
              };
              yield { type: 'tool_call', id: 'call_fixture', name: 'unknown_lookup', arguments: '{}' };
              yield {
                type: 'completion',
                responseId: 'resp-tool',
                output: [{ type: 'tool_call', id: 'call_fixture', name: 'unknown_lookup', arguments: '{}' }],
              };
            },
          };
        }
        if (modelCalls === 2) {
          return {
            async *stream() {
              yield { type: 'text_delta', text: 'Lookup complete.' };
              yield {
                type: 'completion',
                responseId: 'resp-answer',
                output: [{ type: 'message', content: [{ type: 'text', text: 'Lookup complete.' }] }],
              };
            },
          };
        }
        return {
          async *stream(request) {
            replayInputs.push(request.input);
            yield { type: 'completion', responseId: 'resp-replay', output: [] };
          },
        };
      },
    });

    const stream = loop.startStream(
      agent,
      inputMode === 'delta' ? 'Use the lookup tool' : conversationStore.getHistory(),
    );
    for await (const _ of processor.process(stream, {
      gen: generationGuard.capture(),
      source: 'startStream',
      preserveExistingToolArgs: false,
    })) {
      // Production workflow drains processing before finalization.
    }

    expect(processor.finalize(stream, generationGuard.capture(), inputMode, 'startStream')).toEqual({
      kind: 'committed',
    });
    const persisted = conversationStore.getHistory();
    expect(persisted).toEqual(stream.history);
    expect(persisted).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text_delta' }),
        expect.objectContaining({ type: 'model' }),
        expect.objectContaining({ type: 'run_item_stream_event' }),
      ]),
    );
    expect(persisted).toEqual(
      expect.arrayContaining([
        {
          type: 'reasoning',
          id: 'rs_fixture',
          content: [{ type: 'reasoning_text', text: 'Use the lookup tool.' }],
          providerData: { codex: { encrypted_content: 'fixture-ciphertext' } },
        },
        expect.objectContaining({ type: 'function_call', callId: 'call_fixture', name: 'unknown_lookup' }),
        expect.objectContaining({
          type: 'function_call_result',
          callId: 'call_fixture',
          name: 'unknown_lookup',
          output: 'Unknown tool: unknown_lookup',
        }),
        expect.objectContaining({ type: 'message', role: 'assistant' }),
      ]),
    );
    expect(persisted.filter((item) => item.callId === 'call_fixture')).toHaveLength(2);

    const replay = loop.startStream(agent, persisted);
    await expect(replay.completed).resolves.toBeDefined();
    expect(replayInputs).toEqual([
      expect.arrayContaining([
        {
          type: 'reasoning',
          id: 'rs_fixture',
          text: 'Use the lookup tool.',
          providerMetadata: { codex: { encrypted_content: 'fixture-ciphertext' } },
        },
        expect.objectContaining({ type: 'tool_call', id: 'call_fixture', name: 'unknown_lookup' }),
        expect.objectContaining({ type: 'tool_result', id: 'call_fixture', output: 'Unknown tool: unknown_lookup' }),
      ]),
    ]);
  },
);

it('SessionStreamProcessor.finalize() persists no-tool native reasoning for restored replay', async () => {
  const conversationStore = new ConversationStore();
  conversationStore.addUserMessage('Explain the fixture');
  const generationGuard = new GenerationGuard();
  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'native-reasoning-session',
    toolTracker: new SessionToolTracker(conversationStore),
    conversationStore,
    conversationLogger: { hasSink: () => false } as ConversationLogger,
    providerContinuity: new ProviderContinuity(),
    generationGuard,
    journal: makeJournal(),
  });
  const replayInputs: unknown[] = [];
  let calls = 0;
  const loop = new ApplicationRunLoop({
    resolveModel: (): StreamedModelTurn => {
      calls++;
      if (calls === 1) {
        return {
          async *stream() {
            yield {
              type: 'completion',
              responseId: 'resp-native-answer',
              output: [
                {
                  type: 'reasoning',
                  id: 'rs-native-answer',
                  text: 'Native reasoning for replay.',
                  providerMetadata: { codex: { encrypted_content: 'fixture-ciphertext' } },
                },
                { type: 'message', content: [{ type: 'text', text: 'The fixture is explained.' }] },
              ],
            };
          },
        };
      }
      return {
        async *stream(request) {
          replayInputs.push(request.input);
          yield { type: 'completion', responseId: 'resp-native-replay', output: [] };
        },
      };
    },
  });
  const agent: ApplicationAgent = { name: 'test-agent', instructions: '', model: 'test-model', tools: [] };
  const stream = loop.startStream(agent, 'Explain the fixture');
  for await (const _ of processor.process(stream, {
    gen: generationGuard.capture(),
    source: 'startStream',
    preserveExistingToolArgs: false,
  })) {
    // Drain the production processing path before finalization.
  }
  expect(processor.finalize(stream, generationGuard.capture(), 'delta', 'startStream')).toEqual({ kind: 'committed' });

  const persisted = conversationStore.getHistory();
  expect(persisted.filter((item: any) => item.type === 'reasoning')).toEqual([
    {
      type: 'reasoning',
      id: 'rs-native-answer',
      content: [{ type: 'reasoning_text', text: 'Native reasoning for replay.' }],
      providerData: { codex: { encrypted_content: 'fixture-ciphertext' } },
    },
  ]);

  const replay = loop.startStream(agent, persisted);
  await replay.completed;
  expect(replayInputs).toEqual([
    expect.arrayContaining([
      {
        type: 'reasoning',
        id: 'rs-native-answer',
        text: 'Native reasoning for replay.',
        providerMetadata: { codex: { encrypted_content: 'fixture-ciphertext' } },
      },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'The fixture is explained.' }] },
    ]),
  ]);
});

it('SessionStreamProcessor.process() streams events and updates toolTracker', async () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);

  const loggedEvents: any[] = [];
  const conversationLogger = {
    hasSink: () => true,
    log: (event: any) => loggedEvents.push(event),
  } as unknown as ConversationLogger;

  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();
  const token = generationGuard.capture();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });

  const stream = makeStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'call-1',
          name: 'shell',
          arguments: JSON.stringify({ command: 'ls' }),
        },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call_result',
          callId: 'call-1',
          name: 'shell',
          output: 'file1.txt',
        },
      },
    },
  ]);

  const events: ConversationEvent[] = [];
  const generator = processor.process(stream, {
    gen: token,
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  });

  let acc: any = null;
  while (true) {
    const result = await generator.next();
    if (result.done) {
      acc = result.value;
      break;
    } else {
      events.push(result.value);
    }
  }

  expect(acc).toBeTruthy();
  expect(events.some((e) => e.type === 'tool_started')).toBe(true);
  expect(toolTracker.argumentsById.get('call-1')).toBe(JSON.stringify({ command: 'ls' }));
  expect(loggedEvents.length).toBe(1);
  expect(loggedEvents[0].type).toBe('tool_result');
  expect(loggedEvents[0].callId).toBe('call-1');
  expect(loggedEvents[0].output).toBe('file1.txt');
});

it('SessionStreamProcessor.process() aborts a stream that enters a repeating text pattern', async () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const generationGuard = new GenerationGuard();
  let abortCount = 0;
  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger: { hasSink: () => false } as ConversationLogger,
    providerContinuity: new ProviderContinuity(),
    generationGuard,
    journal: makeJournal(),
    abortStream: () => abortCount++,
  });
  const stream = makeStream([
    {
      type: 'raw_model_stream_event',
      data: { type: 'output_text_delta', delta: 'abc '.repeat(60) },
    },
  ]);

  const consume = async () => {
    for await (const _ of processor.process(stream, {
      gen: generationGuard.capture(),
      source: 'startStream',
      preserveExistingToolArgs: false,
    })) {
      // Consume the stream.
    }
  };

  await expect(consume()).rejects.toMatchObject({ code: 'repetitive_model_output' });
  expect(abortCount).toBe(1);
});

it('SessionStreamProcessor.process() preserves reasoning before recovered tool call history', async () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);

  const loggedEvents: any[] = [];
  const conversationLogger = {
    hasSink: () => true,
    log: (event: any) => loggedEvents.push(event),
  } as unknown as ConversationLogger;

  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();
  const token = generationGuard.capture();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });

  const stream = makeStream([
    {
      type: 'raw_model_stream_event',
      data: { type: 'model', event: { choices: [{ delta: { reasoning_content: 'I should inspect.' } }] } },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'call-1',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'package.json' }),
        },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call_result',
          callId: 'call-1',
          name: 'read_file',
          output: 'contents',
        },
      },
    },
  ]);

  const events: ConversationEvent[] = [];
  const generator = processor.process(stream, {
    gen: token,
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  });
  for (;;) {
    const result = await generator.next();
    if (result.done) break;
    events.push(result.value);
  }

  expect(events.some((event) => event.type === 'reasoning_delta')).toBe(true);
  expect(events.map((event) => event.type)).toEqual(['reasoning_delta', 'tool_started', 'command_message']);
  const historyItems = toolTracker.export()[0].historyItems as Array<Record<string, any>>;
  expect(historyItems.map((item) => item.type)).toEqual(['reasoning', 'function_call', 'function_call_result']);
  expect(historyItems[0].content[0].text).toBe('I should inspect.');
  expect(loggedEvents[0].historyItems).toEqual(historyItems);
});

it('SessionStreamProcessor.process() does not log tool results for startStream source', async () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);

  const loggedEvents: any[] = [];
  const conversationLogger = {
    hasSink: () => true,
    log: (event: any) => loggedEvents.push(event),
  } as unknown as ConversationLogger;

  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();
  const token = generationGuard.capture();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });

  const stream = makeStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call_result',
          callId: 'call-1',
          name: 'shell',
          output: 'file1.txt',
        },
      },
    },
  ]);

  const events: ConversationEvent[] = [];
  const generator = processor.process(stream, {
    gen: token,
    source: 'startStream',
    preserveExistingToolArgs: false,
  });

  for await (const event of generator) {
    events.push(event);
  }

  expect(loggedEvents.length).toBe(0); // Should not log for startStream
});

it('SessionStreamProcessor.process() stops pulling stale stream work after generation invalidation', async () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);

  const loggedEvents: any[] = [];
  const conversationLogger = {
    hasSink: () => true,
    log: (event: any) => loggedEvents.push(event),
  } as unknown as ConversationLogger;

  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });

  const token = generationGuard.capture();
  const stream = makeStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'call-1',
          name: 'shell',
          arguments: JSON.stringify({ command: 'ls' }),
        },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call_result',
          callId: 'call-1',
          name: 'shell',
          output: 'file1.txt',
        },
      },
    },
  ]);

  const generator = processor.process(stream, {
    gen: token,
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  });

  const first = await generator.next();
  expect(first.done).toBe(false);
  expect('type' in first.value).toBe(true);
  expect((first.value as ConversationEvent).type).toBe('tool_started');

  generationGuard.invalidate();

  const second = await generator.next();
  expect(second.done).toBe(true);
  expect(toolTracker.export()[0]?.status).toBe('started');
  expect(loggedEvents.length).toBe(0);
});

it('SessionStreamProcessor.process() ignores a stale tool result that arrives while next() is blocked', async () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);

  const loggedEvents: any[] = [];
  const conversationLogger = {
    hasSink: () => true,
    log: (event: any) => loggedEvents.push(event),
  } as unknown as ConversationLogger;

  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });

  const token = generationGuard.capture();
  const releaseSecond = createDeferred<void>();
  let secondPullStarted = false;

  const stream = {
    [Symbol.asyncIterator]: async function* () {
      yield {
        type: 'run_item_stream_event',
        item: {
          rawItem: {
            type: 'function_call',
            callId: 'call-1',
            name: 'shell',
            arguments: JSON.stringify({ command: 'ls' }),
          },
        },
      };

      secondPullStarted = true;
      await releaseSecond.promise;
      yield {
        type: 'run_item_stream_event',
        item: {
          rawItem: {
            type: 'function_call_result',
            callId: 'call-1',
            name: 'shell',
            output: 'file1.txt',
          },
        },
      };
    },
    completed: Promise.resolve(null),
  } as unknown as AgentStream;

  const generator = processor.process(stream, {
    gen: token,
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  });

  const first = await generator.next();
  expect(first.done).toBe(false);
  expect('type' in first.value).toBe(true);
  expect((first.value as ConversationEvent).type).toBe('tool_started');

  const secondPromise = generator.next();
  await Promise.resolve();
  expect(secondPullStarted).toBe(true);

  generationGuard.invalidate();
  releaseSecond.resolve();

  const second = await secondPromise;
  expect(second.done).toBe(true);
  const ledger = toolTracker.export();
  expect(ledger.length).toBe(1);
  expect(ledger[0]?.callId).toBe('call-1');
  expect(ledger[0]?.status).toBe('started');
  expect(ledger[0]?.output).toBeUndefined();
  expect(ledger[0]?.historyItems).toEqual([
    {
      type: 'function_call',
      callId: 'call-1',
      name: 'shell',
      arguments: JSON.stringify({ command: 'ls' }),
    },
  ]);
  expect(loggedEvents.length).toBe(0);
});

it('SessionStreamProcessor.finalize() updates providerContinuity previousResponseId', async () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });

  const token = generationGuard.capture();
  const stream = makeStream([], {
    interruptions: [],
    lastResponseId: 'resp-123',
  });

  const result = processor.finalize(stream, token, 'delta', 'startStream');

  expect(result).toEqual({ kind: 'committed' });
  expect(providerContinuity.previousResponseId).toBe('resp-123');
});

it('SessionStreamProcessor.finalize() promotes a matching checkpoint only after terminal history commit', () => {
  const conversationStore = new ConversationStore();
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();
  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker: new SessionToolTracker(conversationStore),
    conversationStore,
    conversationLogger: {} as ConversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });
  providerContinuity.observeCandidate({
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 0, identity: 'history:0' },
    responseId: 'resp-commit',
  });
  const stream = makeStream([], { interruptions: [], lastResponseId: 'resp-commit' });
  (stream as any).output = [{ role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'done' }] }];

  expect(processor.finalize(stream, generationGuard.capture(), 'delta', 'startStream')).toEqual({ kind: 'committed' });
  expect(conversationStore.getHistory()).toHaveLength(1);
  expect(providerContinuity.previousResponseId).toBe('resp-commit');
  expect(providerContinuity.checkpoint?.state).toBe('accepted');
  expect(providerContinuity.checkpoint?.successorProof).toMatchObject({
    revision: 1,
    history: [{ role: 'assistant', type: 'message' }],
  });
  expect(Object.isFrozen(providerContinuity.checkpoint?.successorProof?.history)).toBe(true);
});

it('records only sanitized publication outcomes for an observed candidate', () => {
  const makeProcessor = () => {
    const conversationStore = new ConversationStore();
    const providerContinuity = new ProviderContinuity();
    const generationGuard = new GenerationGuard();
    const evidence: unknown[] = [];
    const lifecycle = new DefaultOpenAIRootCheckpointLifecycleObserver();
    lifecycle.setEvidenceRecorder((value) => evidence.push(value));
    const processor = new SessionStreamProcessor({
      logger,
      sessionId: 'test-session',
      toolTracker: new SessionToolTracker(conversationStore),
      conversationStore,
      conversationLogger: {} as ConversationLogger,
      providerContinuity,
      openAIRootCheckpointLifecycleObserver: lifecycle,
      generationGuard,
      journal: makeJournal(),
    });
    providerContinuity.observeCandidate({
      identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
      prefix: { revision: 0, identity: 'history:0' },
      responseId: 'resp-candidate',
    });
    return { processor, generationGuard, evidence };
  };

  const promoted = makeProcessor();
  const output: any = [{ role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'done' }] }];
  promoted.processor.finalize(
    makeStream([], { interruptions: [], lastResponseId: 'resp-candidate', output }),
    promoted.generationGuard.capture(),
    'delta',
    'startStream',
  );
  expect(promoted.evidence).toEqual([
    { type: 'openai_root_checkpoint_lifecycle', version: 1, stage: 'publication', outcome: 'promoted' },
  ]);

  const noCommit = makeProcessor();
  noCommit.processor.finalize(
    makeStream([], { interruptions: [], lastResponseId: 'resp-candidate' }),
    noCommit.generationGuard.capture(),
    'delta',
    'startStream',
  );
  expect(noCommit.evidence).toEqual([
    { type: 'openai_root_checkpoint_lifecycle', version: 1, stage: 'publication', outcome: 'history_not_committed' },
  ]);

  const mismatch = makeProcessor();
  mismatch.processor.finalize(
    makeStream([], { interruptions: [], lastResponseId: 'resp-other', output }),
    mismatch.generationGuard.capture(),
    'delta',
    'startStream',
  );
  expect(mismatch.evidence).toEqual([
    { type: 'openai_root_checkpoint_lifecycle', version: 1, stage: 'publication', outcome: 'candidate_not_promoted' },
  ]);
});

it('promotes only an observer candidate whose terminal response commits before its lineage is reset', () => {
  const createHarness = () => {
    const conversationStore = new ConversationStore();
    const providerContinuity = new ProviderContinuity();
    const generationGuard = new GenerationGuard();
    return {
      conversationStore,
      providerContinuity,
      generationGuard,
      observer: new OpenAICandidateObserver(providerContinuity),
      processor: new SessionStreamProcessor({
        logger,
        sessionId: 'test-session',
        toolTracker: new SessionToolTracker(conversationStore),
        conversationStore,
        conversationLogger: {} as ConversationLogger,
        providerContinuity,
        generationGuard,
        journal: makeJournal(),
      }),
    };
  };
  const observe = (observer: OpenAICandidateObserver, responseId: string, lineage = 0) =>
    observer.observe({
      token: 'attempt',
      provider: 'openai',
      transport: 'http',
      model: 'gpt-5',
      endpoint: 'responses',
      requestData: {},
      phase: 'terminal',
      responseId,
      prefixBinding: { snapshotIdentity: 'history:0', snapshotRevision: 0, lineage },
    });
  const output: any = [{ role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'done' }] }];

  const matched = createHarness();
  observe(matched.observer, 'resp-match');
  expect(
    matched.processor.finalize(
      makeStream([], { interruptions: [], lastResponseId: 'resp-match', output }),
      matched.generationGuard.capture(),
      'delta',
      'startStream',
    ),
  ).toEqual({ kind: 'committed' });
  expect(matched.conversationStore.getHistory()).toHaveLength(1);
  expect(matched.providerContinuity.checkpoint?.state).toBe('accepted');

  const mismatched = createHarness();
  observe(mismatched.observer, 'resp-candidate');
  mismatched.processor.finalize(
    makeStream([], { interruptions: [], lastResponseId: 'resp-other', output }),
    mismatched.generationGuard.capture(),
    'delta',
    'startStream',
  );
  expect(mismatched.providerContinuity.checkpoint?.state).toBe('candidate');
  expect(mismatched.providerContinuity.checkpoint?.successorProof).toBeUndefined();

  const stale = createHarness();
  observe(stale.observer, 'resp-stale');
  const token = stale.generationGuard.capture();
  stale.providerContinuity.clear();
  stale.generationGuard.invalidate();
  expect(
    stale.processor.finalize(
      makeStream([], { interruptions: [], lastResponseId: 'resp-stale', output }),
      token,
      'delta',
      'startStream',
    ),
  ).toEqual({ kind: 'stale' });
  expect(stale.providerContinuity.checkpoint).toBeNull();
});

it('SessionStreamProcessor.finalize() cannot promote a candidate from an empty terminal finalization', () => {
  const conversationStore = new ConversationStore();
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();
  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker: new SessionToolTracker(conversationStore),
    conversationStore,
    conversationLogger: {} as ConversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });
  providerContinuity.observeCandidate({
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 0, identity: 'history:0' },
    responseId: 'resp-no-op',
  });

  expect(
    processor.finalize(
      makeStream([], { interruptions: [], lastResponseId: 'resp-no-op' }),
      generationGuard.capture(),
      'delta',
      'startStream',
    ),
  ).toEqual({ kind: 'committed' });
  expect(conversationStore.getHistory()).toHaveLength(0);
  expect(providerContinuity.checkpoint?.state).toBe('candidate');
  expect(providerContinuity.checkpoint?.successorProof).toBeUndefined();
});

it('SessionStreamProcessor.finalize() ignores a genuinely stale post-reset completion', () => {
  const conversationStore = new ConversationStore();
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();
  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker: new SessionToolTracker(conversationStore),
    conversationStore,
    conversationLogger: {} as ConversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });
  providerContinuity.observeCandidate({
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    prefix: { revision: 0, identity: 'history:0' },
    responseId: 'resp-late',
  });
  const staleToken = generationGuard.capture();
  providerContinuity.clear();
  generationGuard.invalidate();
  const stream = makeStream([], { interruptions: [], lastResponseId: 'resp-late' });
  (stream as any).output = [{ role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'late' }] }];

  expect(processor.finalize(stream, staleToken, 'delta', 'startStream')).toEqual({ kind: 'stale' });
  expect(conversationStore.getHistory()).toEqual([]);
  expect(providerContinuity.previousResponseId).toBeNull();
  expect(providerContinuity.checkpoint).toBeNull();
  expect(providerContinuity.retiredCheckpoints).toHaveLength(1);
});

it('SessionStreamProcessor.finalize() prefers full replay history when full-history output only contains tool results', () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });

  const fullHistory = [
    { role: 'user', type: 'message', content: 'Inspect the logs' },
    { type: 'function_call', callId: 'call-read', name: 'read_file', arguments: '{}' },
    { type: 'function_call_output', callId: 'call-read', output: 'log contents' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'I found the problem.' }],
    },
  ];

  const token = generationGuard.capture();
  const stream = makeStream([], {
    interruptions: [],
    lastResponseId: 'resp-123',
  });
  (stream as any).history = fullHistory;
  (stream as any).output = [{ type: 'function_call_output', callId: 'call-read', output: 'log contents' }];
  (stream as any).newItems = [];

  const result = processor.finalize(stream, token, 'full_history', 'startStream');

  expect(result).toEqual({ kind: 'committed' });
  expect(conversationStore.getHistory()).toEqual(fullHistory);
});

it('SessionStreamProcessor.finalize() prefers canonical newItems over conflicting output and cumulative history', () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const generationGuard = new GenerationGuard();
  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger: {} as ConversationLogger,
    providerContinuity: new ProviderContinuity(),
    generationGuard,
    journal: makeJournal(),
  });
  const canonicalItems = [
    { type: 'function_call', callId: 'call-new', name: 'read_file', arguments: '{}' },
    { type: 'function_call_output', callId: 'call-new', output: 'new result' },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'Canonical answer' }],
    },
  ];
  const conflictingOutput = [
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'Output-only answer' }],
    },
  ];
  const stream = makeStream([], { interruptions: [] });
  (stream as any).newItems = canonicalItems;
  (stream as any).output = conflictingOutput;
  (stream as any).history = [
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Prior answer' }] },
    ...canonicalItems,
  ];

  expect(processor.finalize(stream, generationGuard.capture(), 'full_history', 'continueRunStream')).toEqual({
    kind: 'committed',
  });
  expect(conversationStore.getHistory()).toEqual(canonicalItems);
});

it('SessionStreamProcessor.finalize() detects wrapped messages and retains the offered provider objects', () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const generationGuard = new GenerationGuard();
  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger: {} as ConversationLogger,
    providerContinuity: new ProviderContinuity(),
    generationGuard,
    journal: makeJournal(),
  });
  const wrappedAssistant = {
    rawItem: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Kept as wrapped' }] },
  };
  const stream = makeStream([], { interruptions: [] });
  (stream as any).output = [wrappedAssistant];
  (stream as any).newItems = [];
  (stream as any).history = [];

  expect(processor.finalize(stream, generationGuard.capture(), 'full_history', 'startStream')).toEqual({
    kind: 'committed',
  });
  expect(conversationStore.getHistory()).toEqual([wrappedAssistant]);
});

it('SessionStreamProcessor.finalize() appends tool-result-only output when full-history replay snapshot has no messages', () => {
  const conversationStore = new ConversationStore();
  conversationStore.addUserMessage('Initial request');
  conversationStore.appendOutput([
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Baseline response' }],
    } as any,
  ]);

  const baselineHistory = conversationStore.getHistory();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });

  const token = generationGuard.capture();
  const stream = makeStream([], {
    interruptions: [],
    lastResponseId: 'resp-456',
  });
  (stream as any).history = [
    { type: 'function_call_output', callId: 'call-1', output: 'tool result 1' },
    { type: 'function_call_output', callId: 'call-2', output: 'tool result 2' },
  ];
  (stream as any).output = [{ type: 'function_call_output', callId: 'call-2', output: 'tool result 2' }];
  (stream as any).newItems = [];

  const result = processor.finalize(stream, token, 'full_history', 'continueRunStream');

  expect(result).toEqual({ kind: 'committed' });
  expect(conversationStore.getHistory()).toEqual([
    ...baselineHistory,
    { type: 'function_call_output', callId: 'call-2', output: 'tool result 2' },
  ]);
});

it('SessionStreamProcessor.finalize() appends tool results in full-history mode so retry can locate them', () => {
  const conversationStore = new ConversationStore();
  conversationStore.addUserMessage('Run the tool');
  conversationStore.appendOutput([
    { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' } as AgentInputItem,
  ]);

  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });

  const token = generationGuard.capture();
  const stream = makeStream([], {
    interruptions: [],
    lastResponseId: 'resp-789',
  });
  (stream as any).history = [{ type: 'function_call_output', callId: 'call-1', output: 'tool result' }];
  (stream as any).output = [{ type: 'function_call_output', callId: 'call-1', output: 'tool result' }];
  (stream as any).newItems = [];

  const result = processor.finalize(stream, token, 'full_history', 'continueRunStream');

  expect(result).toEqual({ kind: 'committed' });
  expect(conversationStore.getHistory().map((item: any) => item.type)).toEqual([
    'message',
    'function_call',
    'function_call_output',
  ]);
  expect(conversationStore.peekLastToolOutput()).toEqual({
    index: 2,
    itemType: 'function_call_output',
    callId: 'call-1',
    toolName: undefined,
    output: 'tool result',
  });
});

it('SessionStreamProcessor.finalize() does not re-append tool call/result pairs already in history across resumes', () => {
  const conversationStore = new ConversationStore();
  conversationStore.addUserMessage('Run the tools');

  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });

  // Each approval resume carries the whole run's generated items forward, so
  // the pairs from earlier segments reappear in every later stream output.
  const pair = (callId: string) => [
    { type: 'function_call', callId, name: 'shell', arguments: '{}' },
    { type: 'function_call_output', callId, output: `result for ${callId}` },
  ];

  const resumeSegments = [
    [...pair('call-1')],
    [...pair('call-1'), ...pair('call-2')],
    [...pair('call-1'), ...pair('call-2'), ...pair('call-3')],
  ];

  for (const segment of resumeSegments) {
    const token = generationGuard.capture();
    const stream = makeStream([], { interruptions: [], lastResponseId: 'resp-1' });
    (stream as any).history = segment;
    (stream as any).output = segment;
    (stream as any).newItems = segment;

    expect(processor.finalize(stream, token, 'full_history', 'continueRunStream')).toEqual({ kind: 'committed' });
  }

  const committedCallIds = conversationStore
    .getHistory()
    .filter((item: any) => item.type === 'function_call' || item.type === 'function_call_output')
    .map((item: any) => `${item.type}:${item.callId}`);

  expect(committedCallIds).toEqual([
    'function_call:call-1',
    'function_call_output:call-1',
    'function_call:call-2',
    'function_call_output:call-2',
    'function_call:call-3',
    'function_call_output:call-3',
  ]);
});

it('SessionStreamProcessor.finalize() dedupes equivalent wrapped, canonical, and provider result representations', () => {
  const conversationStore = new ConversationStore();
  conversationStore.appendOutput([
    {
      rawItem: { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' },
    } as unknown as AgentInputItem,
    {
      type: 'tool_result',
      callId: 'call-1',
      toolName: 'shell',
      status: 'completed',
      output: 'first result',
    } as unknown as AgentInputItem,
  ]);
  const toolTracker = new SessionToolTracker(conversationStore);
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();
  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger: {} as ConversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });
  const providerItem = {
    rawItem: {
      type: 'function_call_result',
      callId: 'call-2',
      name: 'shell',
      output: 'second result',
      provider_field: 'preserved',
    },
  };
  const stream = makeStream([], { interruptions: [], lastResponseId: 'resp-1' });
  (stream as any).output = [
    { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: '{}' },
    { type: 'function_call_output', callId: 'call-1', output: 'first result' },
    providerItem,
  ];

  expect(processor.finalize(stream, generationGuard.capture(), 'delta', 'continueRunStream')).toEqual({
    kind: 'committed',
  });
  expect(conversationStore.getHistory()).toEqual([
    {
      rawItem: { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' },
    },
    {
      type: 'tool_result',
      callId: 'call-1',
      toolName: 'shell',
      status: 'completed',
      output: 'first result',
    },
    providerItem,
  ]);
});

it('SessionStreamProcessor.finalize() - stale finalization mutates neither continuity nor history and returns stale', () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });

  const staleToken = generationGuard.capture();
  generationGuard.invalidate(); // invalidates staleToken

  const stream = makeStream([], {
    interruptions: [],
    lastResponseId: 'resp-123',
  });
  (stream as any).output = [{ role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'hello' }] }];

  const result = processor.finalize(stream, staleToken, 'delta', 'startStream');

  expect(result).toEqual({ kind: 'stale' });
  expect(providerContinuity.previousResponseId).toBeNull();
  expect(conversationStore.getHistory().length).toBe(0);
});

it('SessionStreamProcessor.finalize() - interrupted stream returns partial, updates continuity, but does not commit terminal history', () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal: makeJournal(),
  });

  const token = generationGuard.capture();

  const stream = makeStream([], {
    interruptions: [{ type: 'tool_approval_item' }] as any,
    lastResponseId: 'resp-123',
  });
  (stream as any).output = [{ role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'hello' }] }];

  const result = processor.finalize(stream, token, 'delta', 'startStream');

  expect(result).toEqual({ kind: 'partial' });
  expect(providerContinuity.previousResponseId).toBe('resp-123');
  expect(conversationStore.getHistory().length).toBe(0); // Should not commit history
});

it('SessionStreamProcessor.process() feeds every raw run item into the journal', async () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = { hasSink: () => false } as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();
  const token = generationGuard.capture();

  const journalItems: unknown[] = [];
  const journal = {
    recordRunItem: (item: unknown) => {
      journalItems.push(item);
    },
  } as any;

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal,
  });

  const stream = makeStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: { type: 'function_call_result', callId: 'call-1', name: 'shell', output: 'ok' },
      },
    },
  ]);

  for await (const _ of processor.process(stream, {
    gen: token,
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  })) {
    // drain
  }

  // Both raw run items should have been fed to the journal.
  expect(journalItems.length).toBe(2);
  expect((journalItems[0] as any).rawItem.type).toBe('function_call');
  expect((journalItems[1] as any).rawItem.type).toBe('function_call_result');
});

it('SessionStreamProcessor.process() records completed outputs in the live ledger before fresh recovery', async () => {
  const conversationStore = new ConversationStore();
  conversationStore.addUserMessage('run both commands');
  const toolTracker = new SessionToolTracker(conversationStore);
  toolTracker.beginTurn();
  const generationGuard = new GenerationGuard();
  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger: { hasSink: () => false } as ConversationLogger,
    providerContinuity: new ProviderContinuity(),
    generationGuard,
    journal: makeJournal(),
  });
  const stream = makeStream([
    {
      type: 'run_item_stream_event',
      item: { rawItem: { type: 'function_call', callId: 'call-a', name: 'shell', arguments: '{}' } },
    },
    {
      type: 'run_item_stream_event',
      item: { rawItem: { type: 'function_call_result', callId: 'call-a', output: 'a' } },
    },
    {
      type: 'run_item_stream_event',
      item: { rawItem: { type: 'function_call', callId: 'call-b', name: 'shell', arguments: '{}' } },
    },
    {
      type: 'run_item_stream_event',
      item: { rawItem: { type: 'function_call_result', callId: 'call-b', output: 'b' } },
    },
  ]);

  for await (const _ of processor.process(stream, {
    gen: generationGuard.capture(),
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  })) {
    // Drain the public stream events before simulating the following request failure.
  }

  expect(toolTracker.completedResultCallIdsForCurrentTurn()).toEqual(['call-a', 'call-b']);
  expect(toolTracker.export()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ callId: 'call-a', status: 'completed', output: 'a' }),
      expect.objectContaining({ callId: 'call-b', status: 'completed', output: 'b' }),
    ]),
  );

  new DefaultRecoveryExecutor({
    toolTracker,
    conversationStore,
    providerContinuity: new ProviderContinuity(),
  }).apply({
    plan: { kind: 'retry_fresh', inputMode: 'full_history' },
    state: {
      journalSnapshot: [],
      addedUserMessage: false,
      stream: { completed: Promise.resolve(null) } as unknown as AgentStream,
    },
    retryCounts: {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    },
  });

  expect(
    conversationStore
      .getHistory()
      .map((item: any) => item.callId)
      .filter(Boolean),
  ).toEqual(['call-a', 'call-a', 'call-b', 'call-b']);
});

it('SessionStreamProcessor.process() drops journal writes after generation invalidation', async () => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = { hasSink: () => false } as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const journalItems: unknown[] = [];
  const journal = {
    recordRunItem: (item: unknown) => {
      journalItems.push(item);
    },
  } as any;

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal,
  });

  const token = generationGuard.capture();
  const stream = makeStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: { type: 'function_call_result', callId: 'call-1', name: 'shell', output: 'ok' },
      },
    },
  ]);

  const generator = processor.process(stream, {
    gen: token,
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  });

  // Drain the first event (tool_started).
  await generator.next();
  // Invalidate the generation so subsequent journal writes are dropped.
  generationGuard.invalidate();
  // Drain the rest. The second run_item_stream_event is processed after
  // invalidation and must not be fed to the journal.
  while (true) {
    const r = await generator.next();
    if (r.done) break;
  }

  // Only the first raw item was committed to the journal; the second was dropped.
  expect(journalItems.length).toBe(1);
  expect((journalItems[0] as any).rawItem.type).toBe('function_call');
});
