import { createServer, type Server } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testCliPath } from '../../tests/helpers/terminal-e2e.js';
import { createIsolatedWorkspaceLease, type IsolatedWorkspaceLease } from './provider-test-harness.js';

/**
 * The notice stored with a turn that used up its retries must say whether the
 * provider could not be reached or answered with an error, and count attempts
 * in plain English. Each case runs the built CLI headless against a loopback
 * chat-completions server and reads the notice from the persisted conversation.
 */

let server: Server | undefined;
let lease: IsolatedWorkspaceLease | undefined;

afterEach(async () => {
  await lease?.cleanup().catch(() => undefined);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  lease = server = undefined;
});

async function failedTurnNotice(behaviour: 'http-500' | 'drop-connection', retryAttempts: number): Promise<string> {
  server = createServer((request, response) => {
    request.resume();
    if (behaviour === 'drop-connection') {
      request.socket.destroy();
      return;
    }
    response.writeHead(500, { 'content-type': 'application/json', 'retry-after': '0', connection: 'close' });
    response.end(JSON.stringify({ error: { message: 'internal fixture failure' } }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  lease = await createIsolatedWorkspaceLease({
    prefix: 'term2-exhausted-notice-',
    prepare: async (_root, paths) => {
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: { modelSelection: { model: 'fixture-chat', provider: 'fixture-custom' }, retryAttempts },
          app: { liteMode: true },
          providers: [
            {
              id: 'fixture-custom',
              name: 'fixture-custom',
              type: 'openai-compatible',
              baseUrl: `http://127.0.0.1:${port}`,
              apiKey: 'fixture-key',
            },
          ],
        }),
      );
    },
  });
  const run = await lease.runCli({
    cwd: lease.root,
    args: ['--lite', '--provider', 'fixture-custom', '--model', 'fixture-chat', '--json', 'Say hello.'],
    cliPath: testCliPath(join(process.cwd(), 'dist/cli.js')),
    deadlineMs: 60_000,
  });
  expect(run.exitCode, run.stderr).toBe(1);
  const log = (await readdir(lease.paths.conversationsDir)).find((name) => name.endsWith('.jsonl'))!;
  const rows = (await readFile(join(lease.paths.conversationsDir, log), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const ended = rows.map((row) => row.fact).find((fact) => fact?.type === 'turn_ended');
  expect(ended?.outcome, JSON.stringify(ended)).toBe('failed');
  return String(ended.notice);
}

describe('notice for a turn that ran out of retries', () => {
  it('says the provider answered with an error, not that it was unreachable, and counts attempts', async () => {
    const notice = await failedTurnNotice('http-500', 0);
    expect(notice).toContain('fixture-custom answered with an error');
    expect(notice).toMatch(/after 1 attempt\b/);
    expect(notice).not.toContain('Could not reach');
    expect(notice).not.toContain('No model response was received');
    expect(notice).toContain('/retry turn');
  });

  it('says the provider could not be reached when the connection fails', async () => {
    const notice = await failedTurnNotice('drop-connection', 0);
    expect(notice).toContain('Could not reach fixture-custom after 1 attempt.');
    expect(notice).toContain('No model response was received.');
    expect(notice).toContain('/retry turn');
  });
});
