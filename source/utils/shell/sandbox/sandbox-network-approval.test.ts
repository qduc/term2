import { describe, expect, it } from 'vitest';
import {
  registerSandboxNetworkApprovalHandler,
  registerSandboxNetworkApprovalPauseController,
  requestSandboxNetworkApproval,
} from './sandbox-network-approval.js';

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

  it('pauses the active sandboxed command while waiting for user approval', async () => {
    let resolveApproval: ((allow: boolean) => void) | undefined;
    const events: string[] = [];
    const unregisterHandler = registerSandboxNetworkApprovalHandler(async () => {
      events.push('handler-started');
      return await new Promise<boolean>((resolve) => {
        resolveApproval = resolve;
      });
    });
    const unregisterPauseController = registerSandboxNetworkApprovalPauseController({
      pause: () => {
        events.push('paused');
      },
      resume: () => {
        events.push('resumed');
      },
    });

    const pending = requestSandboxNetworkApproval({ host: 'example.com', port: 443 });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(['paused', 'handler-started']);

    resolveApproval?.(true);
    await expect(pending).resolves.toBe(true);
    expect(events).toEqual(['paused', 'handler-started', 'resumed']);

    unregisterPauseController();
    unregisterHandler();
  });

  it('resumes the active sandboxed command when approval handling throws', async () => {
    const events: string[] = [];
    const unregisterHandler = registerSandboxNetworkApprovalHandler(async () => {
      throw new Error('approval failed');
    });
    const unregisterPauseController = registerSandboxNetworkApprovalPauseController({
      pause: () => {
        events.push('paused');
      },
      resume: () => {
        events.push('resumed');
      },
    });

    await expect(requestSandboxNetworkApproval({ host: 'example.com', port: 443 })).resolves.toBe(false);

    expect(events).toEqual(['paused', 'resumed']);

    unregisterPauseController();
    unregisterHandler();
  });
});
