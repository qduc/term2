import assert from 'node:assert/strict';
import test from 'node:test';
import { attachAbortCleanup } from './request-guards.js';
import { Term2GatewayClient } from './term2-gateway-client.js';

test('abort cleanup subscribes before an in-flight operation can complete', () => {
  const controller = new AbortController();
  let destroyed = false;
  attachAbortCleanup(controller.signal, () => {
    destroyed = true;
  });
  controller.abort();
  assert.equal(destroyed, true);
});

test('abort cleanup destroys immediately when already aborted', () => {
  const controller = new AbortController();
  controller.abort();
  let destroyed = false;
  attachAbortCleanup(controller.signal, () => {
    destroyed = true;
  });
  assert.equal(destroyed, true);
});

test('stream abort destroys a request that is still waiting for headers', async () => {
  const controller = new AbortController();
  const request = {
    destroyed: false,
    handlers: new Map<string, () => void>(),
    on(event: string, handler: () => void) {
      this.handlers.set(event, handler);
      return this;
    },
    end() {},
    destroy() {
      this.destroyed = true;
      this.handlers.get('error')?.();
    },
  };
  const client = new Term2GatewayClient({
    gatewayConfig: {
      enabled: true,
      sshEnabled: false,
      allowUnsandboxed: false,
      autoApprove: false,
      gatewayPort: 3211,
      gatewayHost: '127.0.0.1',
      streamTimeoutMs: 600_000,
      requestTimeoutMs: 600_000,
      pairingEnabled: false,
      keyId: 'test-key',
      issuer: 'test-issuer',
      audience: 'test-audience',
      assertionTtlSec: 60,
      clockSkewSec: 5,
      tlsRequireClientCert: false,
    },
    requestImpl: () => request,
  });
  client.issueAssertion = () => 'test-assertion';

  const pending = client.stream({
    userId: 'local-owner',
    purpose: 'events_connect',
    workspaceId: 'workspace',
    sessionId: 'session',
    rpcPath: '/private/agent/v1/sessions/session/events',
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();
  const result = await Promise.race([
    pending.then(
      () => 'resolved',
      (error) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
  ]);
  assert.notEqual(result, 'timeout');
  assert.notEqual(result, 'resolved');
  assert.equal(request.destroyed, true, String(result));
});
