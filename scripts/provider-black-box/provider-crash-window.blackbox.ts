import { createServer, type Server } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsService } from '../../source/services/settings/settings-service.js';
import {
  createIsolatedWorkspaceLease,
  exitInteractive,
  writePtyTextAndSubmit,
  type IsolatedWorkspaceLease,
} from './provider-test-harness.js';

/**
 * Regression for the meaningful crash window: the tool body has already run
 * and written its external effect, but the process is killed before any
 * terminal tool_result is persisted (the interrupted-approval scenario in
 * provider-session-resilience.blackbox.ts only kills before any effect).
 *
 * Recovery must keep the executed call in the resumed provider history,
 * settled with an unobserved outcome, so the model can verify state instead
 * of blindly repeating the external action. The original released build
 * dropped the call from the next request entirely on this wire family.
 *
 * Design mirrors the independently verified out-of-repo runtime verifier
 * (chat-completions lane, SIGKILL after a real fsync'd effect, --resume
 * --fork, no paid calls) as a repository-owned CI regression. Everything is
 * lease-local; no repository or home paths are written.
 */

const TOOL_CALL_ID = 'call_crash_after_effect';

interface RecordedRequest {
  url: string;
  body: unknown;
}

let activeLeases: IsolatedWorkspaceLease[] = [];
let activeServers: Server[] = [];

afterEach(async () => {
  const leaseErrors: unknown[] = [];
  for (const child of activeLeases.splice(0)) {
    try {
      await child.cleanup();
    } catch (error) {
      leaseErrors.push(error);
    }
  }
  for (const server of activeServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (leaseErrors.length > 0) throw leaseErrors[0];
});

type ChatDelta = {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    index: number;
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
};

function chatChunk(delta: ChatDelta, finishReason: 'tool_calls' | 'stop') {
  return {
    id: 'chatcmpl-crash-window',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function startChatCompletionsMock(
  effectScriptPath: string,
  markerPath: string,
  requests: RecordedRequest[],
): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ url: req.url ?? '', body: body.length > 0 ? JSON.parse(body) : undefined });
      const first = requests.length === 1;
      const delta: ChatDelta = first
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: TOOL_CALL_ID,
                type: 'function',
                function: {
                  name: 'shell',
                  arguments: JSON.stringify({
                    command: `node ${JSON.stringify(effectScriptPath)} ${JSON.stringify(markerPath)}`,
                    background: false,
                    sandbox: 'default',
                    description: 'Write one harmless fixture marker, then wait',
                  }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'crash-window-verified-final' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(chatChunk(delta, first ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      activeServers.push(server);
      resolve({ port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

/**
 * Effect fixture: append + fsync the marker so the effect is durable before
 * the crash, then hold the process open so SIGKILL lands strictly between the
 * effect and any terminal tool_result. Takes the marker path as argv[2] like
 * the verified out-of-repo fixture; lives inside the isolated lease, not the
 * repository.
 */
const EFFECT_SCRIPT_SOURCE = [
  "import fs from 'node:fs';",
  "const fd = fs.openSync(process.argv[2], 'a');",
  "fs.writeSync(fd, 'effect\\n');",
  'fs.fsyncSync(fd);',
  'fs.closeSync(fd);',
  'await new Promise((resolve) => setTimeout(resolve, 120_000));',
  '',
].join('\n');

describe('crash after tool effect but before the tool result', () => {
  it('keeps the executed call in the resumed provider history without repeating the effect', async () => {
    const requests: RecordedRequest[] = [];
    let markerPath = '';

    const startLease = async (): Promise<IsolatedWorkspaceLease> => {
      let serverPort = 0;
      const lease = await createIsolatedWorkspaceLease({
        prefix: 'term2-crash-window-',
        prepare: async (root, paths) => {
          markerPath = join(root, 'marker.txt');
          const effectScriptPath = join(root, 'fixture-effect.mjs');
          await writeFile(effectScriptPath, EFFECT_SCRIPT_SOURCE, 'utf8');
          await mkdir(paths.logDir, { recursive: true });
          ({ port: serverPort } = await startChatCompletionsMock(effectScriptPath, markerPath, requests));
          await writeFile(
            join(paths.logDir, 'settings.json'),
            JSON.stringify({
              agent: {
                modelSelection: { provider: 'crash-window-fixture', model: 'crash-window-fixture' },
                retryAttempts: 0,
                maxTurns: 4,
              },
              app: { liteMode: true },
              providers: [
                {
                  id: 'crash-window-fixture',
                  name: 'crash-window-fixture',
                  type: 'openai-compatible',
                  baseUrl: `http://127.0.0.1:${serverPort}/v1`,
                  apiKey: 'fixture-key',
                },
              ],
            }),
            'utf8',
          );
          // Verify the supported coupled settings through the real service:
          // an auto-approve mode of 'always' must demote sandbox.enabled
          // to false (the persisted raw 'always' + sandbox default true
          // pair loads back as 'auto').
          const settings = new SettingsService({
            settingsDir: paths.logDir,
            disableLogging: true,
            disableFilePersistence: false,
          });
          settings.set('shell.autoApproveMode', 'always');
          expect(settings.get('shell.autoApproveMode')).toBe('always');
          expect(settings.get('sandbox.enabled')).toBe(false);
        },
      });
      return lease;
    };

    const lease = await startLease();
    activeLeases.push(lease);

    // Launch the built CLI explicitly, matching the verified out-of-repo
    // verifier: the lease-local default launch would look for a dist/ that
    // does not exist inside the lease.
    const start = (args: string[] = []) =>
      lease.start({
        cwd: lease.root,
        command: process.execPath,
        args: [
          join(process.cwd(), 'dist/cli.js'),
          '--lite',
          '-p',
          'crash-window-fixture',
          '-m',
          'crash-window-fixture',
          '--auto-approve',
          ...args,
        ],
      });

    // Turn 1: the model issues the shell call; the effect lands on disk.
    const first = await start();
    await first.waitForIdleInput();
    await writePtyTextAndSubmit(first, 'Append exactly one fixture marker; then finish the unfinished task.');

    const effectDeadline = Date.now() + 40_000;
    let effectText = '';
    while (Date.now() < effectDeadline) {
      effectText = await readFile(markerPath, 'utf8').catch(() => '');
      if (effectText) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // The real external effect must actually be observed before the crash.
    expect(effectText).toBe('effect\n');

    // Crash strictly between the effect and any terminal tool_result.
    await first.terminate({ signal: 'SIGKILL', timeoutMs: 40_000 });

    // The persisted journal records the executed call but no tool_result.
    const files = (await readdir(lease.paths.conversationsDir)).filter((file) => file.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const conversationId = files[0]!.slice(0, -'.jsonl'.length);
    const journal = await readFile(join(lease.paths.conversationsDir, files[0]!), 'utf8');
    const events = journal
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { event: { type: string; toolCallId?: string; callId?: string } }).event);
    expect(events.some((event) => event.type === 'tool_started' && event.toolCallId === TOOL_CALL_ID)).toBe(true);
    expect(events.some((event) => event.type === 'tool_result' && event.callId === TOOL_CALL_ID)).toBe(false);

    // Turn 2: resume from the crashed journal; the model verifies instead
    // of the app blindly redispatching.
    const resumed = await start(['--resume', conversationId, '--fork']);
    await resumed.waitForVisibleOutput('Resumed conversation:');
    const resumedIdle = await resumed.waitForIdleInput();
    await writePtyTextAndSubmit(
      resumed,
      'Continue the unfinished task, verify the interrupted action before any retry.',
    );
    await resumed.waitForVisibleOutput('crash-window-verified-final', 40_000);
    await resumed.waitForIdleInput({ after: resumedIdle });
    await exitInteractive(resumed);

    expect(requests).toHaveLength(2);
    const resumedBody = requests[1]!.body as { messages?: Array<{ role: string; content: string }> };
    const resumedSerialized = JSON.stringify(resumedBody);
    // The executed-but-unsettled call must survive recovery; the original
    // released build omitted it from the next request entirely.
    expect(resumedSerialized).toContain(TOOL_CALL_ID);
    expect(resumedSerialized).toContain('may or may not have occurred');
    expect(resumedSerialized).toContain('do not re-run non-idempotent operations blindly');
    // No automatic redispatch: the resumed turn's new user message is
    // present (user content arrives as a content-parts array).
    expect(
      resumedBody.messages?.some((message) => {
        if (message.role !== 'user') return false;
        const text = Array.isArray(message.content)
          ? message.content.map((part: { text?: string }) => part.text ?? '').join('')
          : String(message.content ?? '');
        return text.includes('verify the interrupted action');
      }),
    ).toBe(true);
    // Exactly one effect: continuation must not have repeated the action.
    expect(await readFile(markerPath, 'utf8')).toBe('effect\n');
  }, 120_000);
});
