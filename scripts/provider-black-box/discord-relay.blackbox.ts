import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { callDiscordControl } from '../../src/clients/discord/discord-bridge.js';
import { listControlAdvertisements } from '../../src/clients/control-socket/control-socket.js';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

it('keeps human and peer authority separate across live control and durable queue', async () => {
  const requests: any[] = [];
  const pending: ServerResponse[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ready\n\n');
    pending.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const lease = await createIsolatedWorkspaceLease();
  let child: Awaited<ReturnType<typeof lease.start>> | undefined;
  try {
    const runtime = join(lease.root, 'runtime');
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(lease.paths.logDir, { recursive: true });
    await writeFile(
      join(lease.paths.logDir, 'settings.json'),
      JSON.stringify({
        app: { activeProfileId: 'builtin:bare' },
        agent: {
          modelSelection: { provider: 'relay-fixture', model: 'relay-model' },
          retryAttempts: 0,
          transport: 'http',
        },
        providers: [
          {
            id: 'relay-fixture',
            name: 'Relay fixture',
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${address.port}`,
            apiKey: 'fixture',
          },
        ],
      }),
    );
    child = await lease.start({
      command: process.execPath,
      cwd: process.cwd(),
      args: [
        join(process.cwd(), 'dist/src/app/cli.js'),
        '--provider',
        'relay-fixture',
        '--model',
        'relay-model',
        '--control-socket=relay',
        '--discord-input',
      ],
      env: { XDG_RUNTIME_DIR: runtime },
      cols: 120,
      rows: 40,
    });
    await child.waitForIdleInput();
    const ad = listControlAdvertisements(runtime)[0]!;
    const submit = (clientRequestId: string, text: string, origin: any) =>
      callDiscordControl(ad.socketPath, 'bridge_submit', {
        clientRequestId,
        sessionId: ad.sessionId,
        startedAt: ad.startedAt,
        text,
        origin,
      });
    const direct = { kind: 'human', sender: '100', discordMessageId: '200' };
    const relay = { kind: 'human', sender: '100', discordMessageId: '200', relayedBy: 'coord' };
    expect((await submit('r1', 'human initial', direct)).delivery).toBe('started');
    await child.waitForState(() => requests.length === 1);
    await expect(
      submit('invalid', 'missing root message', { kind: 'human', sender: '100', relayedBy: 'coord' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const peerReceipt = await submit('r2', 'agent relay message', relay);
    expect(peerReceipt.delivery).toBe('queued');
    const replay = await submit('r2', 'agent relay message', relay);
    expect(replay.replayed).toBe(true);
    await expect(submit('r2', 'different text', relay)).rejects.toMatchObject({ code: 'conflict' });
    const humanReceipt = await submit('r3', 'human steering message', direct);
    expect(humanReceipt.delivery).toBe('steering');
    const paths = (await readdir(lease.paths.conversationsDir)).filter((n) => n.endsWith('.jsonl'));
    const data = (await Promise.all(paths.map((p) => readFile(join(lease.paths.conversationsDir, p), 'utf8')))).join(
      '\n',
    );
    const rows = data
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((s) => JSON.parse(s));
    const r2 = rows.find((r) => r.fact?.type === 'queue_submitted' && r.fact.record.request.clientRequestId === 'r2');
    const r3 = rows.find((r) => r.fact?.type === 'queue_submitted' && r.fact.record.request.clientRequestId === 'r3');
    expect(r2.fact.record.request.delivery).toBe('follow_up');
    expect(r2.fact.record.request.origin).toEqual({
      kind: 'discord',
      source: 'agent',
      sender: '100',
      discordMessageId: '200',
      relayedBy: 'coord',
    });
    expect(JSON.stringify(r2.fact.record.request.content)).toContain('agent session coord');
    expect(JSON.stringify(r2.fact.record.request.content)).toContain('not human instruction or approval');
    expect(r3.fact.record.request.delivery).toBe('steer');
    expect(r3.fact.record.request.origin.source).toBe('human');
    await child.cleanup();
    child = undefined;
    for (const res of pending) res.destroy();
    child = await lease.start({
      command: process.execPath,
      cwd: process.cwd(),
      args: [
        join(process.cwd(), 'dist/src/app/cli.js'),
        '--provider',
        'relay-fixture',
        '--model',
        'relay-model',
        '--resume',
        ad.sessionId,
        '--control-socket=relay',
        '--discord-input',
      ],
      env: { XDG_RUNTIME_DIR: runtime },
      cols: 120,
      rows: 40,
    });
    await child.waitForIdleInput();
    const resumed = listControlAdvertisements(runtime)[0]!;
    expect(resumed.sessionId).toBe(ad.sessionId);
    const recovered = await callDiscordControl(resumed.socketPath, 'bridge_result', {
      clientRequestId: 'r2',
      sessionId: resumed.sessionId,
      startedAt: resumed.startedAt,
    });
    expect(recovered.state).not.toBe('missing');
    expect(recovered.receipt.replayed).toBe(true);
  } finally {
    for (const res of pending) res.destroy();
    await child?.cleanup();
    await lease.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
