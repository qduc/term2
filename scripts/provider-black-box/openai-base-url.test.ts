import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import '../../source/providers/index.js';
import { getProvider } from '../../source/providers/registry.js';
import type { ILoggingService, ISettingsService } from '../../source/services/service-interfaces.js';
import { collectStream } from './provider-test-harness.js';
import { createIsolatedWorkspaceLease, type IsolatedWorkspaceLease } from './provider-test-harness.js';

let workspace: IsolatedWorkspaceLease | undefined;
let server: Server | undefined;

afterEach(async () => {
  const currentWorkspace = workspace;
  const currentServer = server;
  workspace = undefined;
  server = undefined;
  try {
    await currentWorkspace?.cleanup();
  } finally {
    await closeServer(currentServer);
  }
});

describe('OpenAI endpoint redirection', () => {
  it('proves the installed OpenAI client honors OPENAI_BASE_URL without fetch rewriting', async () => {
    let requestPath = '';
    server = createServer((request, response) => {
      requestPath = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ id: 'resp_fixture', object: 'response', status: 'completed', output: [], usage: {} }),
      );
    });
    const baseUrl = await listen(server);
    workspace = await createIsolatedWorkspaceLease();
    const child = await workspace.start({
      command: process.execPath,
      args: ['scripts/provider-black-box/provider-harness-child.mjs', 'openai-base-url'],
      env: { OPENAI_BASE_URL: baseUrl },
    });
    await child.waitForOutput('openai response: resp_fixture');
    await expect(child.waitForExit()).resolves.toMatchObject({ exitCode: 0 });
    expect(requestPath).toBe('/v1/responses');
  });

  it.sequential('routes the application-owned OpenAI provider to OPENAI_BASE_URL', async () => {
    let requestPath = '';
    server = createServer((request, response) => {
      requestPath = request.url ?? '';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        [
          { type: 'response.created', response: { id: 'resp_provider_fixture', status: 'in_progress' } },
          { type: 'response.output_text.delta', delta: 'hello' },
          {
            type: 'response.completed',
            response: {
              id: 'resp_provider_fixture',
              status: 'completed',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
            },
          },
        ]
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
          .concat('data: [DONE]\n\n')
          .join(''),
      );
    });
    const baseUrl = await listen(server);
    const previousBaseUrl = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = baseUrl;
    try {
      const provider = getProvider('openai');
      expect(provider?.createStreamedModel).toBeTypeOf('function');
      const settings = {
        get(key: string) {
          return ({
            'agent.model': 'fixture',
            'agent.openai.apiKey': 'fixture-key',
            'agent.retryAttempts': 0,
            'agent.transport': 'http',
          }[key] ?? undefined) as never;
        },
      } as ISettingsService;
      const model = await provider!.createStreamedModel!('fixture', {
        settingsService: settings,
        loggingService: quietLogging,
      });
      const events = await collectStream(
        model.stream({
          input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          tools: [],
        } as any),
      );
      expect(events.at(-1)).toMatchObject({ type: 'completion', responseId: 'resp_provider_fixture' });
      expect(requestPath).toBe('/v1/responses');
    } finally {
      if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
  });
});

const quietLogging: ILoggingService = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId() {
    return undefined;
  },
  clearCorrelationId() {},
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Endpoint test server did not bind.');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
