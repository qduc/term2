import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCandidate, validateSelectedCandidate, validateSettings } from './term2.js';

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
      safeDefaults: {},
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
});
