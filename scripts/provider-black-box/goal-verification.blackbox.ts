import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it('rejects missing criteria evidence and leaves an unverifiable goal active', async () => {
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
    prefix: 'term2-goal-verify-',
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
  const check = (id: string, status: string, criteriaEvidence?: string) => ({
    id: `item-${id}`,
    type: 'function_call',
    status: 'completed',
    call_id: id,
    name: 'goal_check',
    arguments: JSON.stringify({
      status,
      evidence: 'Fixture evidence',
      ...(criteriaEvidence ? { criteriaEvidence } : {}),
    }),
  });
  const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  const outputs = (index: number, callId: string) =>
    (requests[index]!.input as Record<string, unknown>[]).filter(
      (item) => item.type === 'function_call_output' && item.call_id === callId,
    );
  try {
    const idle = await child.waitForIdleInput();
    await writePtyTextAndSubmit(child, '/goal set VERIFY_FIXTURE --criteria CRITERION_FIXTURE');
    await child.waitForVisibleOutput('Goal (active): VERIFY_FIXTURE');
    await writePtyTextAndSubmit(child, 'TRY_WITHOUT_CRITERIA');
    await child.waitForState(() => requests.length === 1);
    complete(0, [check('missing-criteria', 'achieved')]);
    await child.waitForState(() => requests.length === 2);
    expect(outputs(1, 'missing-criteria')).toHaveLength(1);
    expect(outputs(1, 'missing-criteria')[0]!.output).toBe(
      'Error: goal_check was not recorded: criteriaEvidence is required for achieved because the goal has success criteria.',
    );
    complete(1, [check('blocked', 'blocked')]);
    await child.waitForState(() => requests.length === 3);
    expect(outputs(2, 'blocked')).toHaveLength(1);
    complete(2, [message('BLOCKED_SETTLED')]);
    await child.waitForVisibleOutput('BLOCKED_SETTLED');
    const afterBlocked = await child.waitForIdleInput({ after: idle });
    await writePtyTextAndSubmit(child, 'TRY_VERIFIED_GOAL');
    await child.waitForState(() => requests.length === 4);
    complete(3, [check('achieved', 'achieved', 'Criterion fixture evidence')]);
    await child.waitForState(() => requests.length === 5);
    expect(outputs(4, 'achieved')).toHaveLength(1);
    expect(String(outputs(4, 'achieved')[0]!.output)).toContain('achieved proposed');
    complete(4, [message('PROPOSED_DONE')]);
    await child.waitForVisibleOutput('Completion verification blocked');
    expect(child.getVisibleOutput().replace(/\s+/g, ' ')).toContain(
      'Completion verification blocked: Unsupported workspace: the working directory is not inside a Git repository, so completion cannot be verified. The durable goal remains active.',
    );
    await child.waitForIdleInput({ after: afterBlocked });
    expect(requests).toHaveLength(5);
    const files = (await readdir(lease.paths.conversationsDir)).filter((file) => file.endsWith('.jsonl'));
    const history = (
      await Promise.all(files.map((file) => readFile(join(lease.paths.conversationsDir, file), 'utf8')))
    ).join('\n');
    const changes = history
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event)
      .filter((event) => event.type === 'goal_changed');
    expect(changes).toHaveLength(1);
    expect(String(outputs(4, 'achieved')[0]!.output)).toContain(`[goal ${changes[0].goal.id}]`);
    expect(changes[0].goal).toMatchObject({
      outcome: 'VERIFY_FIXTURE',
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
