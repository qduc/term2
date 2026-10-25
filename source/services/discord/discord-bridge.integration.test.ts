import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { DiscordBridge, callDiscordControl, type DiscordBridgeConfig } from './discord-bridge.js';
import { ControlSocketServer } from '../control-socket/control-socket.js';
import { createControlSessionPort } from '../control-socket/control-session-port.js';
import { ConversationService } from '../conversation/conversation-service.js';
import { ConversationOrchestrator } from '../conversation/conversation-orchestrator.js';
import type { UIPort } from '../conversation/conversation-orchestrator.types.js';
import type { Message } from '../../types/message.js';
import { AgentClient } from '../../lib/agent-client.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { SessionContextService } from '../session/session-context-service.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';
import { createUsageAccumulator } from '../../utils/ai/token-usage.js';
import { registerProvider, unregisterProvider } from '../../providers/registry.js';
import type { StreamedModelTurnRequest } from '../../contracts/streamed-model-turn.js';
import type { ILoggingService } from '../service-interfaces.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const noop = () => {};
const logger = {
  debug: noop,
  error: noop,
  info: noop,
  warn: noop,
  security: noop,
  setCorrelationId: noop,
  getCorrelationId: () => undefined,
  clearCorrelationId: noop,
} as ILoggingService;

async function fixture(
  options: {
    maxHops?: number;
    respond?: (alias: string, request: StreamedModelTurnRequest) => string | Promise<string>;
    optIn?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-discord-'));
  fs.chmodSync(root, 0o700);
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const received: Record<string, StreamedModelTurnRequest[]> = { coord: [], worker: [] };
  const sessions: Record<
    string,
    {
      service: ConversationService;
      orchestrator: ConversationOrchestrator;
      socket: ControlSocketServer;
      messages: () => Message[];
    }
  > = {};
  for (const alias of ['coord', 'worker']) {
    const providerId = `discord-fixture-${path.basename(root)}-${alias}`;
    registerProvider({
      id: providerId,
      label: 'Offline Discord provider fixture',
      capabilities: { supportsConversationChaining: false },
      fetchModels: async () => [],
      createStreamedModel: () => ({
        async *stream(request: StreamedModelTurnRequest) {
          received[alias]!.push(request);
          const text = await (options.respond?.(alias, request) ?? `${alias} answer`);
          yield {
            type: 'completion' as const,
            responseId: `${alias}-${received[alias]!.length}`,
            output: [{ type: 'message' as const, content: [{ type: 'text' as const, text }] }],
          };
        },
      }),
    });
    cleanup.push(() => unregisterProvider(providerId));
    const settings = createMockSettingsService({
      'agent.modelSelection': { provider: providerId, model: 'fixture-model' },
      'agent.retryAttempts': 0,
    });
    const context = new SessionContextService();
    const ownership = new ToolOwnershipRegistry();
    const client = new AgentClient({
      selection: { provider: providerId, model: 'fixture-model' },
      agentOverride: {
        name: 'Discord fixture',
        model: 'fixture-model',
        instructions: 'Use existing conversation history.',
        tools: [],
      },
      toolOwnership: ownership,
      maxTurns: 2,
      retryAttempts: 0,
      deps: { logger, settings, sessionContextService: context },
    });
    const service = new ConversationService({
      agentClient: client,
      sessionId: `session-${alias}`,
      toolOwnership: ownership,
      deps: { logger, settingsService: settings, sessionContextService: context },
    });
    cleanup.push(() => service.dispose());
    let messages: Message[] = [];
    const ui = new Proxy({}, { get: () => noop }) as UIPort;
    const orchestrator = new ConversationOrchestrator({
      conversationService: service,
      loggingService: logger,
      approvedContext: { current: null },
      ui,
      messages: {
        getMessages: () => messages,
        setMessages: (update) => {
          messages = update(messages);
        },
        appendMessages: (rows) => {
          messages.push(...rows);
        },
        trimMessages: (rows) => rows,
      },
    });
    const socket = new ControlSocketServer({
      name: alias,
      sessionId: () => service.sessionId,
      runtimeDir: root,
      discordInput: options.optIn ?? true,
    });
    socket.bind(
      createControlSessionPort({
        conversationService: service,
        orchestrator,
        settingsService: settings,
        usageAccumulator: createUsageAccumulator(),
        controlSocket: socket,
        stopProcessingWithNotice: () => {
          orchestrator.stopProcessing();
        },
        sessionMetadata: () => ({ workspaceRoot: root, version: 'fixture', createdAt: '', logPath: '' }),
      }),
    );
    await socket.listen();
    cleanup.push(() => socket.close());
    sessions[alias] = { service, orchestrator, socket, messages: () => messages };
  }
  const messages: any[] = [];
  const posted: any[] = [];
  const headers: string[] = [];
  let nextId = 10n;
  let reads = 0;
  let posts429 = 0;
  let droppedPost = false;
  let wrongChannel = false;
  const http: Server = createServer(async (request, response) => {
    headers.push(String(request.headers.authorization));
    const url = new URL(request.url!, 'http://localhost');
    if (request.method === 'GET') {
      reads++;
      const after = BigInt(url.searchParams.get('after') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const rows = messages
        .filter((entry) => BigInt(entry.id) > after)
        .slice(0, limit)
        .reverse();
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(
          wrongChannel ? [{ id: '90', channel_id: 'other', content: 'leak', author: { id: '100' } }] : rows,
        ),
      );
    } else {
      let body = '';
      for await (const chunk of request) body += chunk;
      const value = JSON.parse(body);
      if (posts429 > 0) {
        posts429--;
        response.writeHead(429);
        response.end('{"retry_after":1}');
        return;
      }
      posted.push(value);
      messages.push({
        id: String(nextId++),
        channel_id: '200',
        content: value.content,
        author: { id: '300', bot: true },
      });
      if (droppedPost) {
        droppedPost = false;
        request.socket.destroy();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: String(nextId++) }));
    }
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  );
  const address = http.address() as { port: number };
  const warnings: string[] = [];
  const config: DiscordBridgeConfig = {
    channelId: '200',
    humanUserId: '100',
    coordinator: 'coord',
    sessions: {
      coord: { socket: 'coord', sessionId: 'session-coord' },
      worker: { socket: 'worker', sessionId: 'session-worker' },
    },
    stateDir: path.join(root, 'bridge'),
    maxHops: options.maxHops ?? 2,
  };
  const makeBridge = () =>
    new DiscordBridge(config, 'OFFLINE_FIXTURE_TOKEN', {
      runtimeDir: root,
      apiBase: `http://127.0.0.1:${address.port}`,
      warn: (warning) => warnings.push(warning),
    });
  let bridge = makeBridge();
  bridge.open();
  cleanup.push(() => bridge.close());
  const human = (content: string, author = { id: '100' }, extra = {}) => {
    const message = { id: String(nextId++), channel_id: '200', author, content, ...extra };
    messages.push(message);
    return message;
  };
  const cycle = async (count = 3) => {
    for (let i = 0; i < count; i++) {
      await bridge.tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const restart = () => {
    bridge.close();
    bridge = makeBridge();
    bridge.open();
  };
  const journal = () => JSON.parse(fs.readFileSync(path.join(config.stateDir, 'journal.json'), 'utf8'));
  return {
    received,
    sessions,
    posted,
    warnings,
    config,
    human,
    cycle,
    restart,
    journal,
    headers,
    bridge: () => bridge,
    reads: () => reads,
    wrongChannel: () => {
      wrongChannel = true;
    },
    throttlePost: () => {
      posts429 = 1;
    },
    dropPost: () => {
      droppedPost = true;
    },
  };
}

it('attaches to two real existing session histories, attributes human/agent data and routes only explicit bounded chains', async () => {
  const f = await fixture({
    respond: (alias, request) => {
      const input = JSON.stringify(request.input);
      if (input.includes('start-chain') && alias === 'coord') return '@worker inspect this';
      if (alias === 'worker') return 'Worker result @everyone <@100>';
      return 'Coordinator sees terminal context';
    },
  });
  await f.sessions.coord!.orchestrator.sendUserMessage('terminal context secret is apricot');
  const before = f.received.coord!.length;
  f.human('old history must not activate');
  await f.cycle();
  expect(f.received.coord).toHaveLength(before);
  expect(f.posted.some((message) => message.content.includes('Coordinator sees terminal context'))).toBe(false);
  f.human('start-chain');
  await f.cycle(8);
  expect(f.received.coord).toHaveLength(before + 1);
  expect(f.received.worker).toHaveLength(1);
  const coordInput = JSON.stringify(f.received.coord!.at(-1)!.input);
  expect(coordInput).toContain('apricot');
  expect(coordInput).toContain('configured Discord human');
  const workerInput = JSON.stringify(f.received.worker![0]!.input);
  expect(workerInput).toContain('agent session coord');
  expect(workerInput).toContain('NOT a human instruction or approval');
  expect(workerInput).toContain('inspect this');
  expect(JSON.stringify(f.sessions.worker!.service.exportState())).toContain('agent session coord');
  expect(
    f.sessions
      .worker!.messages()
      .filter((message) => message.sender === 'user')
      .at(-1),
  ).toMatchObject({ presentation: 'server_message' });
  expect(f.posted.some((message) => message.content.startsWith('[worker] Worker result'))).toBe(true);
  expect(f.posted.every((message) => message.allowed_mentions.parse.length === 0)).toBe(true);
  const counts = [f.received.coord!.length, f.received.worker!.length];
  await f.cycle(3);
  f.restart();
  await f.cycle(3);
  expect([f.received.coord!.length, f.received.worker!.length]).toEqual(counts);
  expect(new Set(f.posted.map((message) => message.nonce)).size).toBe(f.posted.length);
  expect(f.warnings.join()).not.toContain('OFFLINE_FIXTURE_TOKEN');
}, 20_000);

it('rejects unauthorized/bot/webhook/unknown/wrong-channel messages without waking sessions', async () => {
  const f = await fixture();
  await f.cycle();
  f.human('unauthorized', { id: '999' });
  f.human('@worker bot-loop', { id: '100', bot: true } as any);
  f.human('@worker webhook-loop', { id: '100' }, { webhook_id: '900' });
  f.human('@missing do not fallback');
  f.human('@<bad malformed');
  await f.cycle();
  expect(f.received.coord).toHaveLength(0);
  expect(f.received.worker).toHaveLength(0);
  expect(f.posted.filter((message) => message.content.includes('not delivered'))).toHaveLength(2);
  const cursor = f.journal().cursor;
  f.wrongChannel();
  await f.cycle(1);
  expect(f.journal().cursor).toBe(cursor);
  expect(f.received.coord).toHaveLength(0);
});

it('bounds cyclic explicitly targeted exchanges and implements pause/resume/stop without hidden activation', async () => {
  const f = await fixture({ maxHops: 2, respond: (alias) => (alias === 'coord' ? '@worker bounce' : '@coord bounce') });
  await f.cycle();
  f.human('!bridge pause');
  f.human('cycle');
  await f.cycle();
  expect(f.received.coord).toHaveLength(0);
  f.human('!bridge resume');
  await f.cycle(10);
  expect(f.received.coord!.length + f.received.worker!.length).toBe(3);
  expect(f.posted.some((message) => message.content.includes('hop limit reached'))).toBe(true);
  f.human('!bridge stop');
  f.human('queued while stopped');
  await f.cycle();
  expect(f.journal().paused).toBe(true);
  expect(f.received.coord!.length + f.received.worker!.length).toBe(3);
});

it('uses real busy-session follow-up admission and rejects remote approval answers without changing terminal policy', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({
    respond: async (alias, request) => {
      if (alias === 'coord' && JSON.stringify(request.input).includes('hold-terminal')) await gate;
      return 'done';
    },
  });
  await f.cycle();
  const terminal = f.sessions.coord!.orchestrator.sendUserMessage('hold-terminal');
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.human('follow-up');
  await f.cycle(1);
  expect(f.posted.some((message) => message.content.includes('queued.'))).toBe(true);
  expect(f.received.coord).toHaveLength(1);
  release();
  await terminal;
  await f.cycle(5);
  expect(f.received.coord).toHaveLength(2);
  f.sessions.worker!.service.presentPendingInteraction({
    toolCallId: 'approval-1',
    toolName: 'shell',
    arguments: { command: 'danger' },
  } as any);
  f.human('@worker yes');
  await f.cycle();
  expect(f.received.worker).toHaveLength(0);
  expect(f.sessions.worker!.service.getPendingInteractionSnapshot()).not.toBeNull();
  expect(f.posted.some((message) => message.content.includes('terminal_interaction_required'))).toBe(true);
}, 20_000);

it('requires process opt-in, pins session identity and preserves the ordinary control peer rejection', async () => {
  const f = await fixture({ optIn: false });
  await f.cycle();
  f.human('not allowed');
  await f.cycle();
  expect(f.received.coord).toHaveLength(0);
  expect(f.posted.some((message) => message.content.includes('Control rejected admission'))).toBe(true);
  const socket = f.sessions.coord!.socket;
  await expect(
    callDiscordControl(socket.socketPath, 'submit', {
      text: 'peer',
      clientRequestId: 'peer',
      origin: { kind: 'peer' },
    }),
  ).rejects.toThrow();
  const status = await callDiscordControl(socket.socketPath, 'status');
  expect(status.sessionId).toBe('session-coord');
  const changed = {
    sessionId: 'different',
    startedAt: socket.startedAt,
    text: 'wrong session',
    clientRequestId: 'wrong',
    origin: { kind: 'human', sender: '100' },
  };
  await expect(callDiscordControl(socket.socketPath, 'bridge_submit', changed)).rejects.toThrow();
});

it('chunks Unicode finals, quarantines ambiguous output and never replays an uncertain POST on restart', async () => {
  const f = await fixture({ respond: () => '😀'.repeat(2100) });
  await f.cycle();
  f.dropPost();
  f.human('large final');
  await f.cycle(5);
  expect(f.journal().outbox.some((entry: any) => entry.state === 'uncertain')).toBe(true);
  expect(f.posted.every((message) => message.content.length <= 1800)).toBe(true);
  expect(f.posted.every((message) => !/[\uD800-\uDBFF]$/.test(message.content))).toBe(true);
  const count = f.posted.length;
  f.restart();
  await f.cycle();
  expect(f.posted).toHaveLength(count);
  expect(f.warnings.join()).toContain('Uncertain Discord output');
});

it('honors Discord retry_after instead of retrying within a tight tick loop', async () => {
  const f = await fixture();
  f.throttlePost();
  await f.cycle(1);
  const reads = f.reads();
  await f.cycle(4);
  expect(f.reads()).toBe(reads);
  expect(f.journal().outbox[0].state).toBe('queued');
  f.restart();
  await f.cycle(2);
  expect(f.reads()).toBe(reads);
});

it('deduplicates real session admission, rejects changed bodies and recovers an accepted request after a bridge crash', async () => {
  const f = await fixture();
  await f.cycle();
  const socket = f.sessions.coord!.socket;
  const input = {
    sessionId: 'session-coord',
    startedAt: socket.startedAt,
    clientRequestId: 'discord_70',
    text: 'admit exactly once locally',
    origin: { kind: 'human', sender: '100' },
  };
  const first = await callDiscordControl(socket.socketPath, 'bridge_submit', input);
  const replay = await callDiscordControl(socket.socketPath, 'bridge_submit', input);
  expect(first.delivery).toBe('started');
  expect(replay.replayed).toBe(true);
  await expect(
    callDiscordControl(socket.socketPath, 'bridge_submit', { ...input, text: 'different' }),
  ).rejects.toThrow();
  const journal = f.journal();
  // Crash window: session accepted, but bridge did not persist its receipt.
  journal.jobs.push({
    id: 'discord_70',
    alias: 'coord',
    text: input.text,
    origin: input.origin,
    hops: 0,
    state: 'dispatching',
  });
  fs.writeFileSync(path.join(f.config.stateDir, 'journal.json'), JSON.stringify(journal));
  f.restart();
  await f.cycle(4);
  expect(f.received.coord).toHaveLength(1);
  expect(f.journal().jobs.find((job: any) => job.id === 'discord_70').state).toBe('done');
  expect(f.posted.filter((output) => output.content === '[coord] coord answer')).toHaveLength(1);
});

it('quarantines missing admission outcomes and changed real session identity without replaying into replacement history', async () => {
  const f = await fixture();
  await f.cycle();
  const journal = f.journal();
  journal.jobs.push({
    id: 'discord_80',
    alias: 'coord',
    text: 'uncertain original',
    origin: { kind: 'human', sender: '100' },
    hops: 0,
    state: 'dispatching',
  });
  fs.writeFileSync(path.join(f.config.stateDir, 'journal.json'), JSON.stringify(journal));
  f.restart();
  await f.cycle(3);
  expect(f.received.coord).toHaveLength(0);
  expect(f.journal().jobs[0]).toMatchObject({ state: 'uncertain', text: 'uncertain original' });
  expect(f.posted.some((output) => output.content.includes('NOT resubmitted'))).toBe(true);
  f.human('@worker queued target');
  f.human('!bridge pause');
  await f.cycle(1);
  f.sessions.worker!.service.resetWithNewId('replacement-history');
  f.sessions.worker!.socket.refreshAdvertisement();
  f.human('!bridge resume');
  await f.cycle(3);
  expect(f.received.worker).toHaveLength(0);
  // New, definitely undispatched input is retained rather than sent to a replacement.
  expect(
    f.journal().jobs.some((job: any) => job.alias === 'worker' && job.state === 'new' && job.text === 'queued target'),
  ).toBe(true);
});

it('does not route a truncated final and keeps attribution and mention suppression on every chunk', async () => {
  const f = await fixture({ respond: () => '@worker ' + 'x'.repeat(20_000) });
  await f.cycle();
  f.human('long peer request');
  await f.cycle(16);
  expect(f.received.worker).toHaveLength(0);
  const finals = f.posted.filter((output) => output.content.startsWith('[coord]'));
  expect(finals.length).toBeGreaterThan(1);
  expect(finals.every((output) => output.content.length <= 2000 && output.allowed_mentions.parse.length === 0)).toBe(
    true,
  );
  expect(finals.at(-1).content).toContain('[truncated by session control]');
});

it('advances through a paged backlog without waking for history, bot echoes or unauthorized inputs', async () => {
  const f = await fixture();
  await f.cycle();
  for (let i = 0; i < 54; i++) f.human('ignored backlog', { id: '999' });
  f.human('new authorized message after backlog');
  await f.cycle(6);
  expect(f.received.coord).toHaveLength(1);
  expect(f.received.worker).toHaveLength(0);
  expect(JSON.stringify(f.received.coord![0]!.input)).toContain('new authorized message after backlog');
});

it('rejects invalid file config in an isolated command process without exposing a token or creating sessions', async () => {
  const f = await fixture();
  const file = path.join(f.config.stateDir, 'invalid.json');
  fs.writeFileSync(file, JSON.stringify({ ...f.config, humanUserId: 'not-a-user-id' }));
  const code =
    'import {runDiscordBridge} from "./source/services/discord/discord-command.ts"; await runDiscordBridge(process.argv.slice(1));';
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, file], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', TERM2_DISCORD_BOT_TOKEN: 'FAKE_SECRET_MUST_NOT_PRINT' },
  });
  expect(child.status, child.stderr).toBe(1);
  expect(child.stderr).toContain('Credentials and payloads redacted');
  expect(child.stdout + child.stderr).not.toContain('FAKE_SECRET_MUST_NOT_PRINT');
  expect(f.received.coord).toHaveLength(0);
  const other = new DiscordBridge(f.config, 'OFFLINE_FIXTURE_TOKEN', { runtimeDir: path.dirname(f.config.stateDir) });
  expect(() => other.open()).toThrow('already running');
});

it('native stop aborts actual in-flight work, keeps the bridge paused and suppresses follow-on peer activation', async () => {
  let aborts = 0;
  const f = await fixture({
    respond: async (alias, request) => {
      if (alias === 'coord') {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else
            request.signal?.addEventListener(
              'abort',
              () => {
                aborts++;
                resolve();
              },
              { once: true },
            );
        });
        return '@worker must not run after cancellation';
      }
      return 'unexpected worker';
    },
  });
  await f.cycle();
  f.human('start long work');
  await f.cycle(1);
  expect(f.received.coord).toHaveLength(1);
  f.human('!bridge stop');
  await f.cycle(6);
  expect(aborts).toBe(1);
  expect(f.journal().paused).toBe(true);
  expect(f.received.worker).toHaveLength(0);
  expect(f.posted.some((output) => output.content.includes('interrupted'))).toBe(true);
}, 20_000);

it.each(['resume', 'stop'])(
  'full paused inbox visibly refuses excess work, preserves admission evidence across restart and keeps %s reachable',
  async (command) => {
    const f = await fixture();
    await f.cycle();
    f.human('!bridge pause');
    for (let i = 0; i < 128; i++) f.human(`retained capacity request ${i}`);
    await f.cycle(5);
    const admitted = f.journal().jobs;
    expect(admitted).toHaveLength(128);
    expect(admitted.every((job: any) => job.state === 'new')).toBe(true);
    const excess = f.human('@worker not-admitted-overflow-body');
    const status = f.human('!bridge status');
    await f.cycle(3);
    expect(f.journal().jobs).toEqual(admitted);
    expect(BigInt(f.journal().cursor) >= BigInt(status.id)).toBe(true);
    const refused = () => f.posted.filter((output) => output.content.includes(`Message ${excess.id} NOT accepted`));
    expect(refused()).toHaveLength(1);
    expect(refused()[0].content).toContain('not queued or sent to a session');
    expect(refused()[0].allowed_mentions.parse).toEqual([]);
    expect(f.received.coord).toHaveLength(0);
    expect(f.received.worker).toHaveLength(0);
    f.restart();
    await f.cycle(2);
    expect(f.journal().jobs).toEqual(admitted);
    expect(refused()).toHaveLength(1);
    const control = f.human(`!bridge ${command}`);
    await f.cycle(3);
    expect(BigInt(f.journal().cursor) >= BigInt(control.id)).toBe(true);
    expect(f.journal().paused).toBe(command === 'stop');
    expect(f.journal().jobs.map((job: any) => job.id)).toEqual(admitted.map((job: any) => job.id));
    expect(f.received.worker).toHaveLength(0);
    expect(JSON.stringify(f.received.coord)).not.toContain('not-admitted-overflow-body');
    if (command === 'resume') expect(f.received.coord).toHaveLength(128);
    else {
      expect(f.journal().jobs.every((job: any) => job.state === 'done')).toBe(true);
      expect(f.received.coord).toHaveLength(0);
    }
  },
  30_000,
);

it('overflow refusal keeps ambiguous POST quarantine across restart without replay or repeated admission', async () => {
  const f = await fixture();
  await f.cycle();
  f.human('!bridge pause');
  for (let i = 0; i < 128; i++) f.human(`retained ambiguity request ${i}`);
  await f.cycle(5);
  const admitted = f.journal().jobs;
  const excess = f.human('refused after lost acknowledgement');
  f.dropPost();
  await f.cycle(1);
  const notice = (output: any) => output.content.includes(`Message ${excess.id} NOT accepted`);
  expect(f.posted.filter(notice)).toHaveLength(1);
  const quarantined = f.journal().outbox.find(notice);
  expect(quarantined.state).toBe('uncertain');
  expect(f.journal().jobs).toEqual(admitted);
  f.restart();
  await f.cycle(4);
  expect(f.posted.filter(notice)).toHaveLength(1);
  expect(f.journal().outbox.find(notice)).toEqual(quarantined);
  expect(f.journal().jobs).toEqual(admitted);
  expect(f.received.coord).toHaveLength(0);
  const stop = f.human('!bridge stop');
  await f.cycle(3);
  expect(BigInt(f.journal().cursor) >= BigInt(stop.id)).toBe(true);
  expect(f.journal().jobs.map((job: any) => job.id)).toEqual(admitted.map((job: any) => job.id));
  expect(f.posted.filter(notice)).toHaveLength(1);
  expect(f.journal().outbox.find(notice).state).toBe('uncertain');
});
