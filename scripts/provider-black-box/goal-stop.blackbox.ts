import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it('bounds missing goal checks and keeps blocked and deferred goals active', async () => {
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
    prefix: 'term2-goal-evidence-',
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
  const check = (id: string, status: string) => ({
    id: `item-${id}`,
    type: 'function_call',
    status: 'completed',
    call_id: id,
    name: 'goal_check',
    arguments: JSON.stringify({ status, evidence: 'Need fixture input' }),
  });
  const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  const outputs = (index: number, callId: string) =>
    (requests[index]!.input as Record<string, unknown>[]).filter(
      (item) => item.type === 'function_call_output' && item.call_id === callId,
    );
  try {
    const idle = await child.waitForIdleInput();
    await writePtyTextAndSubmit(child, '/goal set COMPLETE_FIXTURE --criteria CRITERION_FIXTURE');
    await child.waitForVisibleOutput('Goal (active): COMPLETE_FIXTURE');
    await writePtyTextAndSubmit(child, 'WORK_ON_GOAL');
    await child.waitForState(() => requests.length === 1);
    complete(0, [message('FORGOT_CHECK_0')]);
    await child.waitForState(() => requests.length === 2);
    expect(JSON.stringify(requests[1]!.input)).toContain(
      'Durable goal stop check (1 of 2 without new work, 1 of 6 this turn)',
    );
    complete(1, [message('FORGOT_CHECK_1')]);
    await child.waitForState(() => requests.length === 3);
    expect(JSON.stringify(requests[2]!.input)).toContain(
      'Durable goal stop check (2 of 2 without new work, 2 of 6 this turn)',
    );
    complete(2, [message('FORGOT_CHECK_2')]);
    await child.waitForVisibleOutput('Goal stop check unresolved');
    const afterUnresolved = await child.waitForIdleInput({ after: idle });
    expect(requests).toHaveLength(3);
    await writePtyTextAndSubmit(child, 'REPORT_BLOCKER');
    await child.waitForState(() => requests.length === 4);
    complete(3, [check('blocked-check', 'blocked')]);
    await child.waitForState(() => requests.length === 5);
    const blockedOutputs = outputs(4, 'blocked-check');
    expect(blockedOutputs).toHaveLength(1);
    expect(blockedOutputs[0]!.output).toMatch(
      /^Self-check recorded: \[goal [^\]]+\] blocked\. Control returns to the user\./,
    );
    complete(4, [message('BLOCKED_DONE')]);
    await child.waitForVisibleOutput('BLOCKED_DONE');
    const afterBlocked = await child.waitForIdleInput({ after: afterUnresolved });
    expect(requests).toHaveLength(5);
    await writePtyTextAndSubmit(child, 'DEFER_GOAL');
    await child.waitForState(() => requests.length === 6);
    complete(5, [check('deferred-check', 'deferred')]);
    await child.waitForState(() => requests.length === 7);
    const deferredOutputs = outputs(6, 'deferred-check');
    expect(deferredOutputs).toHaveLength(1);
    expect(deferredOutputs[0]!.output).toMatch(
      /^Self-check recorded: \[goal [^\]]+\] deferred\. The durable goal stays active and unchanged\./,
    );
    complete(6, [message('DEFERRED_DONE')]);
    await child.waitForVisibleOutput('DEFERRED_DONE');
    await child.waitForIdleInput({ after: afterBlocked });
    expect(requests).toHaveLength(7);
    const statusMarker = child.getOutput().length;
    await writePtyTextAndSubmit(child, '/goal show');
    await child.waitForState((state) => state.output.slice(statusMarker).includes('Goal (active): COMPLETE_FIXTURE'));
    const files = (await readdir(lease.paths.conversationsDir)).filter((file) => file.endsWith('.jsonl'));
    const history = (
      await Promise.all(files.map((file) => readFile(join(lease.paths.conversationsDir, file), 'utf8')))
    ).join('\n');
    const events = history
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    const changes = events.filter((event) => event.type === 'goal_changed');
    expect(changes).toHaveLength(1);
    expect(blockedOutputs[0]!.output).toContain(`[goal ${changes[0].goal.id}]`);
    expect(deferredOutputs[0]!.output).toContain(`[goal ${changes[0].goal.id}]`);
    expect(changes[0].goal).toMatchObject({
      outcome: 'COMPLETE_FIXTURE',
      successCriteria: 'CRITERION_FIXTURE',
      status: 'active',
    });
  } finally {
    await child.cleanup();
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
