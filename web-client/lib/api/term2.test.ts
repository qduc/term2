import assert from 'node:assert/strict';
import test from 'node:test';
import { httpClient } from '../http.js';
import { term2Client, validateCandidate, validateSelectedCandidate, validateSettings } from './term2.js';

test('bypasses application auth handling for local gateway requests and streams', async () => {
  const client = httpClient as unknown as {
    get: (path: string, options?: Record<string, unknown>) => Promise<{ data: unknown }>;
  };
  const originalGet = client.get;
  const calls: Array<{ path: string; options?: Record<string, unknown> }> = [];
  client.get = async (path, options) => {
    calls.push({ path, options });
    return { data: path.includes('/events?') ? new Response() : { workspaces: [], nextCursor: null } };
  };
  try {
    await term2Client.listWorkspaces(20);
    await term2Client.openEvents('session_1', 0);
  } finally {
    client.get = originalGet;
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.options?.skipAuth, true);
  assert.equal(calls[1]?.options?.skipAuth, true);
  assert.equal(calls[0]?.options?.skipRetry, true);
  assert.equal(calls[1]?.options?.skipRetry, true);
});

test('normalizes the gateway candidate validation response', () => {
  assert.deepEqual(
    validateCandidate({
      valid: true,
      candidateId: 'candidate_1',
      displayName: 'workspace',
      expiresAt: 1_780_000_000_000,
      checks: [{ name: 'contained', status: 'ok' }],
    }),
    {
      valid: true,
      selectable: true,
      candidateId: 'candidate_1',
      displayName: 'workspace',
      expiresAt: 1_780_000_000_000,
      checks: [{ name: 'contained', status: 'ok' }],
    },
  );
});

test('normalizes access from the gateway selection binding', () => {
  assert.deepEqual(
    validateSelectedCandidate({
      workspaceId: 'workspace_1',
      displayName: 'workspace',
      binding: {
        sessionId: 'session_1',
        ownerUserId: 'local-owner',
        workspaceId: 'workspace_1',
        grantVersion: 1,
        canonicalRoot: '/tmp/workspace',
        access: 'read_write',
      },
    }),
    { workspaceId: 'workspace_1', displayName: 'workspace', access: 'read_write' },
  );
});

test('accepts the gateway provider disabled flag in settings projections', () => {
  const projection = validateSettings({
    schemaVersion: 1,
    revision: 'r1',
    defaultsRevision: 'r1',
    settings: {
      safeDefaults: {
        'agent.modelSelection': {
          value: { model: 'bound-model', provider: 'qa-mock' },
          source: 'config', scope: 'session', confirmRequired: false, persistable: false,
        },
      },
      credentials: {},
      providers: [
        {
          id: 'qa-mock',
          label: 'QA mock',
          isCustom: true,
          active: true,
          disabled: false,
          credential: { configured: true, required: false, source: 'local', writable: true },
        },
      ],
      oauthAccounts: {},
      safety: {
        sandbox: 'enabled',
        approval: 'off',
        backgroundShell: 'disabled-by-gateway',
        workspaceAccess: 'read',
        network: 'denied',
      },
    },
  });
  assert.equal(projection.settings.providers[0]?.disabled, false);
  assert.deepEqual(projection.settings.safeDefaults['agent.modelSelection']?.value, { model: 'bound-model', provider: 'qa-mock' });
});

test('rejects incomplete or extra-field selection values from the gateway', () => {
  for (const value of [{ model: 'alone' }, { provider: 'alone' }, { model: 'm', provider: 'p', secret: 'hidden' }, 'scalar']) {
    assert.throws(() => validateSettings({
      schemaVersion: 1, revision: 'r1', defaultsRevision: 'r1',
      settings: { safeDefaults: { 'agent.modelSelection': { value, source: 'config', scope: 'session', confirmRequired: false, persistable: false } }, credentials: {}, providers: [], oauthAccounts: {}, safety: {} },
    }));
  }
});
