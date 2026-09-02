import { describe, expect, it } from 'vitest';
import { createSafeLogMetadata, GatewayLogError } from './safe-log.js';
import { GatewayLifecycle } from './lifecycle.js';

describe('gateway-safe logging and lifecycle', () => {
  it('allows only bounded opaque metadata', () => {
    const record = createSafeLogMetadata({
      operation: 'session_create',
      outcome: 'allowed',
      sessionId: 's',
      workspaceId: 'w',
      grantVersion: 1,
      access: 'read',
      reasonCode: 'accepted',
    });
    expect(record.schemaVersion).toBe(1);
    expect(() =>
      createSafeLogMetadata({ operation: 'session_create', outcome: 'allowed', projectPath: '/secret' } as never),
    ).toThrowError(new GatewayLogError());
    expect(() =>
      createSafeLogMetadata({ operation: 'session_create', outcome: 'allowed', reasonCode: 'raw_command' } as never),
    ).toThrowError(new GatewayLogError());
  });

  it('drains workers, rejects new workers, and cleans every handle once', async () => {
    const lifecycle = new GatewayLifecycle();
    let closes = 0;
    const release = lifecycle.registerWorker({
      close: async () => {
        closes += 1;
      },
    });
    expect(lifecycle.activeWorkerCount).toBe(1);
    await lifecycle.shutdown(100);
    expect(closes).toBe(1);
    expect(lifecycle.state).toBe('stopped');
    release();
    expect(() => lifecycle.registerWorker({ close: () => undefined })).toThrow('not accepting');
  });
});
