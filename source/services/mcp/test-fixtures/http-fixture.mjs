// Streamable HTTP fixture backed by the real v2 SDK server package.
import { createServer } from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

const server = new McpServer({ name: 'http-fixture', version: '1.0.0' });
server.registerTool(
  'echo',
  { description: 'echoes its arguments', inputSchema: z.object({ message: z.string().optional() }) },
  async (args) => ({
    content: [{ type: 'text', text: `echo:${JSON.stringify(args ?? {})}` }],
    structuredContent: { echo: args ?? {} },
  }),
);
server.registerTool('fail', { description: 'always reports a tool failure', inputSchema: z.object({}) }, async () => ({
  content: [{ type: 'text', text: 'boom' }],
  isError: true,
}));

const handler = createMcpHandler(() => server);
const http = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const init = {
    method: req.method,
    headers: req.headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
  };
  const response = await handler.fetch(new Request(`http://${req.headers.host}${req.url}`, init));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    for await (const chunk of response.body) res.write(chunk);
  }
  res.end();
});
http.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: http.address().port }) + '\n'));
