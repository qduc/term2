import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createRunCodeToolDefinition } from './run-code.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';
import type { AnyToolDefinition, ToolRegistry } from '../../types.js';

const noopFormatter = (() => []) as unknown as AnyToolDefinition['formatCommandMessage'];

const tool = (overrides: Partial<AnyToolDefinition> & { name: string }): AnyToolDefinition =>
  ({
    description: 'test tool',
    parameters: z.object({ target: z.string() }),
    needsApproval: () => false,
    execute: (params: unknown) => `echo:${(params as { target: string }).target}`,
    formatCommandMessage: noopFormatter,
    ...overrides,
  } as AnyToolDefinition);

const logging = (): ILoggingService =>
  ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), security: vi.fn() } as unknown as ILoggingService);

const runWith = async (registry: ToolRegistry, code: string, params: Record<string, unknown> = {}) => {
  const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
  for (const candidate of registry) {
    approvalPolicyRegistry.register({
      toolName: candidate.name,
      parameters: candidate.parameters,
      needsApproval: candidate.needsApproval,
    });
  }
  const runCode = createRunCodeToolDefinition({
    loggingService: logging(),
    getToolRegistry: () => registry,
    getCwd: () => process.cwd(),
    approvalPolicyRegistry,
  });
  return String(await runCode.execute({ code, timeout_ms: 60_000, ...params } as never));
};

const checkIn = (execute: AnyToolDefinition['execute']) => tool({ name: 'configure_task_check_in', execute });

const cancelRun = (execute: AnyToolDefinition['execute']) => tool({ name: 'cancel_run', execute });

describe('run_code host-owned action receipts', () => {
  it('marks an ignored semantic ok:false check-in return as not applied despite a script success claim', async () => {
    const output = await runWith(
      [checkIn(() => JSON.stringify({ ok: false, error: 'no such task: foo' }))],
      `const r = await tools.configure_task_check_in({ target: 'foo' });
       return { ok: true, muted: true };`,
    );

    expect(output).toContain('Result:\n{"ok":true,"muted":true}');
    expect(output).toContain('Action outcomes (host-observed):');
    expect(output).toContain('configure_task_check_in');
    expect(output).toContain('not applied');
    expect(output).toContain('no such task: foo');
    expect(output).toContain('authoritative over conflicting script claims');
  });

  it('marks a cancelled/not_active cancel_run result as not applied', async () => {
    const output = await runWith(
      [cancelRun(() => JSON.stringify({ ok: false, code: 'not_active', target: 'missing' }))],
      `const r = await tools.cancel_run({ target: 'missing' });
       return { ok: true, cancelled: true };`,
    );

    expect(output).toContain('Result:\n{"ok":true,"cancelled":true}');
    expect(output).toContain('Action outcomes (host-observed):');
    expect(output).toContain('cancel_run');
    expect(output).toContain('not applied');
    expect(output).toContain('not_active');
  });

  it('records a caught invocation failure as failed even when the script returns success', async () => {
    const output = await runWith(
      [
        checkIn(() => {
          throw new Error('check-in store unavailable');
        }),
      ],
      `try {
         await tools.configure_task_check_in({ target: 'foo' });
       } catch (e) {
         // handled: report success anyway
       }
       return { ok: true };`,
    );

    expect(output).toContain('Result:\n{"ok":true}');
    expect(output).toContain('Action outcomes (host-observed):');
    expect(output).toContain('configure_task_check_in');
    expect(output).toContain('failed');
    expect(output).toContain('check-in store unavailable');
  });

  it('records an approval denial as not applied and keeps the existing Refused notice', async () => {
    const output = await runWith(
      [
        tool({
          name: 'configure_task_check_in',
          needsApproval: () => true,
          execute: () => {
            throw new Error('must not execute without approval');
          },
        }),
      ],
      `try {
         await tools.configure_task_check_in({ target: 'foo' });
       } catch (e) {
         return { ok: true, handled: true };
       }`,
    );

    expect(output).toContain('Refused (needs user approval');
    expect(output).toContain('Action outcomes (host-observed):');
    expect(output).toContain('not applied');
  });

  it('aggregates multiple mixed outcomes honestly without claiming task success', async () => {
    const output = await runWith(
      [
        checkIn(() => JSON.stringify({ ok: false, error: 'no such task: foo' })),
        cancelRun((params) =>
          JSON.stringify({ ok: true, runId: (params as { target: string }).target, status: 'cancelling' }),
        ),
      ],
      `const a = await tools.configure_task_check_in({ target: 'foo' });
       const b = await tools.cancel_run({ target: 'run-1' });
       return { ok: true };`,
    );

    expect(output).toContain('Action outcomes (host-observed):');
    expect(output).toContain('applied');
    expect(output).toContain('not applied');
    expect(output).toContain('Action summary:');
    expect(output).not.toMatch(
      /successfully muted|successfully cancelled|task muted|task complete|cancellation complete/i,
    );
  });

  it('marks a call still in flight at script timeout as unknown', async () => {
    const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
    const hanging = tool({
      name: 'configure_task_check_in',
      execute: () => new Promise<string>(() => undefined),
    });
    approvalPolicyRegistry.register({
      toolName: hanging.name,
      parameters: hanging.parameters,
      needsApproval: hanging.needsApproval,
    });
    const runCode = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => [hanging],
      getCwd: () => process.cwd(),
      approvalPolicyRegistry,
    });
    const output = String(
      await runCode.execute({
        code: `return await tools.configure_task_check_in({ target: 'foo' });`,
        timeout_ms: 500,
      } as never),
    );

    expect(output).toContain('timed out');
    expect(output).toContain('Action outcomes (host-observed):');
    expect(output).toContain('unknown');
    expect(output).toContain('did not settle');
  }, 20_000);

  it('adds no action section for observation-only scripts', async () => {
    const output = await runWith(
      [tool({ name: 'read_file', execute: () => 'contents' })],
      `const r = await tools.read_file({ target: 'notes.md' });
       return { length: r.length };`,
    );

    expect(output).toContain('Result:');
    expect(output).not.toContain('Action outcomes');
  });
});
