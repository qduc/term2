import { describe, expect, it, vi } from 'vitest';
import { createSessionRolloverToolDefinition, sessionRolloverParameters } from './session-rollover-tool.js';

describe('session_rollover tool', () => {
  it('guides short durable handoffs and checks live work before drafting', () => {
    const tool = createSessionRolloverToolDefinition(() => ({
      ok: true,
      status: 'rollover_requested',
      rolloverId: 'r',
    }));
    expect(tool.description).toContain('8,000');
    expect(tool.description).toContain('background work');
    expect(tool.description).toContain('session-owned');
    expect(sessionRolloverParameters.shape.brief.description).toContain('delta');
  });
  it('validates the bounded strict request and records it without approval', async () => {
    const request = vi.fn(() => ({ ok: true as const, status: 'rollover_requested' as const, rolloverId: 'r1' }));
    const tool = createSessionRolloverToolDefinition(request);

    expect(sessionRolloverParameters.safeParse({ brief: 'done', reason: 'task_boundary' }).success).toBe(true);
    expect(sessionRolloverParameters.safeParse({ brief: 'done', extra: true }).success).toBe(false);
    expect(sessionRolloverParameters.safeParse({ brief: 'x'.repeat(8_001) }).success).toBe(false);
    expect(await tool.needsApproval({ brief: 'done' })).toBe(false);
    const output = await tool.execute({ brief: 'done', reason: 'task_boundary' });

    expect(request).toHaveBeenCalledWith({ brief: 'done', reason: 'task_boundary' });
    expect(JSON.parse(String(output))).toEqual({ ok: true, status: 'rollover_requested', rolloverId: 'r1' });
  });

  it('returns a tool error when live background work blocks rollover', async () => {
    const tool = createSessionRolloverToolDefinition(() => ({
      ok: false,
      status: 'rollover_blocked',
      error: 'Session rollover is blocked while background work is live.',
      active: { shell: 1, subagent: 2 },
      rolloverId: 'r2',
    }));

    expect(JSON.parse(String(await tool.execute({ brief: 'done' })))).toEqual({
      ok: false,
      status: 'rollover_blocked',
      error: 'Session rollover is blocked while background work is live.',
      active: { shell: 1, subagent: 2 },
      rolloverId: 'r2',
    });
  });

  it('rejects a missing brief and invalid reason', () => {
    expect(sessionRolloverParameters.safeParse({}).success).toBe(false);
    expect(sessionRolloverParameters.safeParse({ brief: 'done', reason: 'other' }).success).toBe(false);
  });
});
