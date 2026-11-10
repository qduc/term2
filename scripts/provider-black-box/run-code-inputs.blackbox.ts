import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

it('advertises nonrecursive run_code inputs while preserving nested data and canonical rejection', async () => {
  const requests: Array<{ tools: Array<{ function: { name: string; parameters: unknown } }>; messages: unknown[] }> =
    [];
  const nested = JSON.parse('{"user":{"children":[{"name":"Bob","values":[null,true,3]}]}}');
  const expected = 'Bob|true|true|3|true';
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: 'meta/muse-ember', created: Math.floor(Date.now() / 1000), supported_parameters: ['tools'] }],
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const tool = body.tools.find((tool: { function: { name: string } }) => tool.function.name === 'run_code');
    if (JSON.stringify(tool?.function.parameters).includes('"$ref"')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Recursive JSON schemas are not currently supported' } }));
      return;
    }
    const ordinal = requests.length;
    const call = ordinal <= 3;
    const args =
      ordinal === 1
        ? {
            description: 'Read nested JSON inside the script realm',
            inputs: nested,
            code: 'return [inputs.user.children[0].name, inputs.user.children[0].values[0] === null, inputs.user.children[0].values[1], inputs.user.children[0].values[2], Object.getPrototypeOf(inputs).polluted === undefined].join("|");',
          }
        : {
            description: 'Reject invalid inputs before execution',
            inputs: ordinal === 2 ? [1] : 'invalid',
            code: 'throw new Error("INVALID_SCRIPT_RAN");',
          };
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: `inputs-${ordinal}`,
              type: 'function',
              function: { name: 'run_code', arguments: JSON.stringify(args) },
            },
          ],
        }
      : { content: 'RUN_CODE_INPUTS_OK' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = [
      { id: `reply-${ordinal}`, choices: [{ index: 0, delta }] },
      { id: `reply-${ordinal}`, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
    ];
    res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n'].join(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const workspace = await createIsolatedWorkspaceLease({
    prepare: async (root, paths) => {
      await mkdir(join(root, 'project'));
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            modelSelection: { provider: 'openrouter', model: 'meta/muse-ember' },
            retryAttempts: 0,
            openrouter: { apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1` },
          },
          sandbox: { enabled: false },
        }),
      );
    },
  });
  try {
    const result = await workspace.runCli({
      cwd: join(workspace.root, 'project'),
      args: ['--auto-approve', '--json', 'Execute the scripted JSON inputs checks.'],
      deadlineMs: 15000,
    });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('RUN_CODE_INPUTS_OK');
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      const schema = request.tools.find((tool) => tool.function.name === 'run_code')!.function.parameters;
      expect(schema).toMatchObject({ properties: { inputs: { type: 'object', additionalProperties: {} } } });
      expect(JSON.stringify(schema)).not.toContain('"$ref"');
    }
    expect(JSON.stringify(requests[1]!.messages)).toContain(expected);
    for (const request of requests.slice(2)) {
      expect(JSON.stringify(request.messages)).toContain('Tool input did not match schema for run_code');
      expect(JSON.stringify(request.messages)).not.toContain('Script failed: INVALID_SCRIPT_RAN');
    }
  } finally {
    await workspace.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
