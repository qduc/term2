import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, exitInteractive, writePtyTextAndSubmit } from './provider-test-harness.js';

it.skipIf(process.platform !== 'linux')(
  'retains the original retry notice across a process restart without changing durable user input',
  async () => {
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
    let child = await lease.start({
      command: process.execPath,
      args: [join(process.cwd(), 'rewrite/dist/rewrite/src/app/cli.js'), '--lite', '--profile', 'plan'],
      env: {
        PATH: `${join(lease.root, 'bin')}:${process.env.PATH ?? ''}`,
        TERM2_DIRECT_CONVERSATIONS_DIR: lease.paths.conversationsDir,
        CLIPBOARD_FIXTURE: join(lease.root, 'clipboard.png'),
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
      await child.write('FIRST_NOTICE_INPUT');
      await child.waitForComposerValue('FIRST_NOTICE_INPUT');
      await child.write('\u0016');
      await child.waitForVisibleOutput('Pasted Image #1');
      await child.write('\r');
      await child.waitForState(() => requests.length === 1);
      expect(JSON.stringify(requests[0]!.input)).toContain('Plan Mode is ON');
      expect(JSON.stringify(requests[0]!.input)).toContain('FIRST_NOTICE_INPUT');
      expect(JSON.stringify(requests[0]!.input)).toContain(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=',
      );
      expect(requests[0]!.input as unknown[]).toHaveLength(1);
      complete(0);
      await child.waitForVisibleOutput('NOTICE_DONE_0');
      await child.waitForIdleInput({ after: idle });
      await exitInteractive(child);
      const dir = lease.paths.conversationsDir;
      const files = (await readdir(dir)).filter((file) => file.endsWith('.jsonl'));
      expect(files).toHaveLength(1);
      const sessionId = files[0]!.slice(0, -'.jsonl'.length);
      const facts = (await readFile(join(dir, files[0]!), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { fact?: { type?: string; input?: unknown; requestNotice?: string } }).fact)
        .filter((fact) => fact?.type === 'turn_started');
      expect(facts).toHaveLength(1);
      expect(JSON.stringify(facts[0]!.input)).toContain('FIRST_NOTICE_INPUT');
      expect(JSON.stringify(facts[0]!.input)).not.toContain('Plan Mode is ON');
      expect(facts[0]!.requestNotice).toContain('Plan Mode is ON');
      child = await lease.start({
        command: process.execPath,
        args: [
          join(process.cwd(), 'rewrite/dist/rewrite/src/app/cli.js'),
          '--lite',
          '--profile',
          'plan',
          '--resume',
          sessionId,
        ],
        env: {
          PATH: `${join(lease.root, 'bin')}:${process.env.PATH ?? ''}`,
          TERM2_DIRECT_CONVERSATIONS_DIR: lease.paths.conversationsDir,
          CLIPBOARD_FIXTURE: join(lease.root, 'clipboard.png'),
          WAYLAND_DISPLAY: undefined,
        },
        cwd: lease.root,
        cols: 120,
        rows: 40,
      });
      const resumedIdle = await child.waitForIdleInput();
      await writePtyTextAndSubmit(child, '/retry-turn');
      await child.waitForState(() => requests.length === 2);
      expect(requests[1]!.input).toEqual(requests[0]!.input);
      expect(requests[1]!.previous_response_id).toBeUndefined();
      complete(1);
      await child.waitForVisibleOutput('NOTICE_DONE_1');
      const retryIdle = await child.waitForIdleInput({ after: resumedIdle });
      await writePtyTextAndSubmit(child, 'AFTER_RESTART_INPUT');
      await child.waitForState(() => requests.length === 3);
      expect(JSON.stringify(requests[2]!.input)).toContain('AFTER_RESTART_INPUT');
      expect(JSON.stringify(requests[2]!.input)).not.toContain('Plan Mode is ON');
      expect(requests[2]!.previous_response_id).toBe('notice-response-1');
      complete(2);
      await child.waitForVisibleOutput('NOTICE_DONE_2');
      await child.waitForIdleInput({ after: retryIdle });
    } finally {
      await child.cleanup();
      await lease.cleanup();
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    }
  },
);
