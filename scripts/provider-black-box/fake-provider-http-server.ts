import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type FakeProviderScenario = 'success' | 'error' | 'early-close' | 'incomplete' | 'tool-fragments' | 'reasoning';

export interface FakeProviderHttpServer {
  readonly baseUrl: string;
  readonly requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }>;
  close(): Promise<void>;
}

export async function startFakeProviderHttpServer(options: {
  scenario: FakeProviderScenario;
  protocol?: 'chat-completions' | 'responses' | 'anthropic' | 'google';
  port?: number;
}): Promise<FakeProviderHttpServer> {
  const requests: FakeProviderHttpServer['requests'] = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    let parsed: unknown = body;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      /* preserve malformed input */
    }
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body: parsed });
    if (options.scenario === 'error') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Injected provider failure' } }));
      return;
    }
    if (options.scenario === 'early-close') {
      res.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close', 'cache-control': 'no-cache' });
    const protocol = options.protocol ?? 'chat-completions';
    const frames = framesFor(protocol, options.scenario);
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    if (options.scenario !== 'incomplete') res.write('data: [DONE]\n\n');
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
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function framesFor(
  protocol: 'chat-completions' | 'responses' | 'anthropic' | 'google',
  scenario: FakeProviderScenario,
): Record<string, unknown>[] {
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
