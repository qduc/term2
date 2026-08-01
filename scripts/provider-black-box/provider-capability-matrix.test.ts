import { describe, expect, it } from 'vitest';
import {
  accountProviderCapabilityMatrix,
  assertProviderCapabilityAccounting,
  PROVIDER_CAPABILITY_MATRIX,
  type CapabilityExecution,
} from './provider-capability-matrix.js';

describe('provider capability matrix', () => {
  it('declares every target route with transport, lifecycle, and required scenarios', () => {
    expect(PROVIDER_CAPABILITY_MATRIX).toHaveLength(12);
    expect(new Set(PROVIDER_CAPABILITY_MATRIX.map((row) => row.id)).size).toBe(12);
    for (const row of PROVIDER_CAPABILITY_MATRIX) {
      expect(row.registryRoute.providerId, row.id).toBeTruthy();
      expect(row.wireFamily, row.id).toBeTruthy();
      expect(['http-sse', 'websocket']).toContain(row.transport);
      expect(['server-managed', 'stateless']).toContain(row.chainingMode);
      expect(row.requiredScenarios.length, row.id).toBeGreaterThan(0);
      expect(typeof row.toolSupport.supportsTools, row.id).toBe('boolean');
      expect(typeof row.toolSupport.supportsApproval, row.id).toBe('boolean');
      expect(row.nativeContinuationField === null || typeof row.nativeContinuationField === 'string', row.id).toBe(
        true,
      );
    }
  });

  it('unit-tests the accounting primitive with representative execution entries', () => {
    const executions: CapabilityExecution[] = PROVIDER_CAPABILITY_MATRIX.map((row) => ({
      rowId: row.id,
      scenarioId: row.requiredScenarios[0]!,
    }));
    expect(accountProviderCapabilityMatrix(PROVIDER_CAPABILITY_MATRIX, executions)).toEqual({
      accounted: PROVIDER_CAPABILITY_MATRIX.map((row) => row.id),
      unaccounted: [],
      invalidExecutions: [],
    });
    expect(() => assertProviderCapabilityAccounting(PROVIDER_CAPABILITY_MATRIX, executions)).not.toThrow();
  });

  it('fails when a row has neither an executed scenario nor a documented exclusion', () => {
    const executions: CapabilityExecution[] = [
      { rowId: PROVIDER_CAPABILITY_MATRIX[0]!.id, scenarioId: PROVIDER_CAPABILITY_MATRIX[0]!.requiredScenarios[0]! },
    ];
    expect(() => assertProviderCapabilityAccounting(PROVIDER_CAPABILITY_MATRIX, executions)).toThrow(
      /unexecuted and unexcluded capability rows:.*openai-websocket/i,
    );
  });

  it('accepts an exclusion only when it carries a reason and evidence', () => {
    const matrix = PROVIDER_CAPABILITY_MATRIX.map((row) => ({
      ...row,
      exclusion: {
        reason: 'deferred to the provider-family work package',
        evidence: 'integration-test-improvement-remaining.md',
      },
    }));
    expect(() => assertProviderCapabilityAccounting(matrix, [])).not.toThrow();
    const bad = [{ ...matrix[0]!, exclusion: { reason: '', evidence: '' } }];
    expect(() => accountProviderCapabilityMatrix(bad, [])).toThrow(/incomplete exclusion/i);
  });

  it('rejects an execution that does not belong to the row required-scenario set', () => {
    expect(() =>
      assertProviderCapabilityAccounting(PROVIDER_CAPABILITY_MATRIX, [
        { rowId: PROVIDER_CAPABILITY_MATRIX[0]!.id, scenarioId: 'unrelated-scenario' },
      ]),
    ).toThrow(/unknown scenarios/i);
  });
});
