import { createServer } from 'node:http';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runIsolatedCli } from './provider-test-harness.js';

// A headless `--auto-approve` run must not overrule the session's review. The
// command is GREEN to the classifier but asks to leave the sandbox, so it needs
// an approval; the deterministic reviewer then rejects or approves it. Before the
// fix, non-interactive-approval-policy.ts allowed any GREEN command before it
// looked at the review, so a rejected escape still ran.
it.each(['rejected', 'approved'] as const)(
  'headless --auto-approve honours a $verdict review of a GREEN unsandboxed command',
  async (verdict) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'term2-headless-review-')));
    const marker = join(dir, 'ran');
    let reviews = 0;
    let rootRequests = 0;
    const server = createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      const serialized = JSON.stringify(body.messages);
      let content: string | undefined;
      let toolCalls: unknown[] | undefined;
      if (serialized.includes('You decide whether tool actions')) {
        reviews++;
        const approve = verdict === 'approved';
        content = JSON.stringify({
          results: [
            {
              reasoning: approve ? 'Requested by the user.' : 'Fixture rejects this escape.',
              riskLevel: approve ? 'low' : 'high',
              authorization: approve ? 'explicit' : 'unknown',
              confidence: 'high',
            },
          ],
        });
      } else if (rootRequests++ === 0) {
        toolCalls = [
          {
            index: 0,
            id: 'escape_call',
            type: 'function',
            function: {
              name: 'shell',
              arguments: JSON.stringify({ command: `printf ran > '${marker}'`, sandbox: 'unsandboxed' }),
            },
          },
        ];
      } else {
        content = 'Finished.';
      }
      if (body.stream === false) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'fixture',
            choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
          }),
        );
      } else {
        res.setHeader('content-type', 'text/event-stream');
        res.end(
          `data: ${JSON.stringify({
            id: 'fixture',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  ...(content ? { content } : {}),
                  ...(toolCalls ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: toolCalls ? 'tool_calls' : 'stop',
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const result = await runIsolatedCli({
        cwd: process.cwd(),
        args: [
          'Write the marker outside the sandbox.',
          '--auto-approve',
          '--provider',
          'fixture-provider',
          '--model',
          'fixture',
          '--json',
        ],
        deadlineMs: 20000,
        prepare: async (_root, paths) => {
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
                modelSelection: { model: 'fixture', provider: 'fixture-provider' },
                choreModel: [{ model: 'fixture', provider: 'fixture-provider' }],
                completionVerification: false,
              },
              shell: { autoApproveMode: 'auto' },
              sandbox: { enabled: true },
              memory: { enabled: false },
            }),
          );
        },
      });
      expect(result.timedOut).toBe(false);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(reviews).toBe(1);
      expect(existsSync(marker)).toBe(verdict === 'approved');
      expect(result.stdout.includes('approval_rejected')).toBe(verdict === 'rejected');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
