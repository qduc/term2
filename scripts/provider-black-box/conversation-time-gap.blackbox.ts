import { createServer } from 'node:http';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit, type PtyChildDriver } from './provider-test-harness.js';

it('adds separate timing context after long human gaps, including a persisted CLI restart, without short-turn or replay duplication', async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const n = requests.length;
    const chunk = (delta: object, finish_reason: string | null) => ({
      id: `timing-${n}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'timing-model',
      choices: [{ index: 0, delta, finish_reason }],
    });
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(
      `data: ${JSON.stringify(chunk({ role: 'assistant', content: `timing-response-${n}` }, null))}\n\n` +
        `data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  let child: PtyChildDriver | undefined;
  const workspace = await createIsolatedWorkspaceLease({
    prepare: async (_root, paths) => {
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
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
    },
  });
  try {
    const clock = join(workspace.root, 'clock-offset');
    const preload = join(workspace.root, 'clock.mjs');
    // Only this disposable CLI's wall clock moves. Timers and production code
    // are unchanged; the file lets the test simulate hours without sleeping.
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
    const env = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}` };
    const args = ['--provider', 'timing-fixture', '--model', 'timing-model'];
    child = await workspace.start({ cwd: process.cwd(), args, env, cols: 120, rows: 40 });
    await child.waitForIdleInput();
    const send = async (text: string) => {
      const idle = child!.readIdleGeneration();
      const expected = requests.length + 1;
      await writePtyTextAndSubmit(child!, text);
      await child!.waitForVisibleOutput(`timing-response-${expected}`);
      await child!.waitForIdleInput({ after: idle });
    };
    await send('first human message');
    await writeFile(clock, String(-2 * 60 * 60 * 1000));
    await send('back after two hours');
    await send('short follow-up');
    await child.cleanup();
    child = undefined;

    const sessions = (await readdir(workspace.paths.conversationsDir)).filter((name) => name.endsWith('.jsonl'));
    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0]!.replace(/\.jsonl$/, '');
    await writeFile(clock, '0');
    child = await workspace.relaunch({
      cwd: process.cwd(),
      args: [...args, '--resume', sessionId],
      env,
      cols: 120,
      rows: 40,
    });
    await child.waitForIdleInput();
    await send('back after restarting');
    expect(requests).toHaveLength(4);
    const messages = requests.map((body) =>
      (body.messages as { role: string; content: string | { text?: string }[] }[]).map((item) => ({
        role: item.role,
        content: typeof item.content === 'string' ? item.content : item.content.map((part) => part.text ?? '').join(''),
      })),
    );
    const notices = messages.map((items) =>
      items.filter((item) => item.role === 'system' && item.content.includes('[Conversation timing]')),
    );
    expect(notices.map((items) => items.length)).toEqual([0, 1, 1, 2]);
    expect(notices[1]![0]!.content).toContain('120 minutes after the previous human message');
    expect(notices[3]![1]!.content).toContain('120 minutes after the previous human message');
    expect(messages[3]!.filter((item) => item.role === 'user').map((item) => item.content)).toEqual([
      'first human message',
      'back after two hours',
      'short follow-up',
      'back after restarting',
    ]);
  } finally {
    await child?.cleanup();
    await workspace.cleanup();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
