import { createServer, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it.skipIf(process.platform !== 'linux')('confirms a large uncached request after undo before dispatch', async () => {
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
    prefix: 'term2-input-cache-',
    env: { OPENAI_BASE_URL: `http://127.0.0.1:${address.port}` },
    prepare: async (root, paths) => {
      await mkdir(join(root, 'bin'), { recursive: true });
      await writeFile(join(root, 'large.txt'), 'LARGE_DRAFT_START' + 'x'.repeat(270_000) + 'LARGE_DRAFT_END');
      await writeFile(
        join(root, 'bin', 'xclip'),
        '#!/bin/sh\ncase "$*" in *image/png*) exit 1;; *) cat "$CLIPBOARD_FIXTURE";; esac\n',
        { mode: 0o755 },
      );
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
    env: {
      PATH: `${join(lease.root, 'bin')}:${process.env.PATH ?? ''}`,
      CLIPBOARD_FIXTURE: join(lease.root, 'large.txt'),
      WAYLAND_DISPLAY: undefined,
    },
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
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: `NOTICE_DONE_${index}`,
                },
              ],
            },
          ],
        },
      },
    ])
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end();
  };
  try {
    const idle = await child.waitForIdleInput();
    await writePtyTextAndSubmit(child, 'FIRST_CACHE_INPUT');
    await child.waitForState(() => requests.length === 1);
    complete(0);
    await child.waitForVisibleOutput('NOTICE_DONE_0');
    const firstIdle = await child.waitForIdleInput({ after: idle });
    await writePtyTextAndSubmit(child, 'SECOND_CACHE_INPUT');
    await child.waitForState(() => requests.length === 2);
    complete(1);
    await child.waitForVisibleOutput('NOTICE_DONE_1');
    await child.waitForIdleInput({ after: firstIdle });
    await writePtyTextAndSubmit(child, '/undo 2');
    await child.waitForComposerValue('SECOND_CACHE_INPUT', { afterRevision: 0 });
    for (let remaining = 'SECOND_CACHE_INPUT'.length - 1; remaining >= 0; remaining--) {
      await child.write('\u007f');
      await child.waitForComposerValue('SECOND_CACHE_INPUT'.slice(0, remaining), { afterRevision: 0 });
    }
    await child.write('\u001b[Z');
    await child.waitForVisibleOutput('Plan');
    await child.write('\u0016');
    await child.waitForVisibleOutput('Paste text #1');
    await child.waitForVisibleOutput('cache miss risk');
    expect(requests).toHaveLength(2);
    await child.write('\r');
    await child.waitForVisibleOutput('Large request');
    expect(requests).toHaveLength(2);
    await child.write('n');
    await child.waitForComposerValue('LARGE_DRAFT_START' + 'x'.repeat(270_000) + 'LARGE_DRAFT_END', {
      afterRevision: 0,
    });
    expect(requests).toHaveLength(2);
    const confirmationMarker = child.getOutput().length;
    await child.write('\r');
    await child.waitForState((state) => state.output.slice(confirmationMarker).includes('Large request'));
    await child.write('y');
    await child.waitForState(() => requests.length === 3);
    expect(JSON.stringify(requests[2]!.input)).toContain('Plan Mode is ON');
    expect(JSON.stringify(requests[2]!.input)).toContain('LARGE_DRAFT_START' + 'x'.repeat(270_000) + 'LARGE_DRAFT_END');
    complete(2);
    await child.waitForVisibleOutput('NOTICE_DONE_2');
  } finally {
    await child.cleanup();
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  }
});
