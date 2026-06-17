import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { evaluateShellAutoApprovalAdvisories } from './shell-auto-approval-evaluator.js';

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

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

const createMockSettings = (
  mode: 'off' | 'advisory' | 'auto' = 'advisory',
  provider = 'test-auto-provider',
  model = 'test-auto-model',
) => ({
  get: (key: string) => {
    const map: Record<string, unknown> = {
      'shell.autoApproveMode': mode,
      'agent.autoApproveModel': model,
      'agent.autoApproveProvider': provider,
    };
    return map[key];
  },
});

it('returns empty advisories and skips chat when auto-approval mode is off', async () => {
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
    sessionContextService: createSessionContextService() as any,
  });

  expect(advisories.size).toBe(0);
  expect(chatCalls).toBe(0);
});

it('evaluates RED commands via chat but keeps system rejection advisory', async () => {
  let chatCalls = 0;
  const advisories = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-red', command: 'rm -rf /' }],
    history: [{ role: 'user', type: 'message', content: 'clean the machine' }],
    settingsService: createMockSettings('advisory') as any,
    agentClient: {
      chat: async (prompt: string) => {
        chatCalls++;
        expect(prompt.includes('rm -rf /')).toBe(true);
        return JSON.stringify({
          results: [{ id: 'call-red', reasoning: 'This recursively deletes files from root.', approved: false }],
        });
      },
    } as any,
    logger: createMockLogger() as any,
    sessionContextService: createSessionContextService() as any,
  });

  const redAdvisory = advisories.get('call-red');
  expect(redAdvisory).toBeTruthy();
  expect(redAdvisory?.approved).toBe(false);
  expect(redAdvisory?.model).toBe('test-auto-model');
  expect(redAdvisory?.source).toBe('system');
  expect(redAdvisory?.reasoning ?? '').toMatch(/Blocked by safety heuristics \(RED\):/);
  expect(redAdvisory?.reasoning ?? '').toMatch(/Model advisory: This recursively deletes files from root\./);
  expect(chatCalls).toBe(1);
});

it('evaluates non-RED commands via chat and parses valid JSON results', async () => {
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
    sessionContextService: createSessionContextService() as any,
  });

  expect(advisories.get('call-safe')).toEqual({
    model: 'test-auto-model',
    reasoning: 'Read-only listing is safe.',
    approved: true,
    source: 'llm',
  });
  expect(chatCalls.length).toBe(1);
  expect(chatCalls[0].prompt.includes('ls source')).toBe(true);
  expect(chatCalls[0].options.model).toBe('test-auto-model');
  expect(chatCalls[0].options.provider).toBe('test-auto-provider');
  expect(chatCalls[0].options.reasoningEffort).toBe('none');
});

it('uses structured chatJson when structured support is unknown', async () => {
  const chatJsonCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  let chatCalls = 0;

  const advisories = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-safe', command: 'pwd' }],
    history: [{ role: 'user', type: 'message', content: 'inspect location' }],
    settingsService: createMockSettings('advisory', 'structured-unknown-provider') as any,
    agentClient: {
      chatJson: async (prompt: string, options: Record<string, unknown>) => {
        chatJsonCalls.push({ prompt, options });
        return { results: [{ reasoning: 'Read-only current directory inspection is safe.', approved: true }] };
      },
      chat: async () => {
        chatCalls++;
        return '{}';
      },
    } as any,
    logger: createMockLogger() as any,
    sessionContextService: createSessionContextService() as any,
  });

  expect(advisories.get('call-safe')).toEqual({
    model: 'test-auto-model',
    reasoning: 'Read-only current directory inspection is safe.',
    approved: true,
    source: 'llm',
  });
  expect(chatJsonCalls.length).toBe(1);
  expect(chatCalls).toBe(0);
  expect(chatJsonCalls[0].options.provider).toBe('structured-unknown-provider');
});

it.sequential('caches structured support after a successful structured request', async () => {
  const provider = 'structured-supported-provider';
  let chatJsonCalls = 0;

  for (const id of ['call-1', 'call-2']) {
    const advisories = await evaluateShellAutoApprovalAdvisories({
      commands: [{ id, command: 'pwd' }],
      history: [{ role: 'user', type: 'message', content: 'inspect location' }],
      settingsService: createMockSettings('advisory', provider) as any,
      agentClient: {
        chatJson: async () => {
          chatJsonCalls++;
          return { results: [{ reasoning: 'Read-only current directory inspection is safe.', approved: true }] };
        },
        chat: async () => {
          throw new Error('chat fallback should not run');
        },
      } as any,
      logger: createMockLogger() as any,
      sessionContextService: createSessionContextService() as any,
    });

    expect(advisories.get(id)?.approved).toBe(true);
  }

  expect(chatJsonCalls).toBe(2);
});

it.sequential('falls back to chat and caches unsupported after structured output unsupported error', async () => {
  const provider = 'structured-unsupported-provider';
  let chatJsonCalls = 0;
  let chatCalls = 0;

  const first = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-1', command: 'pwd' }],
    history: [{ role: 'user', type: 'message', content: 'inspect location' }],
    settingsService: createMockSettings('advisory', provider) as any,
    agentClient: {
      chatJson: async () => {
        chatJsonCalls++;
        throw new Error('response_format json_schema is not supported by this model');
      },
      chat: async () => {
        chatCalls++;
        return JSON.stringify({
          results: [{ reasoning: 'Read-only current directory inspection is safe.', approved: true }],
        });
      },
    } as any,
    logger: createMockLogger() as any,
    sessionContextService: createSessionContextService() as any,
  });

  const second = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-2', command: 'pwd' }],
    history: [{ role: 'user', type: 'message', content: 'inspect location' }],
    settingsService: createMockSettings('advisory', provider) as any,
    agentClient: {
      chatJson: async () => {
        chatJsonCalls++;
        throw new Error('chatJson should be skipped while unsupported is cached');
      },
      chat: async () => {
        chatCalls++;
        return JSON.stringify({
          results: [{ reasoning: 'Read-only current directory inspection is safe.', approved: true }],
        });
      },
    } as any,
    logger: createMockLogger() as any,
    sessionContextService: createSessionContextService() as any,
  });

  expect(first.get('call-1')?.approved).toBe(true);
  expect(second.get('call-2')?.approved).toBe(true);
  expect(chatJsonCalls).toBe(1);
  expect(chatCalls).toBe(2);
});

it.sequential('does not cache unsupported for malformed structured output', async () => {
  const provider = 'structured-malformed-provider';
  let chatJsonCalls = 0;

  const first = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-1', command: 'pwd' }],
    history: [{ role: 'user', type: 'message', content: 'inspect location' }],
    settingsService: createMockSettings('advisory', provider) as any,
    agentClient: {
      chatJson: async () => {
        chatJsonCalls++;
        return { results: [{ reasoning: 'Missing approved field.' }] };
      },
      chat: async () => {
        throw new Error('prompt fallback should not run for accepted structured malformed output');
      },
    } as any,
    logger: createMockLogger() as any,
    sessionContextService: createSessionContextService() as any,
  });

  const second = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-2', command: 'pwd' }],
    history: [{ role: 'user', type: 'message', content: 'inspect location' }],
    settingsService: createMockSettings('advisory', provider) as any,
    agentClient: {
      chatJson: async () => {
        chatJsonCalls++;
        return { results: [{ reasoning: 'Read-only current directory inspection is safe.', approved: true }] };
      },
      chat: async () => {
        throw new Error('prompt fallback should not run');
      },
    } as any,
    logger: createMockLogger() as any,
    sessionContextService: createSessionContextService() as any,
  });

  expect(first.get('call-1')?.approved).toBe(false);
  expect(second.get('call-2')?.approved).toBe(true);
  expect(chatJsonCalls).toBe(3);
});

it('retries once when structured output is missing approved', async () => {
  let chatJsonCalls = 0;

  const advisories = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-safe', command: 'pwd' }],
    history: [{ role: 'user', type: 'message', content: 'inspect location' }],
    settingsService: createMockSettings('advisory', 'structured-repair-provider') as any,
    agentClient: {
      chatJson: async (prompt: string) => {
        chatJsonCalls++;
        if (chatJsonCalls === 1) {
          return { results: [{ reasoning: 'Missing approved field.' }] };
        }
        expect(prompt.includes('The previous shell auto-approval response was invalid.')).toBe(true);
        return { results: [{ reasoning: 'Read-only current directory inspection is safe.', approved: true }] };
      },
      chat: async () => {
        throw new Error('prompt fallback should not run');
      },
    } as any,
    logger: createMockLogger() as any,
    sessionContextService: createSessionContextService() as any,
  });

  expect(advisories.get('call-safe')?.approved).toBe(true);
  expect(chatJsonCalls).toBe(2);
});

it('denies all non-RED commands when original plus repair are invalid', async () => {
  const advisories = await evaluateShellAutoApprovalAdvisories({
    commands: [
      { id: 'call-safe-1', command: 'ls source' },
      { id: 'call-safe-2', command: 'pwd' },
    ],

    history: [{ role: 'user', type: 'message', content: 'inspect repository' }],
    settingsService: createMockSettings('advisory', 'invalid-repair-provider') as any,
    agentClient: {
      chatJson: async () => ({ results: [{ reasoning: 'Only one result.', approved: true }] }),
      chat: async () => {
        throw new Error('prompt fallback should not run');
      },
    } as any,
    logger: createMockLogger() as any,
    sessionContextService: createSessionContextService() as any,
  });

  for (const id of ['call-safe-1', 'call-safe-2']) {
    expect(advisories.get(id)).toEqual({
      model: 'test-auto-model',
      reasoning: 'LLM did not provide a valid ordered evaluation for this command.',
      approved: false,
      source: 'llm',
    });
  }
});

it('instructions distinguish auto-approval from user-requested destructive intent', async () => {
  const chatCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-reset', command: 'git reset --hard HEAD' }],
    history: [{ role: 'user', type: 'message', content: 'throw away all my changes' }],
    settingsService: createMockSettings('advisory') as any,
    agentClient: {
      chat: async (prompt: string, options: Record<string, unknown>) => {
        chatCalls.push({ prompt, options });
        return JSON.stringify({
          results: [{ id: 'call-reset', reasoning: 'Reset needs human confirmation.', approved: false }],
        });
      },
    } as any,
    logger: createMockLogger() as any,
    sessionContextService: createSessionContextService() as any,
  });

  expect(chatCalls.length).toBe(1);
  expect(chatCalls[0].prompt.includes('without a human approval prompt')).toBe(false);
  expect(chatCalls[0].prompt.includes('even if the user requested them')).toBe(false);
  expect(chatCalls[0].prompt.includes('force flags')).toBe(false);
  expect(chatCalls[0].prompt.includes('resets')).toBe(false);
  expect(String(chatCalls[0].options.instructions).includes('without a human approval prompt')).toBe(true);
  expect(String(chatCalls[0].options.instructions).includes('even if the user requested them')).toBe(true);
  expect(String(chatCalls[0].options.instructions).includes('force flags')).toBe(true);
  expect(String(chatCalls[0].options.instructions).includes('resets')).toBe(true);
  expect(chatCalls[0].prompt.includes('Think step-by-step')).toBe(false);
});

it('prompt contains only user and assistant text from bounded history context', async () => {
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
    sessionContextService: createSessionContextService() as any,
  });

  expect(chatCalls.length).toBe(1);
  expect(chatCalls[0].prompt.includes('[user]')).toBe(true);
  expect(chatCalls[0].prompt.includes('[assistant]')).toBe(true);
  expect(chatCalls[0].prompt.includes('[tool call]')).toBe(false);
  expect(chatCalls[0].prompt.includes('[tool result]')).toBe(false);
  expect(chatCalls[0].prompt.includes('SECRET_OUTPUT')).toBe(false);
  expect(chatCalls[0].prompt.includes('pwd')).toBe(false);
  expect(chatCalls[0].prompt.includes('expensive hidden reasoning')).toBe(false);
  expect(chatCalls[0].prompt.includes('reasoning_details')).toBe(false);
  expect(chatCalls[0].prompt.length < 6_000).toBe(true);
});

it('falls back to deny advisory for all commands when chat response shape is malformed', async () => {
  const advisories = await evaluateShellAutoApprovalAdvisories({
    commands: [
      { id: 'call-safe-1', command: 'ls source' },
      { id: 'call-safe-2', command: 'pwd' },
    ],

    history: [{ role: 'user', type: 'message', content: 'inspect repository' }],
    settingsService: createMockSettings('advisory') as any,
    agentClient: {
      chat: async () => JSON.stringify({ results: [{ reasoning: 'Looks safe', approved: true }, {}] }),
    } as any,
    logger: createMockLogger() as any,
    sessionContextService: createSessionContextService() as any,
  });

  for (const id of ['call-safe-1', 'call-safe-2']) {
    expect(advisories.get(id)).toEqual({
      model: 'test-auto-model',
      reasoning: 'LLM did not provide a valid ordered evaluation for this command.',
      approved: false,
      source: 'llm',
    });
  }
});

it('performs exactly one corrective repair for malformed JSON without upstream retries', async () => {
  const chatCalls: string[] = [];

  const advisories = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-safe', command: 'ls source' }],
    history: [{ role: 'user', type: 'message', content: 'inspect repository' }],
    settingsService: createMockSettings('advisory') as any,
    agentClient: {
      chat: async (prompt: string) => {
        chatCalls.push(prompt);
        if (chatCalls.length === 1) {
          return 'not valid json';
        }
        expect(prompt.includes('The previous shell auto-approval response was invalid.')).toBe(true);
        return JSON.stringify({
          results: [{ reasoning: 'Read-only listing is safe.', approved: true }],
        });
      },
    } as any,
    logger: createMockLogger() as any,
    sessionContextService: createSessionContextService() as any,
    retryOptions: { sleep: async () => {}, random: () => 0 } as any,
  } as any);

  expect(chatCalls.length).toBe(2);
  expect(advisories.get('call-safe')).toEqual({
    model: 'test-auto-model',
    reasoning: 'Read-only listing is safe.',
    approved: true,
    source: 'llm',
  });
});

it('keeps RED commands system-rejected even if the LLM approves them', async () => {
  const advisories = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-red', command: 'rm -rf /' }],
    history: [{ role: 'user', type: 'message', content: 'clean the machine' }],
    settingsService: createMockSettings('advisory', 'red-structured-provider') as any,
    agentClient: {
      chatJson: async () => ({
        results: [{ reasoning: 'The model incorrectly approved this destructive command.', approved: true }],
      }),
      chat: async () => {
        throw new Error('prompt fallback should not run');
      },
    } as any,
    logger: createMockLogger() as any,
    sessionContextService: createSessionContextService() as any,
  });

  const redAdvisory = advisories.get('call-red');
  expect(redAdvisory?.approved).toBe(false);
  expect(redAdvisory?.source).toBe('system');
  expect(redAdvisory?.reasoning ?? '').toMatch(/Blocked by safety heuristics \(RED\):/);
  expect(redAdvisory?.reasoning ?? '').toMatch(/Model advisory: The model incorrectly approved/);
});
