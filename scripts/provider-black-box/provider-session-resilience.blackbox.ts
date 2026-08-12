import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createIsolatedWorkspaceLease,
  type IsolatedWorkspaceLease,
  type IsolatedWorkspacePaths,
  type PtyChildDriver,
} from './provider-test-harness.js';

/**
 * Executed capabilities owned by this file. Gate C should combine this typed
 * ledger with the ledgers exported by the other provider-session workers.
 */
export { RESILIENCE_CAPABILITY_EXECUTIONS as PROVIDER_SESSION_RESILIENCE_EXECUTED_SCENARIO_IDS } from './provider-session-capability-manifest.js';

type HttpWireFamily =
  | 'openai-responses'
  | 'codex-responses'
  | 'ai-sdk-chat'
  | 'chat-completions'
  | 'anthropic-messages'
  | 'google-generate-content';

type HttpScenario =
  | 'native-error'
  | 'early-close'
  | 'incomplete'
  | 'reasoning'
  | 'restart-completed'
  | 'interrupted-tool'
  | 'compaction-restart'
  | 'compaction-tool';

type CapturedHttpRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

type HttpResponseFrame = {
  event?: string;
  data: unknown;
};

interface ResilienceHttpServer {
  readonly baseUrl: string;
  readonly family: HttpWireFamily;
  readonly scenario: HttpScenario;
  readonly requests: CapturedHttpRequest[];
  readonly responseFrames: HttpResponseFrame[][];
  waitForRequests(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

type WsScenario = 'native-error' | 'incomplete' | 'abnormal-close' | 'reasoning';

interface ResilienceWebSocketServer {
  readonly url: string;
  readonly requests: unknown[];
  readonly responseFrames: unknown[][];
  waitForRequests(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

type ProviderRoute = {
  rowId: string;
  provider: string;
  model: string;
  type?: 'openai-compatible' | 'anthropic' | 'google';
  baseUrlEnv?: 'OPENAI_BASE_URL' | 'CODEX_BASE_URL' | 'OPENROUTER_BASE_URL';
  baseUrlSuffix?: string;
  contextCompaction?: boolean;
  alternateProvider?: string;
};

const HTTP_ROUTES: readonly { family: HttpWireFamily; route: ProviderRoute }[] = [
  {
    family: 'openai-responses',
    route: {
      rowId: 'openai-http',
      provider: 'openai',
      model: 'fixture-openai',
      baseUrlEnv: 'OPENAI_BASE_URL',
      baseUrlSuffix: '/v1',
    },
  },
  {
    family: 'codex-responses',
    route: {
      rowId: 'codex-http',
      provider: 'codex',
      model: 'fixture-codex',
      baseUrlEnv: 'CODEX_BASE_URL',
      baseUrlSuffix: '/backend-api/codex',
    },
  },
  {
    family: 'ai-sdk-chat',
    route: {
      rowId: 'openrouter-http',
      provider: 'openrouter',
      model: 'fixture-openrouter',
      baseUrlEnv: 'OPENROUTER_BASE_URL',
    },
  },
  {
    family: 'chat-completions',
    route: {
      rowId: 'runtime-openai-compatible-chat',
      provider: 'fixture-chat-resilience',
      model: 'fixture-chat',
      type: 'openai-compatible',
    },
  },
  {
    family: 'anthropic-messages',
    route: {
      rowId: 'runtime-anthropic-messages',
      provider: 'fixture-anthropic-resilience',
      model: 'fixture-anthropic',
      type: 'anthropic',
    },
  },
  {
    family: 'google-generate-content',
    route: {
      rowId: 'runtime-google-generate-content',
      provider: 'fixture-google-resilience',
      model: 'fixture-google',
      type: 'google',
    },
  },
] as const;

const WS_ROUTES: readonly { family: 'openai-responses' | 'codex-responses'; route: ProviderRoute }[] = [
  {
    family: 'openai-responses',
    route: {
      rowId: 'openai-websocket',
      provider: 'openai',
      model: 'fixture-openai-ws',
      baseUrlEnv: 'OPENAI_BASE_URL',
      baseUrlSuffix: '/v1',
    },
  },
  {
    family: 'codex-responses',
    route: {
      rowId: 'codex-websocket',
      provider: 'codex',
      model: 'fixture-codex-ws',
      baseUrlEnv: 'CODEX_BASE_URL',
      baseUrlSuffix: '/backend-api/codex',
    },
  },
] as const;

const COMPACTION_ROUTE: ProviderRoute = {
  rowId: 'openai-compaction-http',
  provider: 'openai',
  model: 'gpt-5.6-luna',
  baseUrlEnv: 'OPENAI_BASE_URL',
  baseUrlSuffix: '/v1',
  contextCompaction: true,
  alternateProvider: 'fixture-other-provider',
};

const DEFAULT_TIMEOUT_MS = 7_500;
const TERMINAL_KEY_EVENT_YIELD_MS = 50;
const PROMPT = 'fixture resilience prompt';
const ANSWER = 'fixture resilience answer';
const REASONING = 'fixture response-side reasoning';
const TOOL_CALL_ID = 'call_fixture_restart';
const COMPACTION_ITEM_ID = 'cmp_fixture_context';
const COMPACTION_CIPHERTEXT = 'fixture-compaction-encrypted-content';
const COMPACTION_TOOL_CALL_ID = 'call_fixture_compaction_tool';

let activeHttpServers: ResilienceHttpServer[] = [];
let activeWsServers: ResilienceWebSocketServer[] = [];
let activeWorkspaces: IsolatedWorkspaceLease[] = [];
let activeChildren: PtyChildDriver[] = [];

afterEach(async () => {
  const children = activeChildren.splice(0);
  for (const child of children) await child.cleanup().catch(() => undefined);
  const workspaces = activeWorkspaces.splice(0);
  for (const workspace of workspaces) await workspace.cleanup().catch(() => undefined);
  const wsServers = activeWsServers.splice(0);
  for (const server of wsServers) await server.close().catch(() => undefined);
  const httpServers = activeHttpServers.splice(0);
  for (const server of httpServers) await server.close().catch(() => undefined);
});

describe('application-owned provider HTTP resilience', () => {
  for (const { family, route } of HTTP_ROUTES) {
    for (const scenario of ['native-error', 'early-close', 'incomplete'] as const) {
      it(`${route.rowId}.${scenario} does not become empty success`, async () => {
        const server = await startResilienceHttpServer({ family, scenario });
        activeHttpServers.push(server);
        const result = await runOneShot(route, server, scenario);

        expect(result.timedOut, `${route.rowId}.${scenario}: ${result.stderr}`).toBe(false);
        expect(
          result.exitCode,
          `${route.rowId}.${scenario}: ${JSON.stringify({ stdout: result.stdout, stderr: result.stderr })}`,
        ).not.toBe(0);
        expect(result.stdout).not.toContain(ANSWER);
        expect(server.requests.length, `${route.rowId}.${scenario}: no provider request captured`).toBeGreaterThan(0);
        expect(server.responseFrames.length).toBe(server.requests.length);
      });
    }
  }
});

describe('application-owned provider response-side reasoning', () => {
  for (const { family, route } of HTTP_ROUTES) {
    it(`${route.rowId}.reasoning preserves response-side reasoning and final output`, async () => {
      const server = await startResilienceHttpServer({ family, scenario: 'reasoning' });
      activeHttpServers.push(server);
      const result = await runOneShot(route, server, 'reasoning', { reasoning: true });

      expect(result.timedOut, `${route.rowId}: ${result.stderr}`).toBe(false);
      expect(result.exitCode, `${route.rowId}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(ANSWER);
      expect(server.requests).toHaveLength(1);
      expect(server.responseFrames[0]).toContainEqual(expect.objectContaining({ data: expect.anything() }));
      expect(flattenResponseFrames(server.responseFrames[0] ?? [])).toContain(REASONING);
      const traffic = await readProviderTraffic(result.workspace.root);
      expect(traffic.length, `${route.rowId}: no application-owned response traffic was persisted`).toBeGreaterThan(0);
      expect(result.stdout, `${route.rowId}: final output was not observable`).toContain(ANSWER);
    });
  }
});

describe('application-owned provider WebSocket resilience', () => {
  for (const { family, route } of WS_ROUTES) {
    for (const scenario of ['native-error', 'incomplete', 'abnormal-close'] as const) {
      it(`${route.rowId}.${scenario} fails without fabricated completion`, async () => {
        const server = await startResilienceWebSocketServer({ family, scenario });
        activeWsServers.push(server);
        const result = await runOneShot(route, server, scenario);

        expect(result.timedOut, `${route.rowId}.${scenario}: ${result.stderr}`).toBe(false);
        expect(result.exitCode, `${route.rowId}.${scenario}: ${result.stderr}`).not.toBe(0);
        expect(result.stdout).not.toContain(ANSWER);
        expect(server.requests.length, `${route.rowId}.${scenario}: no websocket request captured`).toBeGreaterThan(0);
        expect(server.responseFrames.length).toBe(server.requests.length);
      });
    }
  }
});

describe('application-owned WebSocket response-side reasoning', () => {
  for (const { route } of WS_ROUTES) {
    it(`${route.rowId}.reasoning preserves response-side reasoning and final output`, async () => {
      const server = await startResilienceWebSocketServer({
        family: route.provider === 'codex' ? 'codex-responses' : 'openai-responses',
        scenario: 'reasoning',
      });
      activeWsServers.push(server);
      const result = await runOneShot(route, server, 'reasoning', { reasoning: true });

      expect(result.timedOut, `${route.rowId}: ${result.stderr}`).toBe(false);
      expect(result.exitCode, `${route.rowId}: ${result.stderr}`).toBe(0);
      expect(result.stdout, `${route.rowId}: final output was not observable`).toContain(ANSWER);
      expect(server.requests.length).toBeGreaterThan(0);
      expect(server.requests.every(isResponseCreate)).toBe(true);
      expect(server.responseFrames.some((frames) => flattenStrings(frames).includes(REASONING))).toBe(true);
      const traffic = await readProviderTraffic(result.workspace.root);
      expect(traffic.length, `${route.rowId}: no application-owned response traffic was persisted`).toBeGreaterThan(0);
    });
  }
});

describe('application-owned provider restart continuity', () => {
  it('resumes a completed conversation from full history, then establishes fresh chaining', async () => {
    const server = await startResilienceHttpServer({ family: 'openai-responses', scenario: 'restart-completed' });
    activeHttpServers.push(server);
    const route = HTTP_ROUTES[0]!.route;
    const workspace = await createWorkspace(route, server);
    activeWorkspaces.push(workspace);

    const first = await startInteractive(workspace, route);
    await first.waitForVisibleOutput('❯ ');
    const firstIdlePrompt = captureIdlePrompt(first);
    await submitPrompt(first, 'first persisted prompt');
    await first.waitForVisibleOutput('restart-answer-1');
    await waitForNextIdlePrompt(first, firstIdlePrompt);
    const conversationId = await waitForConversationId(workspace);
    await first.write('\u0003');
    await first.waitForExit(DEFAULT_TIMEOUT_MS);

    const resumed = await startInteractive(workspace, route, ['--resume']);
    await resumed.waitForVisibleOutput(`Resumed conversation: ${conversationId}`);
    await resumed.waitForVisibleOutput('❯ ');
    const resumedIdlePrompt = captureIdlePrompt(resumed);
    await submitPrompt(resumed, 'resumed full-history prompt');
    await resumed.waitForVisibleOutput('restart-answer-2');
    await waitForNextIdlePrompt(resumed, resumedIdlePrompt);
    await resumed.waitForVisibleOutput('❯ ');
    const chainedIdlePrompt = captureIdlePrompt(resumed);
    await submitPrompt(resumed, 'fresh chained prompt');
    await resumed.waitForVisibleOutput('restart-answer-3');
    await waitForNextIdlePrompt(resumed, chainedIdlePrompt);
    await resumed.write('\u0003');
    await resumed.waitForExit(DEFAULT_TIMEOUT_MS);

    expect(server.requests).toHaveLength(3);
    const firstBody = asRecord(server.requests[0]?.body);
    const resumedBody = asRecord(server.requests[1]?.body);
    const chainedBody = asRecord(server.requests[2]?.body);
    expect(firstBody?.previous_response_id).toBeUndefined();
    expect(resumedBody?.previous_response_id).toBeUndefined();
    const resumedMessages = inputItems(resumedBody?.input).filter((item) => item.type === 'message');
    expect(resumedMessages.map((item) => item.role)).toEqual(['user', 'assistant', 'user']);
    expect(inputText(resumedBody?.input)).toEqual(
      expect.arrayContaining(['first persisted prompt', 'restart-answer-1', 'resumed full-history prompt']),
    );
    expect(chainedBody?.previous_response_id).toBe('resp_restart_2');
    expect(inputText(chainedBody?.input)).toContain('fresh chained prompt');
    expect(inputText(chainedBody?.input)).not.toContain('first persisted prompt');
  });

  it('repairs an interrupted tool-bearing conversation without an orphan or stale response id', async () => {
    const server = await startResilienceHttpServer({ family: 'openai-responses', scenario: 'interrupted-tool' });
    activeHttpServers.push(server);
    const route = HTTP_ROUTES[0]!.route;
    const workspace = await createWorkspace(route, server);
    activeWorkspaces.push(workspace);

    const first = await startInteractive(workspace, route);
    await first.waitForVisibleOutput('❯ ');
    await submitPrompt(first, 'interrupt while tool approval is pending');
    await first.waitForVisibleOutput('Allow this action?');
    const conversationId = await waitForConversationId(workspace);
    await first.terminate({ signal: 'SIGKILL', timeoutMs: DEFAULT_TIMEOUT_MS });

    const persisted = await readConversation(workspace.paths, conversationId);
    expect(persisted).toContain(TOOL_CALL_ID);
    expect(persisted).not.toContain('resp_stale_interrupted');

    // SIGKILL intentionally leaves the application-owned lock behind; use the
    // documented fork escape hatch to resume the recovered state safely.
    const resumed = await startInteractive(workspace, route, ['--resume', conversationId, '--fork']);
    await resumed.waitForVisibleOutput(`Forked conversation ${conversationId} → `);
    await resumed.waitForVisibleOutput('Resumed conversation: ');
    await resumed.waitForVisibleOutput('❯ ');
    const resumedIdlePrompt = captureIdlePrompt(resumed);
    await submitPrompt(resumed, 'repair interrupted tool history');
    await resumed.waitForVisibleOutput('restart-repaired-answer');
    await waitForNextIdlePrompt(resumed, resumedIdlePrompt);
    await resumed.write('\u0003');
    await resumed.waitForExit(DEFAULT_TIMEOUT_MS);

    expect(server.requests).toHaveLength(2);
    const resumedBody = asRecord(server.requests[1]?.body);
    expect(resumedBody?.previous_response_id).toBeUndefined();
    const resumedInput = inputItems(resumedBody?.input);
    expect(resumedInput.some((item) => item.type === 'function_call' && callIdOf(item) === TOOL_CALL_ID)).toBe(false);
    expect(resumedInput.some((item) => item.type === 'function_call_output' && callIdOf(item) === TOOL_CALL_ID)).toBe(
      false,
    );
    expect(inputText(resumedBody?.input)).toContain('interrupt while tool approval is pending');
    expect(inputText(resumedBody?.input)).not.toContain('resp_stale_interrupted');
    expect(inputText(resumedBody?.input)).toContain('repair interrupted tool history');
  });
});

describe('application-owned context compaction black-box lifecycle', () => {
  it('persists a compaction item and sends it after save/resume', async () => {
    const server = await startResilienceHttpServer({ family: 'openai-responses', scenario: 'compaction-restart' });
    activeHttpServers.push(server);
    const workspace = await createWorkspace(COMPACTION_ROUTE, server);
    activeWorkspaces.push(workspace);

    const first = await startInteractive(workspace, COMPACTION_ROUTE);
    await first.waitForVisibleOutput('❯ ');
    const firstIdlePrompt = captureIdlePrompt(first);
    await submitPrompt(first, 'persist this compacted turn');
    await first.waitForVisibleOutput('COMPACTION-FIRST');
    await waitForNextIdlePrompt(first, firstIdlePrompt);
    const conversationId = await waitForConversationId(workspace);
    const persisted = await waitForConversationContent(workspace.paths, conversationId, COMPACTION_CIPHERTEXT);
    expect(persisted).toContain('provider_opaque');
    expect(persisted).toContain(COMPACTION_CIPHERTEXT);
    await first.write('\u0003');
    await first.waitForExit(DEFAULT_TIMEOUT_MS);

    const resumed = await startInteractive(workspace, COMPACTION_ROUTE, ['--resume', conversationId]);
    await resumed.waitForVisibleOutput(`Resumed conversation: ${conversationId}`);
    await resumed.waitForVisibleOutput('❯ ');
    const resumedIdlePrompt = captureIdlePrompt(resumed);
    await submitPrompt(resumed, 'continue after saved compaction');
    await resumed.waitForVisibleOutput('COMPACTION-RESUMED');
    await waitForNextIdlePrompt(resumed, resumedIdlePrompt);
    await resumed.write('\u0003');
    await resumed.waitForExit(DEFAULT_TIMEOUT_MS);

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.body.context_management).toEqual([{ type: 'compaction', compact_threshold: 217_600 }]);
    const resumedBody = asRecord(server.requests[1]?.body);
    expect(resumedBody?.previous_response_id).toBeUndefined();
    const compactions = inputItems(resumedBody?.input).filter((item) => item.type === 'compaction');
    expect(compactions).toHaveLength(1);
    expect(compactions[0]).toMatchObject({
      id: COMPACTION_ITEM_ID,
      encrypted_content: COMPACTION_CIPHERTEXT,
    });
  });

  it('rejects an OpenAI compaction item safely after switching providers', async () => {
    const server = await startResilienceHttpServer({ family: 'openai-responses', scenario: 'compaction-restart' });
    activeHttpServers.push(server);
    const workspace = await createWorkspace(COMPACTION_ROUTE, server);
    activeWorkspaces.push(workspace);

    const first = await startInteractive(workspace, COMPACTION_ROUTE);
    await first.waitForVisibleOutput('❯ ');
    const firstIdlePrompt = captureIdlePrompt(first);
    await submitPrompt(first, 'create an OpenAI compaction item');
    await first.waitForVisibleOutput('COMPACTION-FIRST');
    await waitForNextIdlePrompt(first, firstIdlePrompt);
    const conversationId = await waitForConversationId(workspace);
    await waitForConversationContent(workspace.paths, conversationId, COMPACTION_CIPHERTEXT);
    await first.write('\u0003');
    await first.waitForExit(DEFAULT_TIMEOUT_MS);

    const switched = await startInteractive(
      workspace,
      {
        ...COMPACTION_ROUTE,
        provider: COMPACTION_ROUTE.alternateProvider!,
      },
      ['--resume', conversationId],
    );
    try {
      await switched.waitForVisibleOutput(`Resumed conversation: ${conversationId}`);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} output=${switched.getVisibleOutput()}`,
      );
    }
    await switched.waitForVisibleOutput('❯ ');
    await submitPrompt(switched, 'try the switched provider');
    try {
      await switched.waitForState(
        (snapshot) => /provider_opaque|opaque item/i.test(snapshot.visibleOutput),
        DEFAULT_TIMEOUT_MS,
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} output=${switched.getVisibleOutput()}`,
      );
    }

    expect(server.requests).toHaveLength(1);
    expect(switched.getVisibleOutput()).not.toContain('COMPACTION-RESUMED');
    await switched.write('\u0003');
    await switched.waitForExit(DEFAULT_TIMEOUT_MS);
  });

  it('does not re-execute a tool after its turn is replaced by compaction', async () => {
    const server = await startResilienceHttpServer({ family: 'openai-responses', scenario: 'compaction-tool' });
    activeHttpServers.push(server);
    const workspace = await createWorkspace(COMPACTION_ROUTE, server);
    activeWorkspaces.push(workspace);

    const first = await startInteractive(workspace, COMPACTION_ROUTE);
    await first.waitForVisibleOutput('❯ ');
    const firstIdlePrompt = captureIdlePrompt(first);
    await submitPrompt(first, 'run the side effect once');
    await first.waitForVisibleOutput('Allow this action?');
    await submitPrompt(first, 'y');
    await server.waitForRequests(2);
    await first.waitForVisibleOutput('COMPACTION-TOOL-FINAL');
    await waitForNextIdlePrompt(first, firstIdlePrompt);
    const conversationId = await waitForConversationId(workspace);
    await submitPrompt(first, '/quit');
    await first.waitForExit(DEFAULT_TIMEOUT_MS);

    const resumed = await startInteractive(workspace, COMPACTION_ROUTE, ['--resume', conversationId]);
    try {
      await resumed.waitForVisibleOutput(`Resumed conversation: ${conversationId}`);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} output=${resumed.getVisibleOutput()}`);
    }
    await resumed.waitForVisibleOutput('❯ ');
    const resumedIdlePrompt = captureIdlePrompt(resumed);
    await submitPrompt(resumed, 'continue without repeating the tool');
    await resumed.waitForVisibleOutput('COMPACTION-TOOL-RESUMED');
    await waitForNextIdlePrompt(resumed, resumedIdlePrompt);
    await resumed.terminate();

    expect(server.requests).toHaveLength(3);
    const toolResultRequests = server.requests.filter((request) => {
      const input = inputItems(asRecord(request.body)?.input);
      return input.some((item) => item.type === 'function_call_output' || item.type === 'function_call_result');
    });
    expect(
      toolResultRequests,
      JSON.stringify(
        server.requests.map((request) => inputItems(asRecord(request.body)?.input).map((item) => item.type)),
      ),
    ).toHaveLength(1);
    const resumedInput = inputItems(asRecord(server.requests[2]?.body)?.input);
    expect(resumedInput.filter((item) => item.type === 'compaction')).toHaveLength(1);
    expect(resumedInput.some((item) => item.type === 'function_call')).toBe(false);
    expect(
      resumedInput.some((item) => item.type === 'function_call_output' || item.type === 'function_call_result'),
    ).toBe(false);
    expect(resumedInput.some((item) => item.type === 'message' && item.role === 'user')).toBe(true);
  });
});

async function runOneShot(
  route: ProviderRoute,
  server: ResilienceHttpServer | ResilienceWebSocketServer,
  scenario: string,
  options: { reasoning?: boolean } = {},
) {
  const workspace = await createWorkspace(route, server);
  activeWorkspaces.push(workspace);
  const env = route.baseUrlEnv ? { [route.baseUrlEnv]: `${serverUrl(server)}${route.baseUrlSuffix ?? ''}` } : undefined;
  const result = await workspace.runCli({
    cwd: process.cwd(),
    args: [
      PROMPT,
      '--provider',
      route.provider,
      '--model',
      route.model,
      ...(options.reasoning ? ['--reasoning', 'medium'] : []),
    ],
    env,
    deadlineMs: scenario === 'early-close' ? 4_000 : 6_000,
  });
  return { ...result, workspace };
}

async function createWorkspace(route: ProviderRoute, server: ResilienceHttpServer | ResilienceWebSocketServer) {
  const workspace = await createIsolatedWorkspaceLease({
    prefix: `term2-resilience-${route.rowId}-`,
    env: route.baseUrlEnv ? { [route.baseUrlEnv]: `${serverUrl(server)}${route.baseUrlSuffix ?? ''}` } : undefined,
    prepare: async (_root, paths) => {
      await writeSettings(paths.logDir, route, server);
      if (route.provider === 'codex') await writeFixtureCodexAuth(paths);
    },
  });
  return workspace;
}

async function writeSettings(
  settingsDir: string,
  route: ProviderRoute,
  server: ResilienceHttpServer | ResilienceWebSocketServer,
): Promise<void> {
  await mkdir(settingsDir, { recursive: true });
  const settings: Record<string, unknown> = {
    agent: {
      model: route.model,
      provider: route.provider,
      transport: 'url' in server ? 'websocket' : 'http',
      retryAttempts: 0,
      maxTurns: 4,
      reasoningEffort: 'medium',
      openai: { apiKey: 'fixture-key' },
      codex: { websocketFirstFrameTimeoutMs: 1_000, websocketInterFrameTimeoutMs: 1_000 },
      ...(route.contextCompaction ? { contextCompaction: { enabled: true, compactThreshold: 0.8 } } : {}),
    },
    app: { liteMode: true },
  };
  if (route.type) {
    settings.providers = [
      {
        id: route.provider,
        name: route.provider,
        type: route.type,
        baseUrl: serverUrl(server),
        apiKey: 'fixture-key',
      },
    ];
  }
  if (route.alternateProvider) {
    settings.providers = [
      ...(Array.isArray(settings.providers) ? settings.providers : []),
      {
        id: route.alternateProvider,
        name: route.alternateProvider,
        type: 'anthropic',
        baseUrl: serverUrl(server),
        apiKey: 'fixture-key',
      },
    ];
  }
  if (route.provider === 'openrouter') {
    settings.agent = {
      ...(settings.agent as Record<string, unknown>),
      openrouter: {
        baseUrl: serverUrl(server),
        apiKey: 'fixture-key',
        referrer: 'http://127.0.0.1',
        title: 'term2 fixture',
      },
    };
  }
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify(settings), 'utf8');
}

async function writeFixtureCodexAuth(paths: IsolatedWorkspacePaths): Promise<void> {
  await mkdir(paths.codexHome, { recursive: true });
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3_600 })).toString('base64url');
  await writeFile(
    join(paths.codexHome, 'auth.json'),
    JSON.stringify({ tokens: { access_token: `${header}.${payload}.fixture`, account_id: 'fixture-account' } }),
    'utf8',
  );
}

async function startInteractive(
  workspace: IsolatedWorkspaceLease,
  route: ProviderRoute,
  extraArgs: readonly string[] = [],
): Promise<PtyChildDriver> {
  expect(workspace.env.TERM2_CONVERSATIONS_DIR).toBe(workspace.paths.conversationsDir);
  const child = await workspace.start({
    args: ['--lite', '--provider', route.provider, '--model', route.model, ...extraArgs],
    env: { TERM2_CONVERSATIONS_DIR: workspace.paths.conversationsDir },
  });
  activeChildren.push(child);
  return child;
}

async function submitPrompt(child: PtyChildDriver, prompt: string): Promise<void> {
  await child.write(prompt);
  // Keep terminal text and Enter as distinct key events; this bounded yield
  // only prevents PTY input coalescing and does not wait for provider state.
  await delay(TERMINAL_KEY_EVENT_YIELD_MS);
  await child.write('\r');
}

function countIdlePrompts(output: string): number {
  return output.split('❯ ').length - 1;
}

type IdlePromptMarker = { outputLength: number; promptCount: number };

function captureIdlePrompt(child: PtyChildDriver): IdlePromptMarker {
  const output = child.getVisibleOutput();
  return { outputLength: output.length, promptCount: countIdlePrompts(output) };
}

async function waitForNextIdlePrompt(child: PtyChildDriver, previous: IdlePromptMarker): Promise<void> {
  await child.waitForState(
    (snapshot) =>
      snapshot.visibleOutput.length > previous.outputLength &&
      countIdlePrompts(snapshot.visibleOutput) > previous.promptCount,
  );
}

async function waitForConversationId(
  workspace: IsolatedWorkspaceLease,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const files = (await readdir(workspace.paths.conversationsDir).catch(() => [])).filter((file) =>
      file.endsWith('.jsonl'),
    );
    if (files.length > 0) return files[0]!.slice(0, -'.jsonl'.length);
    await delay(25);
  }
  const artifacts = await collectConversationArtifacts(workspace.root);
  throw new Error(
    `Timed out waiting for a persisted conversation in ${workspace.paths.conversationsDir}; ` +
      `TERM2_CONVERSATIONS_DIR=${workspace.env.TERM2_CONVERSATIONS_DIR}; ` +
      `artifacts=${JSON.stringify(artifacts)}`,
  );
}

async function readConversation(paths: IsolatedWorkspacePaths, id: string): Promise<string> {
  return readFile(join(paths.conversationsDir, `${id}.jsonl`), 'utf8');
}

async function waitForConversationContent(
  paths: IsolatedWorkspacePaths,
  id: string,
  needle: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const startedAt = Date.now();
  let content = '';
  while (Date.now() - startedAt < timeoutMs) {
    content = await readConversation(paths, id).catch(() => '');
    if (content.includes(needle)) return content;
    await delay(25);
  }
  throw new Error(`Timed out waiting for conversation ${id} to contain ${needle}; content=${content}`);
}

async function readProviderTraffic(root: string): Promise<unknown[]> {
  const logRoot = join(root, 'Library', 'Logs');
  const files = await collectJsonFiles(logRoot);
  const values: unknown[] = [];
  for (const file of files) {
    values.push(parseJson(await readFile(file, 'utf8')));
  }
  return values;
}

async function collectJsonFiles(directory: string): Promise<string[]> {
  return collectFiles(directory, (name) => name.endsWith('.json'));
}

async function collectConversationArtifacts(root: string): Promise<string[]> {
  const files = await collectFiles(root, (name) => name.endsWith('.jsonl') || name === 'last.json');
  return files.map((file) => relative(root, file));
}

async function collectFiles(directory: string, matches: (name: string) => boolean): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path, matches)));
    else if (entry.isFile() && matches(entry.name)) files.push(path);
  }
  return files;
}

async function startResilienceHttpServer(options: {
  family: HttpWireFamily;
  scenario: HttpScenario;
}): Promise<ResilienceHttpServer> {
  const requests: CapturedHttpRequest[] = [];
  const responseFrames: HttpResponseFrame[][] = [];
  const httpServer = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const captured: CapturedHttpRequest = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers,
      body: parseJson(body),
    };
    requests.push(captured);
    const frames = responseFramesFor(options.family, options.scenario, requests.length);
    responseFrames.push(frames);
    if (options.scenario === 'early-close') {
      response.destroy();
      return;
    }
    if (options.scenario === 'native-error' && nativeErrorUsesHttpStatus(options.family)) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'fixture_error', message: 'Injected native provider failure' } }));
      return;
    }
    response.writeHead(200, { 'content-type': contentTypeFor(), connection: 'close' });
    for (const frame of frames) {
      if (frame.event) response.write(`event: ${frame.event}\n`);
      response.write(`data: ${JSON.stringify(frame.data)}\n\n`);
    }
    if (options.scenario !== 'incomplete') response.write('data: [DONE]\n\n');
    response.end();
  });
  await listen(httpServer);
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Resilience HTTP server did not bind');
  const server: ResilienceHttpServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    family: options.family,
    scenario: options.scenario,
    requests,
    responseFrames,
    waitForRequests: (count, timeoutMs) => waitForCapturedCount(requests, count, timeoutMs),
    close: () => closeHttpServer(httpServer),
  };
  return server;
}

async function startResilienceWebSocketServer(options: {
  family: 'openai-responses' | 'codex-responses';
  scenario: WsScenario;
}): Promise<ResilienceWebSocketServer> {
  const requests: unknown[] = [];
  const responseFrames: unknown[][] = [];
  const clients = new Set<WebSocket>();
  let closing = false;
  const wsServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    wsServer.once('listening', resolve);
    wsServer.once('error', reject);
  });
  wsServer.on('connection', (socket) => {
    clients.add(socket);
    let handled = false;
    socket.on('message', async (raw) => {
      if (handled) return;
      handled = true;
      const message = parseJson(String(raw));
      requests.push(message);
      const frames = responseFramesForWs(options.scenario, requests.length);
      responseFrames.push(frames);
      if (!isResponseCreate(message)) {
        socket.close(1008, 'expected response.create');
        return;
      }
      for (const frame of frames) await sendWs(socket, frame);
      if (options.scenario === 'abnormal-close') socket.terminate();
      else socket.close(1000, 'fixture complete');
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {
      if (!closing) return;
    });
  });
  const address = wsServer.address();
  if (!address || typeof address === 'string') {
    await closeWsServer(wsServer, clients);
    throw new Error('Resilience WebSocket server did not bind');
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    requests,
    responseFrames,
    waitForRequests: (count, timeoutMs) => waitForCapturedCount(requests, count, timeoutMs),
    close: async () => {
      closing = true;
      await closeWsServer(wsServer, clients);
    },
  };
}

function responseFramesFor(family: HttpWireFamily, scenario: HttpScenario, requestNumber: number): HttpResponseFrame[] {
  if (scenario === 'native-error') return nativeErrorFrames(family);
  if (scenario === 'incomplete') return incompleteFrames(family);
  if (scenario === 'reasoning') return reasoningFrames(family);
  if (scenario === 'interrupted-tool' && requestNumber === 1) return interruptedToolFrames();
  if (scenario === 'interrupted-tool') return [openAiCompletedFrame('resp_repaired', 'restart-repaired-answer')];
  if (scenario === 'compaction-restart') {
    const first = requestNumber === 1;
    return [
      openAiCompletedFrame(
        first ? 'resp_compaction_first' : 'resp_compaction_resumed',
        first ? 'COMPACTION-FIRST' : 'COMPACTION-RESUMED',
        {
          compaction: first,
        },
      ),
    ];
  }
  if (scenario === 'compaction-tool') {
    if (requestNumber === 1) return compactionToolCallFrames();
    if (requestNumber === 2) {
      return [openAiCompletedFrame('resp_compaction_tool', 'COMPACTION-TOOL-FINAL', { compaction: true })];
    }
    return [openAiCompletedFrame('resp_compaction_tool_resumed', 'COMPACTION-TOOL-RESUMED')];
  }
  if (scenario === 'restart-completed') {
    const responseId = `resp_restart_${requestNumber}`;
    return [openAiCompletedFrame(responseId, `restart-answer-${requestNumber}`)];
  }
  return successFrames(family);
}

function nativeErrorFrames(family: HttpWireFamily): HttpResponseFrame[] {
  if (family === 'openai-responses' || family === 'codex-responses') {
    return [
      { data: { type: 'response.created', response: { id: 'resp_native_error', status: 'in_progress' } } },
      {
        data: {
          type: 'response.failed',
          response: {
            id: 'resp_native_error',
            status: 'failed',
            error: { code: 'fixture_error', message: 'Injected native provider failure' },
          },
        },
      },
    ];
  }
  if (family === 'anthropic-messages') {
    return [
      {
        event: 'error',
        data: { type: 'error', error: { type: 'api_error', message: 'Injected native provider failure' } },
      },
    ];
  }
  if (family === 'google-generate-content') {
    return [{ data: { error: { code: 500, status: 'INTERNAL', message: 'Injected native provider failure' } } }];
  }
  return [{ data: { error: { message: 'Injected native provider failure', type: 'fixture_error' } } }];
}

function incompleteFrames(family: HttpWireFamily): HttpResponseFrame[] {
  if (family === 'openai-responses' || family === 'codex-responses') {
    return [
      { data: { type: 'response.created', response: { id: 'resp_incomplete', status: 'in_progress' } } },
      { data: { type: 'response.output_text.delta', delta: 'partial' } },
    ];
  }
  if (family === 'anthropic-messages') {
    return [
      {
        data: {
          type: 'message_start',
          message: { id: 'msg_incomplete', role: 'assistant', content: [], usage: { input_tokens: 1 } },
        },
      },
      { data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } },
    ];
  }
  if (family === 'google-generate-content') {
    return [{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }] } }];
  }
  return [
    { data: { id: 'chat_incomplete', choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' } }] } },
  ];
}

function reasoningFrames(family: HttpWireFamily): HttpResponseFrame[] {
  if (family === 'openai-responses' || family === 'codex-responses') {
    return [
      { data: { type: 'response.created', response: { id: 'resp_reasoning', status: 'in_progress' } } },
      { data: { type: 'response.reasoning_summary_text.delta', delta: REASONING } },
      { data: { type: 'response.output_text.delta', delta: ANSWER } },
      { data: openAiCompletedResponse('resp_reasoning', ANSWER, { reasoning: REASONING }) },
    ];
  }
  if (family === 'anthropic-messages') {
    return [
      {
        data: {
          type: 'message_start',
          message: { id: 'msg_reasoning', role: 'assistant', content: [], usage: { input_tokens: 1 } },
        },
      },
      { data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: REASONING } } },
      { data: { type: 'content_block_stop', index: 0 } },
      { data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
      { data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ANSWER } } },
      { data: { type: 'content_block_stop', index: 1 } },
      { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
      { data: { type: 'message_stop' } },
    ];
  }
  if (family === 'google-generate-content') {
    return [
      {
        data: {
          candidates: [
            { content: { role: 'model', parts: [{ text: REASONING, thought: true }] }, finishReason: undefined },
          ],
        },
      },
      { data: { candidates: [{ content: { role: 'model', parts: [{ text: ANSWER }] }, finishReason: 'STOP' }] } },
    ];
  }
  return [
    {
      data: {
        id: 'chat_reasoning',
        choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: REASONING, content: null } }],
      },
    },
    { data: { id: 'chat_reasoning', choices: [{ index: 0, delta: { content: ANSWER }, finish_reason: 'stop' }] } },
  ];
}

function successFrames(family: HttpWireFamily): HttpResponseFrame[] {
  if (family === 'openai-responses' || family === 'codex-responses') {
    return [
      { data: { type: 'response.created', response: { id: 'resp_success', status: 'in_progress' } } },
      { data: { type: 'response.output_text.delta', delta: ANSWER } },
      { data: openAiCompletedResponse('resp_success', ANSWER) },
    ];
  }
  if (family === 'anthropic-messages') {
    return [
      {
        data: {
          type: 'message_start',
          message: { id: 'msg_success', role: 'assistant', content: [], usage: { input_tokens: 1 } },
        },
      },
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } } },
      { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
      { data: { type: 'message_stop' } },
    ];
  }
  if (family === 'google-generate-content') {
    return [
      { data: { candidates: [{ content: { role: 'model', parts: [{ text: ANSWER }] }, finishReason: 'STOP' }] } },
    ];
  }
  return [
    {
      data: {
        id: 'chat_success',
        choices: [{ index: 0, delta: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
      },
    },
  ];
}

function interruptedToolFrames(): HttpResponseFrame[] {
  const argumentsText = JSON.stringify({ command: "printf 'fixture-tool-result'", sandbox: 'unsandboxed' });
  return [
    { data: { type: 'response.created', response: { id: 'resp_stale_interrupted', status: 'in_progress' } } },
    {
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'fc_fixture_restart', type: 'function_call', call_id: TOOL_CALL_ID, name: 'shell', arguments: '' },
      },
    },
    { data: { type: 'response.function_call_arguments.delta', output_index: 0, delta: argumentsText } },
    {
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc_fixture_restart',
          type: 'function_call',
          call_id: TOOL_CALL_ID,
          name: 'shell',
          arguments: argumentsText,
        },
      },
    },
    { data: openAiCompletedResponse('resp_stale_interrupted', '', { toolCall: true, argumentsText }) },
  ];
}

function openAiCompletedFrame(
  responseId: string,
  text: string,
  options: { reasoning?: string; toolCall?: boolean; argumentsText?: string; compaction?: boolean } = {},
): HttpResponseFrame {
  return { data: openAiCompletedResponse(responseId, text, options) };
}

function openAiCompletedResponse(
  responseId: string,
  text: string,
  options: { reasoning?: string; toolCall?: boolean; argumentsText?: string; compaction?: boolean } = {},
): unknown {
  const output = options.toolCall
    ? [
        {
          id: 'fc_fixture_restart',
          type: 'function_call',
          call_id: TOOL_CALL_ID,
          name: 'shell',
          arguments: options.argumentsText ?? '{}',
          status: 'completed',
        },
      ]
    : [
        ...(options.compaction ? [compactionOutput()] : []),
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
        ...(options.reasoning
          ? [{ type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: options.reasoning }] }]
          : []),
      ];
  return { type: 'response.completed', response: { id: responseId, status: 'completed', output } };
}

function compactionOutput(): Record<string, unknown> {
  return {
    id: COMPACTION_ITEM_ID,
    type: 'compaction',
    encrypted_content: COMPACTION_CIPHERTEXT,
    created_by: 'fixture',
  };
}

function compactionToolCallFrames(): HttpResponseFrame[] {
  const argumentsText = JSON.stringify({ command: "printf 'fixture-tool-result'", sandbox: 'unsandboxed' });
  return [
    { data: { type: 'response.created', response: { id: 'resp_compaction_tool_call', status: 'in_progress' } } },
    {
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'fc_fixture_compaction_tool',
          type: 'function_call',
          call_id: COMPACTION_TOOL_CALL_ID,
          name: 'shell',
          arguments: '',
        },
      },
    },
    { data: { type: 'response.function_call_arguments.delta', output_index: 0, delta: argumentsText } },
    {
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc_fixture_compaction_tool',
          type: 'function_call',
          call_id: COMPACTION_TOOL_CALL_ID,
          name: 'shell',
          arguments: argumentsText,
        },
      },
    },
    {
      data: openAiCompletedResponse('resp_compaction_tool_call', '', {
        toolCall: true,
        argumentsText,
      }),
    },
  ];
}

function responseFramesForWs(scenario: WsScenario, requestNumber: number): unknown[] {
  const responseId = `resp_ws_${scenario}_${requestNumber}`;
  if (scenario === 'native-error') {
    return [
      { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
      {
        type: 'response.failed',
        response: {
          id: responseId,
          status: 'failed',
          error: { code: 'fixture_error', message: 'Injected WS failure' },
        },
      },
    ];
  }
  const frames: unknown[] = [
    { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
    ...(scenario === 'reasoning' ? [{ type: 'response.reasoning_summary_text.delta', delta: REASONING }] : []),
    { type: 'response.output_text.delta', delta: scenario === 'reasoning' ? ANSWER : 'partial' },
  ];
  if (scenario === 'reasoning') frames.push(openAiCompletedResponse(responseId, ANSWER, { reasoning: REASONING }));
  return frames;
}

function nativeErrorUsesHttpStatus(family: HttpWireFamily): boolean {
  return isChatFamily(family) || family === 'google-generate-content';
}

function isChatFamily(family: HttpWireFamily): boolean {
  return family === 'ai-sdk-chat' || family === 'chat-completions';
}

function contentTypeFor(): string {
  return 'text/event-stream; charset=utf-8';
}

function serverUrl(server: ResilienceHttpServer | ResilienceWebSocketServer): string {
  if ('baseUrl' in server) return server.baseUrl;
  return server.url.replace(/^ws:/, 'http:');
}

function isResponseCreate(value: unknown): boolean {
  return asRecord(value)?.type === 'response.create';
}

function flattenResponseFrames(frames: readonly HttpResponseFrame[]): string[] {
  return frames.flatMap((frame) => flattenStrings(frame.data));
}

function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(flattenStrings);
}

function inputText(value: unknown): string[] {
  return flattenStrings(value);
}

function inputItems(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item))) : [];
}

function callIdOf(value: Record<string, unknown>): string | undefined {
  const callId = value.call_id ?? value.callId;
  return typeof callId === 'string' ? callId : undefined;
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) body += chunk;
  return body;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function closeWsServer(server: WebSocketServer, clients: Set<WebSocket>): Promise<void> {
  for (const client of clients) {
    try {
      client.close(1001, 'fixture shutdown');
    } catch {
      /* best effort */
    }
    if (client.readyState !== WebSocket.CLOSED) client.terminate();
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) =>
      error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve(),
    ),
  );
}

async function sendWs(socket: WebSocket, value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error(`fixture websocket is not open (${socket.readyState})`));
      return;
    }
    socket.send(JSON.stringify(value), (error?: Error) => (error ? reject(error) : resolve()));
  });
}

async function waitForCapturedCount(
  values: readonly unknown[],
  count: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  while (values.length < count) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for ${count} captured value(s)`);
    await delay(25);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
