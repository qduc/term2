import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it('resumes repeated questions once per decision and settles cancellation before the next turn', async () => {
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
    prefix: 'term2-turn-decisions-',
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
          app: { liteMode: true },
          shell: { autoApproveMode: 'off' },
        }),
      );
    },
  });
  const child = await lease.start({
    command: process.execPath,
    args: [join(process.cwd(), 'dist/cli.js'), '--lite'],
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
  const outputs = (index: number, callId: string) =>
    (requests[index]!.input as Record<string, unknown>[]).filter(
      (item) => item.type === 'function_call_output' && item.call_id === callId,
    );
  try {
    await child.waitForIdleInput();
    const firstIdle = child.readIdleGeneration();
    await writePtyTextAndSubmit(child, 'ANSWER_A_QUESTION');
    await child.waitForState(() => requests.length === 1);
    complete(0, [question('answered-question', 'SELECT_ONE_COLOR')]);
    await child.waitForVisibleOutput('SELECT_ONE_COLOR');
    await child.write('2');
    await child.waitForState(() => requests.length === 2);
    expect(outputs(1, 'answered-question')).toHaveLength(1);
    expect(String(outputs(1, 'answered-question')[0]!.output)).toContain('Violet');
    expect(requests[1]!.previous_response_id).toBe('question-response-0');
    complete(1, [question('second-answered-question', 'SELECT_A_SECOND_COLOR')]);
    await child.waitForVisibleOutput('SELECT_A_SECOND_COLOR');
    await child.write('1');
    await child.waitForState(() => requests.length === 3);
    expect(outputs(2, 'second-answered-question')).toHaveLength(1);
    expect(String(outputs(2, 'second-answered-question')[0]!.output)).toContain('Amber');
    expect(requests[2]!.previous_response_id).toBe('question-response-1');
    expect(outputs(2, 'answered-question')).toHaveLength(0);
    complete(2, [message('ANSWER_SETTLED')]);
    await child.waitForVisibleOutput('ANSWER_SETTLED');
    await child.waitForIdleInput({ after: firstIdle });

    const beforeCancel = child.readIdleGeneration();
    await writePtyTextAndSubmit(child, 'CANCEL_A_QUESTION');
    await child.waitForState(() => requests.length === 4);
    complete(3, [question('cancelled-question', 'CANCEL_THIS_QUESTION')]);
    await child.waitForVisibleOutput('CANCEL_THIS_QUESTION');
    await child.write('\u001b');
    await child.waitForIdleInput({ after: beforeCancel });
    expect(requests).toHaveLength(4);

    await writePtyTextAndSubmit(child, 'AFTER_CANCELLED_QUESTION');
    await child.waitForState(() => requests.length === 5);
    expect(JSON.stringify(requests[4]!.input)).toContain('AFTER_CANCELLED_QUESTION');
    complete(4, [message('QUESTION_SUCCESSOR_DONE')]);
    await child.waitForVisibleOutput('QUESTION_SUCCESSOR_DONE');
    await child.waitForIdleInput({ after: beforeCancel + 1 });
    expect(requests).toHaveLength(5);
    const files = (await readdir(lease.paths.conversationsDir)).filter((file) => file.endsWith('.jsonl'));
    const history = (
      await Promise.all(files.map((file) => readFile(join(lease.paths.conversationsDir, file), 'utf8')))
    ).join('\n');
    expect(history).toContain('answered-question');
    expect(history).toContain('second-answered-question');
    expect(history).toContain('cancelled-question');
    expect(history).toContain('User did not provide an answer.');
  } finally {
    await child.cleanup();
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
