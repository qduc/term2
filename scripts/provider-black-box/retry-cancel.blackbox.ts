import { createServer, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it('retries a failed turn and suppresses a cancelled live response', async () => {
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
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
  const lease = await createIsolatedWorkspaceLease({
    prefix: 'term2-retry-cancel-',
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
        }),
      );
    },
  });
  const child = await lease.start({
    command: process.execPath,
    args: [
      process.env.TERM2_TEST_CLI ? resolve(process.env.TERM2_TEST_CLI) : join(process.cwd(), 'dist/cli.js'),
      '--lite',
      '--profile',
      'full',
    ],
    cwd: lease.root,
    cols: 120,
    rows: 40,
  });
  const complete = (index: number) => {
    const response = pending[index];
    if (!response) throw new Error(`Missing request ${index}`);
    const id = `notice-response-${index}`;
    for (const frame of [
      { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
      {
        type: 'response.completed',
        response: {
          id,
          status: 'completed',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `NOTICE_DONE_${index}` }] },
          ],
        },
      },
    ])
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end();
  };
  try {
    const idle = await child.waitForIdleInput();
    await writePtyTextAndSubmit(child, '/retry-turn');
    await child.waitForVisibleOutput('Retry did not produce a new response.');
    expect(requests).toHaveLength(0);
    await writePtyTextAndSubmit(child, 'FAILED_ORIGINAL');
    await child.waitForState(() => requests.length === 1);
    pending[0]!.write(
      `data: ${JSON.stringify({
        type: 'response.created',
        response: { id: 'failed-response', status: 'in_progress' },
      })}\n\n`,
    );
    pending[0]!.end(
      `data: ${JSON.stringify({
        type: 'response.failed',
        response: {
          id: 'failed-response',
          status: 'failed',
          error: { code: 'fixture_error', message: 'FIXTURE_FAILURE' },
        },
      })}\n\n`,
    );
    await child.waitForVisibleOutput('FIXTURE_FAILURE');
    expect(child.getVisibleOutput()).not.toContain('NOTICE_DONE_0');
    const failedIdle = await child.waitForIdleInput({ after: idle });
    await writePtyTextAndSubmit(child, '/retry-turn');
    await child.waitForState(() => requests.length === 2);
    expect(JSON.stringify(requests[1]!.input).match(/FAILED_ORIGINAL/g)).toHaveLength(1);
    expect((requests[1]!.input as Record<string, unknown>[]).filter((item) => item.role === 'user')).toHaveLength(1);
    expect(requests[1]!.previous_response_id).toBeUndefined();
    complete(1);
    await child.waitForVisibleOutput('NOTICE_DONE_1');
    const retryIdle = await child.waitForIdleInput({ after: failedIdle });
    await writePtyTextAndSubmit(child, 'CANCEL_LIVE');
    await child.waitForState(() => requests.length === 3);
    pending[2]!.write(
      `data: ${JSON.stringify({
        type: 'response.created',
        response: { id: 'cancelled-response', status: 'in_progress' },
      })}\n\n`,
    );
    pending[2]!.write(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'PARTIAL_BEFORE_CANCEL' })}\n\n`,
    );
    await child.waitForVisibleOutput('PARTIAL_BEFORE_CANCEL');
    await child.write('\u0003');
    const cancelledIdle = await child.waitForIdleInput({ after: retryIdle });
    await child.waitForState(() => pending[2]!.destroyed);
    expect(pending[2]!.destroyed).toBe(true);
    expect(
      pending[2]!.write(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'LATE_CANCELLED_TEXT' })}\n\n`,
      ),
    ).toBe(false);
    await writePtyTextAndSubmit(child, 'AFTER_CANCEL');
    await child.waitForState(() => requests.length === 4);
    expect(requests[3]!.previous_response_id).toBeUndefined();
    expect(JSON.stringify(requests[3]!.input)).toContain('AFTER_CANCEL');
    expect(JSON.stringify(requests[3]!.input)).not.toContain('LATE_CANCELLED_TEXT');
    expect(child.getVisibleOutput()).not.toContain('LATE_CANCELLED_TEXT');
    complete(3);
    await child.waitForVisibleOutput('NOTICE_DONE_3');
    await child.waitForIdleInput({ after: cancelledIdle });
  } finally {
    await child.cleanup();
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  }
});
