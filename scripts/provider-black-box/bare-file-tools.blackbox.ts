import { execFile } from 'node:child_process';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
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

/**
 * A FIFO's read blocks until a writer opens it, so the gate sees each read start and decides when it ends.
 * A non-blocking writer open succeeds only while a reader waits; the gate keeps that writer until release.
 */
function fifoGate(dir: string, names: readonly string[], barrier: ReadonlySet<string>, fallbackMs: number) {
  const events = new Map<string, { waitingAt: number; releasedAt?: number; peers: string[] }>();
  const held = new Map<string, number>();
  const release = (name: string) => {
    const fd = held.get(name)!;
    held.delete(name);
    writeSync(fd, `content of ${name}\n`);
    closeSync(fd);
    events.get(name)!.releasedAt = Date.now();
  };
  const timer = setInterval(() => {
    for (const name of names) {
      if (events.has(name)) continue;
      try {
        held.set(name, openSync(join(dir, name), constants.O_WRONLY | constants.O_NONBLOCK));
        events.set(name, { waitingAt: Date.now(), peers: [] });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENXIO') throw error;
      }
    }
    for (const name of held.keys()) events.get(name)!.peers = [...held.keys()].filter((peer) => peer !== name);
    const waiting = [...held.keys()];
    const barrierMet = [...barrier].every((name) => held.has(name));
    for (const name of waiting) {
      // A serial regression never meets the barrier; the fallback only keeps the CLI from hanging.
      if (!barrier.has(name) || barrierMet || Date.now() - events.get(name)!.waitingAt >= fallbackMs) release(name);
    }
  }, 5);
  return {
    events,
    stop() {
      clearInterval(timer);
      for (const fd of held.values()) closeSync(fd);
      held.clear();
    },
  };
}

it('dispatches auto-approved parallel-safe reads together, keeping serial calls, the prompt and result order', async () => {
  // One response mixes parallel-safe reads, a serial shell call and an outside read that needs approval.
  const calls = [
    ['read_file', { path: 'p1' }],
    ['read_file', { path: 'p2' }],
    ['shell', { command: 'cat p3' }],
    ['read_file', { path: '/etc/hosts' }],
    ['read_file', { path: 'p4' }],
    ['read_file', { path: 'note.txt' }],
  ] as const;
  const requests: Array<{ messages: Array<{ role: string; tool_call_id?: string; content?: unknown }> }> = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const first = requests.length === 1;
    const delta = first
      ? {
          tool_calls: calls.map(([name, args], index) => ({
            index,
            id: `call-${index}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          })),
        }
      : { content: 'PARALLEL_READS_OK' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({
        id: `response-${requests.length}`,
        object: 'chat.completion.chunk',
        model: 'meta/muse-ember',
        choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const lease = await createIsolatedWorkspaceLease({
    prepare: async (root, paths) => {
      const project = join(root, 'project');
      await mkdir(project);
      for (const name of ['p1', 'p2', 'p3', 'p4']) await promisify(execFile)('mkfifo', [join(project, name)]);
      await writeFile(join(project, 'note.txt'), 'plain note\n');
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
  const gate = fifoGate(join(lease.root, 'project'), ['p1', 'p2', 'p3', 'p4'], new Set(['p1', 'p2']), 5000);
  try {
    // Without --auto-approve the headless client denies the outside read's prompt.
    const result = await lease.runCli({
      cwd: join(lease.root, 'project'),
      args: ['--json', 'Read the fixtures.'],
      deadlineMs: 30000,
    });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('PARALLEL_READS_OK');
    const at = (name: string) => gate.events.get(name);
    // p1 and p2 were both waiting at once: the barrier released them, not the fallback.
    expect(at('p1')?.peers).toContain('p2');
    expect(at('p2')?.peers).toContain('p1');
    // The shell call starts only after the group settled, and the later read only after the shell.
    expect(at('p3')!.waitingAt).toBeGreaterThanOrEqual(Math.max(at('p1')!.releasedAt!, at('p2')!.releasedAt!));
    expect(at('p3')?.peers).toEqual([]);
    expect(at('p4')!.waitingAt).toBeGreaterThanOrEqual(at('p3')!.releasedAt!);

    expect(requests).toHaveLength(2);
    const results = requests[1]!.messages.filter((message) => message.role === 'tool');
    expect(results.map((message) => message.tool_call_id)).toEqual(calls.map((_, index) => `call-${index}`));
    const text = results.map((message) => JSON.stringify(message.content));
    for (const [index, name] of [
      [0, 'p1'],
      [1, 'p2'],
      [2, 'p3'],
      [4, 'p4'],
    ] as const)
      expect(text[index]).toContain(`content of ${name}`);
    expect(text[3]).toContain('not approved');
    expect(text[5]).toContain('plain note');

    // The outside read is asked once, after the reads before the first staged call ran and before the shell.
    const logs = (await readdir(lease.paths.conversationsDir, { recursive: true })).filter((file) =>
      String(file).endsWith('.jsonl'),
    );
    expect(logs).toHaveLength(1);
    const facts = (await readFile(join(lease.paths.conversationsDir, String(logs[0])), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) => (JSON.parse(line) as { fact: { type: string; callId?: string; resolution?: { kind: string } } }).fact,
      );
    const opened = facts.flatMap((fact, index) => (fact.type === 'interaction_opened' ? [index] : []));
    expect(opened).toHaveLength(1);
    expect(facts.find((fact) => fact.type === 'interaction_closed')?.resolution?.kind).toBe('deny');
    const started = (callId: string) =>
      facts.findIndex((fact) => fact.type === 'tool_started' && fact.callId === callId);
    expect(started('call-1')).toBeLessThan(opened[0]!);
    expect(started('call-2')).toBeGreaterThan(opened[0]!);
  } finally {
    gate.stop();
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
