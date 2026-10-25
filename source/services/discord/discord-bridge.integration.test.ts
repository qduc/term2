import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { DiscordBridge, callDiscordControl, type DiscordBridgeConfig } from './discord-bridge.js';
import { sendDiscord, type DiscordSendInput } from './discord-outbound.js';
import { createFailClosedDiscordSend } from './discord-send-capability.js';
import { getAgentDefinition } from '../../agent.js';
import { createDiscordSendToolDefinition } from '../../tools/discord-send.js';
import { ControlSocketServer } from '../control-socket/control-socket.js';
import { createBridgeCommand } from '../../commands/bridge-command.js';
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
import type { ProviderInputItem } from '../../contracts/provider-input.js';
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
    busyTool?: boolean;
    respond?: (alias: string, request: StreamedModelTurnRequest) => string | Promise<string>;
    optIn?: boolean;
    proactive?: boolean;
    proactiveScripts?: string[];
    profile?: string;
    readOnly?: boolean;
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
          if (options.busyTool && alias === 'coord' && received[alias]!.length === 1) {
            await options.respond?.(alias, request);
            yield {
              type: 'tool_call' as const,
              id: 'busy-tool',
              name: 'run_code',
              arguments: JSON.stringify({ code: 'return "busy tool finished"', description: 'Offline busy-turn tool' }),
            };
            yield { type: 'completion' as const, responseId: 'busy-tool-turn', output: [] };
            return;
          }
          const proactiveScript = (options.proactiveScripts ?? [
            'return await tools.discord_send({action:"send",requestId:"terminal_notice",text:"@worker terminal-origin notification"})',
          ])[(received[alias]!.length - 1) / 2];
          if (options.proactive && alias === 'coord' && proactiveScript) {
            yield {
              type: 'tool_call' as const,
              id: 'terminal-notify',
              name: 'run_code',
              arguments: JSON.stringify({
                code: proactiveScript,
                description: 'Notify the human',
              }),
            };
            yield { type: 'completion' as const, responseId: 'tool-turn', output: [] };
            return;
          }
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
      ...(options.proactive ? { 'app.activeProfileId': options.profile ?? 'builtin:bare' } : {}),
    });
    const context = new SessionContextService();
    const ownership = new ToolOwnershipRegistry();
    const client = new AgentClient({
      selection: { provider: providerId, model: 'fixture-model' },
      ...(options.proactive || options.busyTool
        ? {}
        : {
            agentOverride: {
              name: 'Discord fixture',
              model: 'fixture-model',
              instructions: 'Use existing conversation history.',
              tools: [],
            },
          }),
      toolOwnership: ownership,
      maxTurns: 2,
      retryAttempts: 0,
      deps: {
        logger,
        settings,
        sessionContextService: context,
        readOnly: options.readOnly,
        ...(options.proactive
          ? { discordSend: (input: DiscordSendInput) => sendDiscord(root, sessions[alias]!.socket.binding, input) }
          : {}),
      },
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
  let holdPost = false;
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
      if (holdPost) return;
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
    root,
    apiBase: `http://127.0.0.1:${address.port}`,
    holdPost: () => {
      holdPost = true;
    },
    releasePosts: () => {
      holdPost = false;
    },
    config,
    makeBridge: () => {
      const instance = makeBridge();
      cleanup.push(() => instance.close());
      return instance;
    },
    received,
    sessions,
    posted,
    warnings,
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
  expect(workerInput).toContain('not human instruction or approval');
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

it.each([false, true])(
  'steers human Discord input before busy-turn completion and correlates its outcome (failure=%s)',
  async (fail) => {
    let release!: () => void;
    let started!: () => void;
    let finish!: () => void;
    let continuing!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finalHeld = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const continued = new Promise<void>((resolve) => {
      continuing = resolve;
    });
    let first = true;
    const f = await fixture({
      busyTool: true,
      respond: async () => {
        if (first) {
          first = false;
          started();
          await held;
        } else {
          continuing();
          await finalHeld;
          if (fail) throw new Error('Offline joined-turn failure');
        }
        return 'Joined human answer';
      },
    });
    cleanup.push(() => {
      release();
      finish();
    });
    await f.cycle();
    f.posted.length = 0;
    const active = f.sessions.coord!.orchestrator.sendUserMessage('Terminal task');
    await entered;
    f.human('first steer');
    f.human('second steer');
    const admission = f.cycle();
    await admission;
    expect(f.journal().jobs.map((job: any) => job.state)).toEqual(['accepted', 'accepted']);
    expect(f.posted).toHaveLength(0);
    release();
    await continued;
    await admission;
    expect(f.journal().jobs.map((job: any) => job.state)).toEqual(['accepted', 'accepted']);
    expect(f.posted).toHaveLength(0);
    const continuation = JSON.stringify(f.received.coord![1]!.input);
    expect(continuation).toContain('first steer');
    expect(continuation).toContain('second steer');
    finish();
    await active;
    await f.cycle();
    expect(f.received.coord).toHaveLength(2);
    expect(f.posted.map((row) => row.content)).toEqual(
      fail
        ? [
            '[coord] interrupted; inspect the terminal. No peer activation.',
            '[coord] interrupted; inspect the terminal. No peer activation.',
          ]
        : ['[coord] Joined human answer', '[coord] Joined human answer'],
    );
    expect(f.journal().jobs.map((job: any) => job.state)).toEqual(['done', 'done']);
    if (!fail) await f.sessions.coord!.orchestrator.sendUserMessage('Unrelated later terminal turn');
    await f.restart();
    await f.cycle();
    expect(f.posted).toHaveLength(2);
  },
);

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
  const socket = f.sessions.coord!.socket;
  const receipt = await callDiscordControl(socket.socketPath, 'bridge_submit', {
    sessionId: 'session-coord',
    startedAt: socket.binding.startedAt,
    clientRequestId: 'peer_busy',
    text: 'follow-up',
    origin: { kind: 'agent', sender: 'worker' },
  });
  expect(receipt.delivery).toBe('queued');
  await f.cycle(1);
  expect(f.posted.some((message) => /\[bridge → .*\] (started|queued)\./.test(message.content))).toBe(false);
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

it('fails closed without an opted-in socket and delegates outbound only with opt-in', async () => {
  const f = await fixture({ optIn: false });
  let outboundCalls = 0;
  const send = createFailClosedDiscordSend(
    () => f.sessions.coord!.socket,
    f.root,
    async (_directory, _binding, input) => {
      outboundCalls++;
      return { requestId: input.requestId, delivery: 'queued' };
    },
  );
  const input: DiscordSendInput = { action: 'send', requestId: 'guarded', text: 'safe' };
  expect(await send(input)).toMatchObject({ requestId: 'guarded', delivery: 'unavailable' });
  expect(outboundCalls).toBe(0);
  const optedIn = new ControlSocketServer({
    name: 'runtime-opted',
    runtimeDir: f.root,
    discordInput: true,
    sessionId: () => 'runtime-session',
  });
  await optedIn.listen();
  cleanup.push(() => optedIn.close());
  expect(
    await createFailClosedDiscordSend(
      () => optedIn,
      f.root,
      async (_d, _b, value) => {
        outboundCalls++;
        return { requestId: value.requestId, delivery: 'queued' };
      },
    )(input),
  ).toMatchObject({ delivery: 'queued' });
  expect(outboundCalls).toBe(1);
});

it('runtime bridge command validates, advertises, refuses duplicates, disconnects and reconnects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-runtime-bridge-'));
  fs.chmodSync(root, 0o700);
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  let active: ControlSocketServer | undefined;
  const messages: string[] = [];
  const command = createBridgeCommand({
    getServer: () => active,
    isStartup: false,
    getSessionId: () => 'runtime-session',
    addSystemMessage: (message) => messages.push(message),
    connect: async (name) => {
      const server = new ControlSocketServer({
        name,
        discordInput: true,
        runtimeDir: root,
        sessionId: () => 'runtime-session',
      });
      await server.listen();
      active = server;
      return server;
    },
    disconnect: async (server) => {
      await server.close();
      active = undefined;
    },
  });
  command.action('connect invalid/name');
  expect(messages.pop()).toContain('Invalid bridge socket name');
  command.action('connect runtime');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(active?.discordInputEnabled).toBe(true);
  expect(fs.existsSync(active!.advertisementPath)).toBe(true);
  expect(JSON.parse(fs.readFileSync(active!.advertisementPath, 'utf8'))).toMatchObject({
    name: 'runtime',
    sessionId: 'runtime-session',
    socketPath: active!.socketPath,
  });
  expect(messages.pop()).toContain('approvals and questions remain terminal-only');
  command.action();
  const bareStatus = messages.pop()!;
  expect(bareStatus).toContain('Bridge connected: runtime');
  expect(bareStatus).not.toContain('Usage: /bridge');
  command.action('   \t  ');
  const whitespaceStatus = messages.pop()!;
  expect(whitespaceStatus).toContain('Bridge connected: runtime');
  expect(whitespaceStatus).not.toContain('Usage: /bridge');
  command.action('status');
  expect(messages.pop()).toContain('session runtime-session; startup socket no');
  const startupCommand = createBridgeCommand({
    getServer: () => active,
    isStartup: true,
    getSessionId: () => 'runtime-session',
    addSystemMessage: (message) => messages.push(message),
  });
  startupCommand.action('disconnect');
  expect(messages.pop()).toContain('startup control socket cannot be disconnected');
  expect(active).toBeDefined();
  command.action('connect second');
  expect(messages.pop()).toContain('already connected');
  command.action('disconnect');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(active).toBeUndefined();
  expect(fs.existsSync(path.join(root, 'term2', 'control', 'runtime.json'))).toBe(false);
  expect(messages.pop()).toContain('Bridge disconnected');
  command.action('connect runtime');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(active?.discordInputEnabled).toBe(true);
  command.action('disconnect');
  await new Promise<void>((resolve) => setImmediate(resolve));
});

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

it('silently completes successful empty finals without placeholder or peer routing', async () => {
  const f = await fixture({ respond: () => '  \n\t  ' });
  await f.cycle();
  f.human('finish without a response');
  await f.cycle(8);

  expect(f.journal().jobs.at(-1).state).toBe('done');
  expect(f.posted.some((output) => output.content.includes('completed without text'))).toBe(false);
  expect(f.posted.some((output) => output.content.startsWith('[coord]'))).toBe(false);
  expect(f.received.worker).toHaveLength(0);
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

it.each(['builtin:bare', 'builtin:standard'])(
  'returns usable send and status results from a terminal-origin %s turn through run_code and the private socket',
  async (profile) => {
    const f = await fixture({
      proactive: true,
      profile,
      proactiveScripts: [
        'return await tools.discord_send({action:"send",requestId:"terminal_notice",text:"@worker terminal-origin notification"})',
        'return await tools.discord_send({action:"status",requestId:"terminal_notice"})',
      ],
    });
    await f.bridge().listenOutbound();
    const directory = path.join(f.root, 'term2-discord');
    const advertisement = fs.readdirSync(directory).find((name) => name.endsWith('.json'))!;
    expect(fs.statSync(path.join(directory, advertisement)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(directory, advertisement), 'utf8')).not.toContain('OFFLINE_FIXTURE_TOKEN');
    await f.sessions.coord!.orchestrator.sendUserMessage('Notify the human explicitly from this terminal turn.');
    expect(f.journal().jobs).toHaveLength(0);
    expect(f.journal().proactive).toHaveLength(1);
    expect(f.journal().proactive[0].requestId).toBe('terminal_notice');
    for (let i = 0; i < 3; i++) await f.bridge().tick();
    expect(f.posted.filter((p) => p.content.includes('terminal-origin notification'))).toHaveLength(1);
    const posted = f.posted.find((p) => p.content.includes('terminal-origin notification'))!;
    expect(posted.content).toBe('[coord] @worker terminal-origin notification');
    expect(posted.allowed_mentions).toEqual({ parse: [], replied_user: false });
    expect(f.received.worker).toHaveLength(0);
    expect(
      await sendDiscord(f.root, f.sessions.coord!.socket.binding, { action: 'status', requestId: 'terminal_notice' }),
    ).toMatchObject({
      delivery: 'sent',
      senderAlias: 'coord',
      channelId: '200',
      chunks: { sent: 1, queued: 0, uncertain: 0 },
    });
    await f.sessions.coord!.orchestrator.sendUserMessage('Check delivery of the same notification.');
    expect(f.received.coord).toHaveLength(4);
    // Assert the consumer boundary, not just the POST: a send can take effect before
    // run_code rejects an incorrectly represented tool result.
    for (const [index, delivery] of [
      [1, 'queued'],
      [3, 'sent'],
    ] as const) {
      const results = f.received.coord[index]!.input.filter((item) => item.type === 'tool_result');
      const result = results.at(-1)!;
      expect((result as ProviderInputItem).runCodeExecution).toEqual({ success: true });
      expect(String(result.output)).toMatch(/^Result:\n/);
      expect(JSON.parse(String(result.output).slice('Result:\n'.length).split('\n\n')[0]!)).toMatchObject({
        requestId: 'terminal_notice',
        delivery,
        senderAlias: 'coord',
        channelId: '200',
        chunks: delivery === 'sent' ? { sent: 1, queued: 0, uncertain: 0 } : { sent: 0, queued: 1, uncertain: 0 },
      });
    }
    expect(f.journal().proactive).toHaveLength(1);
    expect(f.posted.filter((p) => p.content.includes('terminal-origin notification'))).toHaveLength(1);
  },
);

it('reconciles duplicate sends, conflicts, pause, bounds and unavailable mappings without admitting effects', async () => {
  const f = await fixture();
  await f.bridge().listenOutbound();
  const send = (input: DiscordSendInput) => sendDiscord(f.root, f.sessions.coord!.socket.binding, input);
  expect(await send({ action: 'status', requestId: 'none' })).toMatchObject({ delivery: 'missing' });
  expect(await send({ action: 'send', requestId: 'key', text: 'hello' })).toMatchObject({ delivery: 'queued' });
  expect(await send({ action: 'send', requestId: 'key', text: 'hello' })).toMatchObject({ delivery: 'queued' });
  expect(f.journal().proactive).toHaveLength(1);
  expect(await send({ action: 'send', requestId: 'utf16', text: '\uD800' })).toMatchObject({ delivery: 'queued' });
  expect(await send({ action: 'send', requestId: 'utf16', text: '\uFFFD' })).toMatchObject({
    delivery: 'rejected',
    reason: 'request_id_conflict',
  });
  expect(await send({ action: 'send', requestId: 'key', text: 'different' })).toMatchObject({
    delivery: 'rejected',
    reason: 'request_id_conflict',
  });
  for (const text of ['', ' ', 'x'.repeat(16_385)])
    expect(await send({ action: 'send', requestId: 'invalid', text })).toMatchObject({
      delivery: 'rejected',
      reason: 'invalid_input',
    });
  expect(await send({ action: 'send', requestId: 'bad key', text: 'valid' })).toMatchObject({
    delivery: 'rejected',
    reason: 'invalid_input',
  });
  expect(await send({ action: 'send', requestId: 'limit', text: 'x'.repeat(16_384) })).toMatchObject({
    delivery: 'queued',
  });
  await f.bridge().tick();
  f.human('!bridge pause');
  await f.bridge().tick();
  expect(await send({ action: 'send', requestId: 'paused', text: 'not sent' })).toMatchObject({
    delivery: 'rejected',
    reason: 'paused',
  });
  expect(await send({ action: 'send', requestId: 'key', text: 'hello' })).not.toMatchObject({ delivery: 'rejected' });
  expect(
    await sendDiscord(
      f.root,
      { ...f.sessions.coord!.socket.binding, sessionId: 'new-id' },
      { action: 'send', requestId: 'new', text: 'no' },
    ),
  ).toMatchObject({ delivery: 'unavailable' });
  const ad = JSON.parse(fs.readFileSync(f.sessions.coord!.socket.advertisementPath, 'utf8'));
  fs.writeFileSync(f.sessions.coord!.socket.advertisementPath, JSON.stringify({ ...ad, sessionId: 'replacement' }), {
    mode: 0o600,
  });
  expect(await send({ action: 'send', requestId: 'changed', text: 'no' })).toMatchObject({
    delivery: 'rejected',
    reason: 'identity_changed',
  });
  expect(await send({ action: 'status', requestId: 'key' })).not.toMatchObject({ delivery: 'rejected' });
});

it('retains proactive dedup and ambiguous POST evidence across restart without duplicate POST', async () => {
  const f = await fixture();
  await f.bridge().tick();
  await f.bridge().listenOutbound();
  const binding = f.sessions.coord!.socket.binding;
  const send = (input: DiscordSendInput) => sendDiscord(f.root, binding, input);
  await send({ action: 'send', requestId: 'crash', text: 'ambiguous notification' });
  f.dropPost();
  await f.bridge().tick();
  expect(await send({ action: 'status', requestId: 'crash' })).toMatchObject({ delivery: 'uncertain' });
  f.bridge().close();
  const restarted = f.makeBridge();
  restarted.open();
  await restarted.listenOutbound();
  expect(await send({ action: 'send', requestId: 'crash', text: 'ambiguous notification' })).toMatchObject({
    delivery: 'uncertain',
  });
  for (let i = 0; i < 3; i++) await restarted.tick();
  expect(f.posted.filter((p) => p.content.includes('ambiguous notification'))).toHaveLength(1);
  const journal = f.journal();
  journal.outbox.find((p: any) => p.content.includes('ambiguous notification')).state = 'sending';
  restarted.close();
  fs.writeFileSync(path.join(f.config.stateDir, 'journal.json'), JSON.stringify(journal), { mode: 0o600 });
  const crashRecovery = f.makeBridge();
  crashRecovery.open();
  await crashRecovery.listenOutbound();
  expect(await send({ action: 'status', requestId: 'crash' })).toMatchObject({ delivery: 'uncertain' });
  await crashRecovery.tick();
  expect(f.posted.filter((p) => p.content.includes('ambiguous notification'))).toHaveLength(1);
});

it('bounds pending proactive admission at the existing 128-work scale, not 512 lifetime sends', async () => {
  const f = await fixture();
  await f.bridge().listenOutbound();
  const binding = f.sessions.coord!.socket.binding;
  for (let i = 0; i < 128; i++)
    expect(await sendDiscord(f.root, binding, { action: 'send', requestId: `n_${i}`, text: 'queued' })).toMatchObject({
      delivery: 'queued',
    });
  expect(await sendDiscord(f.root, binding, { action: 'send', requestId: 'overflow', text: 'no' })).toMatchObject({
    delivery: 'rejected',
    reason: 'capacity',
  });
  expect(f.journal().proactive).toHaveLength(128);
  expect(await sendDiscord(f.root, binding, { action: 'send', requestId: 'n_0', text: 'queued' })).toMatchObject({
    delivery: 'queued',
  });
});

it('requires a root dependency and suppresses read-only/plan sending before the socket boundary', async () => {
  const f = await fixture();
  await f.bridge().listenOutbound();
  const settings = createMockSettingsService({ 'app.activeProfileId': 'builtin:bare' });
  const discordSend = (input: DiscordSendInput) => sendDiscord(f.root, f.sessions.coord!.socket.binding, input);
  const tools = (extra: Record<string, unknown> = {}) =>
    getAgentDefinition({ settingsService: settings, loggingService: logger, ...extra }, 'fixture').tools!;
  expect(tools().some((t) => t.name === 'discord_send')).toBe(false);
  expect(tools({ discordSend }).some((t) => t.name === 'discord_send')).toBe(true);
  expect(tools({ discordSend, readOnly: true }).some((t) => t.name === 'discord_send')).toBe(false);
  settings.set('app.activeProfileId', 'builtin:plan');
  expect(tools({ discordSend }).some((t) => t.name === 'discord_send')).toBe(false);
  const tool = createDiscordSendToolDefinition(discordSend);
  const result = await tool.execute({ action: 'send', requestId: 'root', text: 'root only' });
  expect(result).toMatchObject({ delivery: 'queued' });
  expect(tool.scriptedReturnSchema!.safeParse(result).success).toBe(true);
  // The ordinary result boundary owns text presentation; the executor returns data.
  const messages = await tool.formatCommandMessage(
    { type: 'function_call_result', output: JSON.stringify(result) },
    0,
    new Map(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.output).toBe(JSON.stringify(result));
  expect(f.journal().proactive).toHaveLength(1);
  expect(tool.parameters.safeParse({ action: 'send', requestId: 'x', text: 'hello', channelId: 'evil' }).success).toBe(
    false,
  );
});

it('returns unknown after lost admission acknowledgement and reconciles the same key without another POST', async () => {
  const f = await fixture();
  await f.bridge().listenOutbound();
  const { createServer: createProxy, connect } = await import('node:net');
  const directory = path.join(f.root, 'term2-discord');
  const file = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith('.json'))!);
  const ad = JSON.parse(fs.readFileSync(file, 'utf8'));
  const upstreamPath = ad.socketPath + '.upstream';
  fs.renameSync(ad.socketPath, upstreamPath);
  const proxy = createProxy((client) => {
    const upstream = connect(upstreamPath);
    client.on('error', noop);
    upstream.on('error', () => client.destroy());
    client.pipe(upstream);
    upstream.on('data', (chunk) => {
      if (chunk.toString().includes('"id":"call"')) {
        client.destroy();
        upstream.destroy();
      } else client.write(chunk);
    });
    client.on('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(ad.socketPath, resolve));
  fs.chmodSync(ad.socketPath, 0o600);
  cleanup.push(() => {
    proxy.close();
  });
  const binding = f.sessions.coord!.socket.binding;
  expect(
    await sendDiscord(f.root, binding, { action: 'send', requestId: 'lost_ack', text: 'one notification' }),
  ).toMatchObject({ delivery: 'unknown' });
  expect(f.journal().proactive).toHaveLength(1);
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  fs.renameSync(upstreamPath, ad.socketPath);
  expect(await sendDiscord(f.root, binding, { action: 'status', requestId: 'lost_ack' })).toMatchObject({
    delivery: 'queued',
  });
  expect(
    await sendDiscord(f.root, binding, { action: 'send', requestId: 'lost_ack', text: 'one notification' }),
  ).toMatchObject({ delivery: 'queued' });
  await f.cycle(3);
  expect(f.posted.filter((p) => p.content.includes('one notification'))).toHaveLength(1);
});

it('refuses ambiguous discovery, unsafe runtime permissions and unknown RPC parameters', async () => {
  const f = await fixture();
  await f.bridge().listenOutbound();
  const directory = path.join(f.root, 'term2-discord');
  const file = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith('.json'))!);
  const ad = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(
    await callDiscordControl(ad.socketPath, 'discord_send', {
      binding: f.sessions.coord!.socket.binding,
      requestId: 'spoof',
      text: 'no',
      senderAlias: 'worker',
    }),
  ).toMatchObject({ delivery: 'rejected', reason: 'invalid_input' });
  const second = new DiscordBridge({ ...f.config, stateDir: path.join(f.root, 'second') }, 'SYNTHETIC_TOKEN', {
    runtimeDir: f.root,
  });
  second.open();
  await second.listenOutbound();
  cleanup.push(() => second.close());
  expect(
    await sendDiscord(f.root, f.sessions.coord!.socket.binding, { action: 'send', requestId: 'ambiguous', text: 'no' }),
  ).toMatchObject({ delivery: 'unavailable', reason: 'ambiguous' });
  second.close();
  fs.chmodSync(directory, 0o755);
  expect(
    await sendDiscord(f.root, f.sessions.coord!.socket.binding, { action: 'send', requestId: 'unsafe', text: 'no' }),
  ).toMatchObject({ delivery: 'unavailable' });
  fs.chmodSync(directory, 0o700);
  expect(f.journal().proactive).toHaveLength(0);
});

it('retains sent idempotency evidence beyond 512 lifetime notifications and restart', async () => {
  const f = await fixture();
  await f.bridge().tick();
  await f.bridge().listenOutbound();
  const binding = f.sessions.coord!.socket.binding;
  for (let i = 0; i < 514; i++) {
    expect(
      await sendDiscord(f.root, binding, { action: 'send', requestId: `settled_${i}`, text: `notice ${i}` }),
    ).toMatchObject({ delivery: 'queued' });
    await f.bridge().tick();
  }
  expect(f.journal().proactive).toHaveLength(514);
  expect(f.journal().outbox.filter((output: any) => output.content.startsWith('[coord] notice'))).toHaveLength(514);
  f.restart();
  await f.bridge().listenOutbound();
  expect(
    await sendDiscord(f.root, binding, { action: 'send', requestId: 'settled_0', text: 'notice 0' }),
  ).toMatchObject({ delivery: 'sent' });
  expect(f.posted.filter((p) => p.content === '[coord] notice 0')).toHaveLength(1);
}, 60_000);

it('quarantines a proactive POST interrupted by actual bridge process death and reaps its stale endpoint', async () => {
  const f = await fixture();
  await f.bridge().tick();
  f.bridge().close();
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { DiscordBridge } from './source/services/discord/discord-bridge.ts';
    const bridge=new DiscordBridge(${JSON.stringify(f.config)},'SYNTHETIC_CHILD_TOKEN',${JSON.stringify({
        runtimeDir: f.root,
        apiBase: f.apiBase,
      })});
    bridge.open(); await bridge.listenOutbound(); process.stdout.write('READY');
    process.stdin.once('data',async()=>{await bridge.tick();process.stdout.write('DONE')});
  `,
    ],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  cleanup.push(() => {
    child.kill('SIGKILL');
  });
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk.toString();
  });
  expect(String((await once(child.stdout, 'data'))[0]), errors).toContain('READY');
  const binding = f.sessions.coord!.socket.binding;
  expect(
    await sendDiscord(f.root, binding, { action: 'send', requestId: 'killed', text: 'crash notification' }),
  ).toMatchObject({ delivery: 'queued' });
  f.holdPost();
  child.stdin.write('tick');
  await expect.poll(() => f.posted.filter((p) => p.content.includes('crash notification')).length).toBe(1);
  expect(f.journal().outbox.find((output: any) => output.content.includes('crash notification')).state).toBe('sending');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  f.releasePosts();
  f.restart();
  await f.bridge().listenOutbound();
  expect(await sendDiscord(f.root, binding, { action: 'status', requestId: 'killed' })).toMatchObject({
    delivery: 'uncertain',
  });
  await f.cycle(3);
  expect(f.posted.filter((p) => p.content.includes('crash notification'))).toHaveLength(1);
}, 30_000);

it('does not POST after an admission journal write failure and rejects incompatible index shapes', async () => {
  const f = await fixture();
  await f.bridge().listenOutbound();
  const temporary = path.join(f.config.stateDir, `journal.json.${process.pid}.tmp`);
  fs.mkdirSync(temporary, { mode: 0o700 });
  expect(
    await sendDiscord(f.root, f.sessions.coord!.socket.binding, {
      action: 'send',
      requestId: 'write_failure',
      text: 'must not post',
    }),
  ).toMatchObject({ delivery: 'unknown' });
  expect(f.journal().proactive).toHaveLength(0);
  await expect(f.bridge().tick()).rejects.toThrow('not open or already ticking');
  expect(f.posted).toHaveLength(0);
  fs.rmdirSync(temporary);
  f.restart();
  await f.bridge().listenOutbound();
  expect(
    await sendDiscord(f.root, f.sessions.coord!.socket.binding, { action: 'status', requestId: 'write_failure' }),
  ).toMatchObject({ delivery: 'missing' });
  const journal = f.journal();
  f.bridge().close();
  journal.proactive = { version: 2 };
  fs.writeFileSync(path.join(f.config.stateDir, 'journal.json'), JSON.stringify(journal), { mode: 0o600 });
  expect(() => f.restart()).toThrow('journal/config mismatch');
});

it('admits exactly at the retained-journal byte budget and refuses additional work without losing reconciliation', async () => {
  const f = await fixture();
  await f.bridge().listenOutbound();
  const binding = f.sessions.coord!.socket.binding;
  const send = (requestId: string) => sendDiscord(f.root, binding, { action: 'send', requestId, text: 'x' });
  await send('a');
  const journal = f.journal();
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const prospective = structuredClone(journal);
  prospective.proactive.push({ ...prospective.proactive[0], requestId: 'b' });
  prospective.outbox.push({ ...prospective.outbox[0] });
  const growth = bytes(prospective) - bytes(journal);
  const budget = 16 * 1024 * 1024;
  while (bytes(journal) < budget - growth - 33_000)
    journal.jobs.push({
      id: `padding_${journal.jobs.length}`,
      alias: 'coord',
      text: 'x'.repeat(32_000),
      origin: { kind: 'human', sender: '100' },
      hops: 0,
      state: 'done',
    });
  journal.jobs.push({
    id: 'padding_tail',
    alias: 'coord',
    text: '',
    origin: { kind: 'human', sender: '100' },
    hops: 0,
    state: 'done',
  });
  journal.jobs.at(-1).text = 'x'.repeat(budget - growth - bytes(journal));
  expect(bytes(journal)).toBe(budget - growth);
  f.bridge().close();
  fs.writeFileSync(path.join(f.config.stateDir, 'journal.json'), JSON.stringify(journal), { mode: 0o600 });
  f.restart();
  await f.bridge().listenOutbound();
  expect(await send('b')).toMatchObject({ delivery: 'queued' });
  expect(bytes(f.journal())).toBe(budget);
  expect(await send('c')).toMatchObject({
    delivery: 'rejected',
    reason: 'capacity',
    capacity: { kind: 'journal_bytes', limit: budget },
  });
  expect(f.journal().proactive).toHaveLength(2);
  expect(await send('a')).toMatchObject({ delivery: 'queued' });
}, 30_000);

it.each([{ profile: 'builtin:plan' }, { profile: 'builtin:bare', readOnly: true }])(
  'does not let a $profile readOnly=$readOnly agent dispatch discord_send through run_code',
  async (options) => {
    const f = await fixture({ proactive: true, ...options });
    await f.bridge().listenOutbound();
    await f.sessions.coord!.orchestrator.sendUserMessage('Attempt the explicit notification.');
    expect(f.received.coord).toHaveLength(2);
    expect(f.journal().proactive).toHaveLength(0);
    expect(f.posted).toHaveLength(0);
  },
);
