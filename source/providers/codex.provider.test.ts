import test from 'ava';
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

test.before(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

test.after.always(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

test('getJwtExpiry decodes valid JWT and returns expiration timestamp', (t) => {
  const expSeconds = 3600;
  const jwt = createFakeJwt(expSeconds);
  const expiry = getJwtExpiry(jwt);
  t.truthy(expiry);
  // Allow small clock drift tolerance
  const expected = Math.floor(Date.now() / 1000) + expSeconds;
  t.true(Math.abs((expiry || 0) / 1000 - expected) < 2);
});

test('getJwtExpiry returns null for invalid JWT', (t) => {
  t.is(getJwtExpiry('invalid-token'), null);
  t.is(getJwtExpiry('foo.bar'), null);
  t.is(getJwtExpiry('foo.bar.baz'), null); // not valid base64 JSON
});

test.serial('resolveTokenPath resolves paths in correct order', (t) => {
  // Save original env vars
  const origHome = process.env.CHATGPT_LOCAL_HOME;
  const origCodexHome = process.env.CODEX_HOME;

  t.teardown(() => {
    if (origHome) process.env.CHATGPT_LOCAL_HOME = origHome;
    else delete process.env.CHATGPT_LOCAL_HOME;
    if (origCodexHome) process.env.CODEX_HOME = origCodexHome;
    else delete process.env.CODEX_HOME;
  });

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
  t.is(resolved, path1);

  // Case 2: Only CODEX_HOME is set
  delete process.env.CHATGPT_LOCAL_HOME;
  const resolved2 = resolveTokenPath();
  t.is(resolved2, path2);

  // Cleanup files
  fs.unlinkSync(path1);
  fs.unlinkSync(path2);
});

test('CodexTokenManager throws if no token file found', async (t) => {
  // Use a manager with empty/non-existent paths
  const manager = new CodexTokenManager({
    tokenPathResolver: () => null,
  });

  await t.throwsAsync(
    async () => {
      await manager.getOrRefreshAccessToken();
    },
    { message: /Codex token file not found/ },
  );
});

test('CodexTokenManager does not refresh if access token is valid and refresh is recent', async (t) => {
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
  t.is(token, validToken);
  t.false(fetchCalled, 'Should not have triggered refresh fetch');
});

test('CodexTokenManager refreshes if access token is expired or within 5 minutes of expiry', async (t) => {
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
  t.is(token, newToken);

  // Verify fetch payload
  t.is(fetchPayload.grant_type, 'refresh_token');
  t.is(fetchPayload.refresh_token, 'old-refresh-token');
  t.is(fetchPayload.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');

  // Verify file update & mode
  const updatedContent = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  t.is(updatedContent.tokens.access_token, newToken);
  t.is(updatedContent.tokens.refresh_token, 'new-refresh-token');
  t.is(updatedContent.tokens.id_token, 'new-id-token');
  t.is(updatedContent.tokens.account_id, 'account-123'); // preserved
  t.truthy(updatedContent.last_refresh);

  // Check file mode 0600 on non-windows
  if (process.platform !== 'win32') {
    const stat = fs.statSync(tokenPath);
    t.is(stat.mode & 0o777, 0o600);
  }
});

test('CodexTokenManager refreshes if last_refresh is more than 55 minutes ago', async (t) => {
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
  t.is(token, newToken);
});

test('Codex provider is registered in the registry', (t) => {
  const provider = getProvider('codex');
  t.truthy(provider, 'codex provider should be registered');
  t.is(provider?.id, 'codex');
  t.is(provider?.label, 'Codex');
  t.is(typeof provider?.fetchModels, 'function');
  t.is(typeof provider?.createRunner, 'function');
  t.deepEqual(provider?.capabilities, {
    supportsConversationChaining: false,
    supportsTracingControl: false,
    usesStrictToolSchema: true,
    nativePatchModelPrefixes: ['gpt-5.1'],
  });
});

test('Codex fetchModels parses custom models endpoint', async (t) => {
  const provider = getProvider('codex');
  t.truthy(provider);

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
    t.true(fetchUrl.startsWith('https://chatgpt.com/backend-api/codex/models?client_version='));
    t.is(authHeader, `Bearer ${validToken}`);
    t.is(models.length, 2);
    t.is(models[1].id, 'gpt-4o');
    t.is(models[1].default_reasoning_level, 'low');
    t.is(models[0].id, 'gpt-5-codex');
    t.is(models[0].default_reasoning_level, 'medium');
  } finally {
    process.env.CHATGPT_LOCAL_HOME = origHome;
    try {
      fs.unlinkSync(path.join(TEST_DIR, 'auth.json'));
    } catch {
      // ignore
    }
  }
});

test('resolveCodexClientVersion returns local version if available and writes to cache', async (t) => {
  const cacheDir = path.join(TEST_DIR, 'cache-local');
  fs.mkdirSync(cacheDir, { recursive: true });

  const execImpl = async (cmd: string) => {
    t.is(cmd, 'codex --version');
    return { stdout: 'codex-cli 1.2.3' };
  };

  const version = await resolveCodexClientVersion({
    cacheDir,
    execImpl: execImpl as any,
  });

  t.is(version, '1.2.3');

  // Verify it is cached
  const cachePath = path.join(cacheDir, 'codex-client-version.json');
  t.true(fs.existsSync(cachePath));
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  t.is(cached.version, '1.2.3');
  t.true(typeof cached.timestamp === 'number');
});

test('sanitizeCodexRequestInit leaves non-responses requests unchanged', (t) => {
  const init: RequestInit = {
    body: JSON.stringify({
      input: [{ type: 'reasoning', id: 'rs_123' }],
    }),
  };

  const sanitized = sanitizeCodexRequestInit('https://chatgpt.com/backend-api/codex/models', init);
  t.deepEqual(sanitized, init);
});

test('sanitizeCodexRequestInit normalizes include JSON string to array', (t) => {
  const init: RequestInit = {
    body: JSON.stringify({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      include: '["reasoning.encrypted_content"]',
    }),
  };

  const sanitized = sanitizeCodexRequestInit('https://chatgpt.com/backend-api/codex/responses', init);
  const body = JSON.parse(String(sanitized?.body));
  t.true(Array.isArray(body.include));
  t.deepEqual(body.include, ['reasoning.encrypted_content']);
});

test('resolveCodexClientVersion falls back to npm registry if local version fails', async (t) => {
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

  t.is(version, '2.3.4');
  t.is(fetchUrl, 'https://registry.npmjs.org/@openai/codex/latest');

  // Verify cached
  const cachePath = path.join(cacheDir, 'codex-client-version.json');
  t.true(fs.existsSync(cachePath));
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  t.is(cached.version, '2.3.4');
});

test('resolveCodexClientVersion falls back to fallback version if all fails', async (t) => {
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

  t.is(version, '0.133.0');

  // Verify cached
  const cachePath = path.join(cacheDir, 'codex-client-version.json');
  t.true(fs.existsSync(cachePath));
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  t.is(cached.version, '0.133.0');
});

test('resolveCodexClientVersion uses cache if valid and less than one week old', async (t) => {
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
    t.fail('exec should not be called when valid cache exists');
    return { stdout: '' };
  };

  const mockFetch = async () => {
    t.fail('fetch should not be called when valid cache exists');
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const version = await resolveCodexClientVersion({
    cacheDir,
    execImpl: execImpl as any,
    fetchImpl: mockFetch as any,
  });

  t.is(version, '9.9.9');
});

test('resolveCodexClientVersion ignores cache if older than one week', async (t) => {
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

  t.is(version, '1.0.0');

  // Verify cache updated
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  t.is(cached.version, '1.0.0');
  t.true(Date.now() - cached.timestamp < 1000);
});

test('Codex fetchModels appends correct client_version from cache/resolver', async (t) => {
  const provider = getProvider('codex');
  t.truthy(provider);

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
    t.is(fetchUrl, 'https://chatgpt.com/backend-api/codex/models?client_version=1.2.3-test');
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

test('extractAccountIdFromClaims resolves account ID with correct precedence', (t) => {
  const claims1 = { chatgpt_account_id: 'acc_1' };
  t.is(extractAccountIdFromClaims(claims1), 'acc_1');

  const claims2 = {
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc_2' },
  };
  t.is(extractAccountIdFromClaims(claims2), 'acc_2');

  const claims3 = {
    organizations: [{ id: 'org_3' }],
  };
  t.is(extractAccountIdFromClaims(claims3), 'org_3');

  // Precedence test: chatgpt_account_id > https://api.openai.com/auth > organizations
  const claimsAll = {
    chatgpt_account_id: 'acc_1',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc_2' },
    organizations: [{ id: 'org_3' }],
  };
  t.is(extractAccountIdFromClaims(claimsAll), 'acc_1');

  const claimsNestedAndOrg = {
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc_2' },
    organizations: [{ id: 'org_3' }],
  };
  t.is(extractAccountIdFromClaims(claimsNestedAndOrg), 'acc_2');
});

test('extractAccountId prefers id_token claims over access_token claims', (t) => {
  const idToken = createFakeJwtWithClaims({ chatgpt_account_id: 'acc_id_token' });
  const accessToken = createFakeJwtWithClaims({ chatgpt_account_id: 'acc_access_token' });

  // Preferred id_token
  t.is(extractAccountId(idToken, accessToken), 'acc_id_token');

  // Fallback to access_token if id_token is missing or has no relevant claim
  t.is(extractAccountId(undefined, accessToken), 'acc_access_token');
  t.is(extractAccountId('', accessToken), 'acc_access_token');
});

test.serial('CodexTokenManager extracts and stores accountId from file and refresh responses', async (t) => {
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
  t.is(manager.getAccountId(), null);

  await manager.getOrRefreshAccessToken();
  t.is(manager.getAccountId(), 'acc_from_id_token');

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
  t.is(managerFallback.getAccountId(), 'acc_from_file_direct');
});

test.serial('Codex fetchModels injects ChatGPT-Account-Id header if present', async (t) => {
  const provider = getProvider('codex');
  t.truthy(provider);

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
    t.is(fetchHeaders['ChatGPT-Account-Id'], 'acc_models_test');
  } finally {
    process.env.CHATGPT_LOCAL_HOME = origHome;
    try {
      fs.unlinkSync(path.join(TEST_DIR, 'auth.json'));
    } catch {}
  }
});

test.serial('Codex provider createRunner custom fetch injects chatgpt-account-id header', async (t) => {
  const provider = getProvider('codex');
  t.truthy(provider);
  if (!provider || !provider.createRunner) {
    t.fail('createRunner is undefined');
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
    t.truthy(runner);
    if (!runner) return;
    const modelProvider = runner.config.modelProvider;
    const model = await modelProvider.getModel('gpt-5.3-codex');
    const client = (model as any)._client;

    await client.chat.completions
      .create({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-4o',
      })
      .catch(() => {});

    t.is(interceptorHeaders['chatgpt-account-id'], 'acc_runner_test');
  } finally {
    globalThis.fetch = origFetch;
    process.env.CHATGPT_LOCAL_HOME = origHome;
    try {
      fs.unlinkSync(path.join(TEST_DIR, 'auth.json'));
    } catch {}
  }
});
