import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it('delivers a pending steer after cancelling an unanswered question', async () => {
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
  const lease = await createIsolatedWorkspaceLease({
    prefix: 'term2-cancel-steer-',
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
          shell: { autoApproveMode: 'off' },
        }),
      );
    },
  });
  const child = await lease.start({
    command: process.execPath,
    // ask_user needs a Profile with user interaction; Bare (what --lite now
    // selects) has none. --lite still bypasses the home-directory start guard
    // (cwd is HOME here), and --profile full overrides the Profile it selects.
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
  const complete = (index: number, output: Record<string, unknown>[]) => {
    const response = pending[index];
    if (!response) throw new Error(`Missing request ${index}`);
    const id = `question-response-${index}`;
    for (const frame of [
      { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
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
  const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  try {
    const idle = await child.waitForIdleInput();
    await writePtyTextAndSubmit(child, 'QUESTION_PARENT');
    await child.waitForState(() => requests.length === 1);
    await writePtyTextAndSubmit(child, 'RELEASED_STEER');
    await child.waitForVisibleOutput('RELEASED_STEER');
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
    expect(requests[1]!.input).toEqual([
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
});
