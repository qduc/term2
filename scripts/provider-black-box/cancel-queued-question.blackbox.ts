import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

// The cancelled question's output goes ahead of the steer; without it a real Responses server refuses the
// chain with "No tool output found" (#150 item 10).

// Codex has its own input filters on a chained request, so item 10 is pinned on both Responses routes.
// Accepted difference (#149): the direct CLI has no question-capable Pair profile.
it.skip.each(['openai', 'codex'] as const)(
  'delivers a pending steer after cancelling an unanswered question (%s)',
  async (provider) => {
    const requests: Record<string, unknown>[] = [];
    const pending: ServerResponse[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const part of request) body += String(part);
      // Codex also asks for its model catalog; only Responses requests are turns.
      if (request.method !== 'POST' || !request.url?.includes('responses')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [] }));
        return;
      }
      requests.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': fixture connection accepted\n\n');
      pending.push(response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
    const lease = await createIsolatedWorkspaceLease({
      prefix: 'term2-cancel-steer-',
      env: { OPENAI_BASE_URL: `http://127.0.0.1:${address.port}`, CODEX_BASE_URL: `http://127.0.0.1:${address.port}` },
      prepare: async (_root, paths) => {
        await mkdir(paths.logDir, { recursive: true });
        await writeFile(
          join(paths.logDir, 'settings.json'),
          JSON.stringify({
            agent: {
              modelSelection: { model: 'gpt-5.6-luna', provider },
              transport: 'http',
              retryAttempts: 0,
              openai: { apiKey: 'fixture' },
            },
            shell: { autoApproveMode: 'off' },
          }),
        );
        if (provider === 'codex') {
          await mkdir(paths.codexHome, { recursive: true });
          const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
          const jwt = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
            exp: Math.floor(Date.now() / 1_000) + 3_600,
          })}.fixture`;
          await writeFile(
            join(paths.codexHome, 'auth.json'),
            JSON.stringify({
              tokens: { access_token: jwt, refresh_token: 'fixture-refresh-token', account_id: 'fixture-account' },
            }),
          );
        }
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
      // Codex reads the items from their own events; OpenAI from the completed response.
      for (const frame of [
        { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
        ...output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
        { type: 'response.completed', response: { id, status: 'completed', output } },
      ])
        response.write(`data: ${JSON.stringify(frame)}\n\n`);
      response.end();
    };
    const question = (id: string, text: string) => ({
      id: `item-${id}`,
      type: 'function_call',
      status: 'completed',
      call_id: id,
      name: 'ask_user',
      arguments: JSON.stringify({
        questions: [{ question: text, options: [{ label: 'Amber' }, { label: 'Violet' }] }],
      }),
    });
    const message = (text: string) => ({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
    try {
      const idle = await child.waitForIdleInput();
      await writePtyTextAndSubmit(child, 'QUESTION_PARENT');
      await child.waitForState(() => requests.length === 1);
      await writePtyTextAndSubmit(child, 'RELEASED_STEER');
      // The text appears in the composer before Enter is consumed. Wait for the
      // pending-steer row so the question cannot take ownership of that Enter.
      await child.waitForVisibleOutput('steer · mid-turn').catch((error: unknown) => {
        throw new Error('steer · mid-turn row missing', { cause: error });
      });
      complete(0, [question('cancelled-question', 'CANCEL_QUEUED_QUESTION')]);
      await child.waitForVisibleOutput('CANCEL_QUEUED_QUESTION');
      await child.write('\u001b');
      await child.waitForState(() => requests.length === 2);
      const filesAtRelease = (await readdir(lease.paths.conversationsDir)).filter((file) => file.endsWith('.jsonl'));
      const historyAtRelease = (
        await Promise.all(filesAtRelease.map((file) => readFile(join(lease.paths.conversationsDir, file), 'utf8')))
      ).join('\n');
      expect(historyAtRelease).toContain('cancelled-question');
      expect(historyAtRelease).toContain('User did not provide an answer.');
      expect(requests[1]!.previous_response_id).toBe('question-response-0');
      // Codex lists the tools as the input's first item; the turn's own items follow.
      const turnItems = (requests[1]!.input as Record<string, unknown>[]).filter(
        (item) => item.type !== 'additional_tools',
      );
      expect(turnItems).toEqual([
        { type: 'function_call_output', call_id: 'cancelled-question', output: 'User did not provide an answer.' },
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '<system-notice>\nThe user cancelled the pending question without answering (they pressed Escape). Do not resume, continue, or restate the plan or work that was in progress when you asked; treat it as dropped. Act only on the genuinely new input in this turn.\n</system-notice>\n\nRELEASED_STEER',
            },
          ],
        },
      ]);
      complete(1, [message('RELEASED_DONE')]);
      await child.waitForVisibleOutput('RELEASED_DONE');
      const afterRelease = await child.waitForIdleInput({ after: idle });
      expect(requests).toHaveLength(2);
      await writePtyTextAndSubmit(child, 'FRESH_FOLLOWUP');
      await child.waitForState(() => requests.length === 3);
      expect(JSON.stringify(requests[2]!.input)).toContain('FRESH_FOLLOWUP');
      expect(JSON.stringify(requests[2]!.input)).not.toContain('The user cancelled the pending question');
      complete(2, [message('FOLLOWUP_DONE')]);
      await child.waitForVisibleOutput('FOLLOWUP_DONE');
      await child.waitForIdleInput({ after: afterRelease });
      const files = (await readdir(lease.paths.conversationsDir)).filter((file) => file.endsWith('.jsonl'));
      const history = (
        await Promise.all(files.map((file) => readFile(join(lease.paths.conversationsDir, file), 'utf8')))
      ).join('\n');
      expect(history).toContain('User did not provide an answer.');
    } finally {
      await child.cleanup();
      await lease.cleanup();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  },
);
