import { describe, expect, it } from 'vitest';
import { SandboxNetworkApprovalCoordinator } from './sandbox-network-approval-coordinator.js';

describe('SandboxNetworkApprovalCoordinator', () => {
  it('publishes and resolves requests in FIFO order', async () => {
    const coordinator = new SandboxNetworkApprovalCoordinator();
    const snapshots: string[] = [];
    const unsubscribe = coordinator.subscribe(() => {
      snapshots.push(coordinator.getSnapshot().activeRequest?.host ?? 'none');
    });

    const first = coordinator.request({ host: 'first.example', port: 443 });
    const second = coordinator.request({ host: 'second.example', port: 8443 });

    expect(coordinator.getSnapshot()).toEqual({ activeRequest: { host: 'first.example', port: 443 } });

    const firstRequest = coordinator.getSnapshot().activeRequest;
    expect(firstRequest).not.toBeNull();
    coordinator.resolve(firstRequest!, 'allow-once');
    await expect(first).resolves.toBe('allow-once');
    expect(coordinator.getSnapshot()).toEqual({ activeRequest: { host: 'second.example', port: 8443 } });

    const secondRequest = coordinator.getSnapshot().activeRequest;
    expect(secondRequest).not.toBeNull();
    coordinator.resolve(secondRequest!, 'deny');
    await expect(second).resolves.toBe('deny');
    expect(coordinator.getSnapshot()).toEqual({ activeRequest: null });
    expect(snapshots).toEqual(['first.example', 'second.example', 'none']);

    unsubscribe();
  });

  it('denies the active and queued requests when disposed and never delivers another prompt', async () => {
    const coordinator = new SandboxNetworkApprovalCoordinator();
    const snapshots: string[] = [];
    coordinator.subscribe(() => {
      snapshots.push(coordinator.getSnapshot().activeRequest?.host ?? 'none');
    });
    const first = coordinator.request({ host: 'first.example' });
    const second = coordinator.request({ host: 'second.example' });

    coordinator.dispose();
    coordinator.dispose();

    await expect(first).resolves.toBe('deny');
    await expect(second).resolves.toBe('deny');
    await expect(coordinator.request({ host: 'after-dispose.example' })).resolves.toBe('deny');
    expect(coordinator.getSnapshot()).toEqual({ activeRequest: null });
    expect(snapshots).toEqual(['first.example', 'none']);
  });

  it('ignores stale or no-active resolutions', () => {
    const coordinator = new SandboxNetworkApprovalCoordinator();
    const first = { host: 'first.example' };
    const second = { host: 'second.example' };
    void coordinator.request(first);
    void coordinator.request(second);

    coordinator.resolve(first, 'allow-once');
    coordinator.resolve(first, 'deny');
    expect(coordinator.getSnapshot()).toEqual({ activeRequest: second });

    coordinator.resolve(second, 'deny');
    coordinator.resolve(second, 'allow-once');

    expect(coordinator.getSnapshot()).toEqual({ activeRequest: null });
  });
});
