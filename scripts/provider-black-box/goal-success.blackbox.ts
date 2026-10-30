import { execFileSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it('persists achieved goal after a real independent repository probe', async () => {
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
    prefix: 'term2-goal-success-',
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
    await writePtyTextAndSubmit(
      child,
      '/goal set Verify fixture --criteria proof.txt contains VERIFIED_FIXTURE_CONTENT',
    );
    await child.waitForVisibleOutput('Goal (active): Verify fixture');
    await writePtyTextAndSubmit(child, 'Verify the fixture');
    await child.waitForState(() => requests.length === 1);
    complete(0, [
      call('worker-check', 'goal_check', {
        status: 'achieved',
        evidence: 'Fixture exists',
        criteriaEvidence: 'Read proof.txt',
      }),
    ]);
    await child.waitForState(() => requests.length === 2);
    expect(String(outputs(1, 'worker-check')[0]?.output)).toContain('achieved proposed');
    complete(1, [message('WORKER_PROPOSED_DONE')]);
    await child.waitForState(() => requests.length === 3);
    expect((requests[2]!.tools as Record<string, unknown>[]).map((tool) => tool.name)).toEqual(['verification_probe']);
    expect(requests[2]!.previous_response_id).toBeUndefined();
    expect(requests[2]!.input as unknown[]).toHaveLength(1);
    expect(JSON.stringify(requests[2]!.input)).not.toContain('WORKER_PROPOSED_DONE');
    expect(JSON.stringify(requests[2]!.input)).not.toContain('worker-check');
    expect(JSON.stringify(requests[2]!.input)).not.toContain('Verify the fixture');
    complete(2, [call('verifier-probe', 'verification_probe', { kind: 'read_file', path: 'proof.txt' })]);
    await child.waitForState(() => requests.length === 4);
    expect(outputs(3, 'verifier-probe')).toHaveLength(1);
    expect(outputs(3, 'verifier-probe')[0]!.output).toBe('VERIFIED_FIXTURE_CONTENT\n');
    complete(3, [
      message(
        JSON.stringify({
          outcome: 'PASS',
          evidence: 'Fixture content verified',
          checked: ['proof.txt'],
          limitations: [],
        }),
      ),
    ]);
    await child.waitForVisibleOutput('Completion accepted after the model');
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
    expect(changes[0].goal).toMatchObject({
      outcome: 'Verify fixture',
      successCriteria: 'proof.txt contains VERIFIED_FIXTURE_CONTENT',
      status: 'active',
    });
    expect(changes[1].goal).toEqual({ ...changes[0].goal, status: 'achieved' });
    expect(changes[1].source).toBe('goal_check');
    expect(await readFile(join(lease.root, 'proof.txt'), 'utf8')).toBe('VERIFIED_FIXTURE_CONTENT\n');
    expect(requests).toHaveLength(4);
  } finally {
    await child.cleanup();
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
