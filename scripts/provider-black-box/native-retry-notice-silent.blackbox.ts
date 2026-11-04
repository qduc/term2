import { createServer, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it.skipIf(process.platform !== 'linux')('replays a silent background turn notice when retrying its tool', async () => {
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
    prefix: 'term2-input-notice-',
    env: { OPENAI_BASE_URL: `http://127.0.0.1:${address.port}` },
    prepare: async (root, paths) => {
      await mkdir(join(root, 'bin'), { recursive: true });
      await writeFile(
        join(root, 'clipboard.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      await writeFile(join(root, 'bin', 'xclip'), '#!/bin/sh\ncat "$CLIPBOARD_FIXTURE"\n', { mode: 0o755 });
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          // This fixture tests notice replay, not sandbox availability or approval policy.
          // Both shell calls are fixed, harmless fixture commands in this disposable workspace.
          sandbox: { enabled: false },
          shell: { autoApproveMode: 'always' },
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
    args: [join(process.cwd(), 'rewrite/dist/rewrite/src/app/cli.js'), '--lite', '--profile', 'pair'],
    env: {
      PATH: `${join(lease.root, 'bin')}:${process.env.PATH ?? ''}`,
      CLIPBOARD_FIXTURE: join(lease.root, 'clipboard.png'),
      WAYLAND_DISPLAY: undefined,
    },
    cwd: lease.root,
    cols: 120,
    rows: 40,
  });
  const complete = (index: number, output: Record<string, unknown>[]) => {
    const response = pending[index];
    if (!response) throw new Error(`Missing request ${index}`);
    const id = `notice-response-${index}`;
    response.write(
      `data: ${JSON.stringify({ type: 'response.created', response: { id, status: 'in_progress', output: [] } })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output } })}\n\n`,
    );
    response.end();
  };
  const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  const call = (id: string, command: string, background = false) => ({
    id: `item-${id}`,
    type: 'function_call',
    status: 'completed',
    call_id: id,
    name: 'shell',
    arguments: JSON.stringify({ command, ...(background ? { background: true } : {}) }),
  });
  try {
    const idle = await child.waitForIdleInput();
    await writePtyTextAndSubmit(child, 'START_BACKGROUND');
    await child.waitForState(() => requests.length === 1);
    complete(0, [call('background-call', 'while [ ! -e .fixture-release ]; do sleep 0.05; done', true)]);
    await child.waitForState(() => requests.length === 2);
    complete(1, [message('BACKGROUND_STARTED')]);
    await child.waitForVisibleOutput('BACKGROUND_STARTED');
    const nextIdle = await child.waitForIdleInput({ after: idle });
    await writePtyTextAndSubmit(child, '/profile plan');
    // Legacy /profile switches silently; the idle composer below marks the switch done.
    await child.waitForIdleInput({ after: nextIdle });
    await child.waitForComposerValue('', { afterRevision: 0 });
    const switchedIdle = child.readIdleGeneration();
    await writeFile(join(lease.root, '.fixture-release'), 'go');
    await child.waitForState(() => requests.length === 3);
    expect(JSON.stringify(requests[2]!.input)).toContain('Plan Mode is ON');
    complete(2, [call('silent-call', 'pwd')]);
    await child.waitForState(() => requests.length === 4);
    complete(3, [message('SILENT_DONE')]);
    await child.waitForVisibleOutput('SILENT_DONE');
    await child.waitForIdleInput({ after: switchedIdle });
    await child.waitForComposerValue('', { afterRevision: 0 });
    await writePtyTextAndSubmit(child, '/retry-tool');
    await child.waitForState(() => requests.length === 5);
    expect(JSON.stringify(requests[4]!.input)).toContain('Plan Mode is ON');
    complete(4, [message('RETRY_DONE')]);
    await child.waitForVisibleOutput('RETRY_DONE');
  } finally {
    await child.cleanup();
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  }
});
