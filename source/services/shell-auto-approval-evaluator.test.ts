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

  t.deepEqual(advisories.get('call-red'), {
    reasoning: 'Command is in the dangerous list (RED). Manual approval is strictly required.',
    approved: false,
  });
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
    reasoning: 'Read-only listing is safe.',
    approved: true,
  });
  t.is(chatCalls.length, 1);
  t.true(chatCalls[0].prompt.includes('call-safe'));
  t.true(chatCalls[0].prompt.includes('ls source'));
  t.is(chatCalls[0].options.model, 'test-auto-model');
  t.is(chatCalls[0].options.provider, 'test-auto-provider');
  t.is(chatCalls[0].options.reasoningEffort, 'none');
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
    reasoning: 'Looks safe',
    approved: true,
  });
  t.deepEqual(advisories.get('call-safe-2'), {
    reasoning: 'LLM did not provide a valid evaluation for this command.',
    approved: false,
  });
});
