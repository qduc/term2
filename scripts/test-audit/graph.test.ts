import { describe, expect, it } from 'vitest';
import { mergeAuditGraphs, parseAuditGraph, queryTests, renderAuditReport } from './graph.js';

const validGraph = {
  schemaVersion: 2,
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
      id: 'approval-routing-batch-always-mode',
      kind: 'file',
      file: 'source/services/approval.test.ts',
      domainId: 'approval-routing',
      suiteId: 'unit',
      contractIds: ['always-mode-bypasses-evaluator'],
      fixtureIds: [],
    },
    {
      id: 'approval-routing-batch-always-mode-backup',
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
      id: 'decision-always-mode-primary',
      testId: 'approval-routing-batch-always-mode',
      role: 'primary',
      reviewer: 'explorer-one',
      recommendation: 'consolidation_candidate',
      confidence: 'medium',
      reason: 'A stronger boundary test may cover the same contract.',
      evidence: ['Both tests exercise the same observable rule.'],
      replacementTestIds: ['approval-routing-batch-always-mode-backup'],
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
      'test approval-routing-batch-always-mode references missing contract missing-contract',
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

  it('requires a test id namespaced by its domain so artifacts can merge', () => {
    const graph = structuredClone(validGraph);
    graph.tests[0].id = 'batch-always-mode';
    graph.decisions[0].testId = 'batch-always-mode';

    expect(() => parseAuditGraph(graph)).toThrow(
      'test batch-always-mode must be namespaced by its domain approval-routing',
    );
  });

  it('rejects two file records describing the same path', () => {
    const graph = structuredClone(validGraph);
    graph.tests[1].file = graph.tests[0].file;

    expect(() => parseAuditGraph(graph)).toThrow('duplicate file record for source/services/approval.test.ts');
  });

  it('rejects a file recorded at both file and case granularity', () => {
    const graph = structuredClone(validGraph);
    graph.tests[1] = {
      ...graph.tests[1],
      kind: 'case',
      title: 'bypasses the evaluator',
      file: graph.tests[0].file,
    } as (typeof graph.tests)[number];

    expect(() => parseAuditGraph(graph)).toThrow('file source/services/approval.test.ts mixes file and case records');
  });
});

describe('deletion safety', () => {
  it('rejects a deletion candidate that would orphan a contract', () => {
    const graph = structuredClone(validGraph);
    graph.tests.pop();
    graph.decisions[0] = {
      ...graph.decisions[0],
      recommendation: 'deletion_candidate',
      replacementTestIds: ['approval-routing-batch-always-mode-backup'],
    };

    // The named replacement no longer exists, so the reference check fires first.
    expect(() => parseAuditGraph(graph)).toThrow('references missing replacement test');
  });

  it('requires a deletion candidate to name its retained coverage', () => {
    const graph = structuredClone(validGraph);
    graph.decisions[0] = {
      ...graph.decisions[0],
      recommendation: 'deletion_candidate',
      replacementTestIds: [],
    };

    expect(() => parseAuditGraph(graph)).toThrow('without naming retained coverage');
  });

  it('keeps a rejected deletion proposal as evidence for its contract', () => {
    const graph = structuredClone(validGraph);
    graph.decisions[0] = {
      ...graph.decisions[0],
      recommendation: 'deletion_candidate',
      status: 'rejected',
    };

    expect(() => parseAuditGraph(graph)).not.toThrow();
  });

  it('evaluates deletion candidates as a set when protecting contracts', () => {
    const graph = structuredClone(validGraph);
    graph.decisions = graph.tests.map((test, index) => ({
      id: `decision-delete-${index}`,
      testId: test.id,
      role: 'primary' as const,
      reviewer: `explorer-${index}`,
      recommendation: 'deletion_candidate' as const,
      confidence: 'medium' as const,
      reason: 'Proposed together for consolidation.',
      evidence: ['Both currently appear redundant.'],
      // Each names the other, so neither looks unsafe in isolation.
      replacementTestIds: [graph.tests[index === 0 ? 1 : 0].id],
      status: 'proposed' as const,
    }));

    expect(() => parseAuditGraph(graph)).toThrow(
      'deletion candidate approval-routing-batch-always-mode would orphan contract always-mode-bypasses-evaluator',
    );
  });

  it('ignores a second opinion when deciding whether a test is removed', () => {
    const graph = structuredClone(validGraph);
    graph.tests.pop();
    graph.decisions[0] = { ...graph.decisions[0], recommendation: 'keep', replacementTestIds: [] };
    graph.decisions.push({
      id: 'decision-always-mode-second',
      testId: 'approval-routing-batch-always-mode',
      role: 'second_opinion',
      reviewer: 'explorer-two',
      recommendation: 'deletion_candidate',
      confidence: 'low',
      reason: 'Reads as redundant on a first pass.',
      evidence: ['No sibling coverage was located, so this is a weak claim.'],
      replacementTestIds: ['approval-routing-batch-always-mode'],
      status: 'proposed',
    } as (typeof graph.decisions)[number]);

    // A self-replacement is still nonsense even in a dissent.
    expect(() => parseAuditGraph(graph)).toThrow('cannot replace a test with itself');
  });
});

describe('independent review', () => {
  it('records a second opinion alongside the decision of record', () => {
    const graph = structuredClone(validGraph);
    graph.decisions.push({
      id: 'decision-always-mode-second',
      testId: 'approval-routing-batch-always-mode',
      role: 'second_opinion',
      reviewer: 'explorer-two',
      recommendation: 'keep',
      confidence: 'high',
      reason: 'The contract is the only evidence for an approval bypass.',
      evidence: ['No other test asserts the bypass at this seam.'],
      replacementTestIds: [],
      status: 'proposed',
    } as (typeof graph.decisions)[number]);

    const parsed = parseAuditGraph(graph);

    expect(parsed.decisions).toHaveLength(2);
  });

  it('rejects two decisions of record for one test', () => {
    const graph = structuredClone(validGraph);
    graph.decisions.push({
      ...graph.decisions[0],
      id: 'decision-always-mode-rival',
      reviewer: 'explorer-two',
    });

    expect(() => parseAuditGraph(graph)).toThrow(
      'duplicate primary decision for test approval-routing-batch-always-mode',
    );
  });

  it('refuses a second opinion from the reviewer who wrote the first', () => {
    const graph = structuredClone(validGraph);
    graph.decisions.push({
      ...graph.decisions[0],
      id: 'decision-always-mode-echo',
      role: 'second_opinion',
    });

    expect(() => parseAuditGraph(graph)).toThrow(
      'reviewer explorer-one recorded more than one decision for test approval-routing-batch-always-mode',
    );
  });
});

describe('mergeAuditGraphs', () => {
  it('unions shared vocabulary and concatenates independent records', () => {
    const first = structuredClone(validGraph);
    first.tests = [first.tests[0]];
    first.decisions = [];
    const second = structuredClone(validGraph);
    second.tests = [second.tests[1]];
    second.decisions = [];

    const merged = mergeAuditGraphs([parseAuditGraph(first), parseAuditGraph(second)]);

    expect(merged.domains).toHaveLength(1);
    expect(merged.tests.map(({ id }) => id)).toEqual([
      'approval-routing-batch-always-mode',
      'approval-routing-batch-always-mode-backup',
    ]);
  });

  it('refuses to silently pick a winner when artifacts disagree on a shared node', () => {
    const first = parseAuditGraph(structuredClone(validGraph));
    const conflicting = structuredClone(validGraph);
    conflicting.contracts[0].statement = 'Always mode skips the evaluator entirely.';

    expect(() => mergeAuditGraphs([first, parseAuditGraph(conflicting)])).toThrow(
      'conflicting contracts definition for always-mode-bypasses-evaluator',
    );
  });
});

describe('queryTests', () => {
  it('filters by the recommendation of record and returns every decision', () => {
    const graph = parseAuditGraph(validGraph);

    expect(queryTests(graph, { recommendation: 'consolidation_candidate' })).toEqual([
      {
        test: graph.tests[0],
        primary: graph.decisions[0],
        decisions: [graph.decisions[0]],
      },
    ]);
  });

  it('finds tests still awaiting a decision of record', () => {
    const graph = parseAuditGraph(validGraph);

    expect(queryTests(graph, { undecidedOnly: true }).map(({ test }) => test.id)).toEqual([
      'approval-routing-batch-always-mode-backup',
    ]);
  });
});

describe('renderAuditReport', () => {
  it('summarizes inventory, remaining work, and proposed recommendations', () => {
    const report = renderAuditReport(parseAuditGraph(validGraph));

    expect(report).toContain('Tests: 2');
    expect(report).toContain('Behavior contracts: 1');
    expect(report).toContain('Undecided tests: 1');
    expect(report).toContain('consolidation_candidate: 1');
  });

  it('surfaces tests where a second opinion disagrees', () => {
    const graph = structuredClone(validGraph);
    graph.decisions.push({
      id: 'decision-always-mode-second',
      testId: 'approval-routing-batch-always-mode',
      role: 'second_opinion',
      reviewer: 'explorer-two',
      recommendation: 'keep',
      confidence: 'high',
      reason: 'The contract is the only evidence for an approval bypass.',
      evidence: ['No other test asserts the bypass at this seam.'],
      replacementTestIds: [],
      status: 'proposed',
    } as (typeof graph.decisions)[number]);

    expect(renderAuditReport(parseAuditGraph(graph))).toContain('Tests where a second opinion disagrees: 1');
  });
});
