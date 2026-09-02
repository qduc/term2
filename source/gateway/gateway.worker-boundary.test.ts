import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertExplicitSanitizedEnv,
  composeGatewaySession,
  createSanitizedWorkerEnv,
  WorkerBoundaryError,
} from './worker-boundary.js';
import { executeShellCommand, GatewayShellEnvironmentError } from '../utils/shell/execute-shell.js';
import type { ProviderBrokerCapability } from './contracts.js';

const tempRoots: string[] = [];
const makeTemp = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'term2-gateway-'));
  tempRoots.push(root);
  return root;
};

const broker: ProviderBrokerCapability = {
  capabilityId: 'cap-a',
  providerId: 'openai',
  modelId: 'operator-default',
  request: async () => ({ text: 'ok' }),
  async *stream() {
    yield { type: 'done' as const };
  },
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('worker process boundary', () => {
  it('builds explicit secret-free env and proves a child cannot see ambient secrets', async () => {
    const env = createSanitizedWorkerEnv({ sessionId: 's1', tmpDir: '/private/tmp/s1' });
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      env: { ...env, PROVIDER_API_KEY: undefined, SSH_AUTH_SOCK: undefined },
      encoding: 'utf8',
    });
    const observed = JSON.parse(child.stdout);
    expect(observed.TERM2_SESSION_ID).toBe('s1');
    expect(observed.PROVIDER_API_KEY).toBeUndefined();
    expect(observed.SSH_AUTH_SOCK).toBeUndefined();
    expect(() =>
      createSanitizedWorkerEnv({ sessionId: 's1', tmpDir: '/private/tmp/s1', path: '/bad/KEY' }),
    ).not.toThrow();
    expect(() => assertExplicitSanitizedEnv({ ...env, API_TOKEN: 'secret' })).toThrowError(
      new WorkerBoundaryError('unsafe_environment'),
    );
    await expect(executeShellCommand('ignored', { gatewayMode: true })).rejects.toThrowError(
      new GatewayShellEnvironmentError(),
    );
  });

  it('keeps broker capability secret-free and session composition distinct', () => {
    const rootA = makeTemp();
    const rootB = makeTemp();
    const base = (root: string, id: string) => ({
      sessionId: id,
      ownerUserId: 'u',
      workspaceId: id,
      grantVersion: 1,
      canonicalRoot: root,
      access: 'read' as const,
    });
    const a = composeGatewaySession({
      binding: base(rootA, 'a'),
      providerBroker: broker,
      providerProbe: { available: true, secretFree: true },
      tmpDir: path.join(rootA, 'tmp'),
      sandboxAvailable: true,
    });
    const b = composeGatewaySession({
      binding: base(rootB, 'b'),
      providerBroker: broker,
      providerProbe: { available: true, secretFree: true },
      tmpDir: path.join(rootB, 'tmp'),
      sandboxAvailable: true,
    });
    expect(a.executionContext).not.toBe(b.executionContext);
    expect(a.executionContext.getCwd()).toBe(rootA);
    expect(b.executionContext.getCwd()).toBe(rootB);
    a.dispose();
    b.dispose();
  });

  it('fails closed when provider readiness or sandbox boundary is unavailable', () => {
    expect(() =>
      composeGatewaySession({
        binding: {
          sessionId: 's',
          ownerUserId: 'u',
          workspaceId: 'w',
          grantVersion: 1,
          canonicalRoot: '/',
          access: 'read',
        },
        providerBroker: broker,
        providerProbe: { available: true, secretFree: true },
        tmpDir: '/private/tmp/s',
      }),
    ).toThrowError(new WorkerBoundaryError('sandbox_unavailable'));
    expect(() =>
      composeGatewaySession({
        binding: {
          sessionId: 's',
          ownerUserId: 'u',
          workspaceId: 'w',
          grantVersion: 1,
          canonicalRoot: '/',
          access: 'read',
        },
        providerBroker: broker,
        providerProbe: { available: false, secretFree: false },
        tmpDir: '/tmp/s',
        sandboxAvailable: true,
      }),
    ).toThrowError(new WorkerBoundaryError('provider_unavailable'));
    expect(() =>
      composeGatewaySession({
        binding: {
          sessionId: 's',
          ownerUserId: 'u',
          workspaceId: 'w',
          grantVersion: 1,
          canonicalRoot: '/',
          access: 'read',
        },
        providerBroker: broker,
        providerProbe: { available: true, secretFree: true },
        tmpDir: '/tmp/s',
        sandboxAvailable: false,
      }),
    ).toThrowError(new WorkerBoundaryError('sandbox_unavailable'));
  });
});
