import { createServer, type IncomingMessage } from 'node:http';
import type { FixtureEnvelopeV1, HttpRequestFrame } from './fixture-envelope.js';
import { compareRecordedRequest } from './fixture-comparator.js';

export type FakeProviderScenario = 'success' | 'error' | 'early-close' | 'incomplete' | 'tool-fragments' | 'reasoning';
export type FakeProviderProtocol = 'chat-completions' | 'responses' | 'anthropic' | 'google';
export type CapturedHttpRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

export interface FakeProviderHttpServer {
  readonly baseUrl: string;
  readonly requests: CapturedHttpRequest[];
  readonly comparisonFailures: string[];
  close(): Promise<void>;
  assertReplayValid(): void;
}

export async function startFakeProviderHttpServer(options: {
  scenario?: FakeProviderScenario;
  protocol?: FakeProviderProtocol;
  fixture?: FixtureEnvelopeV1;
  port?: number;
}): Promise<FakeProviderHttpServer> {
  if (!options.scenario && !options.fixture) throw new Error('Fake provider server needs a scenario or fixture');
  const requests: CapturedHttpRequest[] = [];
  const comparisonFailures: string[] = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    let parsed: unknown = body;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      /* preserve malformed input */
    }
    const request: CapturedHttpRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      body: parsed,
    };
    requests.push(request);
    if (options.fixture) {
      replayTurn(options.fixture, requests.length - 1, request, res, comparisonFailures);
      return;
    }
    const scenario = options.scenario!;
    if (scenario === 'error') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Injected provider failure' } }));
      return;
    }
    if (scenario === 'early-close') {
      res.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close', 'cache-control': 'no-cache' });
    for (const frame of framesFor(options.protocol ?? 'chat-completions', scenario))
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    if (scenario !== 'incomplete') res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake provider server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    comparisonFailures,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    assertReplayValid: () => {
      if (comparisonFailures.length) throw new Error(comparisonFailures.join('\n'));
      if (
        options.fixture &&
        requests.length !==
          options.fixture.turns.filter((turn) => turn.frames.some((frame) => frame.kind === 'http-request')).length
      )
        throw new Error(`Replay expected ${options.fixture.turns.length} request turn(s), got ${requests.length}`);
    },
  };
}

function replayTurn(
  fixture: FixtureEnvelopeV1,
  turnIndex: number,
  request: CapturedHttpRequest,
  res: import('node:http').ServerResponse,
  failures: string[],
): void {
  const turns = fixture.turns.filter((turn) => turn.frames.some((frame) => frame.kind === 'http-request'));
  const turn = turns[turnIndex];
  if (!turn) {
    failures.push(`Unexpected replay request #${turnIndex + 1}`);
    res.writeHead(500);
    res.end('Unexpected replay request');
    return;
  }
  const expected = turn.frames.find((frame): frame is HttpRequestFrame => frame.kind === 'http-request')!;
  const actual: HttpRequestFrame = {
    seq: expected.seq,
    kind: 'http-request',
    method: request.method,
    urlPath: request.url,
    headers: normalizeHeaders(request.headers),
    body: request.body,
  };
  const comparison = compareRecordedRequest(expected, actual, { placeholders: fixture.placeholders });
  if (!comparison.equal) failures.push(comparison.diff!);
  const head = turn.frames.find((frame) => frame.kind === 'http-response-head');
  const status = head?.kind === 'http-response-head' ? head.status : 200;
  const headers = head?.kind === 'http-response-head' ? head.headers : { 'content-type': 'text/event-stream' };
  res.writeHead(status, headers);
  const responseFrames = turn.frames.filter((frame) => frame.seq > expected.seq);
  let wrote = false;
  for (const frame of responseFrames) {
    if (frame.kind === 'sse-event') {
      if (frame.event) res.write(`event: ${frame.event}\n`);
      res.write(`data: ${frame.data}\n\n`);
      wrote = true;
    } else if (frame.kind === 'json-body') {
      res.write(JSON.stringify(frame.body));
      wrote = true;
    }
  }
  if (!wrote && status >= 400) res.write(JSON.stringify({ error: { message: 'Recorded provider failure' } }));
  res.end();
}

export function framesFor(protocol: FakeProviderProtocol, scenario: FakeProviderScenario): Record<string, unknown>[] {
  if (protocol === 'anthropic')
    return [
      {
        type: 'message_start',
        message: {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'fake',
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      ...(scenario === 'reasoning'
        ? [{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'reason' } }]
        : []),
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
  if (protocol === 'google')
    return [{ candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }] }];
  if (protocol === 'responses')
    return [
      { type: 'response.created', response: { id: 'resp_fake', status: 'in_progress' } },
      { type: 'response.output_text.delta', delta: 'hello' },
      ...(scenario === 'incomplete'
        ? []
        : [
            {
              type: 'response.completed',
              response: {
                id: 'resp_fake',
                status: 'completed',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
              },
            },
          ]),
    ];
  if (scenario === 'tool-fragments')
    return [
      {
        id: 'chatcmpl_fake',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                { index: 0, id: 'call_fake', type: 'function', function: { name: 'fixture', arguments: '{"a"' } },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl_fake',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }],
      },
    ];
  return [
    {
      id: 'chatcmpl_fake',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    },
  ];
}

function normalizeHeaders(headers: CapturedHttpRequest['headers']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value)]),
  );
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
