import test from 'ava';
import { evaluateShellAutoApprovalAdvisories } from './shell-auto-approval-evaluator.js';

const createMockLogger = () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => 'trace-shell-auto-evaluator-test',
  clearCorrelationId: () => {},
});

const createMockSettings = (mode: 'off' | 'advisory' | 'auto' = 'advisory') => ({
  get: (key: string) => {
    const map: Record<string, unknown> = {
      'shell.autoApproveMode': mode,
      'agent.autoApproveModel': 'test-auto-model',
      'agent.autoApproveProvider': 'test-auto-provider',
    };
    return map[key];
  },
});

test('returns empty advisories and skips chat when auto-approval mode is off', async (t) => {
  let chatCalls = 0;
  const advisories = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-1', command: 'ls source' }],
    history: [{ role: 'user', type: 'message', content: 'list files' }],
    settingsService: createMockSettings('off') as any,
    agentClient: {
      chat: async () => {
        chatCalls++;
        return '{}';
      },
    } as any,
    logger: createMockLogger() as any,
  });

  t.is(advisories.size, 0);
  t.is(chatCalls, 0);
});

test('short-circuits RED commands and does not call chat for all-RED batches', async (t) => {
  let chatCalls = 0;
  const advisories = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-red', command: 'rm -rf /' }],
    history: [{ role: 'user', type: 'message', content: 'clean the machine' }],
    settingsService: createMockSettings('advisory') as any,
    agentClient: {
      chat: async () => {
        chatCalls++;
        return '{}';
      },
    } as any,
    logger: createMockLogger() as any,
  });

  const redAdvisory = advisories.get('call-red');
  t.truthy(redAdvisory);
  t.is(redAdvisory?.approved, false);
  t.is(redAdvisory?.model, 'test-auto-model');
  t.is(redAdvisory?.source, 'system');
  t.regex(redAdvisory?.reasoning ?? '', /Blocked by safety heuristics \(RED\):/);
  t.is(chatCalls, 0);
});

test('evaluates non-RED commands via chat and parses valid JSON results', async (t) => {
  const chatCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const advisories = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-safe', command: 'ls source' }],
    history: [{ role: 'user', type: 'message', content: 'inspect the source tree' }],
    settingsService: createMockSettings('advisory') as any,
    agentClient: {
      chat: async (prompt: string, options: Record<string, unknown>) => {
        chatCalls.push({ prompt, options });
        return JSON.stringify({
          results: [{ id: 'call-safe', reasoning: 'Read-only listing is safe.', approved: true }],
        });
      },
    } as any,
    logger: createMockLogger() as any,
  });

  t.deepEqual(advisories.get('call-safe'), {
    model: 'test-auto-model',
    reasoning: 'Read-only listing is safe.',
    approved: true,
    source: 'llm',
  });
  t.is(chatCalls.length, 1);
  t.true(chatCalls[0].prompt.includes('call-safe'));
  t.true(chatCalls[0].prompt.includes('ls source'));
  t.is(chatCalls[0].options.model, 'test-auto-model');
  t.is(chatCalls[0].options.provider, 'test-auto-provider');
  t.is(chatCalls[0].options.reasoningEffort, 'none');
});

test('sends compact bounded history context instead of raw conversation items', async (t) => {
  const largeToolOutput = 'SECRET_OUTPUT '.repeat(2_000);
  const largeAssistantText = 'assistant detail '.repeat(600);
  const largeUserText = 'please inspect the repository '.repeat(300);
  const chatCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];

  await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-safe', command: 'ls source' }],
    history: [
      { role: 'user', type: 'message', content: 'old request that should be omitted' },
      {
        role: 'assistant',
        type: 'message',
        content: [{ type: 'output_text', text: largeAssistantText }],
        reasoning_details: [{ text: 'expensive hidden reasoning' }],
      },
      { type: 'function_call', name: 'shell', callId: 'call-old', arguments: JSON.stringify({ command: 'pwd' }) },
      { type: 'function_call_result', callId: 'call-old', output: largeToolOutput },
      { role: 'user', type: 'message', content: largeUserText },
    ] as any,
    settingsService: createMockSettings('advisory') as any,
    agentClient: {
      chat: async (prompt: string, options: Record<string, unknown>) => {
        chatCalls.push({ prompt, options });
        return JSON.stringify({
          results: [{ id: 'call-safe', reasoning: 'Read-only listing is safe.', approved: true }],
        });
      },
    } as any,
    logger: createMockLogger() as any,
  });

  t.is(chatCalls.length, 1);
  t.true(chatCalls[0].prompt.includes('[user]'));
  t.true(chatCalls[0].prompt.includes('[assistant]'));
  t.true(chatCalls[0].prompt.includes('[tool call] shell'));
  t.true(chatCalls[0].prompt.includes('[tool result] function_call_result'));
  t.false(chatCalls[0].prompt.includes('SECRET_OUTPUT'));
  t.false(chatCalls[0].prompt.includes('reasoning_details'));
  t.true(chatCalls[0].prompt.length < 6_000);
});

test('falls back to deny advisory for commands missing from malformed chat response', async (t) => {
  const advisories = await evaluateShellAutoApprovalAdvisories({
    commands: [
      { id: 'call-safe-1', command: 'ls source' },
      { id: 'call-safe-2', command: 'pwd' },
    ],
    history: [{ role: 'user', type: 'message', content: 'inspect repository' }],
    settingsService: createMockSettings('advisory') as any,
    agentClient: {
      chat: async () => JSON.stringify({ results: [{ id: 'call-safe-1', reasoning: 'Looks safe', approved: true }] }),
    } as any,
    logger: createMockLogger() as any,
  });

  t.deepEqual(advisories.get('call-safe-1'), {
    model: 'test-auto-model',
    reasoning: 'Looks safe',
    approved: true,
    source: 'llm',
  });
  t.deepEqual(advisories.get('call-safe-2'), {
    model: 'test-auto-model',
    reasoning: 'LLM did not provide a valid evaluation for this command.',
    approved: false,
    source: 'llm',
  });
});
