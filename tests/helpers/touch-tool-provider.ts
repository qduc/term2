import http from 'node:http';

/**
 * A loopback OpenAI-compatible model for approval-posture tests. When the latest message is a user
 * message naming `create <file>.txt`, it asks to run `touch <file>.txt` in the shell, which needs
 * approval unless something approves it; after a tool result it answers `done`. Each tool result it
 * receives is kept in order: a refused call's result carries the refusal reason.
 */
export async function startTouchToolProvider(): Promise<{
  readonly baseUrl: string;
  readonly toolResults: readonly string[];
  readonly close: () => Promise<void>;
}> {
  const toolResults: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'touch-model' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      const messages = (JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> }).messages;
      const last = messages.at(-1);
      if (last?.role === 'tool') toolResults.push(JSON.stringify(last.content));
      const target = /create ([\w.-]+\.txt)/.exec(JSON.stringify(last?.content ?? ''))?.[1];
      const delta =
        last?.role === 'user' && target
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${target}`,
                  type: 'function',
                  function: {
                    name: 'shell',
                    arguments: JSON.stringify({ command: `touch ${target}`, description: 'Create a file' }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'done' };
      const finish = 'tool_calls' in delta ? 'tool_calls' : 'stop';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          `data: ${JSON.stringify({ id: 'c', choices: [{ delta }] })}`,
          '',
          `data: ${JSON.stringify({ id: 'c', choices: [{ delta: {}, finish_reason: finish }] })}`,
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`,
    toolResults,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The approval policy's reason for refusing a request no person can approve, with and without auto-approve. */
export const HEADLESS_AUTO_APPROVE_REFUSAL = 'No person is available to approve this in a non-interactive run.';
export const HEADLESS_REFUSAL = 'Non-interactive mode: use --auto-approve to allow tool execution';
