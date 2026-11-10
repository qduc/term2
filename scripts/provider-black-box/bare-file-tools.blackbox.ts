import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';
import { createConversation } from '../../src/session/conversation.js';
import { createLog } from '../../src/session/log.js';
import type { Item, Model } from '../../src/model/index.js';

it('preserves Muse reasoning state while using native and scripted file tools in Bare', async () => {
  const requests: Array<{
    tools: Array<{ function: { name: string } }>;
    messages: Array<{ role: string; content?: unknown; reasoning_details?: unknown[] }>;
  }> = [];
  const reasoningDetail = {
    type: 'reasoning.encrypted',
    format: 'meta-responses-v1',
    id: 'rs_native_file_fixture',
    index: 0,
    data: 'SYNTHETIC_META_STATE_quoted_"_unchanged',
  };
  const literal = 'before\nquotes: \' " ` ${value}\n';
  const calls = [
    ['create_file', { path: 'direct.txt', content: literal }],
    ['search_replace', { path: 'direct.txt', replacements: [{ search_content: 'before', replace_content: 'after' }] }],
    ['read_file', { path: 'direct.txt' }],
    [
      'run_code',
      {
        code: 'return await tools.search_replace(inputs.edit);',
        description: 'Apply the script edit through the same wrapped file tool',
        inputs: {
          edit: { path: 'direct.txt', replacements: [{ search_content: 'after', replace_content: 'script' }] },
        },
      },
    ],
    ['read_file', { path: 'direct.txt' }],
  ] as const;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const next = calls[requests.length - 1];
    const delta = next
      ? {
          ...(requests.length === 1 ? { reasoning_details: [reasoningDetail] } : {}),
          tool_calls: [
            {
              index: 0,
              id: `call-${requests.length}`,
              type: 'function',
              function: { name: next[0], arguments: JSON.stringify(next[1]) },
            },
          ],
        }
      : { content: 'FILE_TOOLS_OK' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({
        id: `response-${requests.length}`,
        object: 'chat.completion.chunk',
        model: 'meta/muse-ember',
        choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const lease = await createIsolatedWorkspaceLease({
    prepare: async (root, paths) => {
      await mkdir(join(root, 'project'));
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            modelSelection: { provider: 'openrouter', model: 'meta/muse-ember' },
            retryAttempts: 0,
            openrouter: { apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1` },
          },
          sandbox: { enabled: false },
        }),
      );
    },
  });
  try {
    const result = await lease.runCli({
      cwd: join(lease.root, 'project'),
      args: ['--auto-approve', '--json', 'Run the scripted file checks.'],
      deadlineMs: 15000,
    });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('FILE_TOOLS_OK');
    expect(await readFile(join(lease.root, 'project/direct.txt'), 'utf8')).toBe(literal.replace('before', 'script'));
    expect(requests).toHaveLength(6);
    const names = requests[0]!.tools.map((tool) => tool.function.name);
    expect(names).toEqual(expect.arrayContaining(['read_file', 'create_file', 'search_replace', 'shell', 'run_code']));
    for (const request of requests) expect(request.tools.map((tool) => tool.function.name)).toEqual(names);
    for (const request of requests.slice(1)) {
      expect(request.messages.flatMap((message) => message.reasoning_details ?? [])).toEqual([reasoningDetail]);
    }
    const firstRead = requests[3]!.messages.filter((message) => message.role === 'tool').at(-1);
    const secondRead = requests[5]!.messages.filter((message) => message.role === 'tool').at(-1);
    expect(JSON.stringify(firstRead?.content)).toContain('after');
    expect(JSON.stringify(secondRead?.content)).toContain('script');
  } finally {
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

it('resumes SDK-era Muse reasoning metadata through the chat-completions client', async () => {
  const detail = {
    type: 'reasoning.encrypted',
    format: 'meta-responses-v1',
    id: 'rs_legacy_fixture',
    index: 0,
    data: 'SYNTHETIC_LEGACY_META_STATE_quoted_"_unchanged',
  };
  const requests: Array<{
    messages: Array<{ role: string; tool_calls?: Array<{ id: string }>; reasoning_details?: unknown[] }>;
  }> = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({
        id: 'legacy-resume-response',
        object: 'chat.completion.chunk',
        model: 'meta/muse-ember',
        choices: [{ index: 0, delta: { content: 'LEGACY_RESUME_OK' }, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const modelRef = { provider: 'openrouter', model: 'meta/muse-ember' };
  const conversationId = 'conv_11111111-1111-4111-8111-111111111111';
  const lease = await createIsolatedWorkspaceLease({
    prepare: async (root, paths) => {
      const project = join(root, 'project');
      await mkdir(project);
      await mkdir(paths.logDir, { recursive: true });
      await mkdir(paths.conversationsDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            modelSelection: modelRef,
            retryAttempts: 0,
            openrouter: { apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1` },
          },
          sandbox: { enabled: false },
        }),
      );
      const model: Model = {
        ref: modelRef,
        contextWindow: 1_000_000,
        async *stream() {
          yield { type: 'text_delta', delta: 'Previous SDK turn completed.' };
          yield { type: 'done', stopReason: 'end_turn' };
        },
      };
      const conversation = createConversation({
        models: { resolve: () => model, list: () => [modelRef] },
        log: createLog(paths.conversationsDir, conversationId),
        meta: {
          id: conversationId,
          workspace: project,
          model: modelRef,
          profile: { id: 'builtin:bare', version: '3.0.0', digest: 'legacy-fixture' },
          appVersion: 'test',
        },
      });
      try {
        const input = [
          { type: 'user_message', id: 'legacy-user', content: [{ type: 'text', text: 'Read the fixture.' }] },
          {
            type: 'reasoning',
            id: 'legacy-reasoning',
            text: '',
            providerMetadata: { openrouter: { reasoning_details: [detail] } },
          },
          {
            type: 'tool_call',
            id: 'legacy-call',
            callId: 'legacy-call',
            toolName: 'read_file',
            input: { path: 'fixture.txt' },
            providerMetadata: { openrouter: { reasoning_details: [{ ...detail, data: null }] } },
          },
          {
            type: 'tool_result',
            id: 'legacy-result',
            callId: 'legacy-call',
            output: 'Legacy file result.',
            isError: false,
          },
        ] as Item[];
        const turn = conversation.run({ model: modelRef, instructions: 'Seed the SDK-era history.', tools: [], input });
        for await (const event of turn.events) {
          if (event.type === 'turn_ended') expect(event.result.kind).toBe('completed');
        }
      } finally {
        await conversation.close();
      }
    },
  });
  try {
    const result = await lease.runCli({
      cwd: join(lease.root, 'project'),
      args: ['--auto-approve', '--json', '--resume', conversationId, 'Continue the saved conversation.'],
      deadlineMs: 15000,
    });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('LEGACY_RESUME_OK');
    expect(requests).toHaveLength(1);
    const assistant = requests[0]!.messages.find((message) =>
      message.tool_calls?.some((call) => call.id === 'legacy-call'),
    );
    expect(assistant?.reasoning_details).toEqual([detail]);
    expect(requests[0]!.messages.flatMap((message) => message.reasoning_details ?? [])).toEqual([detail]);
  } finally {
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
