// Loopback fake provider: OpenAI-compatible chat completions over SSE. No real provider, no network.
// A responder decides each reply from the request body, so the same script drives both CLIs identically.
import http from 'node:http';

/**
 * A reply is one of:
 *   { text }                         one delta, then stop
 *   { deltas: string[], everyMs }    streamed deltas with a delay between them (a reply "streaming")
 *   { toolCalls: [{ name, arguments }] }
 */
export async function startProvider(responder) {
  const requests = [];
  const open = new Set();
  let streaming = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }, { id: 'mock-beta' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep null
      }
      requests.push(body);
      const n = requests.length;
      const reply = (await responder(body, n, raw)) ?? { text: 'done' };
      const id = `chatcmpl-${n}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      req.socket.setNoDelay(true);
      open.add(res);
      res.on('close', () => open.delete(res));
      const send = (frame) => !res.writableEnded && res.write(`data: ${JSON.stringify(frame)}\n\n`);
      const end = (usage = true) => {
        send({
          id,
          choices: [{ delta: {}, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }],
          ...(usage ? { usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } } : {}),
        });
        if (!res.writableEnded) res.end('data: [DONE]\n\n');
      };
      if (reply.toolCalls) {
        send({
          id,
          choices: [
            {
              delta: {
                role: 'assistant',
                tool_calls: reply.toolCalls.map((call, index) => ({
                  index,
                  id: `call_${n}_${index}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
                })),
              },
            },
          ],
        });
        end();
        return;
      }
      if (reply.deltas) {
        streaming += 1;
        try {
          send({ id, choices: [{ delta: { role: 'assistant', content: '' } }] });
          for (const delta of reply.deltas) {
            if (res.writableEnded || res.destroyed) return;
            send({ id, choices: [{ delta: { content: delta } }] });
            if (reply.everyMs) await new Promise((resolve) => setTimeout(resolve, reply.everyMs));
          }
          end();
        } finally {
          streaming -= 1;
        }
        return;
      }
      send({ id, choices: [{ delta: { role: 'assistant', content: reply.text ?? 'done' } }] });
      end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    /** Replies currently streaming deltas (the client has not cancelled them). */
    activeStreams: () => streaming,
    async close() {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Text of the last user message in a chat-completions request. */
export function lastUserText(body) {
  const messages = body?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => part.text ?? '').join('');
  }
  return '';
}

/** True when the last message is a tool result (the model is being asked to continue after a tool). */
export function afterToolResult(body) {
  const messages = body?.messages ?? [];
  return messages.at(-1)?.role === 'tool';
}

export function isCompactionRequest(raw) {
  return raw.includes('[Host context-compaction request]') || raw.includes('# Historical transcript chunk') || /summar(y|ize) (the|this) conversation/i.test(raw);
}
