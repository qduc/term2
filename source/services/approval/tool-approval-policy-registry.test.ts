import { describe, expect, it } from 'vitest';
import { ToolApprovalPolicyRegistry } from './tool-approval-policy-registry.js';

describe('ToolApprovalPolicyRegistry.decide', () => {
  it.each([
    { label: 'auto-approved', needsApproval: false, expected: 'allow' },
    { label: 'prompted', needsApproval: true, expected: 'deny' },
  ])('maps a $label raw policy to $expected', async ({ needsApproval, expected }) => {
    const registry = new ToolApprovalPolicyRegistry();
    registry.register({
      toolName: 'example',
      needsApproval: () => needsApproval,
    });

    await expect(registry.decide({ toolName: 'example', args: {} })).resolves.toBe(expected);
  });

  it('denies an unknown tool policy', async () => {
    await expect(new ToolApprovalPolicyRegistry().decide({ toolName: 'missing', args: {} })).resolves.toBe('deny');
  });

  it('distinguishes policy errors from a valid prompt', async () => {
    const registry = new ToolApprovalPolicyRegistry();
    registry.register({
      toolName: 'broken',
      needsApproval: () => {
        throw new Error('broken policy');
      },
    });
    await expect(registry.evaluate({ toolName: 'broken', args: {} })).resolves.toEqual({ kind: 'error' });
  });

  it('suppresses prompts when an interceptor rejects a call', async () => {
    const registry = new ToolApprovalPolicyRegistry();
    registry.register({
      toolName: 'blocked',
      needsApproval: () => true,
      checkInterceptors: async () => 'blocked by plan mode',
    });
    await expect(registry.evaluate({ toolName: 'blocked', args: {} })).resolves.toEqual({ kind: 'interceptor_denied' });
  });
});
