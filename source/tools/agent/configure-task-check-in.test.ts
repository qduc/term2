import { describe, expect, it, vi } from 'vitest';
import { createConfigureTaskCheckInToolDefinition } from './configure-task-check-in.js';

describe('configure_task_check_in tool', () => {
  it('defines tool metadata properly', () => {
    const handler = vi.fn();
    const tool = createConfigureTaskCheckInToolDefinition(handler);

    expect(tool.name).toBe('configure_task_check_in');
    expect(tool.needsApproval({ target: '123' }, undefined)).toBe(false);
    expect(tool.description).toContain('check-in');
  });

  it('executes handler and returns JSON output', async () => {
    const handler = vi.fn().mockReturnValue({
      ok: true,
      message: 'Check-in disabled for shell job 123.',
    });
    const tool = createConfigureTaskCheckInToolDefinition(handler);

    const result = await tool.execute(
      {
        target: '123',
        enabled: false,
      },
      undefined,
      undefined,
    );

    expect(handler).toHaveBeenCalledWith({
      target: '123',
      enabled: false,
      interval_seconds: undefined,
      next_check_in_seconds: undefined,
    });

    expect(JSON.parse(result as string)).toEqual({
      ok: true,
      message: 'Check-in disabled for shell job 123.',
    });
  });

  it('formats command message nicely for UI rendering', () => {
    const handler = vi.fn();
    const tool = createConfigureTaskCheckInToolDefinition(handler);

    const messages = tool.formatCommandMessage?.(
      {
        rawItem: {
          arguments: JSON.stringify({
            target: 'worker-1',
            enabled: false,
            interval_seconds: 600,
          }),
          output: JSON.stringify({
            ok: true,
            message: 'Check-in disabled for worker-1.',
          }),
        },
      },
      0,
      new Map(),
    );

    expect(messages).toHaveLength(1);
    expect(messages?.[0].command).toContain('worker-1');
  });
});
