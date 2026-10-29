import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { startFakeProviderHttpServer } from './fake-provider-http-server.js';
import { startFakeCodexServer } from '../fake-codex-server-lib.js';
import { FileMemoryStore } from '../../source/services/memory/memory-store.js';
import { projectScopeKey } from '../../source/utils/project-scope.js';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit, type PtyChildDriver } from './provider-test-harness.js';

// Actual built CLI + persisted sessions + exact provider frames. No backend cache simulation.
it.each([
  { provider: 'codex', model: 'gpt-6.1-sol' },
  { provider: 'codex', model: 'gpt-5.6-luna' },
  { provider: 'openai', model: 'gpt-5.6-luna' },
])(
  '$provider/$model appends changed personal data at human turns and retains it across Bare resume/opt-out',
  async ({ provider, model }) => {
    const codex = provider === 'codex' ? await startFakeCodexServer({ scenario: 'success' }) : undefined;
    const http =
      provider === 'openai'
        ? await startFakeProviderHttpServer({ scenario: 'success', protocol: 'responses' })
        : undefined;
    const server = codex ?? {
      baseUrl: http!.baseUrl,
      get receivedRequests() {
        return http!.requests.map((request) => request.body as Record<string, unknown>);
      },
      close: () => http!.close(),
    };
    const workspace = await createIsolatedWorkspaceLease({
      env: { CODEX_BASE_URL: server.baseUrl, OPENAI_BASE_URL: server.baseUrl },
    });
    let child: PtyChildDriver | undefined;
    try {
      const project = join(workspace.root, 'project');
      const memory = join(workspace.root, 'memory');
      const root = join(memory, 'projects', createHash('sha256').update(projectScopeKey(project)).digest('hex'));
      await mkdir(project);
      await mkdir(root, { recursive: true });
      const store = new FileMemoryStore({ root });
      await store.create({
        id: 'moment',
        title: 'Moment',
        summary: 'A saved shared moment.',
        content: 'PRIVATE FULL BODY',
        tags: ['personal'],
      });
      const optIn = join(root, 'personal-context.json');
      await mkdir(workspace.paths.logDir, { recursive: true });
      await writeFile(
        join(workspace.paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            modelSelection: { provider, model },
            transport: provider === 'codex' ? 'websocket' : 'http',
            retryAttempts: 0,
            openai: { apiKey: 'fixture' },
          },
          app: { activeProfileId: 'builtin:bare' },
          memory: { directory: memory },
          sandbox: { enabled: false },
        }),
      );
      await mkdir(workspace.paths.codexHome, { recursive: true });
      const payload = Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString('base64url');
      await writeFile(
        join(workspace.paths.codexHome, 'auth.json'),
        JSON.stringify({
          tokens: {
            access_token: `fixture.${payload}.signature`,
            refresh_token: 'fixture-refresh',
            account_id: 'fixture-account',
          },
        }),
      );
      const cli = join(process.cwd(), 'dist/cli.js');
      const launch = { command: process.execPath, args: [cli], cwd: project, cols: 120, rows: 40 };
      child = await workspace.start(launch);
      await child.waitForIdleInput();
      const frames: Record<string, unknown>[] = [];
      let instructions: unknown;
      const send = async (text: string, newNotice: boolean, expected?: string) => {
        const idle = child!.readIdleGeneration();
        const before = server.receivedRequests.length;
        await writePtyTextAndSubmit(child!, text);
        await child!.waitForIdleInput({ after: idle });
        expect(server.receivedRequests.length).toBe(before + 1);
        const body = server.receivedRequests.at(-1)!;
        const input = body.input as { type: string; role?: string; content?: { text?: string }[] }[];
        const leading = { instructions: body.instructions, developer: input.filter((x) => x.role === 'developer') };
        if (instructions === undefined) instructions = leading;
        else if (!body.previous_response_id || provider !== 'codex' || model !== 'gpt-5.6-luna')
          expect(leading).toEqual(instructions);
        else expect(leading).toEqual({ instructions: '', developer: [] });
        expect(JSON.stringify(leading)).not.toContain('A saved shared moment');
        const messages = input
          .filter((x) => x.role === 'user')
          .map((x) => x.content?.map((p) => p.text ?? '').join('') ?? '');
        expect(messages.at(-1)).toBe(text);
        const notices = messages.filter((x) => x.startsWith('[Personal memory context'));
        // After restart the full prefix is replayed, not edited. Otherwise these are true chain deltas.
        if (body.previous_response_id) expect(notices).toHaveLength(newNotice ? 1 : 0);
        if (newNotice) {
          expect(messages.at(-2)).toContain(expected);
          expect(messages.at(-2)!.length).toBeLessThanOrEqual(2400);
          expect(messages.at(-2)).toContain('not a human request, instruction, or approval');
        }
        expect(JSON.stringify(input)).not.toContain('PRIVATE FULL BODY');
        frames.push(body);
      };
      await send('Before opting in.', false);
      await child.cleanup();
      child = undefined;
      const sessions = (await readdir(workspace.paths.conversationsDir)).filter((x) => x.endsWith('.jsonl'));
      expect(sessions).toHaveLength(1);
      const sessionId = sessions[0]!.replace(/\.jsonl$/, '');
      const resume = async () => {
        // A fresh process restarts harness generations; discard the dead child's readiness.
        await rm(workspace.paths.idlePath, { force: true });
        await rm(`${workspace.paths.idlePath}.composer`, { force: true });
        child = await workspace.relaunch({ ...launch, args: [cli, '--resume', sessionId] });
        await child.waitForIdleInput();
      };
      await writeFile(optIn, '{"enabled":true}');
      await resume();
      await send('First opted-in human message.', true, 'A saved shared moment.');
      await send('Unchanged human message.', false);
      await store.update('moment', { summary: 'A corrected shared moment.' });
      await send('After correcting the summary.', true, 'A corrected shared moment.');
      await store.remove('moment');
      await send('After deleting the last memory.', true, 'earlier automatic snapshots are withdrawn');
      await store.create({
        id: 'moment',
        title: 'Moment',
        summary: 'A saved shared moment.',
        content: 'PRIVATE FULL BODY',
        tags: ['personal'],
      });
      await send('After adding it back.', true, 'A saved shared moment.');
      const indexPath = join(root, 'index.json');
      const index = await readFile(indexPath, 'utf8');
      await writeFile(indexPath, '{broken');
      await send('After an unreadable index.', true, 'earlier automatic snapshots are withdrawn');
      await writeFile(indexPath, index);
      await send('After repairing the index.', true, 'A saved shared moment.');
      await child!.cleanup();
      child = undefined;
      await resume();
      await send('Unchanged after restart.', false);
      // Full replay contains the old snapshots verbatim, followed by a new human message.
      const replay = frames.at(-1)!.input as unknown[];
      expect(JSON.stringify(replay)).toContain('A corrected shared moment.');
      expect(replay.filter((item) => JSON.stringify(item).includes('[Personal memory context'))).toHaveLength(6);
      const firstInput = frames[1]!.input as { role?: string }[];
      const replayWithoutDeveloper = (replay as { role?: string }[]).filter((item) => item.role !== 'developer');
      expect(replayWithoutDeveloper.slice(0, firstInput.filter((item) => item.role !== 'developer').length)).toEqual(
        firstInput.filter((item) => item.role !== 'developer'),
      );
      await writeFile(optIn, '{"enabled":false}');
      await send('After opting out.', true, 'earlier automatic snapshots are withdrawn');
      await send('Still opted out.', false);
      const log = await readFile(join(workspace.paths.conversationsDir, sessions[0]!), 'utf8');
      expect(log).toContain('personal_memory_context');
      expect(log).toContain('builtin:bare');
    } finally {
      await child?.cleanup();
      await workspace.cleanup();
      await server.close();
    }
  },
);
