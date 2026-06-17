import { it, expect, beforeAll, afterAll } from 'vitest';
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
} from './codex.provider.js';

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
    tokenPathResolver: () => null,
  });

  await expect(async () => {
    await manager.getOrRefreshAccessToken();
  }).rejects.toThrow(/Codex token file not found/);
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
    tokenPathResolver: () => tokenPath,
    fetchImpl: mockFetch as any,
  });

  const token = await manager.getOrRefreshAccessToken();
  expect(token).toBe(validToken);
  expect(fetchCalled).toBe(false);
});

it('CodexTokenManager refreshes if access token is expired or within 5 minutes of expiry', async () => {
  const tokenPath = path.join(TEST_DIR, 'auth_expired.json');
  const expiredToken = createFakeJwt(120); // 2 minutes expiry (within 5 minutes boundary)
  const initialTokens = {
    tokens: {
      access_token: expiredToken,
      refresh_token: 'old-refresh-token',
      id_token: 'old-id-token',
      account_id: 'account-123',
    },
    last_refresh: new Date().toISOString(),
  };

  fs.writeFileSync(tokenPath, JSON.stringify(initialTokens));

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
    tokenPathResolver: () => tokenPath,
    fetchImpl: mockFetch as any,
  });

  const token = await manager.getOrRefreshAccessToken();
  expect(token).toBe(newToken);

  // Verify fetch payload
  expect(fetchPayload.grant_type).toBe('refresh_token');
  expect(fetchPayload.refresh_token).toBe('old-refresh-token');
  expect(fetchPayload.client_id).toBe('app_EMoamEEZ73f0CkXaXp7hrann');

  // Verify file update & mode
  const updatedContent = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  expect(updatedContent.tokens.access_token).toBe(newToken);
  expect(updatedContent.tokens.refresh_token).toBe('new-refresh-token');
  expect(updatedContent.tokens.id_token).toBe('new-id-token');
  expect(updatedContent.tokens.account_id).toBe('account-123'); // preserved
  expect(updatedContent.last_refresh).toBeTruthy();

  // Check file mode 0600 on non-windows
  if (process.platform !== 'win32') {
    const stat = fs.statSync(tokenPath);
    expect(stat.mode & 0o777).toBe(0o600);
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
  expect(typeof provider?.createRunner).toBe('function');
  expect(provider?.capabilities).toEqual({
    supportsConversationChaining: true,
    supportsTracingControl: false,
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

it('resolveCodexClientVersion uses cache if valid and less than one week old', async () => {
  const cacheDir = path.join(TEST_DIR, 'cache-valid');
  fs.mkdirSync(cacheDir, { recursive: true });

  const cachePath = path.join(cacheDir, 'codex-client-version.json');
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      version: '9.9.9',
      timestamp: Date.now() - 24 * 60 * 60 * 1000, // 1 day ago
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

it('resolveCodexClientVersion ignores cache if older than one week', async () => {
  const cacheDir = path.join(TEST_DIR, 'cache-expired');
  fs.mkdirSync(cacheDir, { recursive: true });

  const cachePath = path.join(cacheDir, 'codex-client-version.json');
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      version: '9.9.9',
      timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago (expired)
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
    process.env.TERM2_CACHE_DIR = origCacheDir;
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

it.sequential('Codex provider createRunner custom fetch injects chatgpt-account-id header', async () => {
  const provider = getProvider('codex');
  expect(provider).toBeTruthy();
  if (!provider || !provider.createRunner) {
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
    const runner = provider.createRunner(deps as any);
    expect(runner).toBeTruthy();
    if (!runner) return;
    const modelProvider = runner.config.modelProvider;
    const model = await modelProvider.getModel('gpt-5.3-codex');
    const client = (model as any).wrappedModel._client;

    await client.chat.completions
      .create({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-4o',
      })
      .catch(() => {});

    expect(interceptorHeaders['chatgpt-account-id']).toBe('acc_runner_test');
  } finally {
    globalThis.fetch = origFetch;
    process.env.CHATGPT_LOCAL_HOME = origHome;
    try {
      fs.unlinkSync(path.join(TEST_DIR, 'auth.json'));
    } catch {}
  }
});
