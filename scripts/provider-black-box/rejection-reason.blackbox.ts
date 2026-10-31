import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it('sends a rejection reason without running the denied tool', async () => {
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
    prefix: 'term2-reject-reason-',
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
          shell: { autoApproveMode: 'off' },
        }),
      );
    },
  });
  const child = await lease.start({
    command: process.execPath,
    // This journey needs Pair capabilities; full/standard now alias Bare.
    // Keep --lite to bypass the home-directory start guard (cwd is HOME),
    // then select Pair explicitly rather than relying on a legacy alias.
    args: [
      process.env.TERM2_TEST_CLI ? resolve(process.env.TERM2_TEST_CLI) : join(process.cwd(), 'dist/cli.js'),
      '--lite',
      '--profile',
      'pair',
    ],
    cwd: lease.root,
    cols: 120,
    rows: 40,
  });
  const complete = (index: number, output: Record<string, unknown>[]) => {
    const response = pending[index];
    if (!response) throw new Error(`Missing request ${index}`);
    const id = `question-response-${index}`;
    for (const frame of [
      { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
      { type: 'response.completed', response: { id, status: 'completed', output } },
    ])
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end();
  };
  const call = (id: string, file: string) => ({
    id: `item-${id}`,
    type: 'function_call',
    status: 'completed',
    call_id: id,
    name: 'shell',
    arguments: JSON.stringify({ command: `printf x >> ${file}`, sandbox: 'unsandboxed' }),
  });
  const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  const outputs = (index: number, callId: string) =>
    (requests[index]!.input as Record<string, unknown>[]).filter(
      (item) => item.type === 'function_call_output' && item.call_id === callId,
    );
  try {
    const idle = await child.waitForIdleInput();
    await writePtyTextAndSubmit(child, 'MIXED_APPROVALS');
    await child.waitForState(() => requests.length === 1);
    complete(0, [call('denied-call', 'denied.txt')]);
    await child.waitForVisibleOutput('Allow this action?');
    await child.write('2');
    await child.waitForVisibleOutput('(or Esc to cancel)');
    await writePtyTextAndSubmit(child, 'REJECTION_REASON_MARKER');
    await child.waitForState(() => requests.length === 2);
    expect(outputs(1, 'denied-call')).toHaveLength(1);
    expect(outputs(1, 'denied-call')[0]!.output).toBe(
      "Tool execution was not approved. User's reason: REJECTION_REASON_MARKER",
    );
    await expect(readFile(join(lease.root, 'denied.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    complete(1, [message('MIXED_DONE')]);
    await child.waitForVisibleOutput('MIXED_DONE');
    const nextIdle = await child.waitForIdleInput({ after: idle });
    await writePtyTextAndSubmit(child, 'AFTER_REJECTION');
    await child.waitForState(() => requests.length === 3);
    expect(JSON.stringify(requests[2]!.input)).toContain('AFTER_REJECTION');
    expect(JSON.stringify(requests[2]!.input)).not.toContain('REJECTION_REASON_MARKER');
    complete(2, [message('FOLLOWUP_DONE')]);
    await child.waitForVisibleOutput('FOLLOWUP_DONE');
    await child.waitForIdleInput({ after: nextIdle });
  } finally {
    await child.cleanup();
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
