import { createServer, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it('attaches a selected skill to one user request and retains the plain next turn', async () => {
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
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
  const lease = await createIsolatedWorkspaceLease({
    prefix: 'term2-input-skill-',
    env: { OPENAI_BASE_URL: `http://127.0.0.1:${address.port}` },
    prepare: async (root, paths) => {
      await mkdir(join(root, '.agents', 'skills', 'evidence-skill'), { recursive: true });
      await writeFile(
        join(root, '.agents', 'skills', 'evidence-skill', 'SKILL.md'),
        '---\nname: evidence-skill\ndescription: Evidence fixture skill\n---\nSKILL_BODY_MARKER\n',
      );
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
  const complete = (index: number) => {
    const response = pending[index];
    if (!response) throw new Error(`Missing request ${index}`);
    const id = `notice-response-${index}`;
    for (const frame of [
      { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
      {
        type: 'response.completed',
        response: {
          id,
          status: 'completed',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `NOTICE_DONE_${index}` }] },
          ],
        },
      },
    ])
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end();
  };
  try {
    const idle = await child.waitForIdleInput();
    await child.write('/skills evidence-skill');
    await child.waitForVisibleOutput('evidence-skill');
    await child.write('\r');
    await child.waitForVisibleOutput('Skill "evidence-skill" activated');
    await writePtyTextAndSubmit(child, 'FIRST_SKILL_INPUT');
    await child.waitForState(() => requests.length === 1);
    expect(JSON.stringify(requests[0]!.input)).toContain('SKILL_BODY_MARKER');
    expect(JSON.stringify(requests[0]!.input)).toContain('FIRST_SKILL_INPUT');
    expect(requests[0]!.input as unknown[]).toHaveLength(1);
    complete(0);
    await child.waitForVisibleOutput('NOTICE_DONE_0');
    const nextIdle = await child.waitForIdleInput({ after: idle });
    await writePtyTextAndSubmit(child, '/retry-turn');
    await child.waitForState(() => requests.length === 2);
    expect(JSON.stringify(requests[1]!.input)).toContain('SKILL_BODY_MARKER');
    expect(JSON.stringify(requests[1]!.input)).toContain('FIRST_SKILL_INPUT');
    complete(1);
    await child.waitForVisibleOutput('NOTICE_DONE_1');
    const retryIdle = await child.waitForIdleInput({ after: nextIdle });
    await writePtyTextAndSubmit(child, 'SECOND_SKILL_INPUT');
    await child.waitForState(() => requests.length === 3);
    expect(JSON.stringify(requests[2]!.input)).toContain('SECOND_SKILL_INPUT');
    expect(JSON.stringify(requests[2]!.input)).not.toContain('SKILL_BODY_MARKER');
    expect(requests[2]!.previous_response_id).toBe('notice-response-1');
    complete(2);
    await child.waitForVisibleOutput('NOTICE_DONE_2');
    await child.waitForIdleInput({ after: retryIdle });
  } finally {
    await child.cleanup();
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  }
});
