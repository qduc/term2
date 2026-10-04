import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createRunCodeToolDefinition, getRunCodeExecutionResult } from './run-code.js';
import { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import type { AnyToolDefinition } from '../../types.js';

const fixtures = [
  { name: 'plain', payload: 'ordinary text', naive: 'exact' },
  { name: 'backticks', payload: 'const text = `hello`;', naive: 'parse failure' },
  { name: 'interpolation', payload: '${1 + 1}', naive: 'changed bytes' },
  { name: 'quotes', payload: 'He said "yes"; it\'s fine.\nSecond line.', naive: 'exact' },
  { name: 'jsx', payload: '<Panel title={`hello ${1 + 1}`} />', naive: 'parse failure' },
] as const;

describe('local run_code code/data composition experiment', () => {
  for (const fixture of fixtures) {
    for (const strategy of ['naive template', 'escaped literal', 'inputs'] as const) {
      it(`${strategy}: ${fixture.name}`, async () => {
        const received: string[] = [];
        const execute = vi.fn((params: unknown) => {
          received.push((params as { value: string }).value);
          return 'accepted';
        });
        const nested = {
          name: 'capture',
          description: 'Capture exact composition bytes without filesystem effects',
          parameters: z.object({ value: z.string() }),
          needsApproval: () => false,
          execute,
          formatCommandMessage: () => [],
        } as unknown as AnyToolDefinition;
        const approvals = new ToolApprovalPolicyRegistry();
        approvals.register({
          toolName: nested.name,
          parameters: nested.parameters,
          needsApproval: nested.needsApproval,
        });
        const host = createRunCodeToolDefinition({
          loggingService: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            security: vi.fn(),
          } as unknown as ILoggingService,
          getToolRegistry: () => [nested],
          getCwd: () => process.cwd(),
          approvalPolicyRegistry: approvals,
        });
        const value =
          strategy === 'naive template'
            ? '`' + fixture.payload + '`'
            : strategy === 'escaped literal'
            ? JSON.stringify(fixture.payload)
            : 'inputs.payload';
        const result = await host.execute(
          {
            code: 'return await tools.capture({ value: ' + value + ' });',
            inputs: { payload: fixture.payload },
            description: 'local paired composition fixture',
          } as never,
          undefined,
          { toolCall: { callId: 'composition-fixture' } },
        );
        const execution = getRunCodeExecutionResult(result);
        if (strategy === 'naive template' && fixture.naive === 'parse failure') {
          expect(execution?.script.status).toBe('failed');
          expect(execute).not.toHaveBeenCalled();
        } else {
          expect(execution?.script.status).toBe('succeeded');
          expect(execute).toHaveBeenCalledTimes(1);
          if (strategy === 'naive template' && fixture.naive === 'changed bytes') {
            expect(received).toEqual(['2']);
            expect(received[0]).not.toBe(fixture.payload);
          } else {
            expect(received).toEqual([fixture.payload]);
          }
        }
      });
    }
  }
});
