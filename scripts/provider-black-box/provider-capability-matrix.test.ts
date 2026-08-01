import { describe, expect, it } from 'vitest';
import {
  accountProviderCapabilityMatrix,
  assertProviderCapabilityAccounting,
  PROVIDER_CAPABILITY_MATRIX,
  type CapabilityExecution,
} from './provider-capability-matrix.js';
import { ALL_PROVIDER_SESSION_CAPABILITY_EXECUTIONS } from './provider-session-capability-manifest.js';

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
      expect(row.requiredScenarios, row.id).toContain(`${row.id}.two-user-turn`);
      expect(row.requiredScenarios, row.id).toContain(`${row.id}.approval-approve`);
      expect(row.requiredScenarios, row.id).toContain(`${row.id}.approval-reject`);
      if (row.transport === 'http-sse') expect(row.requiredScenarios, row.id).not.toContain(`${row.id}.abnormal-close`);
      if (row.transport === 'websocket') expect(row.requiredScenarios, row.id).toContain(`${row.id}.abnormal-close`);
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
    const accounting = accountProviderCapabilityMatrix(PROVIDER_CAPABILITY_MATRIX, executions);
    expect(accounting.accounted).toEqual(PROVIDER_CAPABILITY_MATRIX.map((row) => row.id));
    expect(accounting.unaccounted).toEqual([]);
    expect(accounting.invalidExecutions).toEqual([]);
    expect(accounting.missingScenarios).toContain('openai-http.approval-approve');
    expect(() => assertProviderCapabilityAccounting(PROVIDER_CAPABILITY_MATRIX, executions)).toThrow(
      /required lifecycle scenarios are missing/i,
    );
  });

  it('accounts the real lifecycle ledgers without importing their test modules', () => {
    const accounting = accountProviderCapabilityMatrix(
      PROVIDER_CAPABILITY_MATRIX,
      ALL_PROVIDER_SESSION_CAPABILITY_EXECUTIONS,
    );
    expect(accounting.unaccounted).toEqual([]);
    expect(accounting.missingScenarios).toEqual([]);
    expect(accounting.invalidExecutions).toEqual([]);
    expect(() =>
      assertProviderCapabilityAccounting(PROVIDER_CAPABILITY_MATRIX, ALL_PROVIDER_SESSION_CAPABILITY_EXECUTIONS),
    ).not.toThrow();
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
    const badScenario = [
      {
        ...PROVIDER_CAPABILITY_MATRIX[0]!,
        exclusion: { reason: 'reason', evidence: 'evidence', scenarioIds: ['unknown'] },
      },
    ];
    expect(() => accountProviderCapabilityMatrix(badScenario, [])).toThrow(/excludes unknown scenario/i);
  });

  it('rejects an execution that does not belong to the row required-scenario set', () => {
    expect(() =>
      assertProviderCapabilityAccounting(PROVIDER_CAPABILITY_MATRIX, [
        { rowId: PROVIDER_CAPABILITY_MATRIX[0]!.id, scenarioId: 'unrelated-scenario' },
      ]),
    ).toThrow(/unknown scenarios/i);
  });
});
