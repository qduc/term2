import { describe, expect, it } from 'vitest';
import { registerSandboxNetworkApprovalHandler, requestSandboxNetworkApproval } from './sandbox-network-approval.js';

describe('sandbox-network-approval', () => {
  it('returns false when no handler is registered', async () => {
    registerSandboxNetworkApprovalHandler(null);

    const allowed = await requestSandboxNetworkApproval({ host: 'example.com', port: 443 });

    expect(allowed).toBe(false);
  });

  it('delegates to the registered handler', async () => {
    const unregister = registerSandboxNetworkApprovalHandler(async ({ host, port }) => {
      return host === 'example.com' && port === 443;
    });

    await expect(requestSandboxNetworkApproval({ host: 'example.com', port: 443 })).resolves.toBe(true);
    await expect(requestSandboxNetworkApproval({ host: 'example.com', port: 80 })).resolves.toBe(false);

    unregister();
  });

  it('clears only the active handler on unregister', async () => {
    const unregisterFirst = registerSandboxNetworkApprovalHandler(async () => true);
    const unregisterSecond = registerSandboxNetworkApprovalHandler(async () => false);

    unregisterFirst();
    await expect(requestSandboxNetworkApproval({ host: 'example.com', port: 443 })).resolves.toBe(false);

    unregisterSecond();
    await expect(requestSandboxNetworkApproval({ host: 'example.com', port: 443 })).resolves.toBe(false);
  });
});
