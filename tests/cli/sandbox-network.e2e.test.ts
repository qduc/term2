import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import { getProviderIds } from '../../src/model/providers/index.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import { createTestChildEnv, spawnTerminal, testCliPath } from '../helpers/terminal-e2e.js';

// Opt-in: runs only with RUN_SHELL_SANDBOX_INTEGRATION=1, because it needs the real sandbox: bwrap and socat
// on PATH and a kernel with IPv6 (the sandbox's in-namespace proxy bridge is `socat TCP-LISTEN:3128`, which
// opens an AF_INET6 socket; without IPv6 the fetch fails with "Failed to connect to localhost port 3128" and
// the prompt never appears). CI's `test` job has those and sets the variable, and scripts/run-ci-lane.mjs
// places this file in that lane, not in `e2e`, whose job installs no sandbox tools. It needs a PTY only for
// the approval prompt ("Allow once" / "Always allow host for this project"). The policy underneath (blocked
// without approval, reachable after `sandbox-network allow`, closed by `allowNetworking: false` or a revoke)
// is checked headlessly by sandbox-network.integration.test.ts; the prompt flow and the reuse across linked
// worktrees are checked only here.
const cli = testCliPath(fileURLToPath(new URL('../../dist/src/app/cli.js', import.meta.url)));
const enabled = ['darwin', 'linux'].includes(process.platform) && process.env.RUN_SHELL_SANDBOX_INTEGRATION === '1';

it.skipIf(!enabled)(
  'approves a linked-worktree fetch and reuses or revokes the decision across sessions',
  {
    timeout: 90_000,
  },
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-network-e2e-')));
    const home = path.join(root, 'home');
    const scratch = path.join(root, 'scratch');
    const repo = path.join(root, 'repo');
    const linked = path.join(root, 'linked');
    const remote = path.join(root, 'remote.git');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' });
    for (const dir of [home, repo, scratch]) fs.mkdirSync(dir);
    git(repo, 'init', '-q');
    git(
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
      '--allow-empty',
    );
    git(repo, 'worktree', 'add', '-qb', 'linked', linked);
    git(repo, 'clone', '-q', '--bare', repo, remote);
    git(repo, '--git-dir=' + remote, 'update-server-info');

    const fixtureCredentials = 'fixture:fixture-token';
    const authorization = 'Basic ' + Buffer.from(fixtureCredentials).toString('base64');
    let command = '';
    let posts = 0;
    const results: string[] = [];
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (/^\/remote\/(?:HEAD|info\/refs|objects\/[a-zA-Z0-9/._-]+)$/.test(pathname)) {
        if (req.headers.authorization !== authorization) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' }).end();
          return;
        }
        const target = path.resolve(remote, pathname.slice('/remote/'.length));
        if (!target.startsWith(remote + path.sep)) {
          res.writeHead(404).end();
          return;
        }
        const stream = fs.createReadStream(target);
        stream.once('error', () => res.writeHead(404).end());
        stream.once('open', () => stream.pipe(res));
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[]}');
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const messages = (JSON.parse(body).messages ?? []) as { role: string; content?: unknown }[];
        for (const entry of messages) if (entry.role === 'tool') results.push(String(entry.content));
        const first = posts++ === 0;
        const delta = first
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'fetch-1',
                  type: 'function',
                  function: {
                    name: 'shell',
                    arguments: JSON.stringify({ command, description: 'Fetch fixture repository' }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'AFTER-FETCH' };
        const frames = [
          { id: 'fetch-chat', choices: [{ delta }] },
          { id: 'fetch-chat', choices: [{ delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture server address');
      const host = '127.0.0.1';
      const { port } = address;
      const baseUrl = `http://${host}:${port}`;
      command = `git -c credential.helper= fetch --no-tags http://${fixtureCredentials}@${host}:${port}/remote/ HEAD`;
      const env = createTestChildEnv({
        HOME: home,
        TMPDIR: scratch,
        TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
        DISABLE_LOGGING: '1',
        CI: 'false',
      });
      const settings = resolveSettingsDirectory({ homeDir: home, env });
      fs.mkdirSync(settings, { recursive: true });
      fs.writeFileSync(
        path.join(settings, 'settings.json'),
        JSON.stringify({
          agent: { retryAttempts: 0, disabledProviders: getProviderIds() },
          providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: `${baseUrl}/v1`, apiKey: 'fixture' }],
          sandbox: { enabled: true },
          shell: { autoApproveMode: 'off', timeout: 20_000 },
        }),
      );

      async function fetchFrom(cwd: string, approve: boolean): Promise<void> {
        posts = 0;
        results.length = 0;
        const idlePath = path.join(root, `idle-${path.basename(cwd)}`);
        const terminal = spawnTerminal('node', [cli, '-m', 'mockprov/mock-alpha'], {
          cwd,
          env: { ...env, [HARNESS_IDLE_ENV]: idlePath },
          cols: 110,
          rows: 36,
        });
        try {
          await waitForHarnessIdleGeneration(idlePath);
          terminal.write('Fetch the fixture');
          await waitForHarnessComposerValue(idlePath, 'Fetch the fixture');
          terminal.write('\r');
          if (approve) {
            await terminal.waitForOutput('❯ 1. Allow once');
            terminal.write('\x1b[A');
            await terminal.waitForOutput('❯ 3. Always allow host for this project');
            terminal.write('\r');
          }
          await terminal.waitForOutput('AFTER-FETCH');
          expect(results.at(-1)).toMatch(/HEAD\s+-> FETCH_HEAD/);
          expect(terminal.getOutput().includes('Always allow host for this project')).toBe(approve);
        } finally {
          terminal.dispose();
        }
      }

      await fetchFrom(linked, true);
      await fetchFrom(repo, false);
      const nested = path.join(repo, 'nested');
      fs.mkdirSync(nested);
      const provision = (decision: 'allow' | 'revoke', destinationPort = port) => {
        const result = spawnSync('node', [cli, 'sandbox-network', decision, host, String(destinationPort)], {
          cwd: nested,
          env,
        });
        expect(result.status, result.stderr?.toString()).toBe(0);
      };
      async function fetchHeadless() {
        posts = 0;
        results.length = 0;
        await promisify(execFile)('node', [cli, '-m', 'mockprov/mock-alpha', '--json', 'Fetch the fixture'], {
          cwd: linked,
          env,
          timeout: 30_000,
        });
        return results.at(-1);
      }

      provision('revoke');
      provision('allow', port === 65535 ? port - 1 : port + 1);
      expect(await fetchHeadless()).toMatch(/403|requires.*approval/i);
      provision('allow');
      expect(await fetchHeadless()).toMatch(/HEAD\s+-> FETCH_HEAD/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
