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

test('evaluates RED commands via chat but keeps system rejection advisory', async (t) => {
  let chatCalls = 0;
  const advisories = await evaluateShellAutoApprovalAdvisories({
    commands: [{ id: 'call-red', command: 'rm -rf /' }],
    history: [{ role: 'user', type: 'message', content: 'clean the machine' }],
    settingsService: createMockSettings('advisory') as any,
    agentClient: {
      chat: async (prompt: string) => {
        chatCalls++;
        t.true(prompt.includes('rm -rf /'));
        return JSON.stringify({
          results: [{ id: 'call-red', reasoning: 'This recursively deletes files from root.', approved: false }],
        });
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
  t.regex(redAdvisory?.reasoning ?? '', /Model advisory: This recursively deletes files from root\./);
  t.is(chatCalls, 1);
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
  t.true(chatCalls[0].prompt.includes('ls source'));
  t.is(chatCalls[0].options.model, 'test-auto-model');
  t.is(chatCalls[0].options.provider, 'test-auto-provider');
  t.is(chatCalls[0].options.reasoningEffort, 'none');
});

test('uses structured chatJson when structured support is unknown', async (t) => {
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
  });

  t.deepEqual(advisories.get('call-safe'), {
    model: 'test-auto-model',
    reasoning: 'Read-only current directory inspection is safe.',
    approved: true,
    source: 'llm',
  });
  t.is(chatJsonCalls.length, 1);
  t.is(chatCalls, 0);
  t.is(chatJsonCalls[0].options.provider, 'structured-unknown-provider');
});

test.serial('caches structured support after a successful structured request', async (t) => {
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
    });

    t.is(advisories.get(id)?.approved, true);
  }

  t.is(chatJsonCalls, 2);
});

test.serial('falls back to chat and caches unsupported after structured output unsupported error', async (t) => {
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
  });

  t.is(first.get('call-1')?.approved, true);
  t.is(second.get('call-2')?.approved, true);
  t.is(chatJsonCalls, 1);
  t.is(chatCalls, 2);
});

test.serial('does not cache unsupported for malformed structured output', async (t) => {
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
  });

  t.is(first.get('call-1')?.approved, false);
  t.is(second.get('call-2')?.approved, true);
  t.is(chatJsonCalls, 3);
});

test('retries once when structured output is missing approved', async (t) => {
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
        t.true(prompt.includes('The previous shell auto-approval response was invalid.'));
        return { results: [{ reasoning: 'Read-only current directory inspection is safe.', approved: true }] };
      },
      chat: async () => {
        throw new Error('prompt fallback should not run');
      },
    } as any,
    logger: createMockLogger() as any,
  });

  t.is(advisories.get('call-safe')?.approved, true);
  t.is(chatJsonCalls, 2);
});

test('denies all non-RED commands when original plus repair are invalid', async (t) => {
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
  });

  for (const id of ['call-safe-1', 'call-safe-2']) {
    t.deepEqual(advisories.get(id), {
      model: 'test-auto-model',
      reasoning: 'LLM did not provide a valid ordered evaluation for this command.',
      approved: false,
      source: 'llm',
    });
  }
});

test('instructions distinguish auto-approval from user-requested destructive intent', async (t) => {
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
  });

  t.is(chatCalls.length, 1);
  t.false(chatCalls[0].prompt.includes('without a human approval prompt'));
  t.false(chatCalls[0].prompt.includes('even if the user requested them'));
  t.false(chatCalls[0].prompt.includes('force flags'));
  t.false(chatCalls[0].prompt.includes('resets'));
  t.true(String(chatCalls[0].options.instructions).includes('without a human approval prompt'));
  t.true(String(chatCalls[0].options.instructions).includes('even if the user requested them'));
  t.true(String(chatCalls[0].options.instructions).includes('force flags'));
  t.true(String(chatCalls[0].options.instructions).includes('resets'));
  t.false(chatCalls[0].prompt.includes('Think step-by-step'));
});

test('prompt contains only user and assistant text from bounded history context', async (t) => {
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
  t.false(chatCalls[0].prompt.includes('[tool call]'));
  t.false(chatCalls[0].prompt.includes('[tool result]'));
  t.false(chatCalls[0].prompt.includes('SECRET_OUTPUT'));
  t.false(chatCalls[0].prompt.includes('pwd'));
  t.false(chatCalls[0].prompt.includes('expensive hidden reasoning'));
  t.false(chatCalls[0].prompt.includes('reasoning_details'));
  t.true(chatCalls[0].prompt.length < 6_000);
});

test('falls back to deny advisory for all commands when chat response shape is malformed', async (t) => {
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
  });

  for (const id of ['call-safe-1', 'call-safe-2']) {
    t.deepEqual(advisories.get(id), {
      model: 'test-auto-model',
      reasoning: 'LLM did not provide a valid ordered evaluation for this command.',
      approved: false,
      source: 'llm',
    });
  }
});

test('keeps RED commands system-rejected even if the LLM approves them', async (t) => {
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
  });

  const redAdvisory = advisories.get('call-red');
  t.is(redAdvisory?.approved, false);
  t.is(redAdvisory?.source, 'system');
  t.regex(redAdvisory?.reasoning ?? '', /Blocked by safety heuristics \(RED\):/);
  t.regex(redAdvisory?.reasoning ?? '', /Model advisory: The model incorrectly approved/);
});

test('rethrows upstream errors when throwOnError is enabled', async (t) => {
  const upstreamError = Object.assign(new Error('Rate limit exceeded'), {
    status: 429,
    headers: {
      'x-ratelimit-reset': '1741305600000',
    },
  });

  const error = await t.throwsAsync(() =>
    evaluateShellAutoApprovalAdvisories({
      commands: [{ id: 'call-safe', command: 'ls source' }],
      history: [{ role: 'user', type: 'message', content: 'inspect repository' }],
      settingsService: createMockSettings('advisory') as any,
      agentClient: {
        chat: async () => {
          throw upstreamError;
        },
      } as any,
      logger: createMockLogger() as any,
      throwOnError: true,
    }),
  );

  t.is(error, upstreamError);
});
