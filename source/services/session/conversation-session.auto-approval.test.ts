import { it, expect } from 'vitest';
import { type ConversationEvent } from '../conversation/conversation-events.js';
import { type ConversationTerminal } from '../../contracts/conversation.js';
import { createConversationSession } from '../../test-helpers/conversation-session-with-adapter.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';

type ApprovalRequiredResult = Extract<ConversationTerminal, { type: 'approval_required' }>;
type ResponseResult = Extract<ConversationTerminal, { type: 'response' }>;

const createMockLogger = () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => 'trace-auto-approval-test',
  clearCorrelationId: () => {},
});

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

class MockStream {
  public readonly events: unknown[];
  public completed: Promise<unknown>;
  public lastResponseId: string | null;
  public interruptions: unknown[];
  public state: unknown;
  public newItems: unknown[];
  public history: unknown[];
  public finalOutput: string;

  constructor(events: unknown[] = []) {
    this.events = events;
    this.completed = Promise.resolve(undefined);
    this.lastResponseId = 'resp-test';
    this.interruptions = [];
    this.state = {};
    this.newItems = [];
    this.history = [];
    this.finalOutput = '';
  }

  async *[Symbol.asyncIterator](): AsyncIterable<unknown> {
    for (const event of this.events) {
      yield event;
    }
  }
}

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

const createShellInterruption = ({
  callId,
  command,
  toolName = 'shell',
}: {
  callId?: string;
  command: string;
  toolName?: 'shell' | 'bash';
}) => ({
  name: toolName,
  agent: { name: 'CLI Agent' },
  arguments: JSON.stringify({ command }),
  ...(callId ? { callId } : {}),
});

const createNonShellInterruption = ({
  callId,
  toolName = 'apply_patch',
  argumentsValue = { path: 'source/app.tsx' },
}: {
  callId?: string;
  toolName?: string;
  argumentsValue?: Record<string, unknown>;
}) => ({
  name: toolName,
  agent: { name: 'CLI Agent' },
  arguments: JSON.stringify(argumentsValue),
  ...(callId ? { callId } : {}),
});

const createInterruptedStream = (interruptions: unknown[]) => {
  const stream = new MockStream();
  stream.interruptions = interruptions;
  stream.state = createApprovalState();
  return stream;
};

const createFinalStream = (finalOutput = 'Done.') => {
  const stream = new MockStream();
  stream.finalOutput = finalOutput;
  return stream;
};

const getApprovalResult = (result: ConversationTerminal | null): ApprovalRequiredResult => {
  expect(result).toBeTruthy();
  expect(result?.type).toBe('approval_required');
  if (!result || result.type !== 'approval_required') {
    throw new Error('Expected approval_required result');
  }

  return result;
};

const getResponseResult = (result: ConversationTerminal | null): ResponseResult => {
  expect(result).toBeTruthy();
  expect(result?.type).toBe('response');
  if (!result || result.type !== 'response') {
    throw new Error('Expected response result');
  }

  return result;
};

const createSessionHarness = ({
  settingsOverrides = {},
  startStreams = [],
  continuationStreams = [],
  chatImpl,
}: {
  settingsOverrides?: Record<string, unknown>;
  startStreams?: MockStream[];
  continuationStreams?: MockStream[];
  chatImpl?: (prompt: string, options: Record<string, unknown>) => Promise<string> | string;
}) => {
  const chatCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const askUserAnswerCalls: Array<{ callId: string; answer: string }> = [];
  let startIndex = 0;
  let continuationIndex = 0;

  const agentClient = {
    setAskUserAnswer(callId: string, answer: string) {
      askUserAnswerCalls.push({ callId, answer });
    },
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
    async chat(prompt: string, options: Record<string, unknown>) {
      chatCalls.push({ prompt, options });
      if (!chatImpl) {
        throw new Error('Unexpected chat() call');
      }

      return chatImpl(prompt, options);
    },
  };

  const bundle = createConversationSession({
    sessionId: 'session-auto-approval',
    agentClient: agentClient as any,
    deps: {
      logger: createMockLogger(),
      settingsService: createMockSettingsService({
        'shell.autoApproveMode': 'advisory',
        'agent.autoApproveModel': 'test-auto-model',
        'agent.autoApproveProvider': 'test-auto-provider',
        ...settingsOverrides,
      }),
      sessionContextService: createSessionContextService() as any,
    },
  });

  return { bundle, chatCalls, askUserAnswerCalls };
};

const testMalformedResponse = async ({
  llmResponse,
  expectedReasoning,
}: {
  llmResponse: string;
  expectedReasoning: string;
}) => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-safe', command: 'ls source' }),
  ]);
  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    chatImpl: async () => llmResponse,
  });

  const result = await bundle.terminalAdapter.sendMessage('inspect the source tree');
  const approval = getApprovalResult(result).approval;

  expect(approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: expectedReasoning,
    approved: false,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(2);
  expect(chatCalls[1].prompt.includes('The previous shell auto-approval response was invalid.')).toBe(true);
};

it('shell auto-approval off skips advisory evaluation and omits llmAdvisory', async () => {
  const first = createShellInterruption({ callId: 'call-off-1', command: 'ls source' });
  const second = createShellInterruption({ callId: 'call-off-2', command: 'pwd' });

  const initialStream = createInterruptedStream([first, second]);
  const continuationStream = createInterruptedStream([second]);

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'off' },
    startStreams: [initialStream],
    continuationStreams: [continuationStream],
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the project');
  const firstApproval = getApprovalResult(firstResult).approval;
  expect(firstApproval.llmAdvisory).toBe(undefined);

  const secondResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  const secondApproval = getApprovalResult(secondResult).approval;
  expect(secondApproval.llmAdvisory).toBe(undefined);
  expect(chatCalls.length).toBe(0);
});

it('RED-classified shell command includes LLM rationale but remains a system rejection advisory', async () => {
  const initialStream = createInterruptedStream([createShellInterruption({ callId: 'call-red', command: 'rm -rf /' })]);
  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    chatImpl: async (prompt) => {
      expect(prompt.includes('rm -rf /')).toBe(true);
      return JSON.stringify({
        results: [
          {
            id: 'call-red',
            reasoning: 'This command recursively deletes files from the filesystem root.',
            approved: false,
          },
        ],
      });
    },
  });

  const result = await bundle.terminalAdapter.sendMessage('clean up the machine');
  const approval = getApprovalResult(result).approval;

  const llmAdvisory = approval.llmAdvisory;
  expect(llmAdvisory).toBeTruthy();
  expect(llmAdvisory?.approved).toBe(false);
  expect(llmAdvisory?.model).toBe('test-auto-model');
  expect(llmAdvisory?.source).toBe('system');
  expect(llmAdvisory?.reasoning ?? '').toMatch(/Blocked by safety heuristics \(RED\):/);
  expect(llmAdvisory?.reasoning ?? '').toMatch(/Model advisory: This command recursively deletes files/);
  expect(chatCalls.length).toBe(1);
});

it('single safe shell command calls the LLM once and attaches its advisory', async () => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-safe-1', command: 'ls source' }),
  ]);
  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [
          {
            id: 'call-safe-1',
            reasoning: 'Listing the source folder is read-only and matches the request.',
            approved: true,
          },
        ],
      }),
  });

  const result = await bundle.terminalAdapter.sendMessage('inspect the source tree');
  const approval = getApprovalResult(result).approval;

  expect(approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'Listing the source folder is read-only and matches the request.',
    approved: true,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(1);
  expect(chatCalls[0].prompt.includes('ls source')).toBe(true);
  expect(chatCalls[0].prompt.includes('inspect the source tree')).toBe(true);
  expect(chatCalls[0].options.model).toBe('test-auto-model');
  expect(chatCalls[0].options.provider).toBe('test-auto-provider');
  expect(chatCalls[0].options.reasoningEffort).toBe('none');
});

it('batch evaluation calls the LLM once and reuses cached advisories across sequential approvals', async () => {
  const first = createShellInterruption({ callId: 'call-batch-1', command: 'ls source' });
  const second = createShellInterruption({ callId: 'call-batch-2', command: 'pwd' });
  const third = createShellInterruption({ callId: 'call-batch-3', command: 'git status' });

  const initialStream = createInterruptedStream([first, second, third]);
  const finalContinuation = createFinalStream('All commands handled.');

  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [finalContinuation],
    chatImpl: async () =>
      JSON.stringify({
        results: [
          { id: 'call-batch-1', reasoning: 'Listing files is safe.', approved: true },
          { id: 'call-batch-2', reasoning: 'Printing the working directory is safe.', approved: true },
          { id: 'call-batch-3', reasoning: 'Reading git status is safe.', approved: true },
        ],
      }),
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the repository');
  expect(getApprovalResult(firstResult).approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'Listing files is safe.',
    approved: true,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(1);

  const secondResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  expect(getApprovalResult(secondResult).approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'Printing the working directory is safe.',
    approved: true,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(1);

  const thirdResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  expect(getApprovalResult(thirdResult).approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'Reading git status is safe.',
    approved: true,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(1);

  const finalResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  expect(getResponseResult(finalResult).finalText).toBe('All commands handled.');
  expect(chatCalls.length).toBe(1);
});

it('handleApprovalDecision forwards approval answers to the ask_user bridge', async () => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-ask-user', command: 'echo awaiting approval' }),
  ]);
  const finalStream = createFinalStream('Approved command completed.');

  const { bundle, askUserAnswerCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [finalStream],
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('please continue');
  getApprovalResult(firstResult);

  const finalResult = await bundle.terminalAdapter.handleApprovalDecision('y', undefined, {
    approvalAnswer: 'Use option B',
  });
  expect(getResponseResult(finalResult).finalText).toBe('Approved command completed.');
  expect(askUserAnswerCalls).toEqual([{ callId: 'call-ask-user', answer: 'Use option B' }]);
});

it('mixed RED and non-RED batch evaluates both while RED remains system rejected', async () => {
  const red = createShellInterruption({ callId: 'call-mixed-red', command: 'rm -rf /' });
  const safe = createShellInterruption({ callId: 'call-mixed-safe', command: 'ls source' });

  const initialStream = createInterruptedStream([red, safe]);
  const continuationStream = createInterruptedStream([safe]);

  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [continuationStream],
    chatImpl: async (prompt) => {
      expect(prompt.includes('rm -rf /')).toBe(true);
      expect(prompt.includes('ls source')).toBe(true);
      return JSON.stringify({
        results: [
          {
            id: 'call-mixed-red',
            reasoning: 'Recursive forced deletion from root is destructive.',
            approved: false,
          },
          {
            id: 'call-mixed-safe',
            reasoning: 'Listing source files is safe.',
            approved: true,
          },
        ],
      });
    },
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the repository');
  const mixedAdvisory = getApprovalResult(firstResult).approval.llmAdvisory;
  expect(mixedAdvisory).toBeTruthy();
  expect(mixedAdvisory?.approved).toBe(false);
  expect(mixedAdvisory?.model).toBe('test-auto-model');
  expect(mixedAdvisory?.source).toBe('system');
  expect(mixedAdvisory?.reasoning ?? '').toMatch(/Blocked by safety heuristics \(RED\):/);
  expect(mixedAdvisory?.reasoning ?? '').toMatch(/Model advisory: Recursive forced deletion from root/);
  expect(chatCalls.length).toBe(1);

  const secondResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  expect(getApprovalResult(secondResult).approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'Listing source files is safe.',
    approved: true,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(1);
});

it('malformed LLM advisory response: not valid json at all', () =>
  testMalformedResponse({
    llmResponse: 'not valid json at all',
    expectedReasoning: 'LLM did not provide a valid ordered evaluation for this command.',
  }));
it('malformed LLM advisory response: {"results":{}}', () =>
  testMalformedResponse({
    llmResponse: JSON.stringify({ results: {} }),
    expectedReasoning: 'LLM did not provide a valid ordered evaluation for this command.',
  }));
it('malformed LLM advisory response: missing approved field', () =>
  testMalformedResponse({
    llmResponse: JSON.stringify({ results: [{ id: 'call-safe', reasoning: 'Missing approved field' }] }),
    expectedReasoning: 'LLM did not provide a valid ordered evaluation for this command.',
  }));
it('malformed LLM advisory response: empty results', () =>
  testMalformedResponse({
    llmResponse: JSON.stringify({ results: [] }),
    expectedReasoning: 'LLM did not provide a valid ordered evaluation for this command.',
  }));

it('LLM evaluation errors return the safe-default advisory for every pending command in the batch', async () => {
  const first = createShellInterruption({ callId: 'call-error-1', command: 'ls source' });
  const second = createShellInterruption({ callId: 'call-error-2', command: 'pwd' });

  const initialStream = createInterruptedStream([first, second]);
  const continuationStream = createInterruptedStream([second]);

  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [continuationStream],
    chatImpl: async () => {
      throw new Error('secondary model unavailable');
    },
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the repository');
  expect(getApprovalResult(firstResult).approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'LLM evaluation encountered an error.',
    approved: false,
    source: 'llm',
    isError: true,
  });
  expect(chatCalls.length).toBe(1);

  const secondResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  expect(getApprovalResult(secondResult).approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'LLM evaluation encountered an error.',
    approved: false,
    source: 'llm',
    isError: true,
  });
  expect(chatCalls.length).toBe(1);
});

it('interruption without callId uses inline evaluation and does not reuse a cached advisory', async () => {
  const first = createShellInterruption({ command: 'ls source' });
  const second = createShellInterruption({ command: 'pwd' });

  const initialStream = createInterruptedStream([first, second]);
  const continuationStream = createInterruptedStream([second]);

  let llmResponseIndex = 0;
  const llmResponses = [
    JSON.stringify({ results: [{ id: '__single__', reasoning: 'Listing files is safe.', approved: true }] }),
    JSON.stringify({
      results: [{ id: '__single__', reasoning: 'Printing the working directory is safe.', approved: true }],
    }),
  ];

  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [continuationStream],
    chatImpl: async () => llmResponses[llmResponseIndex++],
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the repository');
  expect(getApprovalResult(firstResult).approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'Listing files is safe.',
    approved: true,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(1);

  const secondResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  expect(getApprovalResult(secondResult).approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'Printing the working directory is safe.',
    approved: true,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(2);
});

it('reset clears cached advisories before the next approval turn', async () => {
  const firstTurn = createInterruptedStream([createShellInterruption({ callId: 'call-reset', command: 'ls source' })]);
  const secondTurn = createInterruptedStream([createShellInterruption({ callId: 'call-reset', command: 'ls source' })]);

  let llmResponseIndex = 0;
  const llmResponses = [
    JSON.stringify({ results: [{ id: 'call-reset', reasoning: 'First advisory.', approved: true }] }),
    JSON.stringify({ results: [{ id: 'call-reset', reasoning: 'Second advisory after reset.', approved: false }] }),
  ];

  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [firstTurn, secondTurn],
    chatImpl: async () => llmResponses[llmResponseIndex++],
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the repository');
  expect(getApprovalResult(firstResult).approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'First advisory.',
    approved: true,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(1);

  bundle.stateFacade.reset();

  const secondResult = await bundle.terminalAdapter.sendMessage('inspect the repository again');
  expect(getApprovalResult(secondResult).approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'Second advisory after reset.',
    approved: false,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(2);
});

it('turn completion clears cached advisories so a new turn gets a fresh evaluation', async () => {
  const firstTurn = createInterruptedStream([createShellInterruption({ callId: 'call-turn', command: 'ls source' })]);
  const firstTurnFinal = createFinalStream('First turn done.');
  const secondTurn = createInterruptedStream([createShellInterruption({ callId: 'call-turn', command: 'ls source' })]);

  let llmResponseIndex = 0;
  const llmResponses = [
    JSON.stringify({ results: [{ id: 'call-turn', reasoning: 'First turn advisory.', approved: true }] }),
    JSON.stringify({ results: [{ id: 'call-turn', reasoning: 'Second turn advisory.', approved: false }] }),
  ];

  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [firstTurn, secondTurn],
    continuationStreams: [firstTurnFinal],
    chatImpl: async () => llmResponses[llmResponseIndex++],
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the repository');
  expect(getApprovalResult(firstResult).approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'First turn advisory.',
    approved: true,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(1);

  const completedTurn = await bundle.terminalAdapter.handleApprovalDecision('y');
  expect(getResponseResult(completedTurn).finalText).toBe('First turn done.');

  const secondResult = await bundle.terminalAdapter.sendMessage('inspect the repository again');
  expect(getApprovalResult(secondResult).approval.llmAdvisory).toEqual({
    model: 'test-auto-model',
    reasoning: 'Second turn advisory.',
    approved: false,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(2);
});

it('non-shell tools do not trigger advisory evaluation or attach llmAdvisory', async () => {
  const initialStream = createInterruptedStream([
    createNonShellInterruption({
      callId: 'call-patch',
      toolName: 'apply_patch',
      argumentsValue: { path: 'source/app.tsx' },
    }),
  ]);
  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
  });

  const result = await bundle.terminalAdapter.sendMessage('apply the patch');
  const approval = getApprovalResult(result).approval;

  expect(approval.toolName).toBe('apply_patch');
  expect(approval.llmAdvisory).toBe(undefined);
  expect(chatCalls.length).toBe(0);
});

// Phase 2: Full Auto-Approval tests

it('auto mode: LLM-approved safe command skips approval_required and returns final response', async () => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-auto-1', command: 'ls source' }),
  ]);
  const finalStream = createFinalStream('Files listed.');

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    continuationStreams: [finalStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [{ id: 'call-auto-1', reasoning: 'Listing files is read-only and safe.', approved: true }],
      }),
  });

  const result = await bundle.terminalAdapter.sendMessage('list the source files');
  expect(result?.type).toBe('response');
  if (result?.type !== 'response') throw new Error('Expected response');
  expect(result.finalText).toBe('Files listed.');
  expect(chatCalls.length).toBe(1);
});

it('auto mode: approved continuation emits tool_started before streamed output and final', async () => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-auto-sequence', command: 'ls source' }),
  ]);
  const finalStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Files listed.' }]);
  finalStream.finalOutput = 'Files listed.';

  const { bundle } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    continuationStreams: [finalStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [{ id: 'call-auto-sequence', reasoning: 'Listing files is safe.', approved: true }],
      }),
  });

  const events: ConversationEvent[] = [];
  for await (const event of bundle.turnCoordinator.start('list the source files')) {
    events.push(event);
  }

  expect(
    events.map((event) =>
      event.type === 'tool_started'
        ? { type: event.type, callId: event.toolCallId, toolName: event.toolName }
        : event.type === 'text_delta' || event.type === 'final'
        ? { type: event.type, text: event.type === 'text_delta' ? event.delta : event.finalText }
        : { type: event.type },
    ),
  ).toEqual([
    { type: 'tool_started', callId: 'call-auto-sequence', toolName: 'shell' },
    { type: 'text_delta', text: 'Files listed.' },
    { type: 'final', text: 'Files listed.' },
  ]);
});

it('auto mode: LLM-rejected command still prompts user with advisory', async () => {
  const initialStream = createInterruptedStream([
    // Use a YELLOW command (not RED) so heuristics pass and the LLM makes the rejection call
    createShellInterruption({ callId: 'call-auto-reject', command: 'git log --all --format="%H"' }),
  ]);

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [
          {
            id: 'call-auto-reject',
            reasoning: 'Dumping all commit hashes is not aligned with the current task.',
            approved: false,
          },
        ],
      }),
  });

  const result = await bundle.terminalAdapter.sendMessage('run the installer');
  const approval = getApprovalResult(result).approval;
  expect(approval.llmAdvisory?.approved).toBe(false);
  expect(approval.llmAdvisory?.source).toBe('llm');
  expect(chatCalls.length).toBe(1);
});

it('auto mode: RED command (source=system) is never auto-approved', async () => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-auto-red', command: 'rm -rf /' }),
  ]);

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [
          { id: 'call-auto-red', reasoning: 'The model explanation should not auto-approve RED.', approved: true },
        ],
      }),
  });

  const result = await bundle.terminalAdapter.sendMessage('clean the system');
  const approval = getApprovalResult(result).approval;
  expect(approval.llmAdvisory?.approved).toBe(false);
  expect(approval.llmAdvisory?.source).toBe('system');
  expect(approval.llmAdvisory?.reasoning ?? '').toMatch(
    /Model advisory: The model explanation should not auto-approve RED\./,
  );
  expect(chatCalls.length).toBe(1);
});

it('advisory mode: LLM-approved command still prompts the user (Phase 1 behavior preserved)', async () => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-advisory', command: 'ls source' }),
  ]);

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'advisory' },
    startStreams: [initialStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [{ id: 'call-advisory', reasoning: 'Listing files is safe.', approved: true }],
      }),
  });

  const result = await bundle.terminalAdapter.sendMessage('list the source files');
  const approval = getApprovalResult(result).approval;
  expect(approval.llmAdvisory?.approved).toBe(true);
  expect(approval.llmAdvisory?.source).toBe('llm');
  expect(chatCalls.length).toBe(1);
});

it('auto mode: batch of two commands — first auto-approved, second triggers prompt when rejected', async () => {
  const first = createShellInterruption({ callId: 'call-batch-auto-1', command: 'ls source' });
  // Use a YELLOW (non-RED) command so heuristics pass and LLM makes the rejection call
  const second = createShellInterruption({ callId: 'call-batch-auto-2', command: 'git log --all --format="%H"' });

  const initialStream = createInterruptedStream([first, second]);
  // After first is auto-approved, continuation stream surfaces the second interruption
  const continuationAfterFirst = createInterruptedStream([second]);

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    continuationStreams: [continuationAfterFirst],
    chatImpl: async () =>
      JSON.stringify({
        results: [
          { id: 'call-batch-auto-1', reasoning: 'Listing files is safe.', approved: true },
          {
            id: 'call-batch-auto-2',
            reasoning: 'Dumping all commit hashes is not aligned with the current task.',
            approved: false,
          },
        ],
      }),
  });

  // First command is auto-approved, continuation hits the second which is rejected by LLM
  const result = await bundle.terminalAdapter.sendMessage('inspect repository and dump history');
  const approval = getApprovalResult(result).approval;
  expect(approval.toolName).toBe('shell');
  expect(approval.llmAdvisory?.approved).toBe(false);
  expect(approval.llmAdvisory?.source).toBe('llm');
  expect(chatCalls.length).toBe(1);
});

it('auto mode: response usage includes the auto-approved first turn, not just the continuation', async () => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-usage-1', command: 'ls source' }),
  ]);
  (initialStream.state as any).usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };

  // The continuation reuses the same live RunState, so its run-state usage
  // accumulator is already cumulative for the whole run (first turn included).
  const finalStream = createFinalStream('Files listed.');
  (finalStream.state as any).usage = { inputTokens: 300, outputTokens: 50, totalTokens: 350 };

  const { bundle } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    continuationStreams: [finalStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [{ id: 'call-usage-1', reasoning: 'Listing files is read-only and safe.', approved: true }],
      }),
  });

  const result = getResponseResult(await bundle.terminalAdapter.sendMessage('list the source files'));

  // The auto-approved first turn must be reflected in the reported usage. The
  // SDK run-state accumulator already includes it (300 in / 50 out cumulative);
  // it must be reported verbatim, not added on top of the first turn again.
  expect(result.usage?.prompt_tokens).toBe(300);
  expect(result.usage?.completion_tokens).toBe(50);
});

it('auto mode: approval_required usage includes the auto-approved first turn', async () => {
  const first = createShellInterruption({ callId: 'call-usage-batch-1', command: 'ls source' });
  const second = createShellInterruption({ callId: 'call-usage-batch-2', command: 'git log --all --format="%H"' });

  const initialStream = createInterruptedStream([first, second]);
  (initialStream.state as any).usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };

  // The batch barrier must not consume this continuation until the manual
  // sibling is approved.
  const continuationAfterFirst = createInterruptedStream([second]);
  (continuationAfterFirst.state as any).usage = { inputTokens: 300, outputTokens: 50, totalTokens: 350 };

  const { bundle } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    continuationStreams: [continuationAfterFirst],
    chatImpl: async () =>
      JSON.stringify({
        results: [
          { id: 'call-usage-batch-1', reasoning: 'Listing files is safe.', approved: true },
          {
            id: 'call-usage-batch-2',
            reasoning: 'Dumping all commit hashes is not aligned with the current task.',
            approved: false,
          },
        ],
      }),
  });

  const approvalResult = getApprovalResult(
    await bundle.terminalAdapter.sendMessage('inspect repository and dump history'),
  );

  expect(approvalResult.usage?.prompt_tokens).toBe(100);
  expect(approvalResult.usage?.completion_tokens).toBe(20);
});

it('auto mode: evaluator error falls back to prompt without crashing', async () => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-auto-err', command: 'ls source' }),
  ]);

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    chatImpl: async () => {
      throw new Error('model unavailable');
    },
  });

  const result = await bundle.terminalAdapter.sendMessage('list files');
  const approval = getApprovalResult(result).approval;
  expect(approval.llmAdvisory?.approved).toBe(false);
  expect(approval.llmAdvisory?.source).toBe('llm');
  expect(chatCalls.length).toBe(1);
});
