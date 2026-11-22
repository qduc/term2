// Credentials supplied through the environment: which key the built CLI puts on the wire, in which header,
// and which one wins when `settings.json` supplies one as well: a non-empty saved key wins and the variable is a
// fallback, for the built-in providers, web search and custom providers alike.
//
// Every case is one headless run of the built CLI against a loopback server with HOME, XDG, TERM2_CONFIG_DIR
// and temp directories of its own, and a child environment that carries only the key under test.
// Web search is run end to end too: the fake model asks for `web_search` and the search backend is the
// loopback server. Tavily and Exa have fixed https URLs in the product, so a `--import` preload moves a
// `fetch` to those two hosts onto loopback (tests/helpers/oauth-login-fixture.ts); Firecrawl and SearXNG
// take their base URL from the environment and need no redirection.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrationCliPath as cliPath } from '../helpers/integration-cli.js';
import { createTestChildEnv } from '../helpers/terminal-e2e.js';
import { redirectHostsEnv } from '../helpers/oauth-login-fixture.js';
import {
  startFakeProviderHttpServer,
  type CapturedHttpRequest,
  type FakeProviderHttpServer,
  type FakeProviderProtocol,
} from '../../scripts/provider-black-box/fake-provider-http-server.js';
import {
  completedFrame,
  createdFrame,
  messageOutput,
  sendSse,
  startGrokFixtureServer,
  startRefusingProxy,
  textFrames,
  type GrokFixtureServer,
  type RefusingProxy,
} from '../../scripts/provider-black-box/grok-fixture.js';

const TIMEOUT = 30_000;
let refusingProxy: RefusingProxy;
beforeAll(async () => {
  refusingProxy = await startRefusingProxy();
});
afterAll(async () => {
  await refusingProxy.close();
});

type Run = { status: number | null; stdout: string; stderr: string };
type Wire = Pick<FakeProviderHttpServer, 'baseUrl' | 'requests'> & { close(): Promise<void> };

/** Run the built CLI once, headless, in a sandbox of its own, then remove the sandbox. */
async function runCli(options: {
  args: string[];
  env?: Record<string, string>;
  settings?: Record<string, unknown>;
  extraEnv?: (root: string) => NodeJS.ProcessEnv;
}): Promise<Run> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-env-key-')));
  try {
    const dirs = {
      workspace: path.join(root, 'workspace'),
      home: path.join(root, 'home'),
      state: path.join(root, 'state'),
      scratch: path.join(root, 'scratch'),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    const settingsDir = path.join(dirs.state, 'term2-nodejs');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        app: { liteMode: true },
        sandbox: { enabled: false },
        ...options.settings,
        agent: { transport: 'http', retryAttempts: 0, ...(options.settings?.agent as object | undefined) },
      }),
    );
    const child = spawn('node', [cliPath(), '--lite', ...options.args], {
      cwd: dirs.workspace,
      env: createTestChildEnv({
        HOME: dirs.home,
        XDG_STATE_HOME: dirs.state,
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
        TERM2_CONFIG_DIR: path.join(root, 'config'),
        TERM2_CACHE_DIR: path.join(root, 'cache'),
        DISABLE_LOGGING: '1',
        TMPDIR: dirs.scratch,
        TEMP: dirs.scratch,
        TMP: dirs.scratch,
        // HTTPS the run reaches for beyond the fixtures (update check, catalogues) is refused here.
        ...refusingProxy.env,
        ...options.extraEnv?.(root),
        ...options.env,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT,
    });
    return await new Promise<Run>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const describeRun = (run: Run) =>
  `exit=${run.status}\nstdout=${run.stdout.slice(-500)}\nstderr=${run.stderr.slice(-500)}`;
const header = (request: CapturedHttpRequest | { headers: Record<string, unknown> }, name: string) => {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : (value as string | undefined);
};
/** Model requests only: the catalogue lookups some providers make are GETs. */
const modelRequests = (wire: Wire) => wire.requests.filter((request) => request.method === 'POST');

async function withFake<T>(protocol: FakeProviderProtocol, body: (wire: FakeProviderHttpServer) => Promise<T>) {
  const wire = await startFakeProviderHttpServer({ scenario: 'success', protocol });
  try {
    return await body(wire);
  } finally {
    await wire.close();
  }
}

const customProvider = (name: string, type: string, baseUrl: string, apiKey?: string) => ({
  providers: [{ id: name, name, type, baseUrl, ...(apiKey ? { apiKey } : {}) }],
  agent: { modelSelection: { provider: name, model: 'fixture-model' } },
});

describe.concurrent('API keys from the environment, through the built CLI', () => {
  describe('openai', () => {
    const answer = 'Answer from the loopback OpenAI.';
    async function openai(options: { env?: Record<string, string>; settingsKey?: string }) {
      const server = await startGrokFixtureServer((_request, number, response) =>
        sendSse(response, textFrames(`resp-env-${number}`, answer)),
      );
      try {
        const run = await runCli({
          args: ['--provider', 'openai', '--model', 'fixture-model', 'Say hello'],
          env: { OPENAI_BASE_URL: server.baseUrl, ...options.env },
          settings: options.settingsKey ? { agent: { openai: { apiKey: options.settingsKey } } } : undefined,
        });
        return { run, requests: server.requests.filter((request) => request.method === 'POST') };
      } finally {
        await server.close();
      }
    }

    it('sends OPENAI_API_KEY as the bearer token on the Responses request', { timeout: TIMEOUT }, async () => {
      const { run, requests } = await openai({ env: { OPENAI_API_KEY: 'env-openai-key' } });
      expect(run.status, describeRun(run)).toBe(0);
      expect(run.stdout).toContain(answer);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe('/v1/responses');
      expect(requests[0]!.headers.authorization).toBe('Bearer env-openai-key');
    });

    it('uses the key in settings.json when the environment has none', { timeout: TIMEOUT }, async () => {
      const { run, requests } = await openai({ settingsKey: 'settings-openai-key' });
      expect(run.status, describeRun(run)).toBe(0);
      expect(requests.map((request) => request.headers.authorization)).toEqual(['Bearer settings-openai-key']);
    });

    it('prefers settings.json over the environment when both supply a key', { timeout: TIMEOUT }, async () => {
      const { run, requests } = await openai({
        env: { OPENAI_API_KEY: 'env-openai-key' },
        settingsKey: 'settings-openai-key',
      });
      expect(run.status, describeRun(run)).toBe(0);
      expect(requests.map((request) => request.headers.authorization)).toEqual(['Bearer settings-openai-key']);
    });

    it("sends no other provider's key to OpenAI when it has none of its own", { timeout: TIMEOUT }, async () => {
      const { requests } = await openai({
        env: { OPENROUTER_API_KEY: 'env-openrouter-key', ANTHROPIC_API_KEY: 'env-anthropic-key' },
      });
      const sent = JSON.stringify(requests.map((request) => request.headers));
      expect(sent).not.toContain('env-openrouter-key');
      expect(sent).not.toContain('env-anthropic-key');
      // With no key at all the OpenAI SDK sends its own `Bearer placeholder` (it does not stop the run); that is
      // the only credential-shaped value allowed here.
      for (const request of requests)
        expect([undefined, 'Bearer placeholder']).toContain(request.headers.authorization);
    });

    it(
      'with no key and the default base URL fails before any request, and does not borrow another provider key',
      { timeout: TIMEOUT },
      async () => {
        await withFake('responses', async (wire) => {
          // No OPENAI_BASE_URL: the SDK would use https://api.openai.com, which the preload sends to the fixture
          // server, so a request that left the process would be counted here.
          const run = await runCli({
            args: ['--provider', 'openai', '--model', 'fixture-model', 'Say hello'],
            env: { OPENROUTER_API_KEY: 'env-openrouter-key', ANTHROPIC_API_KEY: 'env-anthropic-key' },
            extraEnv: (root) => redirectHostsEnv(root, wire.baseUrl, ['api.openai.com']),
          });
          expect(run.status, describeRun(run)).toBe(1);
          expect(run.stderr).toContain('OpenAI API key is not configured');
          expect(run.stderr).toContain('OPENAI_API_KEY');
          expect(modelRequests(wire), 'a model request was sent although no key is configured').toHaveLength(0);
          // The catalogue lookup is the only traffic left; it never carried a credential.
          for (const request of wire.requests) expect(header(request, 'authorization')).toBeUndefined();
        });
      },
    );
  });

  describe('openrouter', () => {
    async function openrouter(options: { env?: Record<string, string>; settingsKey?: string }) {
      return withFake('chat-completions', async (wire) => {
        const run = await runCli({
          args: ['--provider', 'openrouter', '--model', 'fixture/model', 'Say hello'],
          env: { OPENROUTER_BASE_URL: `${wire.baseUrl}/api/v1`, ...options.env },
          settings: options.settingsKey ? { agent: { openrouter: { apiKey: options.settingsKey } } } : undefined,
        });
        return { run, requests: modelRequests(wire) };
      });
    }

    it('sends OPENROUTER_API_KEY as the bearer token on the chat request', { timeout: TIMEOUT }, async () => {
      const { run, requests } = await openrouter({ env: { OPENROUTER_API_KEY: 'env-openrouter-key' } });
      expect(run.status, describeRun(run)).toBe(0);
      expect(run.stdout).toContain('hello');
      expect(requests.map((request) => [request.url, header(request, 'authorization')])).toEqual([
        ['/api/v1/chat/completions', 'Bearer env-openrouter-key'],
      ]);
    });

    it('uses the key in settings.json when the environment has none', { timeout: TIMEOUT }, async () => {
      const { run, requests } = await openrouter({ settingsKey: 'settings-openrouter-key' });
      expect(run.status, describeRun(run)).toBe(0);
      expect(requests.map((request) => header(request, 'authorization'))).toEqual(['Bearer settings-openrouter-key']);
    });

    it('prefers settings.json over the environment when both supply a key', { timeout: TIMEOUT }, async () => {
      const { run, requests } = await openrouter({
        env: { OPENROUTER_API_KEY: 'env-openrouter-key' },
        settingsKey: 'settings-openrouter-key',
      });
      expect(run.status, describeRun(run)).toBe(0);
      expect(requests.map((request) => header(request, 'authorization'))).toEqual(['Bearer settings-openrouter-key']);
    });

    it(
      'with no key anywhere fails before any model request, and does not borrow the OpenAI key',
      { timeout: TIMEOUT },
      async () => {
        const { run, requests } = await openrouter({ env: { OPENAI_API_KEY: 'env-openai-key' } });
        expect(run.status, describeRun(run)).toBe(1);
        expect(run.stderr).toContain('OpenRouter API key is not configured');
        expect(requests).toHaveLength(0);
      },
    );
  });

  describe('custom providers with a type-level environment variable', () => {
    const cases = [
      { type: 'anthropic', protocol: 'anthropic', variable: 'ANTHROPIC_API_KEY', base: '/v1', path: '/v1/messages' },
      {
        type: 'google',
        protocol: 'google',
        variable: 'GOOGLE_GENERATIVE_AI_API_KEY',
        base: '/v1beta',
        path: '/v1beta/models/fixture-model:streamGenerateContent?alt=sse',
      },
      {
        type: 'opencode',
        protocol: 'chat-completions',
        variable: 'OPENCODE_API_KEY',
        base: '/v1',
        path: '/v1/chat/completions',
      },
    ] as const;
    /** The header each type's adapter authenticates with. */
    const credentialOf = (type: string, request: CapturedHttpRequest) =>
      type === 'anthropic'
        ? header(request, 'x-api-key')
        : type === 'google'
        ? header(request, 'x-goog-api-key')
        : header(request, 'authorization');
    const expected = (type: string, key: string) => (type === 'opencode' ? `Bearer ${key}` : key);

    async function custom(
      entry: (typeof cases)[number],
      options: { env?: Record<string, string>; settingsKey?: string },
    ) {
      return withFake(entry.protocol, async (wire) => {
        // A hostname that is not loopback, as a real endpoint's is: the product treats loopback providers as
        // needing no key, which is a different path. The preload sends that one host to the fixture server.
        const host = `${entry.type}.fixture.test`;
        const run = await runCli({
          args: ['--provider', 'fixture-provider', '--model', 'fixture-model', 'Say hello'],
          env: options.env,
          settings: customProvider('fixture-provider', entry.type, `http://${host}${entry.base}`, options.settingsKey),
          extraEnv: (root) => redirectHostsEnv(root, wire.baseUrl, [host]),
        });
        return { run, requests: modelRequests(wire), all: [...wire.requests] };
      });
    }

    it.each(cases)('$type: $variable authenticates the model request', { timeout: TIMEOUT }, async (entry) => {
      const { run, requests } = await custom(entry, { env: { [entry.variable]: 'env-custom-key' } });
      expect(run.status, describeRun(run)).toBe(0);
      expect(run.stdout).toContain('hello');
      expect(requests.map((request) => request.url)).toEqual([entry.path]);
      expect(requests.map((request) => credentialOf(entry.type, request))).toEqual([
        expected(entry.type, 'env-custom-key'),
      ]);
    });

    it(
      'google: lists models with the key in x-goog-api-key, and no request URL carries the key',
      { timeout: TIMEOUT },
      async () => {
        const entry = cases[1];
        const { run, all } = await custom(entry, { env: { [entry.variable]: 'env-custom-key' } });
        expect(run.status, describeRun(run)).toBe(0);
        const lists = all.filter((request) => request.method === 'GET');
        expect(
          lists.map((request) => request.url),
          'no model-list request was made',
        ).toEqual(['/v1beta/models']);
        expect(lists.map((request) => header(request, 'x-goog-api-key'))).toEqual(['env-custom-key']);
        expect(all.map((request) => request.url).join('\n')).not.toContain('env-custom-key');
      },
    );

    it.each(cases)(
      '$type: when settings.json also has an apiKey for the provider, that one is sent, not $variable',
      { timeout: TIMEOUT },
      async (entry) => {
        const { run, requests } = await custom(entry, {
          env: { [entry.variable]: 'env-custom-key' },
          settingsKey: 'settings-custom-key',
        });
        expect(run.status, describeRun(run)).toBe(0);
        expect(requests.map((request) => credentialOf(entry.type, request))).toEqual([
          expected(entry.type, 'settings-custom-key'),
        ]);
      },
    );

    it.each(['openai-compatible', 'openai'] as const)(
      '%s: has no environment variable, so OPENAI_API_KEY and OPENROUTER_API_KEY are not sent to it',
      { timeout: TIMEOUT },
      async (type) => {
        await withFake('chat-completions', async (wire) => {
          const run = await runCli({
            args: ['--provider', 'fixture-provider', '--model', 'fixture-model', 'Say hello'],
            env: { OPENAI_API_KEY: 'env-openai-key', OPENROUTER_API_KEY: 'env-openrouter-key' },
            settings: customProvider('fixture-provider', type, `${wire.baseUrl}/v1`),
          });
          expect(run.status, describeRun(run)).toBe(0);
          const requests = modelRequests(wire);
          expect(requests).toHaveLength(1);
          expect(JSON.stringify(wire.requests.map((request) => request.headers))).not.toContain('env-');
          expect(header(requests[0]!, 'authorization')).toBeUndefined();
        });
      },
    );
  });

  describe('web search', () => {
    const MARKER = 'SEARCH-BACKEND-RESULT';
    type Backend = {
      origin: string;
      requests: Array<{ method: string; url: string; headers: Record<string, string>; body: string }>;
      close(): Promise<void>;
    };

    async function startBackend(): Promise<Backend> {
      const requests: Backend['requests'] = [];
      const server: Server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, String(v)])),
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        // One body every backend can read: Tavily/SearXNG `results[].content`, Exa `results[].highlights`,
        // Firecrawl `data[].description`.
        response.end(
          JSON.stringify({
            query: 'term2 fixture query',
            results: [{ title: 'Fixture hit', url: 'https://example.test/hit', content: MARKER, highlights: [MARKER] }],
            data: [{ title: 'Fixture hit', url: 'https://example.test/hit', description: MARKER }],
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Search backend did not bind');
      return {
        origin: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      };
    }

    const sendJsonBody = (response: import('node:http').ServerResponse, body: unknown) => {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(body));
    };

    /** A model that asks for one web search, then answers once it has the result. */
    function searchingModel(): Promise<GrokFixtureServer> {
      let posts = 0;
      return startGrokFixtureServer((request, _number, response) => {
        // The model catalogue lookup is a GET; only POSTs are turns.
        if (request.method !== 'POST') return sendJsonBody(response, { object: 'list', data: [] });
        posts += 1;
        if (posts > 1) return sendSse(response, textFrames(`resp-search-${posts}`, 'Searched.'));
        // The default profile offers web_search only inside run_code, as `tools.web_search`.
        const args = JSON.stringify({
          description: 'Search the web for the fixture query',
          code: "return await tools.web_search({ query: 'term2 fixture query' });",
        });
        const item = {
          id: 'item-ws',
          type: 'function_call',
          status: 'in_progress',
          arguments: '',
          call_id: 'call-ws',
          name: 'run_code',
        };
        const done = { ...item, status: 'completed', arguments: args };
        sendSse(response, [
          createdFrame('resp-search-1'),
          { type: 'response.output_item.added', item, output_index: 0 },
          {
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            call_id: item.call_id,
            delta: args,
            output_index: 0,
          },
          {
            type: 'response.function_call_arguments.done',
            item_id: item.id,
            call_id: item.call_id,
            arguments: args,
            output_index: 0,
          },
          { type: 'response.output_item.done', item: done, output_index: 0 },
          completedFrame('resp-search-1', [done]),
        ]);
      });
    }

    async function search(options: {
      env: Record<string, string>;
      settings?: Record<string, unknown>;
      redirectHosts?: string[];
      /** The search backend's origin is added to the child's environment under these names. */
      backendVariables?: string[];
    }) {
      const backend = await startBackend();
      const model = await searchingModel();
      try {
        const run = await runCli({
          args: ['--provider', 'openai', '--model', 'fixture-model', 'Search for the fixture'],
          env: {
            OPENAI_API_KEY: 'env-openai-key',
            OPENAI_BASE_URL: model.baseUrl,
            ...Object.fromEntries((options.backendVariables ?? []).map((name) => [name, backend.origin])),
            ...options.env,
          },
          settings: options.settings,
          extraEnv: (root) =>
            options.redirectHosts ? redirectHostsEnv(root, backend.origin, options.redirectHosts) : {},
        });
        const modelRequests = model.requests.filter((request) => request.method === 'POST');
        return { run, backend, modelRequests };
      } finally {
        await model.close();
        await backend.close();
      }
    }
    /** The tools the model can reach through run_code: its catalogue line names every tool outside the essentials. */
    const scriptTools = (request: GrokFixtureServer['requests'][number]): string[] => {
      const runCode = (request.body.tools as Array<{ name?: string; description?: string }>).find(
        (tool) => tool.name === 'run_code',
      );
      const line = /Other tools \(call tools\.describe\(name\) before use\): (.*)/.exec(
        runCode?.description ?? '',
      )?.[1];
      if (!line) throw new Error('run_code lists no other tools');
      return line.split(', ');
    };

    it('tavily: TAVILY_API_KEY is the api_key in the search request body', { timeout: TIMEOUT }, async () => {
      const { run, backend, modelRequests } = await search({
        env: { TAVILY_API_KEY: 'env-tavily-key', WEB_SEARCH_PROVIDER: 'tavily' },
        redirectHosts: ['api.tavily.com'],
      });
      expect(run.status, describeRun(run)).toBe(0);
      expect(scriptTools(modelRequests[0]!)).toContain('web_search');
      expect(backend.requests.map((request) => [request.method, request.url])).toEqual([['POST', '/search']]);
      expect(JSON.parse(backend.requests[0]!.body)).toMatchObject({
        api_key: 'env-tavily-key',
        query: 'term2 fixture query',
      });
      expect(JSON.stringify(modelRequests[1]!.body.input)).toContain(MARKER);
    });

    it('tavily: a key in settings.json wins over the environment key', { timeout: TIMEOUT }, async () => {
      const { run, backend } = await search({
        env: { TAVILY_API_KEY: 'env-tavily-key', WEB_SEARCH_PROVIDER: 'tavily' },
        settings: { webSearch: { tavily: { apiKey: 'settings-tavily-key' } } },
        redirectHosts: ['api.tavily.com'],
      });
      expect(run.status, describeRun(run)).toBe(0);
      expect(backend.requests.map((request) => JSON.parse(request.body).api_key)).toEqual(['settings-tavily-key']);
    });

    it('tavily: an empty key in settings.json falls back to the environment key', { timeout: TIMEOUT }, async () => {
      const { run, backend } = await search({
        env: { TAVILY_API_KEY: 'env-tavily-key', WEB_SEARCH_PROVIDER: 'tavily' },
        settings: { webSearch: { tavily: { apiKey: '' } } },
        redirectHosts: ['api.tavily.com'],
      });
      expect(run.status, describeRun(run)).toBe(0);
      expect(backend.requests.map((request) => JSON.parse(request.body).api_key)).toEqual(['env-tavily-key']);
    });

    it('exa: EXA_API_KEY is the x-api-key header of the search request', { timeout: TIMEOUT }, async () => {
      const { run, backend, modelRequests } = await search({
        env: { EXA_API_KEY: 'env-exa-key', WEB_SEARCH_PROVIDER: 'exa' },
        redirectHosts: ['api.exa.ai'],
      });
      expect(run.status, describeRun(run)).toBe(0);
      expect(backend.requests.map((request) => [request.method, request.url, request.headers['x-api-key']])).toEqual([
        ['POST', '/search', 'env-exa-key'],
      ]);
      expect(JSON.stringify(modelRequests[1]!.body.input)).toContain(MARKER);
    });

    it(
      'firecrawl: FIRECRAWL_API_KEY is the bearer token and FIRECRAWL_BASE_URL is where it goes',
      { timeout: TIMEOUT },
      async () => {
        const { run, backend } = await search({
          env: { FIRECRAWL_API_KEY: 'env-firecrawl-key', WEB_SEARCH_PROVIDER: 'firecrawl' },
          backendVariables: ['FIRECRAWL_BASE_URL'],
        });
        expect(run.status, describeRun(run)).toBe(0);
        expect(backend.requests.map((request) => [request.method, request.url, request.headers.authorization])).toEqual(
          [['POST', '/v1/search', 'Bearer env-firecrawl-key']],
        );
      },
    );

    it(
      'firecrawl: a base URL alone (a self-hosted instance) searches without any Authorization header',
      { timeout: TIMEOUT },
      async () => {
        const { run, backend } = await search({
          env: { WEB_SEARCH_PROVIDER: 'firecrawl' },
          backendVariables: ['FIRECRAWL_BASE_URL'],
        });
        expect(run.status, describeRun(run)).toBe(0);
        expect(backend.requests.map((request) => [request.url, request.headers.authorization])).toEqual([
          ['/v1/search', undefined],
        ]);
      },
    );

    it(
      'searxng: SEARXNG_BASE_URL is where the query goes, and no credential is sent',
      { timeout: TIMEOUT },
      async () => {
        const { run, backend, modelRequests } = await search({
          env: { WEB_SEARCH_PROVIDER: 'searxng' },
          backendVariables: ['SEARXNG_BASE_URL'],
        });
        expect(run.status, describeRun(run)).toBe(0);
        expect(backend.requests).toHaveLength(1);
        const request = backend.requests[0]!;
        const url = new URL(request.url, 'http://loopback');
        expect([request.method, url.pathname, url.searchParams.get('q'), url.searchParams.get('format')]).toEqual([
          'GET',
          '/search',
          'term2 fixture query',
          'json',
        ]);
        expect(request.headers.authorization).toBeUndefined();
        expect(JSON.stringify(modelRequests[1]!.body.input)).toContain(MARKER);
      },
    );

    it(
      'offers no web_search tool, and makes no search request, when no search credential is configured',
      { timeout: TIMEOUT },
      async () => {
        const { run, backend, modelRequests } = await search({ env: {} });
        expect(run.status, describeRun(run)).toBe(0);
        expect(scriptTools(modelRequests[0]!)).not.toContain('web_search');
        expect(backend.requests).toHaveLength(0);
      },
    );
  });
});
