import { describe, expect, it, vi } from 'vitest';
import { createContinuationHandle } from '../../contracts/continuation-handle.js';
import { BackgroundSubagentApprovalController } from './background-subagent-approval-controller.js';
import type { BackgroundSubagentApprovalPause } from '../subagents/foreground-subagent-lease.js';

const logger = {
  getCorrelationId: () => 'trace-test',
  debug: () => undefined,
  error: () => undefined,
  security: () => undefined,
};

describe('BackgroundSubagentApprovalController', () => {
  it('resolves the FIFO entry by applying policy to its exact retained continuation', () => {
    const approve = vi.fn();
    const apply = vi.fn(
      (callback: BackgroundSubagentApprovalPause['apply'] extends (callback: infer T) => boolean ? T : never) =>
        callback({
          runId: 'child-run',
          generation: 1,
          handle: createContinuationHandle({ approve }),
          interruption: { name: 'shell', callId: 'child-tool', arguments: '{"command":"pwd"}' },
        }),
    );
    const controller = new BackgroundSubagentApprovalController({ logger: logger as any, sessionId: 'session-1' });
    controller.publish({
      runId: 'child-run',
      generation: 1,
      role: 'worker',
      interruption: { name: 'shell', callId: 'child-tool', arguments: '{"command":"pwd"}' },
      apply,
    });

    const snapshot = controller.getSnapshot();
    expect(snapshot.current).toMatchObject({ runId: 'child-run', toolCallId: 'child-tool', toolName: 'shell' });
    expect(
      controller.resolve({ revision: snapshot.revision, entry: snapshot.current!, decision: { answer: 'y' } }),
    ).toMatchObject({
      kind: 'resolved',
    });
    expect(approve).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().current).toBeNull();
  });
});
