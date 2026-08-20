import { it, expect, beforeAll, afterAll, vi } from 'vitest';
import { CodexResponsesModel, CodexResponsesTransport, CodexResponsesWSModel } from './codex-responses-model.js';
import type { StreamedModelTurnRequest } from '../contracts/streamed-model-turn.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProvider } from './index.js';
import {
  CodexTokenManager,
  resolveTokenPath,
  getJwtExpiry,
  extractAccountIdFromClaims,
  extractAccountId,
  resolveCodexClientVersion,
  sanitizeCodexRequestInit,
  addCodexResponsesLiteHeader,
  CodexProvider,
} from './codex.provider.js';

class FakeCodexResponsesTransport extends CodexResponsesTransport {
  readonly calls: Array<{ request: StreamedModelTurnRequest; stream: boolean; requestData: any }> = [];
  private readonly events: readonly any[];

  constructor(events: readonly any[] = []) {
    super();
    this.events = events;
  }

  override async fetchResponse(request: StreamedModelTurnRequest, stream: boolean, requestData: any): Promise<any> {
    this.calls.push({ request, stream, requestData });
    return (async function* (events: readonly any[]) {
      yield* events;
    })(this.events);
  }
}

const fakeCodexTokenManager = {
  getOrRefreshAccessToken: async () => 'test-token',
  getAccountId: () => undefined,
};

class HangingCodexResponsesTransport extends CodexResponsesTransport {
  signal?: AbortSignal;

  override async fetchResponse(request: StreamedModelTurnRequest, _stream: boolean, _requestData: any): Promise<any> {
    this.signal = request.signal;
    let reads = 0;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          reads += 1;
          return reads === 1
            ? Promise.resolve({ done: false, value: { type: 'response.created', response: { id: 'resp_1' } } })
            : new Promise(() => {});
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  }
}

function typedRequest(
  request: Omit<StreamedModelTurnRequest, 'tools'> & { tools?: StreamedModelTurnRequest['tools'] },
): StreamedModelTurnRequest {
  return { tools: [], ...request };
}

it('guards Codex tests against prototype monkey patches', () => {
  const source = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const modelPrototypePatch = new RegExp('(?:OpenAI|Codex)Responses(?:WS)?Model' + '\\.prototype');
  const methodAssignment = new RegExp('(?:raw' + 'Stream|fetch' + 'Response)\\s*=');
  expect(source).not.toMatch(modelPrototypePatch);
  expect(source).not.toMatch(methodAssignment);
});

// Helper to create a fake JWT with a specific expiry time in seconds from now
function createFakeJwt(expiresInSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

// Temporary directory inside the system temp directory for safe testing
const TEST_DIR = path.join(os.tmpdir(), `term2-temp-codex-test-${Math.random().toString(36).slice(2)}`);

beforeAll(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

it('getJwtExpiry decodes valid JWT and returns expiration timestamp', () => {
  const expSeconds = 3600;
  const jwt = createFakeJwt(expSeconds);
  const expiry = getJwtExpiry(jwt);
  expect(expiry).toBeTruthy();
  // Allow small clock drift tolerance
  const expected = Math.floor(Date.now() / 1000) + expSeconds;
  expect(Math.abs((expiry || 0) / 1000 - expected) < 2).toBe(true);
});

it('getJwtExpiry returns null for invalid JWT', () => {
  expect(getJwtExpiry('invalid-token')).toBe(null);
  expect(getJwtExpiry('foo.bar')).toBe(null);
  expect(getJwtExpiry('foo.bar.baz')).toBe(null); // not valid base64 JSON
});

it.sequential('resolveTokenPath resolves paths in correct order', () => {
  // Save original env vars
  const origHome = process.env.CHATGPT_LOCAL_HOME;
  const origCodexHome = process.env.CODEX_HOME;

  try {
    const chatgptLocalHomeDir = path.join(TEST_DIR, 'chatgpt-local-home');
    const codexHomeDir = path.join(TEST_DIR, 'codex-home');

    fs.mkdirSync(chatgptLocalHomeDir, { recursive: true });
    fs.mkdirSync(codexHomeDir, { recursive: true });

    const path1 = path.join(chatgptLocalHomeDir, 'auth.json');
    const path2 = path.join(codexHomeDir, 'auth.json');

    // Case 1: CHATGPT_LOCAL_HOME is set
    fs.writeFileSync(path1, '{}');
    fs.writeFileSync(path2, '{}');
    process.env.CHATGPT_LOCAL_HOME = chatgptLocalHomeDir;
    process.env.CODEX_HOME = codexHomeDir;

    const resolved = resolveTokenPath();
    expect(resolved).toBe(path1);

    // Case 2: Only CODEX_HOME is set
    delete process.env.CHATGPT_LOCAL_HOME;
    const resolved2 = resolveTokenPath();
    expect(resolved2).toBe(path2);

    // Cleanup files
    fs.unlinkSync(path1);
    fs.unlinkSync(path2);
  } finally {
    // Restore original env vars
    if (origHome) process.env.CHATGPT_LOCAL_HOME = origHome;
    else delete process.env.CHATGPT_LOCAL_HOME;
    if (origCodexHome) process.env.CODEX_HOME = origCodexHome;
    else delete process.env.CODEX_HOME;
  }
});

it('CodexTokenManager throws if no token file found', async () => {
  // Use a manager with empty/non-existent paths
  const manager = new CodexTokenManager({
    authPath: path.join(TEST_DIR, `term2-auth-1.json`),
    tokenPathResolver: () => null,
  });

  await expect(async () => {
    await manager.getOrRefreshAccessToken();
  }).rejects.toThrow(/--codex-login/);
});

it('CodexTokenManager reads the Codex installation ID beside auth.json', () => {
  const tokenPath = path.join(TEST_DIR, 'installation-auth.json');
  fs.writeFileSync(tokenPath, '{}');
  fs.writeFileSync(path.join(TEST_DIR, 'installation_id'), 'installation-123\n');

  const manager = new CodexTokenManager({
    authPath: path.join(TEST_DIR, `term2-auth-2.json`),
    tokenPathResolver: () => tokenPath,
  });

  expect(manager.getInstallationId()).toBe('installation-123');
  expect(manager.getInstallationId()).toBe('installation-123');
});

it('CodexTokenManager does not refresh if access token is valid and refresh is recent', async () => {
  const tokenPath = path.join(TEST_DIR, 'auth_valid.json');
  const validToken = createFakeJwt(3600); // 1 hour expiry
  const initialTokens = {
    tokens: {
      access_token: validToken,
      refresh_token: 'valid-refresh-token',
      id_token: 'id-token',
      account_id: 'account-123',
    },
    last_refresh: new Date().toISOString(),
  };

  fs.writeFileSync(tokenPath, JSON.stringify(initialTokens));

  let fetchCalled = false;
  const mockFetch = async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const manager = new CodexTokenManager({
    authPath: path.join(TEST_DIR, `term2-auth-3.json`),
    tokenPathResolver: () => tokenPath,
    fetchImpl: mockFetch as any,
  });

  const token = await manager.getOrRefreshAccessToken();
  expect(token).toBe(validToken);
  expect(fetchCalled).toBe(false);
});

it("CodexTokenManager refuses to spend the codex CLI's refresh token, and leaves its file untouched", async () => {
  // The CLI store is import-only: we take its access token but never its
  // refresh token, because OpenAI rotates refresh tokens and two writers on one
  // rotation chain silently log one of them out.
  const tokenPath = path.join(TEST_DIR, 'auth_cli_expired.json');
  const initialTokens = {
    tokens: {
      access_token: createFakeJwt(120), // within the 5-minute refresh window
      refresh_token: 'cli-refresh-token',
      id_token: 'cli-id-token',
    },
    last_refresh: new Date().toISOString(),
  };
  const original = JSON.stringify(initialTokens);
  fs.writeFileSync(tokenPath, original);

  let fetchCalled = false;
  const manager = new CodexTokenManager({
    authPath: path.join(TEST_DIR, 'term2-auth-cli-expired.json'),
    tokenPathResolver: () => tokenPath,
    fetchImpl: (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as any,
  });

  await expect(manager.getOrRefreshAccessToken()).rejects.toThrow(/--codex-login/);
  expect(fetchCalled).toBe(false);
  expect(fs.readFileSync(tokenPath, 'utf8')).toBe(original);
});

it('CodexTokenManager refreshes its own credential into its own store', async () => {
  const cliPath = path.join(TEST_DIR, 'auth_cli_untouched.json');
  const cliContents = JSON.stringify({ tokens: { access_token: createFakeJwt(3600), refresh_token: 'cli-refresh' } });
  fs.writeFileSync(cliPath, cliContents);

  const authPath = path.join(TEST_DIR, 'term2-auth-refresh.json');
  const expiredToken = createFakeJwt(120); // 2 minutes expiry (within 5 minutes boundary)
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: expiredToken,
        refresh_token: 'old-refresh-token',
        id_token: 'old-id-token',
        account_id: 'account-123',
      },
    }),
  );

  const newToken = createFakeJwt(3600);
  let fetchPayload: any = null;
  const mockFetch = async (_url: string, init: any) => {
    fetchPayload = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        access_token: newToken,
        refresh_token: 'new-refresh-token',
        id_token: 'new-id-token',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const manager = new CodexTokenManager({
    authPath,
    tokenPathResolver: () => cliPath,
    fetchImpl: mockFetch as any,
  });

  const token = await manager.getOrRefreshAccessToken();
  expect(token).toBe(newToken);

  expect(fetchPayload.grant_type).toBe('refresh_token');
  expect(fetchPayload.refresh_token).toBe('old-refresh-token');
  expect(fetchPayload.client_id).toBe('app_EMoamEEZ73f0CkXaXp7hrann');

  // The refresh lands in term2's store, against the account that was active.
  // The legacy single-credential file is migrated into an account on read.
  const updatedContent = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  expect(updatedContent.accounts).toHaveLength(1);
  expect(updatedContent.activeAccountId).toBe(updatedContent.accounts[0].id);
  const storedTokens = updatedContent.accounts[0].tokens;
  expect(storedTokens.access_token).toBe(newToken);
  expect(storedTokens.refresh_token).toBe('new-refresh-token');
  expect(storedTokens.id_token).toBe('new-id-token');
  expect(storedTokens.account_id).toBe('account-123'); // preserved

  // ...and never in the codex CLI's.
  expect(fs.readFileSync(cliPath, 'utf8')).toBe(cliContents);

  if (process.platform !== 'win32') {
    expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
  }
});

it('CodexTokenManager refreshes if last_refresh is more than 55 minutes ago', async () => {
  const tokenPath = path.join(TEST_DIR, 'auth_old_refresh.json');
  const validToken = createFakeJwt(3600); // JWT still valid for 1 hour
  const initialTokens = {
    tokens: {
      access_token: validToken,
      refresh_token: 'old-refresh-token',
    },
    // last refresh 60 minutes ago
    last_refresh: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  };

  fs.writeFileSync(tokenPath, JSON.stringify(initialTokens));

  const newToken = createFakeJwt(3600);
  const mockFetch = async () => {
    return new Response(
      JSON.stringify({
        access_token: newToken,
        refresh_token: 'new-refresh',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const manager = new CodexTokenManager({
    authPath: path.join(TEST_DIR, `term2-auth-5.json`),
    tokenPathResolver: () => tokenPath,
    fetchImpl: mockFetch as any,
  });

  const token = await manager.getOrRefreshAccessToken();
  expect(token).toBe(newToken);
});

it('Codex provider is registered in the registry', () => {
  const provider = getProvider('codex');
  expect(provider).toBeTruthy();
  expect(provider?.id).toBe('codex');
  expect(provider?.label).toBe('Codex');
  expect(typeof provider?.fetchModels).toBe('function');
  expect(typeof provider?.createStreamedModel).toBe('function');
  expect(provider?.capabilities).toEqual({
    supportsConversationChaining: true,
    supportsContextCompaction: false,
    usesStrictToolSchema: true,
    supportsPromptCacheKey: true,
  });
});

it('Codex fetchModels parses custom models endpoint', async () => {
  const provider = getProvider('codex');
  expect(provider).toBeTruthy();

  const tokenPath = path.join(TEST_DIR, 'auth_models.json');
  const validToken = createFakeJwt(3600);
  fs.writeFileSync(
    tokenPath,
    JSON.stringify({
      tokens: { access_token: validToken },
      last_refresh: new Date().toISOString(),
    }),
  );

  let fetchUrl = '';
  let authHeader = '';
  const mockFetch = async (url: string, init: any) => {
    fetchUrl = url;
    authHeader = init?.headers?.Authorization || init?.headers?.authorization || '';
    return new Response(
      JSON.stringify({
        models: [
          { slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', default_reasoning_level: 'medium' },
          { slug: 'gpt-4o', display_name: 'GPT-4o', default_reasoning_level: 'low' },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const deps = {
    settingsService: {
      get: () => 'gpt-5-codex',
    },
    loggingService: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };

  const origHome = process.env.CHATGPT_LOCAL_HOME;
  process.env.CHATGPT_LOCAL_HOME = TEST_DIR;
  fs.renameSync(tokenPath, path.join(TEST_DIR, 'auth.json'));

  try {
    const models = await provider!.fetchModels(deps as any, mockFetch as any);
    expect(fetchUrl.startsWith('https://chatgpt.com/backend-api/codex/models?client_version=')).toBe(true);
    expect(authHeader).toBe(`Bearer ${validToken}`);
    expect(models.length).toBe(2);
    expect(models[1].id).toBe('gpt-4o');
    expect(models[1].default_reasoning_level).toBe('low');
    expect(models[0].id).toBe('gpt-5-codex');
    expect(models[0].default_reasoning_level).toBe('medium');
  } finally {
    process.env.CHATGPT_LOCAL_HOME = origHome;
    try {
      fs.unlinkSync(path.join(TEST_DIR, 'auth.json'));
    } catch {
      // ignore
    }
  }
});

it('resolveCodexClientVersion returns local version if available and writes to cache', async () => {
  const cacheDir = path.join(TEST_DIR, 'cache-local');
  fs.mkdirSync(cacheDir, { recursive: true });

  const execImpl = async (cmd: string) => {
    expect(cmd).toBe('codex --version');
    return { stdout: 'codex-cli 1.2.3' };
  };

  const version = await resolveCodexClientVersion({
    cacheDir,
    execImpl: execImpl as any,
  });

  expect(version).toBe('1.2.3');

  // Verify it is cached
  const cachePath = path.join(cacheDir, 'codex-client-version.json');
  expect(fs.existsSync(cachePath)).toBe(true);
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  expect(cached.version).toBe('1.2.3');
  expect(typeof cached.timestamp === 'number').toBe(true);
});

it('sanitizeCodexRequestInit leaves non-responses requests unchanged', () => {
  const init: RequestInit = {
    body: JSON.stringify({
      input: [{ type: 'reasoning', id: 'rs_123' }],
    }),
  };

  const sanitized = sanitizeCodexRequestInit('https://chatgpt.com/backend-api/codex/models', init);
  expect(sanitized).toEqual(init);
});

it('sanitizeCodexRequestInit normalizes include JSON string to array', () => {
  const init: RequestInit = {
    body: JSON.stringify({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      include: '["reasoning.encrypted_content"]',
    }),
  };

  const sanitized = sanitizeCodexRequestInit('https://chatgpt.com/backend-api/codex/responses', init);
  const body = JSON.parse(String(sanitized?.body));
  expect(Array.isArray(body.include)).toBe(true);
  expect(body.include).toEqual(['reasoning.encrypted_content']);
});

it('addCodexResponsesLiteHeader marks Luna Responses requests', () => {
  const init: RequestInit = {
    headers: { authorization: 'Bearer token' },
    body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] }),
  };

  const updated = addCodexResponsesLiteHeader('https://chatgpt.com/backend-api/codex/responses', init);

  if (!updated) {
    throw new Error('Expected Luna Responses headers to be added');
  }
  expect(new Headers(updated.headers).get('x-openai-internal-codex-responses-lite')).toBe('true');
});

it('resolveCodexClientVersion falls back to npm registry if local version fails', async () => {
  const cacheDir = path.join(TEST_DIR, 'cache-npm');
  fs.mkdirSync(cacheDir, { recursive: true });

  const execImpl = async () => {
    throw new Error('command not found');
  };

  let fetchUrl = '';
  const mockFetch = async (url: string) => {
    fetchUrl = url;
    return new Response(JSON.stringify({ version: '2.3.4' }), { status: 200 });
  };

  const version = await resolveCodexClientVersion({
    cacheDir,
    execImpl: execImpl as any,
    fetchImpl: mockFetch as any,
  });

  expect(version).toBe('2.3.4');
  expect(fetchUrl).toBe('https://registry.npmjs.org/@openai/codex/latest');

  // Verify cached
  const cachePath = path.join(cacheDir, 'codex-client-version.json');
  expect(fs.existsSync(cachePath)).toBe(true);
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  expect(cached.version).toBe('2.3.4');
});

it('resolveCodexClientVersion falls back to fallback version if all fails', async () => {
  const cacheDir = path.join(TEST_DIR, 'cache-fallback');
  fs.mkdirSync(cacheDir, { recursive: true });

  const execImpl = async () => {
    throw new Error('command not found');
  };

  const mockFetch = async () => {
    return new Response(JSON.stringify({}), { status: 500 });
  };

  const version = await resolveCodexClientVersion({
    cacheDir,
    execImpl: execImpl as any,
    fetchImpl: mockFetch as any,
  });

  expect(version).toBe('0.133.0');

  // Verify cached
  const cachePath = path.join(cacheDir, 'codex-client-version.json');
  expect(fs.existsSync(cachePath)).toBe(true);
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  expect(cached.version).toBe('0.133.0');
});

it('resolveCodexClientVersion uses cache if valid and less than one day old', async () => {
  const cacheDir = path.join(TEST_DIR, 'cache-valid');
  fs.mkdirSync(cacheDir, { recursive: true });

  const cachePath = path.join(cacheDir, 'codex-client-version.json');
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      version: '9.9.9',
      timestamp: Date.now() - 12 * 60 * 60 * 1000, // 12 hours ago
    }),
  );

  const execImpl = async () => {
    expect(true).toBe(false);
    return { stdout: '' };
  };

  const mockFetch = async () => {
    expect(true).toBe(false);
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const version = await resolveCodexClientVersion({
    cacheDir,
    execImpl: execImpl as any,
    fetchImpl: mockFetch as any,
  });

  expect(version).toBe('9.9.9');
});

it('resolveCodexClientVersion ignores cache if older than one day', async () => {
  const cacheDir = path.join(TEST_DIR, 'cache-expired');
  fs.mkdirSync(cacheDir, { recursive: true });

  const cachePath = path.join(cacheDir, 'codex-client-version.json');
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      version: '9.9.9',
      timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago (expired)
    }),
  );

  const execImpl = async () => {
    return { stdout: 'codex-cli 1.0.0' };
  };

  const version = await resolveCodexClientVersion({
    cacheDir,
    execImpl: execImpl as any,
  });

  expect(version).toBe('1.0.0');

  // Verify cache updated
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  expect(cached.version).toBe('1.0.0');
  expect(Date.now() - cached.timestamp < 1000).toBe(true);
});

it('Codex fetchModels appends correct client_version from cache/resolver', async () => {
  const provider = getProvider('codex');
  expect(provider).toBeTruthy();

  // Set cache dir to test dir
  const origCacheDir = process.env.TERM2_CACHE_DIR;
  process.env.TERM2_CACHE_DIR = path.join(TEST_DIR, 'fetch-models-cache');
  fs.mkdirSync(process.env.TERM2_CACHE_DIR, { recursive: true });

  // Pre-seed cache with a specific version
  const cachePath = path.join(process.env.TERM2_CACHE_DIR, 'codex-client-version.json');
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      version: '1.2.3-test',
      timestamp: Date.now(),
    }),
  );

  const tokenPath = path.join(TEST_DIR, 'auth_models_version.json');
  const validToken = createFakeJwt(3600);
  fs.writeFileSync(
    tokenPath,
    JSON.stringify({
      tokens: { access_token: validToken },
      last_refresh: new Date().toISOString(),
    }),
  );

  let fetchUrl = '';
  const mockFetch = async (url: string) => {
    fetchUrl = url;
    return new Response(
      JSON.stringify({
        data: [{ id: 'gpt-4o', name: 'GPT-4o' }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const deps = {
    settingsService: { get: () => 'gpt-4o' },
    loggingService: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  const origHome = process.env.CHATGPT_LOCAL_HOME;
  process.env.CHATGPT_LOCAL_HOME = TEST_DIR;
  fs.renameSync(tokenPath, path.join(TEST_DIR, 'auth.json'));

  try {
    await provider!.fetchModels(deps as any, mockFetch as any);
    expect(fetchUrl).toBe('https://chatgpt.com/backend-api/codex/models?client_version=1.2.3-test');
  } finally {
    process.env.CHATGPT_LOCAL_HOME = origHome;
    if (origCacheDir !== undefined) {
      process.env.TERM2_CACHE_DIR = origCacheDir;
    } else {
      delete process.env.TERM2_CACHE_DIR;
    }
    try {
      fs.unlinkSync(path.join(TEST_DIR, 'auth.json'));
    } catch {}
  }
});

function createFakeJwtWithClaims(claims: any): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.signature`;
}

it('extractAccountIdFromClaims resolves account ID with correct precedence', () => {
  const claims1 = { chatgpt_account_id: 'acc_1' };
  expect(extractAccountIdFromClaims(claims1)).toBe('acc_1');

  const claims2 = {
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc_2' },
  };
  expect(extractAccountIdFromClaims(claims2)).toBe('acc_2');

  const claims3 = {
    organizations: [{ id: 'org_3' }],
  };
  expect(extractAccountIdFromClaims(claims3)).toBe('org_3');

  // Precedence test: chatgpt_account_id > https://api.openai.com/auth > organizations
  const claimsAll = {
    chatgpt_account_id: 'acc_1',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc_2' },
    organizations: [{ id: 'org_3' }],
  };
  expect(extractAccountIdFromClaims(claimsAll)).toBe('acc_1');

  const claimsNestedAndOrg = {
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc_2' },
    organizations: [{ id: 'org_3' }],
  };
  expect(extractAccountIdFromClaims(claimsNestedAndOrg)).toBe('acc_2');
});

it('extractAccountId prefers id_token claims over access_token claims', () => {
  const idToken = createFakeJwtWithClaims({ chatgpt_account_id: 'acc_id_token' });
  const accessToken = createFakeJwtWithClaims({ chatgpt_account_id: 'acc_access_token' });

  // Preferred id_token
  expect(extractAccountId(idToken, accessToken)).toBe('acc_id_token');

  // Fallback to access_token if id_token is missing or has no relevant claim
  expect(extractAccountId(undefined, accessToken)).toBe('acc_access_token');
  expect(extractAccountId('', accessToken)).toBe('acc_access_token');
});

it.sequential('CodexTokenManager extracts and stores accountId from file and refresh responses', async () => {
  const tokenPath = path.join(TEST_DIR, 'auth_account_id.json');
  const idToken = createFakeJwtWithClaims({ chatgpt_account_id: 'acc_from_id_token' });
  const accessToken = createFakeJwt(3600);

  const initialTokens = {
    tokens: {
      access_token: accessToken,
      refresh_token: 'refresh-token',
      id_token: idToken,
    },
    last_refresh: new Date().toISOString(),
  };

  fs.writeFileSync(tokenPath, JSON.stringify(initialTokens));

  const manager = new CodexTokenManager({
    authPath: path.join(TEST_DIR, `term2-auth-6.json`),
    tokenPathResolver: () => tokenPath,
  });

  // Ensure accountId is initially null before loading
  expect(manager.getAccountId()).toBe(null);

  await manager.getOrRefreshAccessToken();
  expect(manager.getAccountId()).toBe('acc_from_id_token');

  // Test update with fallback to file-level account_id if no claims found
  const tokenPathFallback = path.join(TEST_DIR, 'auth_account_id_fallback.json');
  const initialTokensFallback = {
    tokens: {
      access_token: accessToken,
      refresh_token: 'refresh-token',
      account_id: 'acc_from_file_direct',
    },
    last_refresh: new Date().toISOString(),
  };
  fs.writeFileSync(tokenPathFallback, JSON.stringify(initialTokensFallback));

  const managerFallback = new CodexTokenManager({
    authPath: path.join(TEST_DIR, `term2-auth-7.json`),
    tokenPathResolver: () => tokenPathFallback,
  });
  await managerFallback.getOrRefreshAccessToken();
  expect(managerFallback.getAccountId()).toBe('acc_from_file_direct');
});

it.sequential('Codex fetchModels injects ChatGPT-Account-Id header if present', async () => {
  const provider = getProvider('codex');
  expect(provider).toBeTruthy();

  const tokenPath = path.join(TEST_DIR, 'auth_models_header.json');
  const validToken = createFakeJwt(3600);
  const idToken = createFakeJwtWithClaims({ chatgpt_account_id: 'acc_models_test' });
  fs.writeFileSync(
    tokenPath,
    JSON.stringify({
      tokens: { access_token: validToken, id_token: idToken },
      last_refresh: new Date().toISOString(),
    }),
  );

  let fetchHeaders: Record<string, string> = {};
  const mockFetch = async (_url: string, init: any) => {
    fetchHeaders = init?.headers || {};
    return new Response(
      JSON.stringify({
        models: [],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const deps = {
    settingsService: { get: () => 'gpt-5-codex' },
    loggingService: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  const origHome = process.env.CHATGPT_LOCAL_HOME;
  process.env.CHATGPT_LOCAL_HOME = TEST_DIR;
  fs.renameSync(tokenPath, path.join(TEST_DIR, 'auth.json'));

  try {
    await provider!.fetchModels(deps as any, mockFetch as any);
    expect(fetchHeaders['ChatGPT-Account-Id']).toBe('acc_models_test');
  } finally {
    process.env.CHATGPT_LOCAL_HOME = origHome;
    try {
      fs.unlinkSync(path.join(TEST_DIR, 'auth.json'));
    } catch {}
  }
});

it.sequential('Codex provider createStreamedModel custom fetch injects chatgpt-account-id header', async () => {
  const provider = getProvider('codex');
  expect(provider).toBeTruthy();
  if (!provider || !provider.createStreamedModel) {
    expect(true).toBe(false);
    return;
  }

  const validToken = createFakeJwt(3600);
  const idToken = createFakeJwtWithClaims({ chatgpt_account_id: 'acc_runner_test' });

  const origHome = process.env.CHATGPT_LOCAL_HOME;
  process.env.CHATGPT_LOCAL_HOME = TEST_DIR;
  fs.writeFileSync(
    path.join(TEST_DIR, 'auth.json'),
    JSON.stringify({
      tokens: { access_token: validToken, id_token: idToken },
      last_refresh: new Date().toISOString(),
    }),
  );

  const mockLogging = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  const deps = {
    settingsService: { get: (key: string) => (key === 'agent.model' ? 'gpt-5.3-codex' : undefined) },
    loggingService: mockLogging,
  };

  let interceptorHeaders: Record<string, string> = {};
  const mockFetch = async (_url: string, init: any) => {
    interceptorHeaders = {};
    if (init?.headers) {
      if (typeof init.headers.forEach === 'function') {
        init.headers.forEach((v: string, k: string) => {
          interceptorHeaders[k.toLowerCase()] = String(v);
        });
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          interceptorHeaders[k.toLowerCase()] = String(v);
        }
      }
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as any;

  try {
    const model = provider.createStreamedModel!('gpt-5.3-codex', deps as any) as any;
    expect(model).toBeTruthy();
    const client = (model as any).wrappedModel.client;

    await client.responses.create({ model: 'gpt-5.3-codex', input: [], stream: false }).catch(() => {});

    expect(interceptorHeaders['chatgpt-account-id']).toBe('acc_runner_test');
  } finally {
    globalThis.fetch = origFetch;
    process.env.CHATGPT_LOCAL_HOME = origHome;
    try {
      fs.unlinkSync(path.join(TEST_DIR, 'auth.json'));
    } catch {}
  }
});

it.sequential('Codex provider uses CODEX_BASE_URL for local server simulation', async () => {
  const provider = getProvider('codex');
  expect(provider?.createStreamedModel).toBeTruthy();
  if (!provider?.createStreamedModel) return;

  const originalBaseUrl = process.env.CODEX_BASE_URL;
  process.env.CODEX_BASE_URL = 'http://127.0.0.1:8787/backend-api/codex';

  try {
    const model = provider.createStreamedModel!('gpt-5.3-codex', {
      settingsService: { get: (key: string) => (key === 'agent.model' ? 'gpt-5.3-codex' : undefined) },
      loggingService: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as any);
    expect(model).toBeTruthy();

    expect((model as any).wrappedModel.client.baseURL).toBe('http://127.0.0.1:8787/backend-api/codex');
  } finally {
    if (originalBaseUrl === undefined) {
      delete process.env.CODEX_BASE_URL;
    } else {
      process.env.CODEX_BASE_URL = originalBaseUrl;
    }
  }
});

it.sequential('Codex HTTP stream forwards application instructions to Luna as developer context', async () => {
  let capturedRequest: any;
  const client = {
    responses: {
      create: async (request: any) => {
        capturedRequest = request;
        return (async function* () {
          yield {
            type: 'response.completed',
            response: {
              id: 'resp-context',
              output: [],
              usage: { input_tokens: 7, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } },
            },
          };
        })();
      },
    },
  };
  const provider = new CodexProvider(client as any, {} as any, {}, undefined, 'http', 0, {
    firstFrameMs: 1_000,
    interFrameMs: 1_000,
  });
  const model = provider.getStreamedModel('gpt-5.6-luna');

  const events = [];
  for await (const event of model.stream(
    typedRequest({
      instructions: 'PROJECT_CONTEXT_SENTINEL',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
    }),
  )) {
    events.push(event);
  }

  expect(capturedRequest.instructions).toBe('');
  expect(capturedRequest.input).toContainEqual({
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'PROJECT_CONTEXT_SENTINEL' }],
  });
  expect(events.at(-1)).toMatchObject({
    type: 'completion',
    usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 },
  });
});

it.sequential('Codex registry boundary preserves the full streamed-turn request and response contract', async () => {
  const provider = getProvider('codex');
  expect(provider?.createStreamedModel).toBeTruthy();
  if (!provider?.createStreamedModel) return;

  const transport = new FakeCodexResponsesTransport([
    { type: 'response.output_text.delta', delta: 'answer' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_out', delta: 'thought' },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'call_out', name: 'lookup', arguments: '{"q":1}' },
    },
    {
      type: 'codex.rate_limits',
      rate_limits: {
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 11, window_minutes: 300, reset_after_seconds: 9697, reset_at: 1779703037 },
        secondary: { used_percent: 14, window_minutes: 10080, reset_after_seconds: 503937, reset_at: 1780197277 },
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_contract',
        status: 'completed',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
        },
        output: [
          {
            type: 'reasoning',
            id: 'rs_out',
            summary: [{ type: 'summary_text', text: 'thought' }],
            encrypted_content: 'cipher',
          },
          { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
          { type: 'function_call', call_id: 'call_out', name: 'lookup', arguments: '{"q":1}' },
        ],
      },
    },
    { type: 'response.output_text.delta', delta: 'must not escape terminal' },
  ]);

  {
    const controller = new AbortController();
    const model = await provider.createStreamedModel('gpt-5.3-codex', {
      settingsService: {
        get: (key: string) =>
          key === 'agent.transport' ? 'websocket' : key === 'agent.retryAttempts' ? 0 : 'gpt-5.3-codex',
      },
      loggingService: transport,
    } as any);
    const events: any[] = [];
    for await (const event of model.stream(
      typedRequest({
        instructions: 'PROJECT_CONTEXT_SENTINEL',
        previousResponseId: 'resp_before',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'image', image: 'https://example.test/image.png' }] },
          {
            type: 'reasoning',
            id: 'rs_in',
            text: 'old thought',
            providerMetadata: { codex: { encrypted_content: 'old-cipher' } },
          },
          { type: 'tool_call', id: 'call_in', name: 'lookup', arguments: '{}' },
          {
            type: 'tool_result',
            id: 'call_in',
            output: [{ type: 'file', file: { id: 'file_1', filename: 'result.txt' } }],
          },
        ],
        tools: [{ name: 'lookup', parameters: { type: 'object' }, strict: true }],
        toolChoice: { name: 'lookup' },
        temperature: 0.2,
        topP: 0.8,
        frequencyPenalty: 0.3,
        presencePenalty: 0.4,
        maxTokens: 321,
        reasoning: { effort: 'high', summary: 'detailed' },
        providerOptions: { generate: false, custom_codex_option: true },
        signal: controller.signal,
      }),
    )) {
      events.push(event);
    }

    const captured = transport.calls[0].request;
    expect(captured).toMatchObject({
      previousResponseId: 'resp_before',
      instructions: 'PROJECT_CONTEXT_SENTINEL',
      toolChoice: { name: 'lookup' },
      temperature: 0.2,
      topP: 0.8,
      frequencyPenalty: 0.3,
      presencePenalty: 0.4,
      maxTokens: 321,
      reasoning: { effort: 'high', summary: 'detailed' },
      providerOptions: { generate: false, custom_codex_option: true },
      signal: controller.signal,
    });
    expect(captured.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'image', image: 'https://example.test/image.png' }] },
      {
        type: 'reasoning',
        id: 'rs_in',
        text: 'old thought',
        providerMetadata: { codex: { encrypted_content: 'old-cipher' } },
      },
      { type: 'tool_call', id: 'call_in', name: 'lookup', arguments: '{}' },
      {
        type: 'tool_result',
        id: 'call_in',
        output: [{ type: 'file', file: { id: 'file_1', filename: 'result.txt' } }],
      },
    ]);
    expect(events).toEqual([
      { type: 'text_delta', text: 'answer' },
      { type: 'reasoning_delta', id: 'rs_out', text: 'thought' },
      {
        type: 'codex_rate_limits',
        rateLimits: {
          allowed: true,
          limit_reached: false,
          primary: { used_percent: 11, window_minutes: 300, reset_after_seconds: 9697, reset_at: 1779703037 },
          secondary: { used_percent: 14, window_minutes: 10080, reset_after_seconds: 503937, reset_at: 1780197277 },
        },
      },
      { type: 'tool_call', id: 'call_out', name: 'lookup', arguments: '{"q":1}' },
      {
        type: 'completion',
        responseId: 'resp_contract',
        finishReason: 'completed',
        usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, cacheWriteTokens: 2 },
        output: [
          { type: 'tool_call', id: 'call_out', name: 'lookup', arguments: '{"q":1}' },
          {
            type: 'reasoning',
            id: 'rs_out',
            text: 'thought',
            providerMetadata: { codex: { encrypted_content: 'cipher' } },
          },
          { type: 'message', content: [{ type: 'text', text: 'answer' }] },
        ],
      },
    ]);
  }
});

it.sequential('Codex HTTP and WebSocket adapters expose equivalent application-turn semantics', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'parity' },
    {
      type: 'response.completed',
      response: {
        id: 'resp_parity',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'parity' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  const httpTransport = new FakeCodexResponsesTransport(events);
  const websocketTransport = new FakeCodexResponsesTransport(events);
  const request = typedRequest({
    instructions: 'PARITY_SENTINEL',
    previousResponseId: 'resp_before',
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    toolChoice: 'none',
    topP: 0.5,
    maxTokens: 10,
    reasoning: { effort: 'low' },
    codex: { promptCacheKey: 'session-parity', include: ['reasoning.encrypted_content'] },
    providerOptions: { generate: false },
  });
  const http = new CodexResponsesModel({} as any, 'gpt-5.3-codex', httpTransport);
  const websocket = new CodexResponsesWSModel({} as any, 'gpt-5.3-codex', fakeCodexTokenManager, websocketTransport);
  const collect = async (model: CodexResponsesModel | CodexResponsesWSModel) => {
    const result: any[] = [];
    for await (const event of model.stream(request)) result.push(event);
    return result;
  };
  expect(await collect(http)).toEqual(await collect(websocket));
  expect(websocketTransport.calls[0].request).toMatchObject({
    instructions: request.instructions,
    previousResponseId: request.previousResponseId,
    input: request.input,
    tools: request.tools,
    toolChoice: request.toolChoice,
    topP: request.topP,
    maxTokens: request.maxTokens,
    reasoning: request.reasoning,
    codex: request.codex,
    providerOptions: { generate: false },
  });
  expect(httpTransport.calls[0].request.codex).toMatchObject({
    promptCacheKey: 'session-parity',
    include: ['reasoning.encrypted_content'],
  });
});

it.sequential('Codex HTTP stream rejects EOF before a completed response event', async () => {
  const client = {
    responses: {
      create: async () =>
        (async function* () {
          yield { type: 'response.created', response: { id: 'resp_incomplete', status: 'in_progress' } };
          yield { type: 'response.output_text.delta', delta: 'partial' };
        })(),
    },
  };
  const provider = new CodexProvider(client as any, {} as any, {}, undefined, 'http', 0, {
    firstFrameMs: 1_000,
    interFrameMs: 1_000,
  });
  const model = provider.getStreamedModel('fixture-codex');

  await expect(
    (async () => {
      for await (const _event of model.stream(
        typedRequest({
          input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          tools: [],
        }),
      )) {
        // drain
      }
    })(),
  ).rejects.toThrow('without a completed response');
});

it.sequential('Codex provider reuses its streamed model so continuation state survives turns', async () => {
  const transport = new FakeCodexResponsesTransport([
    { type: 'response.completed', response: { id: 'resp-1', output: [], usage: {} } },
  ]);
  const provider = new CodexProvider(
    {} as any,
    fakeCodexTokenManager as any,
    transport as any,
    undefined,
    'websocket',
    0,
    {
      firstFrameMs: 1000,
      interFrameMs: 1000,
    },
  );
  const first = provider.getStreamedModel('gpt-5.3-codex');
  const second = provider.getStreamedModel('gpt-5.3-codex');
  expect(second).toBe(first);
  for await (const _event of first.stream(typedRequest({ input: [] }))) {
    // drain
  }
  for await (const _event of second.stream(typedRequest({ input: [] }))) {
    // drain
  }
  expect(transport.calls).toHaveLength(2);
});

it.sequential('Codex provider rejects transport changes while cached continuation state exists', async () => {
  const provider = getProvider('codex');
  expect(provider?.createStreamedModel).toBeTruthy();
  if (!provider?.createStreamedModel) return;

  {
    const settings = new Map<string, unknown>([
      ['agent.model', 'gpt-5.3-codex'],
      ['agent.transport', 'websocket'],
      ['agent.retryAttempts', 2],
      ['agent.codex.websocketFirstFrameTimeoutMs', 90_000],
      ['agent.codex.websocketInterFrameTimeoutMs', 600_000],
    ]);
    const settingsService = { get: (key: string) => settings.get(key) };
    const deps = {
      settingsService,
      loggingService: {} as any,
      sessionContextService: { getContext: () => ({ sessionId: 'factory-test' }) },
    } as any;
    const first = (await provider.createStreamedModel('gpt-5.3-codex', deps)) as any;
    const same = (await provider.createStreamedModel('gpt-5.3-codex', deps)) as any;
    expect(same).toBe(first);
    settings.set('agent.transport', 'http');
    expect(() => provider.createStreamedModel!('gpt-5.3-codex', deps)).toThrow('Start a new session before continuing');
  }
});

it.sequential('Codex provider does not share continuation state when no session context is supplied', async () => {
  const provider = getProvider('codex');
  expect(provider?.createStreamedModel).toBeTruthy();
  if (!provider?.createStreamedModel) return;

  const deps = {
    settingsService: { get: (key: string) => (key === 'agent.model' ? 'gpt-5.3-codex' : undefined) },
    loggingService: {} as any,
  } as any;
  const first = (await provider.createStreamedModel('gpt-5.3-codex', deps)) as any;
  const second = (await provider.createStreamedModel('gpt-5.3-codex', deps)) as any;
  expect(first).not.toBe(second);
});

it.sequential('Codex provider stream() wraps tool definitions with type: function for the wire request', async () => {
  const transport = new FakeCodexResponsesTransport([
    { type: 'response.completed', response: { id: 'resp_1', output: [], usage: {} } },
  ]);
  const model = new CodexResponsesWSModel({} as any, 'gpt-5.3-codex', fakeCodexTokenManager, transport);
  for await (const _event of model.stream(
    typedRequest({
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'shell', description: 'Run shell.', parameters: { type: 'object' }, strict: true }],
    }),
  )) {
    // drain
  }
  expect(transport.calls[0].requestData.tools).toEqual([
    { type: 'function', name: 'shell', description: 'Run shell.', parameters: { type: 'object' }, strict: true },
  ]);
});

it.sequential('Codex provider stream() serializes assistant history as output_text, not input_text', async () => {
  const transport = new FakeCodexResponsesTransport([
    { type: 'response.completed', response: { id: 'resp_1', output: [], usage: {} } },
  ]);
  const model = new CodexResponsesWSModel({} as any, 'gpt-5.3-codex', fakeCodexTokenManager, transport);
  for await (const _event of model.stream(
    typedRequest({
      previousResponseId: 'resp-before',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
      ],
    }),
  )) {
    // drain
  }
  expect(transport.calls[0].requestData.previous_response_id).toBe('resp-before');
  expect(transport.calls[0].requestData.input).toEqual([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello there' }] },
  ]);
});

it.sequential(
  'Codex provider stream() unwraps websocket-shaped events into text_delta and a completed message',
  async () => {
    const transport = new FakeCodexResponsesTransport([
      {
        type: 'codex.rate_limits',
        rate_limits: {
          allowed: true,
          limit_reached: false,
          primary: { used_percent: 11, window_minutes: 300, reset_after_seconds: 60, reset_at: 1_700_000_000 },
          secondary: { used_percent: 14, window_minutes: 10_080, reset_after_seconds: 120, reset_at: 1_700_000_100 },
        },
      },
      { type: 'response.output_text.delta', delta: 'Hi! How can I help you today?' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          output: [{ type: 'message', content: [{ text: 'Hi! How can I help you today?' }] }],
          usage: {},
        },
      },
    ]);
    const model = new CodexResponsesWSModel({} as any, 'gpt-5.3-codex', fakeCodexTokenManager, transport);
    const events: any[] = [];
    for await (const event of model.stream(
      typedRequest({
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: 'codex_rate_limits',
        rateLimits: {
          allowed: true,
          limit_reached: false,
          primary: { used_percent: 11, window_minutes: 300, reset_after_seconds: 60, reset_at: 1_700_000_000 },
          secondary: { used_percent: 14, window_minutes: 10_080, reset_after_seconds: 120, reset_at: 1_700_000_100 },
        },
      },
      { type: 'text_delta', text: 'Hi! How can I help you today?' },
      {
        type: 'completion',
        responseId: 'resp_1',
        output: [{ type: 'message', content: [{ type: 'text', text: 'Hi! How can I help you today?' }] }],
      },
    ]);
    expect(transport.calls).toHaveLength(1);
  },
);

it.sequential('Codex provider passes configured receive timeouts to websocket models', async () => {
  vi.useFakeTimers();
  try {
    const transport = new HangingCodexResponsesTransport();
    const model = new CodexResponsesWSModel(
      {} as any,
      'gpt-5.3-codex',
      fakeCodexTokenManager,
      undefined,
      undefined,
      undefined,
      { firstFrameMs: 50, interFrameMs: 25 },
      undefined,
      transport,
    );
    const pending = (async () => {
      for await (const _event of model.stream(
        typedRequest({
          input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        }),
      )) {
        // The test stream intentionally never yields.
      }
    })();
    void pending.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25);
    expect(transport.signal?.aborted).toBe(true);
    expect((transport.signal?.reason as Error).message).toBe('WebSocket idle timeout');
  } finally {
    vi.useRealTimers();
  }
});
