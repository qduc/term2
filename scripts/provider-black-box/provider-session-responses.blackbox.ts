import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createIsolatedWorkspaceLease,
  type IsolatedWorkspaceLease,
  type PtyChildDriver,
} from './provider-test-harness.js';

const MODEL = 'gpt-5.6-luna';
const FIRST_RESPONSE_ID = 'resp-first';
const SECOND_RESPONSE_ID = 'resp-second';
const TOOL_RESPONSE_ID = 'resp-tool-producing';
const TOOL_RESUMED_RESPONSE_ID = 'resp-tool-resumed';
const TOOL_CALL_ID = 'call-fixture-approval';
const TOOL_ITEM_ID = 'item-fixture-approval';
const TOOL_ARGUMENTS_PARTS = ['{"command":"pwd",', '"sandbox":"unsandboxed"}'] as const;
const TOOL_ARGUMENTS = TOOL_ARGUMENTS_PARTS.join('');
const BACKGROUND_SHELL_CALL_ID = 'call-fixture-background-shell';
const BACKGROUND_SHELL_ITEM_ID = 'item-fixture-background-shell';
// Harmless and deliberately short-lived: completion occurs after the launch
// acknowledgement, while keeping this shipped-CLI fixture free of inline code.
const BACKGROUND_SHELL_ARGUMENTS = JSON.stringify({ command: 'sleep 1', background: true });

type ProviderId = 'openai' | 'codex';
type Transport = 'http' | 'websocket';
type FixtureMode =
  | 'multi-turn'
  | 'approval'
  | 'background-shell'
  | 'native-error'
  | 'incomplete'
  | 'abnormal-close'
  | 'runaway-output';

/** Typed lifecycle ledger consumed by the Gate C matrix-accounting test. */
export { RESPONSES_CAPABILITY_EXECUTIONS as executedCapabilityScenarioIds } from './provider-session-capability-manifest.js';

interface ProviderTransportCase {
  readonly provider: ProviderId;
  readonly transport: Transport;
}

const providerTransportCases: readonly ProviderTransportCase[] = [
  { provider: 'openai', transport: 'http' },
  { provider: 'openai', transport: 'websocket' },
  { provider: 'codex', transport: 'http' },
  { provider: 'codex', transport: 'websocket' },
] as const;

interface CapturedResponsesRequest {
  readonly transport: Transport;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Record<string, unknown>;
}

interface ServedResponse {
  readonly request: CapturedResponsesRequest;
  readonly terminalType?: 'response.completed' | 'response.failed' | 'response.incomplete';
  readonly responseId?: string;
  readonly closedAbnormally: boolean;
}

interface ResponsesFixtureServer {
  readonly baseUrl: string;
  readonly websocketUrl: string;
  readonly requests: CapturedResponsesRequest[];
  readonly served: ServedResponse[];
  waitForRequests(
    predicate: (requests: readonly CapturedResponsesRequest[]) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
  close(): Promise<void>;
}

let activeServer: ResponsesFixtureServer | undefined;
let activeWorkspace: IsolatedWorkspaceLease | undefined;
let activeChild: PtyChildDriver | undefined;

afterEach(async () => {
  const child = activeChild;
  const workspace = activeWorkspace;
  const server = activeServer;
  activeChild = undefined;
  activeWorkspace = undefined;
  activeServer = undefined;

  try {
    await child?.cleanup({ timeoutMs: 2_000 });
  } finally {
    try {
      await server?.close();
    } finally {
      await cleanupWorkspace(workspace);
    }
  }
});

describe('application-owned Responses lifecycle through the shipped CLI', () => {
  it.each(providerTransportCases)('$provider $transport preserves two-turn response chaining', async (providerCase) => {
    const server = await startResponsesFixtureServer({ mode: 'multi-turn' });
    activeServer = server;
    const workspace = await createWorkspace(server, providerCase);
    activeWorkspace = workspace;
    const child = await startCli(workspace);
    activeChild = child;

    await child.waitForVisibleOutput('❯');
    const firstTurnOutputLength = child.getVisibleOutput().length;
    await writePrompt(child, 'first user turn');
    await waitForRequests(server, child, (requests) => normalRequests(requests).length >= 1);
    await waitForIdlePromptAfterResponse(child, firstTurnOutputLength, 'FIRST-RESPONSE');
    await waitForRequests(server, child, () => server.served.some((item) => item.responseId === FIRST_RESPONSE_ID));

    await writePrompt(child, 'second user turn');
    await waitForRequests(server, child, (requests) => normalRequests(requests).length >= 2);
    await child.waitForVisibleOutput('SECOND-RESPONSE');

    const requests = normalRequests(server.requests);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.previous_response_id).toBe(
      expectedInitialPreviousResponseId(providerCase.provider, providerCase.transport),
    );
    expect(requests[1]?.body.previous_response_id).toBe(FIRST_RESPONSE_ID);
    expect(
      server.served
        .filter((item) => item.request.body.generate !== false && item.terminalType === 'response.completed')
        .map((item) => item.responseId),
    ).toEqual([FIRST_RESPONSE_ID, SECOND_RESPONSE_ID]);
    expect(requests.every((request) => request.body.model === MODEL)).toBe(true);
    if (providerCase.provider === 'codex') {
      // This is the production CLI → configuration → application-loop →
      // registry seam. Both Codex transports must retain the session-scoped
      // request options, while OpenAI cases above prove they are not generic
      // Responses fields.
      for (const request of requests) {
        expect(request.body.prompt_cache_key).toEqual(expect.any(String));
        expect(request.body.prompt_cache_key).not.toBe('');
        expect(request.body.include).toEqual(expect.arrayContaining(['reasoning.encrypted_content']));
      }
    } else {
      expect(
        requests.every(
          (request) =>
            Array.isArray(request.body.include) && request.body.include.includes('reasoning.encrypted_content'),
        ),
      ).toBe(true);
    }
  });

  it.each(providerTransportCases)(
    '$provider $transport resumes an approved tool from its producing response',
    async (providerCase) => {
      const server = await startResponsesFixtureServer({ mode: 'approval' });
      activeServer = server;
      const workspace = await createWorkspace(server, providerCase);
      activeWorkspace = workspace;
      const child = await startCli(workspace);
      activeChild = child;

      await child.waitForVisibleOutput('❯');
      await writePrompt(child, 'run the approval fixture');
      await waitForRequests(server, child, (requests) => normalRequests(requests).length >= 1);
      await child.waitForVisibleOutput('Allow this action?');
      await writePrompt(child, 'y');
      await waitForRequests(server, child, (requests) => toolResultRequests(requests).length >= 1);
      await child.waitForVisibleOutput('APPROVED-FINAL');

      assertApprovalResume(server, providerCase, 'approved');
      expect(child.getVisibleOutput()).not.toContain('Approval Rejected');
    },
  );

  it.each(providerTransportCases)('$provider $transport resumes a rejected tool exactly once', async (providerCase) => {
    const server = await startResponsesFixtureServer({ mode: 'approval' });
    activeServer = server;
    const workspace = await createWorkspace(server, providerCase);
    activeWorkspace = workspace;
    const child = await startCli(workspace);
    activeChild = child;

    await child.waitForVisibleOutput('❯');
    await writePrompt(child, 'run the rejection fixture');
    await waitForRequests(server, child, (requests) => normalRequests(requests).length >= 1);
    await child.waitForVisibleOutput('Allow this action?');
    await writePrompt(child, 'n');
    await child.waitForVisibleOutput('Why?');
    await writePrompt(child, 'fixture rejection');
    await waitForRequests(server, child, (requests) => toolResultRequests(requests).length >= 1);
    await child.waitForVisibleOutput('REJECTED-FINAL');

    assertApprovalResume(server, providerCase, 'rejected');
    expect(child.getVisibleOutput()).toContain('fixture rejection');
  });

  it('OpenAI HTTP returns a background shell launch acknowledgement before its late completion notification', async () => {
    const providerCase: ProviderTransportCase = { provider: 'openai', transport: 'http' };
    const server = await startResponsesFixtureServer({ mode: 'background-shell' });
    activeServer = server;
    const workspace = await createWorkspace(server, providerCase, 'background-shell');
    activeWorkspace = workspace;
    const child = await startCli(workspace);
    activeChild = child;

    await child.waitForVisibleOutput('❯');
    await writePrompt(child, 'launch the background shell fixture');
    await waitForRequests(server, child, (requests) => normalRequests(requests).length >= 2);
    await child.waitForVisibleOutput('BACKGROUND-LAUNCH-FINAL');
    await waitForRequests(server, child, (requests) => normalRequests(requests).length >= 3, 10_000);
    await child.waitForVisibleOutput('BACKGROUND-COMPLETION-FINAL');

    const requests = normalRequests(server.requests);
    const launchContinuation = requests[1];
    const results = toolResultItems(launchContinuation);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: 'function_call_output', call_id: BACKGROUND_SHELL_CALL_ID });
    const acknowledgement = parseFunctionResultOutput(results[0]);
    expect(acknowledgement).toMatchObject({ jobId: expect.any(String), status: 'running' });

    // A background completion is a separate notification turn, never a second
    // function result for the original tool call.
    expect(requests.flatMap(toolResultItems).filter((item) => item.call_id === BACKGROUND_SHELL_CALL_ID)).toHaveLength(
      1,
    );
    expect(toolResultItems(requests[2])).toEqual([]);

    await child.terminate({ timeoutMs: 2_000 });
  });
});

describe('application-owned Responses terminal failure lifecycle', () => {
  it.each(providerTransportCases)('$provider $transport surfaces native terminal failure', async (providerCase) => {
    await runFailureScenario(providerCase, 'native-error');
  });

  it.each(providerTransportCases)('$provider $transport rejects an incomplete stream', async (providerCase) => {
    await runFailureScenario(providerCase, 'incomplete');
  });

  it.each(providerTransportCases)('$provider $transport stops runaway streamed output', async (providerCase) => {
    await runFailureScenario(providerCase, 'runaway-output');
  });

  it.each(providerTransportCases.filter(({ transport }) => transport === 'websocket'))(
    '$provider websocket rejects an abnormal close without a fabricated completion',
    async (providerCase) => {
      await runFailureScenario(providerCase, 'abnormal-close');
    },
  );
});

async function runFailureScenario(
  providerCase: ProviderTransportCase,
  mode: Exclude<FixtureMode, 'multi-turn' | 'approval'>,
) {
  const server = await startResponsesFixtureServer({ mode });
  activeServer = server;
  const workspace = await createWorkspace(server, providerCase, mode);
  activeWorkspace = workspace;
  const child = await startCli(workspace);
  activeChild = child;

  await child.waitForVisibleOutput('❯');
  await writePrompt(child, `exercise ${mode}`);
  await waitForRequests(server, child, (requests) => normalRequests(requests).length >= 1);
  const failureSignal = mode === 'native-error' ? /error|failed/i : /PARTIAL|error|failed|closed/i;
  await child.waitForState(
    (snapshot) => failureSignal.test(snapshot.visibleOutput) && !snapshot.visibleOutput.includes('SUCCESS'),
    10_000,
  );
  expect(child.getVisibleOutput()).not.toContain('SUCCESS');
  expect(
    server.served.some((item) => item.request.body.generate !== false && item.terminalType === 'response.completed'),
  ).toBe(false);
  if (mode === 'runaway-output') expect(normalRequests(server.requests)).toHaveLength(1);

  await child.terminate({ timeoutMs: 2_000 });
}

function expectedInitialPreviousResponseId(provider: ProviderId, transport: Transport): string | undefined {
  // Codex WebSocket's Responses Lite path seeds its server-managed wire chain
  // with a generate:false warmup before the first generated turn.
  return provider === 'codex' && transport === 'websocket' ? 'resp-warmup-0' : undefined;
}

function assertApprovalResume(
  server: ResponsesFixtureServer,
  providerCase: ProviderTransportCase,
  decision: 'approved' | 'rejected',
): void {
  const first = normalRequests(server.requests)[0];
  expect(first).toBeDefined();
  expect(first?.body.previous_response_id).toBe(
    expectedInitialPreviousResponseId(providerCase.provider, providerCase.transport),
  );

  const resumed = toolResultRequests(server.requests);
  expect(resumed).toHaveLength(1);
  expect(resumed[0]?.body.previous_response_id).toBe(TOOL_RESPONSE_ID);

  const input = Array.isArray(resumed[0]?.body.input) ? resumed[0]?.body.input : [];
  const toolResults = input.filter((item) => isRecord(item) && item.type === 'function_call_output');
  expect(toolResults).toHaveLength(1);
  expect(toolResults[0]).toMatchObject({ type: 'function_call_output', call_id: TOOL_CALL_ID });
  expect(toolResults[0]).not.toHaveProperty('callId');
  if (decision === 'rejected') {
    expect(JSON.stringify(toolResults[0])).toContain('fixture rejection');
  }

  const terminalIds = server.served.filter((item) => item.terminalType).map((item) => item.responseId);
  expect(terminalIds).toContain(TOOL_RESPONSE_ID);
  expect(terminalIds).toContain(TOOL_RESUMED_RESPONSE_ID);
}

async function createWorkspace(
  server: ResponsesFixtureServer,
  providerCase: ProviderTransportCase,
  mode?: FixtureMode,
): Promise<IsolatedWorkspaceLease> {
  return createIsolatedWorkspaceLease({
    prefix: `term2-provider-session-${providerCase.provider}-${providerCase.transport}-`,
    env: {
      OPENAI_BASE_URL: server.baseUrl,
      CODEX_BASE_URL: server.baseUrl,
    },
    prepare: async (_root, paths) => {
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            model: MODEL,
            provider: providerCase.provider,
            transport: providerCase.transport,
            retryAttempts: 0,
            ...(mode === 'runaway-output' ? { maxStreamOutputChars: 32 } : {}),
            openai: { apiKey: 'fixture-key' },
            codex: {
              websocketFirstFrameTimeoutMs: 2_000,
              websocketInterFrameTimeoutMs: 2_000,
            },
          },
          app: { liteMode: true },
          shell: { autoApproveMode: 'off' },
          sandbox: { enabled: mode !== 'background-shell', allowNetworking: false },
        }),
      );
      if (providerCase.provider === 'codex') {
        await mkdir(paths.codexHome, { recursive: true });
        await writeFile(
          join(paths.codexHome, 'auth.json'),
          JSON.stringify({
            tokens: {
              access_token: fixtureJwt(),
              refresh_token: 'fixture-refresh-token',
              account_id: 'fixture-account',
            },
          }),
        );
      }
    },
  });
}

async function startCli(workspace: IsolatedWorkspaceLease): Promise<PtyChildDriver> {
  return workspace.start({
    command: process.execPath,
    // --lite is required: workspace.root is also HOME, and the CLI home-directory
    // start guard blocks interactive non-lite starts when cwd === homedir.
    // Settings app.liteMode is loaded later and does not bypass that guard.
    args: [join(process.cwd(), 'dist/cli.js'), '--lite'],
    cwd: workspace.root,
    cols: 120,
    rows: 40,
  });
}

async function cleanupWorkspace(workspace: IsolatedWorkspaceLease | undefined): Promise<void> {
  if (!workspace) return;
  try {
    await workspace.cleanup();
  } catch (firstError) {
    try {
      await workspace.cleanup();
    } catch {
      throw firstError;
    }
  }
}

function fixtureJwt(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1_000) + 3_600 })}.fixture`;
}

function normalRequests(requests: readonly CapturedResponsesRequest[]): CapturedResponsesRequest[] {
  return requests.filter((request) => request.body.generate !== false);
}

async function waitForRequests(
  server: ResponsesFixtureServer,
  child: PtyChildDriver,
  predicate: (requests: readonly CapturedResponsesRequest[]) => boolean,
): Promise<void> {
  try {
    await server.waitForRequests(predicate);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nchild output:\n${child.getVisibleOutput()}`,
    );
  }
}

async function waitForIdlePromptAfterResponse(
  child: PtyChildDriver,
  outputLength: number,
  marker: string,
): Promise<void> {
  await child.waitForState((snapshot) => {
    const appended = snapshot.visibleOutput.slice(outputLength);
    const markerIndex = appended.lastIndexOf(marker);
    const promptIndex = appended.lastIndexOf('❯');
    if (markerIndex < 0 || promptIndex <= markerIndex) return false;
    const promptFrame = appended.slice(promptIndex);
    return (
      !promptFrame.includes('processing') && !promptFrame.includes('Thinking') && !promptFrame.includes('Calling ')
    );
  });
}

/** Separate terminal text and Enter so PTY input coalescing cannot drop the key event. */
async function writePrompt(child: PtyChildDriver, text: string): Promise<void> {
  await child.write(text);
  await delay(50);
  await child.write('\r');
}

function toolResultRequests(requests: readonly CapturedResponsesRequest[]): CapturedResponsesRequest[] {
  return normalRequests(requests).filter((request) => {
    const input = request.body.input;
    return (
      Array.isArray(input) &&
      input.some(
        (item) => isRecord(item) && (item.type === 'function_call_output' || item.type === 'function_call_result'),
      )
    );
  });
}

function toolResultItems(request: CapturedResponsesRequest | undefined): Array<Record<string, unknown>> {
  const input = request?.body.input;
  return Array.isArray(input)
    ? input.filter(
        (item): item is Record<string, unknown> =>
          isRecord(item) && (item.type === 'function_call_output' || item.type === 'function_call_result'),
      )
    : [];
}

function parseFunctionResultOutput(item: Record<string, unknown>): unknown {
  const output = item.output;
  if (typeof output !== 'string') return output;
  return JSON.parse(output);
}

async function startResponsesFixtureServer(options: { mode: FixtureMode }): Promise<ResponsesFixtureServer> {
  const requests: CapturedResponsesRequest[] = [];
  const served: ServedResponse[] = [];
  const sockets = new Set<Socket>();
  const clients = new Set<WebSocket>();
  const httpServer = createServer(async (request, response) => {
    sockets.add(request.socket);
    request.socket.once('close', () => sockets.delete(request.socket));
    const captured = {
      transport: 'http' as const,
      path: request.url ?? '/',
      headers: request.headers,
      body: await readJsonBody(request),
    } satisfies CapturedResponsesRequest;
    requests.push(captured);
    await serveResponse(options.mode, captured, response, undefined, served);
  });
  const webSocketServer = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request);
    });
  });
  webSocketServer.on('connection', (client, request) => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    let servedRequest = false;
    client.on('message', (raw) => {
      if (servedRequest) return;
      servedRequest = true;
      const captured = {
        transport: 'websocket' as const,
        path: request.url ?? '/',
        headers: request.headers,
        body: parseJsonMessage(raw),
      } satisfies CapturedResponsesRequest;
      requests.push(captured);
      void serveResponse(options.mode, captured, undefined, client, served);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1');
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Responses fixture server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let closePromise: Promise<void> | undefined;

  return {
    baseUrl,
    websocketUrl: `ws://127.0.0.1:${address.port}`,
    requests,
    served,
    waitForRequests: async (predicate, timeoutMs = 15_000) => {
      const startedAt = Date.now();
      while (!predicate(requests)) {
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(`Timed out waiting for captured Responses requests; got ${requests.length}.`);
        }
        await delay(25);
      }
    },
    close: async () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        for (const client of clients) {
          try {
            client.close(1001, 'fixture shutdown');
          } catch {
            /* best effort */
          }
          if (client.readyState !== client.CLOSED) client.terminate();
        }
        await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      })();
      return closePromise;
    },
  };
}

async function serveResponse(
  mode: FixtureMode,
  request: CapturedResponsesRequest,
  httpResponse: ServerResponse | undefined,
  webSocket: WebSocket | undefined,
  served: ServedResponse[],
): Promise<void> {
  const isWarmup = request.body.generate === false;
  const hasToolResult = Array.isArray(request.body.input)
    ? request.body.input.some(
        (item) => isRecord(item) && (item.type === 'function_call_output' || item.type === 'function_call_result'),
      )
    : false;
  const normalIndex = countNormalServed(served);

  if (isWarmup) {
    await sendFrames(httpResponse, webSocket, [completedFrame(`resp-warmup-${normalIndex}`, [])]);
    served.push({
      request,
      terminalType: 'response.completed',
      responseId: `resp-warmup-${normalIndex}`,
      closedAbnormally: false,
    });
    return;
  }

  if (mode === 'native-error') {
    const responseId = 'resp-native-error';
    await sendFrames(httpResponse, webSocket, [
      createdFrame(responseId),
      {
        type: 'response.failed',
        response: {
          id: responseId,
          status: 'failed',
          output: [],
          error: { code: 'fixture_error', message: 'Injected native provider failure' },
        },
      },
    ]);
    served.push({ request, terminalType: 'response.failed', responseId, closedAbnormally: false });
    return;
  }

  if (mode === 'incomplete' || mode === 'abnormal-close') {
    const responseId = `resp-${mode}`;
    const frames = [createdFrame(responseId), { type: 'response.output_text.delta', delta: 'PARTIAL' }];
    await sendFrames(httpResponse, webSocket, frames, mode === 'abnormal-close');
    served.push({ request, closedAbnormally: mode === 'abnormal-close' });
    return;
  }

  if (mode === 'runaway-output') {
    const responseId = 'resp-runaway-output';
    await sendFrames(httpResponse, webSocket, [
      createdFrame(responseId),
      ...Array.from({ length: 8 }, () => ({ type: 'response.output_text.delta', delta: 'LOOPLOOP' })),
    ]);
    served.push({ request, responseId, closedAbnormally: false });
    return;
  }

  if (mode === 'approval' && !hasToolResult) {
    const responseId = TOOL_RESPONSE_ID;
    await sendFrames(httpResponse, webSocket, toolCallFrames(responseId));
    served.push({ request, terminalType: 'response.completed', responseId, closedAbnormally: false });
    return;
  }

  if (mode === 'background-shell') {
    const responseId = normalIndex === 0 ? 'resp-background-tool' : `resp-background-${normalIndex}`;
    const text = normalIndex === 1 ? 'BACKGROUND-LAUNCH-FINAL' : 'BACKGROUND-COMPLETION-FINAL';
    const frames =
      normalIndex === 0
        ? backgroundShellToolCallFrames(responseId)
        : [createdFrame(responseId), ...messageFrames(text), completedFrame(responseId, [messageOutput(text)])];
    await sendFrames(httpResponse, webSocket, frames);
    served.push({ request, terminalType: 'response.completed', responseId, closedAbnormally: false });
    return;
  }

  const responseId =
    mode === 'approval' ? TOOL_RESUMED_RESPONSE_ID : normalIndex === 0 ? FIRST_RESPONSE_ID : SECOND_RESPONSE_ID;
  const text =
    mode === 'approval'
      ? hasToolResult && toolResultText(request).includes('fixture rejection')
        ? 'REJECTED-FINAL'
        : 'APPROVED-FINAL'
      : normalIndex === 0
      ? 'FIRST-RESPONSE'
      : 'SECOND-RESPONSE';
  await sendFrames(httpResponse, webSocket, [
    createdFrame(responseId),
    ...messageFrames(text),
    completedFrame(responseId, [messageOutput(text)]),
  ]);
  served.push({ request, terminalType: 'response.completed', responseId, closedAbnormally: false });
}

function countNormalServed(served: readonly ServedResponse[]): number {
  return served.filter((item) => item.request.body.generate !== false).length;
}

function toolResultText(request: CapturedResponsesRequest): string {
  const input = Array.isArray(request.body.input) ? request.body.input : [];
  const result = input.find(
    (item) => isRecord(item) && (item.type === 'function_call_output' || item.type === 'function_call_result'),
  );
  return result ? JSON.stringify(result) : '';
}

function createdFrame(responseId: string): Record<string, unknown> {
  return { type: 'response.created', response: { id: responseId, status: 'in_progress', output: [] } };
}

function completedFrame(responseId: string, output: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { type: 'response.completed', response: { id: responseId, status: 'completed', output } };
}

function messageOutput(text: string): Record<string, unknown> {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

function messageFrames(text: string): Record<string, unknown>[] {
  return [
    { type: 'response.output_text.delta', delta: text.slice(0, Math.ceil(text.length / 2)) },
    { type: 'response.output_text.delta', delta: text.slice(Math.ceil(text.length / 2)) },
    { type: 'response.output_text.done', text },
    { type: 'response.output_item.done', item: messageOutput(text) },
  ];
}

function toolCallFrames(responseId: string): Record<string, unknown>[] {
  const item = {
    id: TOOL_ITEM_ID,
    type: 'function_call',
    status: 'in_progress',
    arguments: '',
    call_id: TOOL_CALL_ID,
    name: 'shell',
  };
  return [
    createdFrame(responseId),
    { type: 'response.output_item.added', item, output_index: 0 },
    ...TOOL_ARGUMENTS_PARTS.map((delta) => ({
      type: 'response.function_call_arguments.delta',
      item_id: TOOL_ITEM_ID,
      call_id: TOOL_CALL_ID,
      delta,
      output_index: 0,
    })),
    {
      type: 'response.function_call_arguments.done',
      item_id: TOOL_ITEM_ID,
      call_id: TOOL_CALL_ID,
      arguments: TOOL_ARGUMENTS,
      output_index: 0,
    },
    {
      type: 'response.output_item.done',
      item: { ...item, status: 'completed', arguments: TOOL_ARGUMENTS },
      output_index: 0,
    },
    completedFrame(responseId, [{ ...item, status: 'completed', arguments: TOOL_ARGUMENTS }]),
  ];
}

function backgroundShellToolCallFrames(responseId: string): Record<string, unknown>[] {
  const item = {
    id: BACKGROUND_SHELL_ITEM_ID,
    type: 'function_call',
    status: 'in_progress',
    arguments: '',
    call_id: BACKGROUND_SHELL_CALL_ID,
    name: 'shell',
  };
  return [
    createdFrame(responseId),
    { type: 'response.output_item.added', item, output_index: 0 },
    {
      type: 'response.function_call_arguments.delta',
      item_id: BACKGROUND_SHELL_ITEM_ID,
      call_id: BACKGROUND_SHELL_CALL_ID,
      delta: BACKGROUND_SHELL_ARGUMENTS,
      output_index: 0,
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: BACKGROUND_SHELL_ITEM_ID,
      call_id: BACKGROUND_SHELL_CALL_ID,
      arguments: BACKGROUND_SHELL_ARGUMENTS,
      output_index: 0,
    },
    {
      type: 'response.output_item.done',
      item: { ...item, status: 'completed', arguments: BACKGROUND_SHELL_ARGUMENTS },
      output_index: 0,
    },
    completedFrame(responseId, [{ ...item, status: 'completed', arguments: BACKGROUND_SHELL_ARGUMENTS }]),
  ];
}

async function sendFrames(
  httpResponse: ServerResponse | undefined,
  webSocket: WebSocket | undefined,
  frames: readonly Record<string, unknown>[],
  abnormalClose = false,
): Promise<void> {
  if (httpResponse) {
    httpResponse.writeHead(200, {
      'content-type': 'text/event-stream',
      connection: 'close',
      'cache-control': 'no-cache',
    });
    for (const frame of frames) httpResponse.write(`data: ${JSON.stringify(frame)}\n\n`);
    if (!abnormalClose) httpResponse.end();
    else httpResponse.destroy();
    return;
  }
  if (!webSocket) throw new Error('Responses fixture has no response channel');
  for (const frame of frames) {
    if (webSocket.readyState !== webSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      webSocket.send(JSON.stringify(frame), (error?: Error) => (error ? reject(error) : resolve()));
    });
  }
  if (abnormalClose) webSocket.terminate();
  else webSocket.close(1000, 'fixture complete');
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return parseJsonMessage(Buffer.concat(chunks));
}

function parseJsonMessage(raw: Buffer | WebSocket.RawData): Record<string, unknown> {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw.toString();
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!isRecord(parsed)) throw new Error('Responses fixture received a non-object request');
  return parsed;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
