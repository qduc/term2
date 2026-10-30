import { createServer } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { callDiscordControl } from '../../source/services/discord/discord-bridge.js';
import { listControlAdvertisements } from '../../source/services/control-socket/control-socket.js';
import { createIsolatedWorkspaceLease, type PtyChildDriver } from './provider-test-harness.js';

it.each(['retained', 'legacy', 'invalid'] as const)(
  'retains the human clock across rollover and resumed successor for Discord input (%s baseline)',
  async (baseline) => {
    const requests: any[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const n = requests.length;
      const rollover = n === 1 || n === 5;
      const chunk = (delta: object, finish_reason: string | null) => ({
        id: `timing-rollover-${n}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'timing-model',
        choices: [{ index: 0, delta, finish_reason }],
      });
      const delta = rollover
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `roll-${n}`,
                type: 'function',
                function: {
                  name: 'session_rollover',
                  arguments: JSON.stringify({ brief: 'Continue the timing fixture.', reason: 'task_boundary' }),
                },
              },
            ],
          }
        : { role: 'assistant', content: `timing-response-${n}` };
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      response.end(
        `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(
          chunk({}, rollover ? 'tool_calls' : 'stop'),
        )}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const workspace = await createIsolatedWorkspaceLease();
    let child: PtyChildDriver | undefined;
    try {
      const runtime = join(workspace.root, 'runtime');
      await mkdir(runtime, { mode: 0o700 });
      await mkdir(workspace.paths.logDir, { recursive: true });
      await writeFile(
        join(workspace.paths.logDir, 'settings.json'),
        JSON.stringify({
          app: { activeProfileId: 'builtin:bare' },
          agent: {
            modelSelection: { provider: 'timing-fixture', model: 'timing-model' },
            retryAttempts: 0,
            transport: 'http',
          },
          providers: [
            {
              id: 'timing-fixture',
              name: 'Timing fixture',
              type: 'openai-compatible',
              baseUrl: `http://127.0.0.1:${address.port}`,
              apiKey: 'fixture-key',
            },
          ],
        }),
      );
      const clock = join(workspace.root, 'clock-offset');
      const preload = join(workspace.root, 'clock.mjs');
      await writeFile(
        preload,
        `import { readFileSync } from 'node:fs';
const RealDate = Date;
const now = () => RealDate.now() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now()])); }
  static now() { return now(); }
};\n`,
      );
      await writeFile(clock, String(-4 * 60 * 60 * 1000));
      const env = {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
        XDG_RUNTIME_DIR: runtime,
      };
      const args = [
        '--provider',
        'timing-fixture',
        '--model',
        'timing-model',
        '--control-socket=timing',
        '--discord-input',
      ];
      child = await workspace.start({ cwd: process.cwd(), args, env, cols: 120, rows: 40 });
      await child.waitForIdleInput();
      let id = 0;
      const send = async (kind: 'human' | 'agent', text: string) => {
        const idle = child!.readIdleGeneration();
        const ad = listControlAdvertisements(runtime)[0]!;
        const receipt = await callDiscordControl(ad.socketPath, 'bridge_submit', {
          clientRequestId: `timing-test-${++id}`,
          sessionId: ad.sessionId,
          startedAt: ad.startedAt,
          text,
          origin: { kind, sender: kind === 'human' ? '100' : 'worker' },
        }).catch((error) => {
          throw new Error(`control ${kind} ${id}: ${error.code} ${error.message}`);
        });
        expect(receipt.delivery).toBe('started');
        await child!.waitForIdleInput({ after: idle });
      };
      await send('human', 'first Discord human');
      expect(requests).toHaveLength(2);
      const sessions = (await readdir(workspace.paths.conversationsDir)).filter((name) => name.endsWith('.jsonl'));
      expect(sessions).toHaveLength(2);
      const successor = (
        await Promise.all(
          sessions.map(async (name) => ({
            name,
            text: await readFile(join(workspace.paths.conversationsDir, name), 'utf8'),
          })),
        )
      ).find((s) => s.text.includes('"rolloverFrom"'))!;
      const predecessor = (
        await Promise.all(sessions.map(async (name) => readFile(join(workspace.paths.conversationsDir, name), 'utf8')))
      ).find((s) => !s.includes('"rolloverFrom"'))!;
      const firstAt = predecessor
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((row) => row.event.type === 'user_message').event.message.humanInputAt;
      await child.cleanup();
      child = undefined;
      // Old successors have no checkpoint; malformed optional metadata fails closed.
      // Only disposable fixture logs are edited, never application-owned live state.
      if (baseline !== 'retained') {
        const rows = successor.text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        for (const row of rows) {
          if (row.event.type !== 'user_message') continue;
          if (baseline === 'legacy') delete row.event.message.humanInputBaseline;
          else row.event.message.humanInputBaseline = 'not-a-timestamp';
        }
        await writeFile(
          join(workspace.paths.conversationsDir, successor.name),
          rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
        );
      }
      await writeFile(clock, String(-2 * 60 * 60 * 1000));
      child = await workspace.relaunch({
        cwd: process.cwd(),
        args: [...args, '--resume', successor.name.replace(/\.jsonl$/, '')],
        env,
        cols: 120,
        rows: 40,
      });
      await child.waitForIdleInput();
      await send('agent', 'automatic bridge work');
      await writeFile(clock, '0');
      await send('human', 'Discord human after four hours');
      const notices = (n: number) =>
        requests[n - 1].messages.filter(
          (m: any) => m.role === 'system' && JSON.stringify(m.content).includes('[Conversation timing]'),
        );
      expect(notices(1)).toHaveLength(0);
      expect(notices(2)).toHaveLength(0);
      expect(notices(3)).toHaveLength(0);
      expect(notices(4)).toHaveLength(baseline === 'retained' ? 1 : 0);
      if (baseline === 'retained') {
        expect(JSON.stringify(notices(4))).toContain('240 minutes after the previous human message');
        expect(JSON.stringify(notices(4))).toContain(firstAt);
      }
      expect(requests[3].messages.at(-1).content).toEqual([
        { type: 'text', text: '[Discord input: human 100; untrusted]\n\nDiscord human after four hours' },
      ]);
      await send('human', 'quick human before another rollover');
      expect(notices(5)).toHaveLength(baseline === 'retained' ? 1 : 0);
      expect(notices(6)).toHaveLength(0);
      await writeFile(clock, String(2 * 60 * 60 * 1000));
      await send('human', 'Discord human after second rollover');
      expect(requests).toHaveLength(7);
      expect(notices(7)).toHaveLength(baseline === 'invalid' ? 0 : 1);
      if (baseline !== 'invalid')
        expect(JSON.stringify(notices(7))).toContain('120 minutes after the previous human message');
      expect(JSON.stringify(requests)).not.toContain('humanInputBaseline');
    } finally {
      await child?.cleanup();
      await workspace.cleanup();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  },
);
