import { describe, expect, it } from 'vitest';
import { parseAuditGraph, queryTests, renderAuditReport } from './graph.js';

const validGraph = {
  schemaVersion: 1,
  domains: [{ id: 'approval-routing', label: 'Approval routing' }],
  suites: [{ id: 'unit', label: 'Unit' }],
  seams: [{ id: 'continuation-batch', label: 'Continuation batch' }],
  risks: [{ id: 'unintended-interruption', label: 'Unintended interruption', severity: 'high' }],
  fixtures: [],
  contracts: [
    {
      id: 'always-mode-bypasses-evaluator',
      statement: 'Always mode bypasses advisory evaluation.',
      seamIds: ['continuation-batch'],
      riskIds: ['unintended-interruption'],
    },
  ],
  tests: [
    {
      id: 'approval-batch-always-mode',
      kind: 'file',
      file: 'source/services/approval.test.ts',
      domainId: 'approval-routing',
      suiteId: 'unit',
      contractIds: ['always-mode-bypasses-evaluator'],
      fixtureIds: [],
    },
    {
      id: 'approval-batch-always-mode-backup',
      kind: 'file',
      file: 'source/services/approval-backup.test.ts',
      domainId: 'approval-routing',
      suiteId: 'unit',
      contractIds: ['always-mode-bypasses-evaluator'],
      fixtureIds: [],
    },
  ],
  decisions: [
    {
      testId: 'approval-batch-always-mode',
      recommendation: 'consolidation_candidate',
      confidence: 'medium',
      reason: 'A stronger boundary test may cover the same contract.',
      evidence: ['Both tests exercise the same observable rule.'],
      replacementTestIds: ['approval-batch-always-mode-backup'],
      status: 'proposed',
    },
  ],
};

describe('parseAuditGraph', () => {
  it('accepts a graph whose typed references resolve', () => {
    expect(parseAuditGraph(validGraph)).toEqual(validGraph);
  });

  it('reports dangling typed references', () => {
    const graph = structuredClone(validGraph);
    graph.tests[0].contractIds = ['missing-contract'];

    expect(() => parseAuditGraph(graph)).toThrow(
      'test approval-batch-always-mode references missing contract missing-contract',
    );
  });

  it('rejects duplicate identifiers within a node type', () => {
    const graph = structuredClone(validGraph);
    graph.risks.push({ ...graph.risks[0] });

    expect(() => parseAuditGraph(graph)).toThrow('duplicate risk id unintended-interruption');
  });

  it('requires a title when a record represents one test case', () => {
    const graph = structuredClone(validGraph);
    graph.tests[0] = { ...graph.tests[0], kind: 'case' } as (typeof graph.tests)[number];

    expect(() => parseAuditGraph(graph)).toThrow();
  });

  it('rejects a deletion candidate that would orphan a contract', () => {
    const graph = structuredClone(validGraph);
    graph.tests.pop();
    graph.decisions[0] = {
      ...graph.decisions[0],
      recommendation: 'deletion_candidate',
      replacementTestIds: [],
    };

    expect(() => parseAuditGraph(graph)).toThrow(
      'deletion candidate approval-batch-always-mode would orphan contract always-mode-bypasses-evaluator',
    );
  });

  it('keeps a rejected deletion proposal as evidence for its contract', () => {
    const graph = structuredClone(validGraph);
    graph.tests.pop();
    graph.decisions[0] = {
      ...graph.decisions[0],
      recommendation: 'deletion_candidate',
      replacementTestIds: [],
      status: 'rejected',
    };

    expect(() => parseAuditGraph(graph)).not.toThrow();
  });

  it('evaluates deletion candidates as a set when protecting contracts', () => {
    const graph = structuredClone(validGraph);
    graph.decisions = graph.tests.map((test) => ({
      testId: test.id,
      recommendation: 'deletion_candidate' as const,
      confidence: 'medium' as const,
      reason: 'Proposed together for consolidation.',
      evidence: ['Both currently appear redundant.'],
      replacementTestIds: [],
      status: 'proposed' as const,
    }));

    expect(() => parseAuditGraph(graph)).toThrow(
      'deletion candidate approval-batch-always-mode would orphan contract always-mode-bypasses-evaluator',
    );
  });
});

describe('queryTests', () => {
  it('filters by recommendation and returns the associated decision', () => {
    const graph = parseAuditGraph(validGraph);

    expect(queryTests(graph, { recommendation: 'consolidation_candidate' })).toEqual([
      {
        test: graph.tests[0],
        decision: graph.decisions[0],
      },
    ]);
  });
});

describe('renderAuditReport', () => {
  it('summarizes inventory and proposed recommendations', () => {
    const report = renderAuditReport(parseAuditGraph(validGraph));

    expect(report).toContain('Tests: 2');
    expect(report).toContain('Behavior contracts: 1');
    expect(report).toContain('consolidation_candidate: 1');
  });
});
