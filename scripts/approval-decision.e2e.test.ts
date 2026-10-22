import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-black-box/provider-test-harness.js';

// Real shell, sandbox, session facade, Ink input and provider wire. Only the
// external provider is a fixture; a projection-only test misses the held tool.
// This real Linux sandbox journey needs the same host dependencies as the CLI.
const hasSandbox =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--', '/bin/true']).status === 0 &&
  spawnSync('socat', ['-V']).status === 0;
it.skipIf(!hasSandbox).each(['deny', 'allow-once', 'escape', 'auto-approve'] as const)(
  'settles a sandbox blocked-read approval through the interactive CLI: %s',
  async (decision) => {
    const requests: { messages: { role: string; content: string; tool_call_id?: string }[] }[] = [];
    let command = '';
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
        return;
      }
      let text = '';
      for await (const chunk of req) text += chunk;
      requests.push(JSON.parse(text));
      const tool = requests.length === 1;
      res.setHeader('content-type', 'text/event-stream');
      res.end(
        `data: ${JSON.stringify({
          id: `fixture-${requests.length}`,
          choices: [
            {
              index: 0,
              delta: tool
                ? {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'blocked-read',
                        type: 'function',
                        function: {
                          name: 'shell',
                          arguments: JSON.stringify({ command, background: false }),
                        },
                      },
                    ],
                  }
                : { role: 'assistant', content: 'fixture-turn-settled' },
              finish_reason: tool ? 'tool_calls' : 'stop',
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const workspace = await createIsolatedWorkspaceLease({
      prefix: 'term2-blocked-read-',
      prepare: async (root, paths) => {
        await mkdir(join(root, 'work'));
        await mkdir(join(root, 'private'));
        await writeFile(join(root, 'private', 'data.txt'), 'fixture-private-content');
        command = `cat < '${join(root, 'private', 'data.txt')}'`;
        await mkdir(paths.logDir, { recursive: true });
        await writeFile(
          join(paths.logDir, 'settings.json'),
          JSON.stringify({
            providers: [
              {
                id: 'fixture-provider',
                name: 'fixture-provider',
                type: 'openai-compatible',
                baseUrl,
                apiKey: 'fixture-key',
              },
            ],
            agent: {
              modelSelection: { provider: 'fixture-provider', model: 'fixture' },
              completionVerification: false,
            },
            shell: { autoApproveMode: decision === 'auto-approve' ? 'auto' : 'off' },
            sandbox: { enabled: true, readPolicy: 'strict' },
            memory: { enabled: false },
          }),
        );
      },
    });
    try {
      const child = await workspace.start({
        command: process.execPath,
        args: [resolve('dist/cli.js'), '--provider', 'fixture-provider', '--model', 'fixture', '--profile', 'bare'],
        cwd: join(workspace.root, 'work'),
        cols: 140,
        rows: 40,
      });
      await child.waitForIdleInput();
      const idle = child.readIdleGeneration();
      await writePtyTextAndSubmit(child, 'Read the private fixture');
      await child.waitForVisibleOutput('Sandbox blocked read access:');
      expect(requests).toHaveLength(1);
      if (decision === 'escape') {
        await child.write('\u001b');
        await child.waitForIdleInput({ after: idle });
        await writePtyTextAndSubmit(child, 'Continue after cancellation');
      } else if (decision === 'allow-once') {
        await child.write('1');
      } else {
        await child.write('n');
        await writePtyTextAndSubmit(child, 'Do not read this path');
      }
      await child.waitForVisibleOutput('fixture-turn-settled');
      await child.waitForIdleInput({ after: idle });
      expect(child.getVisibleOutput()).not.toContain('No conversation decision is waiting');
      expect(requests).toHaveLength(2);
      const results = requests[1]!.messages.filter((message) => message.role === 'tool');
      if (decision !== 'escape') {
        expect(results).toHaveLength(1);
        expect(results[0]!.tool_call_id).toBe('blocked-read');
        expect(results[0]!.content.includes('fixture-private-content')).toBe(decision === 'allow-once');
        if (decision !== 'allow-once') expect(results[0]!.content).toContain('Sandbox blocked a read access');
      }
      // A subsequent user turn proves the retained run was released, not just
      // visually dismissed while the shell still waits on its registry gate.
      const settledIdle = child.readIdleGeneration();
      await writePtyTextAndSubmit(child, 'One more turn');
      await child.waitForState(() => requests.length === 3);
      await child.waitForIdleInput({ after: settledIdle });
      expect(requests).toHaveLength(3);
    } catch (error) {
      for (const file of await readdir(workspace.paths.logDir, { recursive: true })) {
        if (String(file).endsWith('.log'))
          console.error(
            String(file),
            (await readFile(join(workspace.paths.logDir, String(file)), 'utf8')).slice(-12000),
          );
      }
      throw new Error(
        `${String(error)}\nProvider history: ${JSON.stringify(
          requests.at(-1)?.messages.filter((message) => message.role === 'tool'),
        )}`,
        { cause: error },
      );
    } finally {
      await workspace.cleanup();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    }
  },
  90_000,
);
