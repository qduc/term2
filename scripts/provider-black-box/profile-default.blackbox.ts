import { createServer } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, exitInteractive, writePtyTextAndSubmit } from './provider-test-harness.js';

it('resumes retired Standard as Bare and rolls over without reviving its old composition or losing history', async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
      return;
    }
    requests.push(JSON.parse(raw));
    const n = requests.length;
    const delta =
      n === 2
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'rollover-call',
                type: 'function',
                function: {
                  name: 'session_rollover',
                  arguments: JSON.stringify({
                    brief: 'BARE_SUCCESSOR_BRIEF: retain the observed checks; continue the task.',
                    reason: 'task_boundary',
                  }),
                },
              },
            ],
          }
        : { content: `fixture-response-${n}` };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of [
      { choices: [{ delta, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: n === 2 ? 'tool_calls' : 'stop' }] },
    ])
      res.write(`data: ${JSON.stringify({ id: `response-${n}`, ...chunk })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  const settings = JSON.stringify({
    app: { activeProfileId: 'builtin:standard', autoUpdate: false },
    agent: { modelSelection: { model: 'fixture', provider: 'fixture-provider' }, retryAttempts: 0 },
    providers: [
      {
        name: 'fixture-provider',
        type: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'fixture-key',
      },
    ],
  });
  const oldId = 'old-standard-session';
  const oldHistory =
    [
      {
        type: 'session_init',
        id: oldId,
        createdAt: '2026-01-01T00:00:00.000Z',
        projectPath: process.cwd(),
        activeProfileId: 'builtin:standard',
      },
      { type: 'user_message', message: { id: 'old-user', sender: 'user', text: 'OLD_STANDARD_HISTORY_SENTINEL' } },
    ]
      .map((event, index) => JSON.stringify({ v: 3, seq: index + 1, ts: '2026-01-01T00:00:00.000Z', event }))
      .join('\n') + '\n';
  const workspace = await createIsolatedWorkspaceLease({
    prepare: async (_root, paths) => {
      await mkdir(paths.logDir, { recursive: true });
      await mkdir(paths.conversationsDir, { recursive: true });
      await writeFile(join(paths.logDir, 'settings.json'), settings);
      await writeFile(join(paths.conversationsDir, `${oldId}.jsonl`), oldHistory);
    },
  });
  try {
    const child = await workspace.start({ args: ['--resume', oldId], cols: 120, rows: 40 });
    await child.waitForIdleInput();
    expect(child.getVisibleOutput()).toContain('BARE');
    // The actual picker offers the default and workflows, not retired Standard.
    await writePtyTextAndSubmit(child, '/profile');
    await child.waitForVisibleOutput('Default: shell-only');
    const menu = child.getVisibleOutput();
    expect(menu).not.toContain('Default full-context mode');
    const idle = child.readIdleGeneration();
    // Accept the highlighted Bare entry through the real picker.
    await child.write('\r');
    await child.waitForIdleInput({ after: idle });
    await child.waitForComposerValue('', { afterRevision: 0 });
    for (const alias of ['standard', 'full', 'lite']) {
      await writePtyTextAndSubmit(child, `/profile ${alias}`);
      await child.waitForComposerValue('', { afterRevision: 0 });
    }
    await writePtyTextAndSubmit(child, 'Continue the saved conversation');
    await child.waitForVisibleOutput('fixture-response-1');
    await child.waitForIdleInput();
    expect(JSON.stringify(requests[0].messages)).toContain('OLD_STANDARD_HISTORY_SENTINEL');
    await writePtyTextAndSubmit(child, 'Please roll over now with a brief');
    await child.waitForVisibleOutput('fixture-response-3');
    await child.waitForIdleInput();
    await exitInteractive(child);
    const names = (request: any) => request.tools.map((tool: any) => tool.function.name).sort();
    expect(names(requests[0])).toContain('session_rollover');
    expect(names(requests[0])).not.toContain('apply_patch');
    expect(names(requests[2])).toEqual(names(requests[0]));
    expect(JSON.stringify(requests[2].messages)).toContain('BARE_SUCCESSOR_BRIEF');
    expect(await readFile(join(workspace.paths.logDir, 'settings.json'), 'utf8')).toBe(settings);
    const oldAfter = await readFile(join(workspace.paths.conversationsDir, `${oldId}.jsonl`), 'utf8');
    expect(oldAfter.startsWith(oldHistory)).toBe(true);
    const files = (await readdir(workspace.paths.conversationsDir)).filter((name) => name.endsWith('.jsonl'));
    expect(files).toHaveLength(2);
    const successor = await readFile(
      join(workspace.paths.conversationsDir, files.find((name) => name !== `${oldId}.jsonl`)!),
      'utf8',
    );
    const events = successor
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    expect(events.find((event) => event.type === 'session_init')).toMatchObject({
      activeProfileId: 'builtin:bare',
      rolloverFrom: oldId,
    });
    expect(
      events.some((event) => event.type === 'user_message' && event.message.text.includes('BARE_SUCCESSOR_BRIEF')),
    ).toBe(true);
  } finally {
    await workspace.cleanup();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
