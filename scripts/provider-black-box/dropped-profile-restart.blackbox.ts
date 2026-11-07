import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getProfileMetadata } from '../../src/config/profiles/active-profile.js';
import { profileEnterNotice } from '../../src/session/mode-notices.js';
import type { FactLine } from '../../src/session/facts.js';
import { createIsolatedWorkspaceLease, exitInteractive, writePtyTextAndSubmit } from './provider-test-harness.js';

// Seed genuine CLI-produced logs as historical dropped workflows, then reopen through the real CLI.
// This exercises persistence migration without reintroducing dropped profiles as selectable modes.
it
  .skipIf(process.platform !== 'linux')
  .each(
    ['plan', 'pair', 'mentor', 'orchestrator'].flatMap((profile) => [false, true].map((fork) => ({ profile, fork }))),
  )(
  'reopens historical $profile as Bare and retries its image without its old mode notice (fork=$fork)',
  async ({ profile, fork }) => {
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
      prefix: 'term2-dropped-profile-retry-',
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
      args: [join(process.cwd(), 'dist/src/app/cli.js'), '--lite', '--profile', 'bare'],
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
      const originalPath = join(dir, files[0]!);
      const originalRows = (await readFile(originalPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as FactLine);
      const metadata = getProfileMetadata(`builtin:${profile}`);
      const historicalProfile = {
        id: metadata.activeProfileId,
        version: metadata.activeProfileVersion,
        digest: metadata.activeProfileDigest,
      };
      const oldNotice = profileEnterNotice(`builtin:${profile}`)!;
      expect(oldNotice).toBeTruthy();
      const rows = originalRows.map((row): FactLine => {
        if (row.fact.type === 'session_started') {
          // Pair specifically covers the latest configuration_changed profile rather than only the header.
          return profile === 'pair' ? row : { ...row, fact: { ...row.fact, profile: historicalProfile } };
        }
        if (row.fact.type === 'turn_started') {
          expect(row.fact.requestConfiguration).toBeDefined();
          return {
            ...row,
            fact: {
              ...row.fact,
              requestConfiguration: { ...row.fact.requestConfiguration!, mode: profile },
              requestNotice: oldNotice,
            },
          };
        }
        return row;
      });
      if (profile === 'pair') {
        const start = rows[0]!;
        if (start.fact.type !== 'session_started') throw new Error('Expected native session header');
        rows.push({
          ...start,
          seq: rows.at(-1)!.seq + 1,
          fact: {
            type: 'configuration_changed',
            configuration: { model: start.fact.model },
            intent: { modelSelection: start.fact.model, reasoningEffort: 'default' },
            profile: historicalProfile,
          },
        });
      }
      const historicalBytes = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
      await writeFile(originalPath, historicalBytes);
      child = await lease.start({
        command: process.execPath,
        args: [join(process.cwd(), 'dist/src/app/cli.js'), '--resume', sessionId, ...(fork ? ['--fork'] : [])],
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
      expect(JSON.stringify(requests[1])).toContain('Use the shell to read, search, and edit files');
      expect(JSON.stringify(requests[1])).not.toContain(oldNotice);
      expect(JSON.stringify(requests[1])).not.toMatch(/(?:Plan|Pair|Mentor|Orchestrator) Mode is ON/);
      expect(JSON.stringify(requests[1])).not.toContain('propose_goal');
      expect(requests[1]!.previous_response_id).toBeUndefined();
      complete(1);
      await child.waitForVisibleOutput('NOTICE_DONE_1');
      const retryIdle = await child.waitForIdleInput({ after: resumedIdle });
      await writePtyTextAndSubmit(child, 'AFTER_RESTART_INPUT');
      await child.waitForState(() => requests.length === 3);
      expect(JSON.stringify(requests[2]!.input)).toContain('AFTER_RESTART_INPUT');
      expect(requests[2]!.previous_response_id).toBe('notice-response-1');
      complete(2);
      await child.waitForVisibleOutput('NOTICE_DONE_2');
      await child.waitForIdleInput({ after: retryIdle });
      await exitInteractive(child);
      const savedOriginal = await readFile(originalPath, 'utf8');
      if (fork) expect(savedOriginal).toBe(historicalBytes);
      else expect(savedOriginal.startsWith(historicalBytes)).toBe(true);
      const savedFiles = (await readdir(dir)).filter((file) => file.endsWith('.jsonl'));
      expect(savedFiles).toHaveLength(fork ? 2 : 1);
      const activePath = fork ? join(dir, savedFiles.find((file) => file !== files[0])!) : originalPath;
      const activeFacts = (await readFile(activePath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as FactLine).fact);
      const retried = activeFacts.filter((fact) => fact.type === 'turn_started' && fact.retryContext);
      expect(retried).toHaveLength(1);
      expect(retried[0]).toMatchObject({ requestConfiguration: { mode: 'bare' } });
      expect(retried[0]).not.toHaveProperty('requestNotice');
    } finally {
      await child.cleanup();
      await lease.cleanup();
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    }
  },
);
