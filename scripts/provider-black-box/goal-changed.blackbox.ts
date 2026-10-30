import { execFileSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it('does not credit a goal check to a replacement goal', async () => {
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
    prefix: 'term2-goal-changed-',
    env: { OPENAI_BASE_URL: `http://127.0.0.1:${address.port}` },
    prepare: async (root, paths) => {
      execFileSync('git', ['init', '-q', root]);
      await writeFile(
        join(root, '.git', 'info', 'exclude'),
        '/config/\n/state/\n/data/\n/cache/\n/codex/\n/conversations/\n/outputs/\n',
      );
      execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
      execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.test']);
      await writeFile(join(root, 'proof.txt'), 'VERIFIED_FIXTURE_CONTENT\n');
      execFileSync('git', ['-C', root, 'add', 'proof.txt']);
      execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
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
  const call = (id: string, name: string, args: unknown) => ({
    id: `item-${id}`,
    type: 'function_call',
    status: 'completed',
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  });
  const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  const outputs = (index: number, callId: string) =>
    (requests[index]!.input as Record<string, unknown>[]).filter(
      (item) => item.type === 'function_call_output' && item.call_id === callId,
    );
  try {
    const idle = await child.waitForIdleInput();
    await writePtyTextAndSubmit(child, '/goal set Original goal --criteria proof.txt');
    await child.waitForVisibleOutput('Goal (active): Original goal');
    await writePtyTextAndSubmit(child, 'WORK_FOR_ORIGINAL');
    await child.waitForState(() => requests.length === 1);
    await writePtyTextAndSubmit(child, '/goal set Replacement goal --criteria proof.txt');
    await child.waitForVisibleOutput('Goal (active): Replacement goal');
    complete(0, [
      call('old-goal-check', 'goal_check', { status: 'achieved', evidence: 'Old goal', criteriaEvidence: 'proof.txt' }),
    ]);
    await child.waitForState(() => requests.length === 2);
    expect(outputs(1, 'old-goal-check')).toHaveLength(1);
    expect(outputs(1, 'old-goal-check')[0]!.output).toBe(
      'Error: goal_check was not recorded: the session goal changed after this response began, so this check was for a goal no longer current; check the current goal (shown in your instructions on the next request).',
    );
    complete(1, [call('replacement-blocked', 'goal_check', { status: 'blocked', evidence: 'Need user input' })]);
    await child.waitForState(() => requests.length === 3);
    const blocked = outputs(2, 'replacement-blocked');
    expect(blocked).toHaveLength(1);
    expect(String(blocked[0]!.output)).toContain('blocked. Control returns to the user.');
    complete(2, [message('REPLACEMENT_BLOCKED_DONE')]);
    await child.waitForVisibleOutput('REPLACEMENT_BLOCKED_DONE');
    await child.waitForIdleInput({ after: idle });
    const files = (await readdir(lease.paths.conversationsDir)).filter((file) => file.endsWith('.jsonl'));
    const history = (
      await Promise.all(files.map((file) => readFile(join(lease.paths.conversationsDir, file), 'utf8')))
    ).join('\n');
    const changes = history
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event)
      .filter((event) => event.type === 'goal_changed');
    expect(changes).toHaveLength(2);
    expect(changes[0].goal).toMatchObject({ outcome: 'Original goal', status: 'active' });
    expect(changes[1].goal).toMatchObject({ outcome: 'Replacement goal', status: 'active' });
    expect(changes[1].goal.id).not.toBe(changes[0].goal.id);
    expect(String(blocked[0]!.output)).toContain(`[goal ${changes[1].goal.id}]`);
    expect(requests).toHaveLength(3);
  } finally {
    await child.cleanup();
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
