import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it('retries from the last tool result without re-executing the tool', async () => {
  const requests: Record<string, unknown>[] = [];
  const pending: ServerResponse[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += String(part);
    requests.push(JSON.parse(body) as Record<string, unknown>);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': fixture connection accepted\n\n');
    pending.push(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
  const lease = await createIsolatedWorkspaceLease({
    prefix: 'term2-retry-tool-',
    env: { OPENAI_BASE_URL: `http://127.0.0.1:${address.port}` },
    prepare: async (_root, paths) => {
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            modelSelection: { model: 'gpt-5.6-luna', provider: 'openai' },
            transport: 'http',
            retryAttempts: 0,
            openai: { apiKey: 'fixture' },
          },
          app: { liteMode: true },
          shell: { autoApproveMode: 'off' },
          sandbox: { enabled: true, allowNetworking: false },
        }),
      );
    },
  });
  const child = await lease.start({
    command: process.execPath,
    args: [
      process.env.TERM2_TEST_CLI ? resolve(process.env.TERM2_TEST_CLI) : join(process.cwd(), 'dist/cli.js'),
      '--lite',
    ],
    cwd: lease.root,
    cols: 120,
    rows: 40,
  });
  const complete = (index: number, output: Record<string, unknown>[]) => {
    const response = pending[index];
    if (!response) throw new Error(`Missing request ${index}`);
    const id = `loop-response-${index}`;
    for (const frame of [
      { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
      { type: 'response.completed', response: { id, status: 'completed', output } },
    ])
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end();
  };
  const call = (id: string) => ({
    id: `item-${id}`,
    type: 'function_call',
    status: 'completed',
    call_id: id,
    name: 'shell',
    arguments: JSON.stringify({ command: 'printf x >> retry-effects.txt', sandbox: 'unsandboxed' }),
  });
  const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  try {
    const idle = await child.waitForIdleInput();
    await writePtyTextAndSubmit(child, '/retry-tool');
    await child.waitForVisibleOutput('No tool call to retry.');
    expect(requests).toHaveLength(0);
    await writePtyTextAndSubmit(child, 'ORIGINAL_RETRY_INPUT');
    await child.waitForState(() => requests.length === 1);
    complete(0, [call('retry-call')]);
    await child.waitForVisibleOutput('Allow this action?');
    await child.write('y');
    await child.waitForState(() => requests.length === 2);
    expect(await readFile(join(lease.root, 'retry-effects.txt'), 'utf8')).toBe('x');
    complete(1, [message('ANSWER_TO_REMOVE')]);
    await child.waitForVisibleOutput('ANSWER_TO_REMOVE');
    const nextIdle = await child.waitForIdleInput({ after: idle });
    await writePtyTextAndSubmit(child, '/retry-tool');
    await child.waitForState(() => requests.length === 3);
    const retryInput = requests[2]!.input as Record<string, unknown>[];
    expect(retryInput.map((item) => item.type)).toEqual(['message', 'function_call', 'function_call_output']);
    const originalResult = (requests[1]!.input as Record<string, unknown>[]).filter(
      (item) => item.type === 'function_call_output' && item.call_id === 'retry-call',
    );
    expect(originalResult).toHaveLength(1);
    expect(retryInput.filter((item) => item.type === 'function_call' && item.call_id === 'retry-call')).toEqual([
      {
        type: 'function_call',
        call_id: 'retry-call',
        name: 'shell',
        arguments: JSON.stringify({ command: 'printf x >> retry-effects.txt', sandbox: 'unsandboxed' }),
      },
    ]);
    expect(retryInput.filter((item) => item.type === 'function_call_output' && item.call_id === 'retry-call')).toEqual(
      originalResult,
    );
    expect(JSON.stringify(retryInput).match(/ORIGINAL_RETRY_INPUT/g)).toHaveLength(1);
    expect(JSON.stringify(retryInput)).not.toContain('ANSWER_TO_REMOVE');
    expect(requests[2]!.previous_response_id).toBeUndefined();
    expect(await readFile(join(lease.root, 'retry-effects.txt'), 'utf8')).toBe('x');
    complete(2, [message('RETRY_DONE')]);
    await child.waitForVisibleOutput('RETRY_DONE');
    await child.waitForIdleInput({ after: nextIdle });
    expect(await readFile(join(lease.root, 'retry-effects.txt'), 'utf8')).toBe('x');
  } finally {
    await child.cleanup();
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
