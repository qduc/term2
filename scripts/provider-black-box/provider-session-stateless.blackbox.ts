import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIsolatedWorkspaceLease,
  writePtyTextAndSubmit,
  type IsolatedWorkspaceLease,
  type PtyChildDriver,
} from './provider-test-harness.js';

type StatelessProtocol = 'chat-completions' | 'anthropic' | 'google';
type RuntimeProviderType = 'openai' | 'openai-compatible' | 'llama.cpp' | 'anthropic' | 'google' | 'opencode';

type StatelessProviderRow = {
  id:
    | 'openrouter-http'
    | 'runtime-openai-chat'
    | 'runtime-openai-compatible-chat'
    | 'runtime-llama-cpp-chat'
    | 'runtime-anthropic-messages'
    | 'runtime-google-generate-content'
    | 'opencode-chat-completions'
    | 'opencode-anthropic-messages';
  label: string;
  providerId: string;
  model: string;
  protocol: StatelessProtocol;
  basePath: string;
  runtimeType?: RuntimeProviderType;
};

const STATELESS_PROVIDER_ROWS = [
  {
    id: 'openrouter-http',
    label: 'Built-in OpenRouter',
    providerId: 'openrouter',
    model: 'fixture/openrouter',
    protocol: 'chat-completions',
    basePath: '/api/v1',
  },
  {
    id: 'runtime-openai-chat',
    label: 'Runtime openai',
    providerId: 'runtime-openai',
    model: 'fixture-openai',
    protocol: 'chat-completions',
    basePath: '',
    runtimeType: 'openai',
  },
  {
    id: 'runtime-openai-compatible-chat',
    label: 'Runtime openai-compatible',
    providerId: 'runtime-openai-compatible',
    model: 'fixture-openai-compatible',
    protocol: 'chat-completions',
    basePath: '',
    runtimeType: 'openai-compatible',
  },
  {
    id: 'runtime-llama-cpp-chat',
    label: 'Runtime llama.cpp',
    providerId: 'runtime-llama-cpp',
    model: 'fixture-llama-cpp',
    protocol: 'chat-completions',
    basePath: '',
    runtimeType: 'llama.cpp',
  },
  {
    id: 'runtime-anthropic-messages',
    label: 'Runtime Anthropic',
    providerId: 'runtime-anthropic',
    model: 'fixture-anthropic',
    protocol: 'anthropic',
    basePath: '',
    runtimeType: 'anthropic',
  },
  {
    id: 'runtime-google-generate-content',
    label: 'Runtime Google',
    providerId: 'runtime-google',
    model: 'fixture-google',
    protocol: 'google',
    basePath: '/v1beta',
    runtimeType: 'google',
  },
  {
    id: 'opencode-chat-completions',
    label: 'OpenCode Chat route',
    providerId: 'opencode-chat',
    model: 'deepseek-v4-flash',
    protocol: 'chat-completions',
    basePath: '/zen/go/v1',
    runtimeType: 'opencode',
  },
  {
    id: 'opencode-anthropic-messages',
    label: 'OpenCode Anthropic route',
    providerId: 'opencode-anthropic',
    model: 'minimax-m3',
    protocol: 'anthropic',
    basePath: '/zen/go/v1',
    runtimeType: 'opencode',
  },
] as const satisfies readonly StatelessProviderRow[];

export { STATELESS_CAPABILITY_EXECUTIONS as EXECUTED_CAPABILITY_SCENARIO_IDS } from './provider-session-capability-manifest.js';

type CapturedStatelessRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

type StatelessLifecycleServer = {
  readonly baseUrl: string;
  readonly requests: CapturedStatelessRequest[];
  close(): Promise<void>;
};

const TOOL_CALL_ARGUMENTS = JSON.stringify({ command: 'true', sandbox: 'unsandboxed' });
const APPROVAL_CALL_ID = 'call-approve';
const REJECTION_CALL_ID = 'call-reject';

let activeServer: StatelessLifecycleServer | undefined;
let activeWorkspace: IsolatedWorkspaceLease | undefined;
let activeChild: PtyChildDriver | undefined;

afterEach(async () => {
  await activeChild?.cleanup().catch(() => undefined);
  await activeWorkspace?.cleanup().catch(() => undefined);
  await activeServer?.close().catch(() => undefined);
  activeChild = undefined;
  activeWorkspace = undefined;
  activeServer = undefined;
});

describe('assembled stateless provider lifecycle black-box', () => {
  it.each(STATELESS_PROVIDER_ROWS)(
    '$label executes two user turns and approval continuations through its registry route',
    async (row) => {
      activeServer = await startStatelessLifecycleServer(row);
      activeWorkspace = await createIsolatedWorkspaceLease({
        prefix: `term2-${row.id}-`,
        prepare: (_root, paths) => writeStatelessSettings(paths.logDir, row, activeServer!.baseUrl),
      });
      activeChild = await activeWorkspace.start({
        cwd: process.cwd(),
        args: ['--provider', row.providerId, '--model', row.model, '--reasoning', 'medium'],
        cols: 120,
        rows: 40,
      });

      await activeChild.waitForIdleInput({ timeoutMs: 15_000 });

      await sendUserTurn(activeChild, 'first stateless user turn', 'first-response');
      await sendUserTurn(activeChild, 'second stateless user turn', 'second-response');

      await sendApprovalTurn(activeChild, 'approve this deterministic tool', 'approved-response', 'y');
      await sendApprovalTurn(activeChild, 'reject this deterministic tool', 'rejected-response', 'n');

      expect(activeServer.requests, `${row.id} captured requests`).toHaveLength(6);
      assertProviderRoute(row, activeServer.requests);
      assertHistoryAndNativeShape(row, activeServer.requests);
    },
  );
});

async function sendUserTurn(child: PtyChildDriver, prompt: string, response: string): Promise<void> {
  const idle = child.readIdleGeneration();
  await writeAndSubmitText(child, prompt);
  await waitForCompletedTurn(child, response, idle);
}

async function sendApprovalTurn(
  child: PtyChildDriver,
  prompt: string,
  response: string,
  decision: 'y' | 'n',
): Promise<void> {
  const idle = child.readIdleGeneration();
  const outputMarker = captureOutputMarker(child);
  await writeAndSubmitText(child, prompt);
  await waitForNewVisibleOutput(child, 'Allow this action?', outputMarker, 15_000);
  // ApprovalPrompt handles y/n as single-key shortcuts; unlike text input,
  // this control does not consume a trailing carriage return.
  await writeApprovalShortcut(child, decision);
  if (decision === 'n') {
    await writeAndSubmitText(child, 'black-box rejection');
  }
  await waitForCompletedTurn(child, response, idle);
}

async function writeAndSubmitText(child: PtyChildDriver, text: string): Promise<void> {
  await writePtyTextAndSubmit(child, text);
}

async function writeApprovalShortcut(child: PtyChildDriver, decision: 'y' | 'n'): Promise<void> {
  await child.write(decision);
}

type ChildOutputMarker = {
  outputLength: number;
  visibleLength: number;
};

async function waitForCompletedTurn(child: PtyChildDriver, response: string, idle: number): Promise<void> {
  await child.waitForVisibleOutput(response, 15_000);
  await child.waitForIdleInput({ after: idle, timeoutMs: 15_000 });
}

function captureOutputMarker(child: PtyChildDriver): ChildOutputMarker {
  const visibleOutput = child.getVisibleOutput();
  return {
    outputLength: child.getOutput().length,
    visibleLength: visibleOutput.length,
  };
}

async function waitForNewVisibleOutput(
  child: PtyChildDriver,
  text: string,
  outputMarker: ChildOutputMarker,
  timeoutMs: number,
): Promise<void> {
  await child.waitForState(
    (snapshot) =>
      snapshot.output.length > outputMarker.outputLength &&
      snapshot.visibleOutput.length > outputMarker.visibleLength &&
      snapshot.output.slice(outputMarker.outputLength).includes(text),
    timeoutMs,
  );
}

async function writeStatelessSettings(settingsDir: string, row: StatelessProviderRow, baseUrl: string): Promise<void> {
  await mkdir(settingsDir, { recursive: true });

  const providerEntry = row.runtimeType
    ? {
        id: row.providerId,
        name: row.label,
        type: row.runtimeType,
        baseUrl: `${baseUrl}${row.basePath}`,
        apiKey: 'fixture-key',
      }
    : undefined;

  await writeFile(
    join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: {
        model: row.model,
        provider: row.providerId,
        reasoningEffort: 'medium',
        retryAttempts: 0,
        transport: 'http',
        maxTurns: 20,
        ...(row.id === 'openrouter-http'
          ? {
              openrouter: {
                apiKey: 'fixture-key',
                baseUrl: `${baseUrl}${row.basePath}`,
                referrer: 'https://fixture.test',
                title: 'stateless-provider-blackbox',
              },
            }
          : {}),
      },
      app: { liteMode: false },
      ...(providerEntry ? { providers: [providerEntry] } : {}),
    }),
  );
}

function assertProviderRoute(row: StatelessProviderRow, requests: readonly CapturedStatelessRequest[]): void {
  for (const request of requests) {
    expect(request.method, row.id).toBe('POST');
    if (row.protocol !== 'google') expect(request.body.model, row.id).toBe(row.model);
    if (row.protocol === 'chat-completions') {
      expect(request.url, row.id).toBe(`${row.basePath}/chat/completions` || '/chat/completions');
    } else if (row.protocol === 'anthropic') {
      expect(request.url, row.id).toBe(`${row.basePath}/messages` || '/messages');
    } else {
      expect(request.url, row.id).toContain(`${row.basePath}/models/${row.model}:streamGenerateContent`);
    }
  }

  if (row.runtimeType) {
    // This is deliberately route-specific evidence for the aliases that share
    // Chat Completions. The child loaded this provider from its settings.json,
    // which registers it in the application registry before the CLI validates
    // --provider and creates the session model.
    expect(row.providerId).toContain(row.id.startsWith('opencode') ? 'opencode' : 'runtime');
  }

  if (row.runtimeType === 'opencode') {
    const sessionId = requests[0]?.headers['x-opencode-session'];
    expect(sessionId, `${row.id} OpenCode session header`).toMatch(/^ses_[0-9a-zA-Z]{26}$/);
    for (const request of requests) {
      expect(request.headers['x-opencode-session'], `${row.id} stable OpenCode session header`).toBe(sessionId);
    }
  }
}

function assertHistoryAndNativeShape(row: StatelessProviderRow, requests: readonly CapturedStatelessRequest[]): void {
  const first = requests[0]!.body;
  const second = requests[1]!.body;
  const approvedResume = requests[3]!.body;
  const rejectedResume = requests[5]!.body;

  if (row.protocol === 'chat-completions') {
    for (const body of requests.map((request) => request.body)) assertChatRequestShape(body, row);
    expect(
      nonSystemMessages(second).map((message) => message.role),
      row.id,
    ).toEqual(['user', 'assistant', 'user']);
    expect(
      nonSystemMessages(approvedResume).map((message) => message.role),
      row.id,
    ).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'tool']);
    expect(
      nonSystemMessages(rejectedResume).map((message) => message.role),
      row.id,
    ).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
      'assistant',
      'tool',
    ]);
    assertChatToolHistory(approvedResume, [APPROVAL_CALL_ID]);
    assertChatToolHistory(rejectedResume, [APPROVAL_CALL_ID, REJECTION_CALL_ID], 'black-box rejection');
    expect(nonSystemMessages(first), row.id).toHaveLength(1);
    return;
  }

  if (row.protocol === 'anthropic') {
    for (const body of requests.map((request) => request.body)) assertAnthropicRequestShape(body, row);
    expect(
      nonSystemMessages(second, 'messages').map((message) => message.role),
      row.id,
    ).toEqual(['user', 'assistant', 'user']);
    expect(
      nonSystemMessages(approvedResume, 'messages').map((message) => message.role),
      row.id,
    ).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(
      nonSystemMessages(rejectedResume, 'messages').map((message) => message.role),
      row.id,
    ).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    assertAnthropicToolHistory(approvedResume, [APPROVAL_CALL_ID]);
    assertAnthropicToolHistory(rejectedResume, [APPROVAL_CALL_ID, REJECTION_CALL_ID], 'black-box rejection');
    expect(nonSystemMessages(first, 'messages'), row.id).toHaveLength(1);
    return;
  }

  for (const body of requests.map((request) => request.body)) assertGoogleRequestShape(body, row);
  expect(
    contents(second).map((message) => message.role),
    row.id,
  ).toEqual(['user', 'model', 'user']);
  expect(
    contents(approvedResume).map((message) => message.role),
    row.id,
  ).toEqual(['user', 'model', 'user', 'model', 'user', 'model', 'user']);
  expect(
    contents(rejectedResume).map((message) => message.role),
    row.id,
  ).toEqual(['user', 'model', 'user', 'model', 'user', 'model', 'user', 'model', 'user', 'model', 'user']);
  assertGoogleToolHistory(approvedResume, 1);
  assertGoogleToolHistory(rejectedResume, 2, 'black-box rejection');
  expect(contents(first), row.id).toHaveLength(1);
}

function assertChatRequestShape(body: Record<string, unknown>, row: StatelessProviderRow): void {
  expect(body.model).toBe(row.model);
  expect(body.stream).toBe(true);
  expect(body.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'shell' }) }),
    ]),
  );
  if (row.runtimeType === 'llama.cpp') {
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.chat_template_kwargs).toEqual({
      reasoning_effort: 'medium',
      enable_thinking: true,
      thinking_mode: 'medium',
      reasoning_budget: 4096,
    });
  } else if (row.providerId !== 'openrouter') {
    expect(body.reasoning_effort).toBe('medium');
  }
  expect(JSON.stringify(body)).not.toContain('callId');

  if (row.providerId.startsWith('opencode')) {
    expect(row.basePath).toBe('/zen/go/v1');
  }
}

function assertChatToolHistory(
  body: Record<string, unknown>,
  expectedCallIds: readonly string[],
  rejectionReason?: string,
): void {
  const messages = body.messages as Array<Record<string, unknown>>;
  const calls = messages.flatMap((message) => (Array.isArray(message.tool_calls) ? message.tool_calls : [])) as Array<
    Record<string, unknown>
  >;
  const results = messages.filter((message) => message.role === 'tool');
  expect(calls.map((call) => call.id)).toEqual(expectedCallIds);
  expect(results.map((result) => result.tool_call_id)).toEqual(expectedCallIds);
  for (const call of calls) {
    expect(call.type).toBe('function');
    expect(call.function).toEqual(expect.objectContaining({ name: 'shell' }));
  }
  if (rejectionReason) {
    expect(results.at(-1)?.content).toEqual(expect.stringContaining(rejectionReason));
  }
}

function assertAnthropicRequestShape(body: Record<string, unknown>, row: StatelessProviderRow): void {
  expect(body.model).toBe(row.model);
  expect(body.stream).toBe(true);
  expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  expect(body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'shell' })]));
  expect(JSON.stringify(body)).not.toContain('callId');
}

function assertAnthropicToolHistory(
  body: Record<string, unknown>,
  expectedCallIds: readonly string[],
  rejectionReason?: string,
): void {
  const messages = body.messages as Array<Record<string, unknown>>;
  const blocks = messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])) as Array<
    Record<string, unknown>
  >;
  const calls = blocks.filter((block) => block.type === 'tool_use');
  const results = blocks.filter((block) => block.type === 'tool_result');
  expect(calls.map((call) => call.id)).toEqual(expectedCallIds);
  expect(results.map((result) => result.tool_use_id)).toEqual(expectedCallIds);
  expect(calls.map((call) => call.name)).toEqual(expectedCallIds.map(() => 'shell'));
  if (rejectionReason) {
    expect(JSON.stringify(results.at(-1))).toContain(rejectionReason);
  }
}

function assertGoogleRequestShape(body: Record<string, unknown>, row: StatelessProviderRow): void {
  expect(body.contents).toBeInstanceOf(Array);
  expect(body.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        functionDeclarations: expect.arrayContaining([expect.objectContaining({ name: 'shell' })]),
      }),
    ]),
  );
  expect(body.generationConfig).toEqual(
    expect.objectContaining({ thinkingConfig: { thinkingBudget: 4096, includeThoughts: true } }),
  );
  expect(JSON.stringify(body)).not.toContain('callId');
  expect(row.basePath).toBe('/v1beta');
}

function assertGoogleToolHistory(
  body: Record<string, unknown>,
  expectedPairCount: number,
  rejectionReason?: string,
): void {
  const blocks = contents(body).flatMap((message) => message.parts) as Array<Record<string, unknown>>;
  const calls = blocks.filter((part) => part.functionCall) as Array<Record<string, unknown>>;
  const results = blocks.filter((part) => part.functionResponse) as Array<Record<string, unknown>>;
  expect(calls).toHaveLength(expectedPairCount);
  expect(results).toHaveLength(expectedPairCount);
  expect(calls.map((part) => (part.functionCall as Record<string, unknown>).name)).toEqual(
    expectedCallCountNames(expectedPairCount),
  );
  expect(results.map((part) => (part.functionResponse as Record<string, unknown>).name)).toEqual(
    expectedCallCountNames(expectedPairCount),
  );
  if (rejectionReason) expect(JSON.stringify(results.at(-1))).toContain(rejectionReason);
}

function expectedCallCountNames(count: number): string[] {
  return Array.from({ length: count }, () => 'shell');
}

function nonSystemMessages(body: Record<string, unknown>, key = 'messages'): Array<Record<string, unknown>> {
  const messages = body[key] as Array<Record<string, unknown>>;
  return messages.filter((message) => message.role !== 'system');
}

function contents(body: Record<string, unknown>): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
  return body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
}

async function startStatelessLifecycleServer(row: StatelessProviderRow): Promise<StatelessLifecycleServer> {
  const requests: CapturedStatelessRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    const captured: CapturedStatelessRequest = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: normalizeHeaders(request),
      body,
    };
    requests.push(captured);

    const requestNumber = requests.length;
    if (requestNumber > 6) {
      response.writeHead(500, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ error: { message: 'Unexpected extra stateless lifecycle request' } }));
      return;
    }

    response.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'close',
      'content-type': 'text/event-stream',
    });
    writeProviderResponse(row, response, requestNumber);
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Stateless lifecycle fake server did not bind');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function writeProviderResponse(row: StatelessProviderRow, response: ServerResponse, requestNumber: number): void {
  const { protocol } = row;
  const isToolRequest = requestNumber === 3 || requestNumber === 5;
  const callId = requestNumber === 3 ? APPROVAL_CALL_ID : REJECTION_CALL_ID;
  if (protocol === 'chat-completions') {
    const id = `chat-response-${requestNumber}`;
    const frames = isToolRequest
      ? [
          {
            data: {
              id,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: callId,
                        type: 'function',
                        function: { name: 'shell', arguments: TOOL_CALL_ARGUMENTS },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
          },
          { data: { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
        ]
      : [
          {
            data: {
              id,
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: responseText(requestNumber) },
                  finish_reason: 'stop',
                },
              ],
            },
          },
        ];
    writeSseFrames(response, frames);
    response.write('data: [DONE]\n\n');
    return;
  }

  if (protocol === 'anthropic') {
    const messageId = `message-${requestNumber}`;
    const frames = isToolRequest
      ? [
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: row.model,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: callId, name: 'shell', input: {} },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: TOOL_CALL_ARGUMENTS },
            },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          {
            event: 'message_delta',
            data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]
      : [
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: row.model,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: responseText(requestNumber) },
            },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          {
            event: 'message_delta',
            data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ];
    writeSseFrames(response, frames);
    return;
  }

  const parts = isToolRequest
    ? [{ functionCall: { name: 'shell', args: { command: 'true', sandbox: 'unsandboxed' } } }]
    : [{ text: responseText(requestNumber) }];
  writeSseFrames(response, [
    {
      data: {
        candidates: [
          {
            content: { role: 'model', parts },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        responseId: `google-response-${requestNumber}`,
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
    },
  ]);
}

function responseText(requestNumber: number): string {
  if (requestNumber === 1) return 'first-response';
  if (requestNumber === 2) return 'second-response';
  if (requestNumber === 4) return 'approved-response';
  return 'rejected-response';
}

function writeSseFrames(response: ServerResponse, frames: readonly { event?: string; data: unknown }[]): void {
  for (const frame of frames) {
    if (frame.event) response.write(`event: ${frame.event}\n`);
    response.write(`data: ${typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)}\n\n`);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await new Promise<string>((resolve, reject) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      text += chunk;
    });
    request.on('end', () => resolve(text));
    request.on('error', reject);
  });
  const parsed: unknown = body ? JSON.parse(body) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stateless lifecycle request body was not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function normalizeHeaders(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value)]),
  );
}
