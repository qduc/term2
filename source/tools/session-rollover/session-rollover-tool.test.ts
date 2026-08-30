import { describe, expect, it, vi } from 'vitest';
import { createSessionRolloverToolDefinition, sessionRolloverParameters } from './session-rollover-tool.js';

describe('session_rollover tool', () => {
  it('validates the bounded strict request and records it without approval', async () => {
    const request = vi.fn();
    const tool = createSessionRolloverToolDefinition(request);

    expect(sessionRolloverParameters.safeParse({ brief: 'done', reason: 'task_boundary' }).success).toBe(true);
    expect(sessionRolloverParameters.safeParse({ brief: 'done', extra: true }).success).toBe(false);
    expect(sessionRolloverParameters.safeParse({ brief: 'x'.repeat(8_001) }).success).toBe(false);
    expect(await tool.needsApproval({ brief: 'done' })).toBe(false);
    await tool.execute({ brief: 'done', reason: 'task_boundary' });

    expect(request).toHaveBeenCalledWith({ brief: 'done', reason: 'task_boundary' });
  });

  it('rejects a missing brief and invalid reason', () => {
    expect(sessionRolloverParameters.safeParse({}).success).toBe(false);
    expect(sessionRolloverParameters.safeParse({ brief: 'done', reason: 'other' }).success).toBe(false);
  });
});
