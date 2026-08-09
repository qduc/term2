import { z } from 'zod';

const idSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const referenceListSchema = z.array(idSchema).default([]);

const namedNodeSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1),
});

const recommendationSchema = z.enum([
  'keep',
  'rewrite_candidate',
  'consolidation_candidate',
  'retier_candidate',
  'deletion_candidate',
  'architecture_signal',
  'needs_review',
]);

const decisionSchema = z
  .object({
    id: idSchema,
    testId: idSchema,
    // `primary` is the decision of record. `second_opinion` carries an independent
    // reviewer's judgment without overwriting it, which is what the calibration wave
    // and mandatory deletion review produce.
    role: z.enum(['primary', 'second_opinion']),
    reviewer: idSchema,
    sourceArtifact: z.string().trim().min(1).optional(),
    recommendation: recommendationSchema,
    confidence: z.enum(['low', 'medium', 'high']),
    reason: z.string().trim().min(1),
    evidence: z.array(z.string().trim().min(1)).min(1),
    replacementTestIds: referenceListSchema,
    status: z.enum(['proposed', 'reviewed', 'approved', 'rejected']),
  })
  .superRefine((decision, context) => {
    if (decision.recommendation === 'deletion_candidate' && decision.replacementTestIds.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['replacementTestIds'],
        message: `decision ${decision.id} proposes deletion without naming retained coverage`,
      });
    }
  });

const auditGraphSchema = z.object({
  schemaVersion: z.literal(2),
  domains: z.array(namedNodeSchema),
  suites: z.array(namedNodeSchema),
  seams: z.array(namedNodeSchema),
  risks: z.array(
    namedNodeSchema.extend({
      severity: z.enum(['low', 'medium', 'high', 'critical']),
    }),
  ),
  fixtures: z.array(namedNodeSchema),
  contracts: z.array(
    z.object({
      id: idSchema,
      statement: z.string().trim().min(1),
      seamIds: referenceListSchema,
      riskIds: referenceListSchema,
    }),
  ),
  tests: z.array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('file'),
        id: idSchema,
        file: z.string().trim().min(1),
        domainId: idSchema,
        suiteId: idSchema,
        contractIds: z.array(idSchema).min(1),
        fixtureIds: referenceListSchema,
      }),
      z.object({
        kind: z.literal('case'),
        id: idSchema,
        file: z.string().trim().min(1),
        title: z.string().trim().min(1),
        domainId: idSchema,
        suiteId: idSchema,
        contractIds: z.array(idSchema).min(1),
        fixtureIds: referenceListSchema,
      }),
    ]),
  ),
  decisions: z.array(decisionSchema),
});

export type AuditGraph = z.infer<typeof auditGraphSchema>;
export type AuditRecommendation = z.infer<typeof recommendationSchema>;
export type AuditTest = AuditGraph['tests'][number];
export type AuditDecision = AuditGraph['decisions'][number];

function idsOf(nodes: Array<{ id: string }>): Set<string> {
  return new Set(nodes.map(({ id }) => id));
}

function assertUniqueIds(kind: string, nodes: Array<{ id: string }>): void {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) throw new Error(`duplicate ${kind} id ${node.id}`);
    seen.add(node.id);
  }
}

function assertReference(owner: string, relation: string, id: string, targets: Set<string>): void {
  if (!targets.has(id)) throw new Error(`${owner} references missing ${relation} ${id}`);
}

/**
 * A test id must be namespaced by its domain. Explorer artifacts are produced
 * independently and merged later, so unqualified ids would collide across waves.
 */
function assertDomainNamespace(test: AuditTest): void {
  if (!test.id.startsWith(`${test.domainId}-`)) {
    throw new Error(`test ${test.id} must be namespaced by its domain ${test.domainId}`);
  }
}

/**
 * A file is recorded at one granularity. Mixing a file record with case records for
 * the same path double-counts its evidence and makes deletion arithmetic wrong.
 */
function assertConsistentGranularity(tests: AuditTest[]): void {
  const kindsByFile = new Map<string, Set<AuditTest['kind']>>();
  for (const test of tests) {
    const kinds = kindsByFile.get(test.file) ?? new Set<AuditTest['kind']>();
    if (test.kind === 'file' && kinds.has('file')) {
      throw new Error(`duplicate file record for ${test.file}`);
    }
    kinds.add(test.kind);
    kindsByFile.set(test.file, kinds);
  }
  for (const [file, kinds] of kindsByFile) {
    if (kinds.size > 1) throw new Error(`file ${file} mixes file and case records`);
  }
}

function isPendingDeletion(decision: AuditDecision | undefined): boolean {
  // A rejected deletion proposal keeps its test, so it still counts as evidence.
  return decision?.recommendation === 'deletion_candidate' && decision.status !== 'rejected';
}

export function primaryDecisionOf(graph: AuditGraph, testId: string): AuditDecision | undefined {
  return graph.decisions.find((decision) => decision.testId === testId && decision.role === 'primary');
}

function validateGraph(graph: AuditGraph): void {
  assertUniqueIds('domain', graph.domains);
  assertUniqueIds('suite', graph.suites);
  assertUniqueIds('seam', graph.seams);
  assertUniqueIds('risk', graph.risks);
  assertUniqueIds('fixture', graph.fixtures);
  assertUniqueIds('contract', graph.contracts);
  assertUniqueIds('test', graph.tests);
  assertUniqueIds('decision', graph.decisions);

  const domainIds = idsOf(graph.domains);
  const suiteIds = idsOf(graph.suites);
  const seamIds = idsOf(graph.seams);
  const riskIds = idsOf(graph.risks);
  const fixtureIds = idsOf(graph.fixtures);
  const contractIds = idsOf(graph.contracts);
  const testIds = idsOf(graph.tests);

  for (const contract of graph.contracts) {
    for (const seamId of contract.seamIds) {
      assertReference(`contract ${contract.id}`, 'seam', seamId, seamIds);
    }
    for (const riskId of contract.riskIds) {
      assertReference(`contract ${contract.id}`, 'risk', riskId, riskIds);
    }
  }

  for (const test of graph.tests) {
    assertReference(`test ${test.id}`, 'domain', test.domainId, domainIds);
    assertReference(`test ${test.id}`, 'suite', test.suiteId, suiteIds);
    assertDomainNamespace(test);
    for (const contractId of test.contractIds) {
      assertReference(`test ${test.id}`, 'contract', contractId, contractIds);
    }
    for (const fixtureId of test.fixtureIds) {
      assertReference(`test ${test.id}`, 'fixture', fixtureId, fixtureIds);
    }
  }
  assertConsistentGranularity(graph.tests);

  const primaryByTest = new Map<string, AuditDecision>();
  const reviewersByTest = new Map<string, Set<string>>();
  for (const decision of graph.decisions) {
    assertReference(`decision ${decision.id}`, 'test', decision.testId, testIds);

    if (decision.role === 'primary') {
      if (primaryByTest.has(decision.testId)) {
        throw new Error(`duplicate primary decision for test ${decision.testId}`);
      }
      primaryByTest.set(decision.testId, decision);
    }

    // Independent review is only independent if a different reviewer performed it.
    const reviewers = reviewersByTest.get(decision.testId) ?? new Set<string>();
    if (reviewers.has(decision.reviewer)) {
      throw new Error(`reviewer ${decision.reviewer} recorded more than one decision for test ${decision.testId}`);
    }
    reviewers.add(decision.reviewer);
    reviewersByTest.set(decision.testId, reviewers);

    for (const replacementId of decision.replacementTestIds) {
      assertReference(`decision ${decision.id}`, 'replacement test', replacementId, testIds);
      if (replacementId === decision.testId) {
        throw new Error(`decision ${decision.id} cannot replace a test with itself`);
      }
    }
  }

  const retainedTests = graph.tests.filter((test) => !isPendingDeletion(primaryByTest.get(test.id)));
  for (const decision of graph.decisions) {
    // Only the decision of record removes a test; a second opinion is not yet acted on.
    if (decision.role !== 'primary' || !isPendingDeletion(decision)) continue;
    const test = graph.tests.find(({ id }) => id === decision.testId)!;
    for (const contractId of test.contractIds) {
      if (!retainedTests.some((candidate) => candidate.contractIds.includes(contractId))) {
        throw new Error(`deletion candidate ${test.id} would orphan contract ${contractId}`);
      }
    }
  }
}

export function parseAuditGraph(input: unknown): AuditGraph {
  const graph = auditGraphSchema.parse(input);
  validateGraph(graph);
  return graph;
}

/**
 * Combine independently produced explorer artifacts. Shared vocabulary nodes may
 * repeat across artifacts, but only when they agree; a conflicting definition is a
 * reconciliation task for the coordinator, not something to silently pick a winner for.
 */
export function mergeAuditGraphs(graphs: AuditGraph[]): AuditGraph {
  if (graphs.length === 0) throw new Error('merge requires at least one graph');

  const merged: AuditGraph = {
    schemaVersion: 2,
    domains: [],
    suites: [],
    seams: [],
    risks: [],
    fixtures: [],
    contracts: [],
    tests: [],
    decisions: [],
  };

  const vocabularyKeys = ['domains', 'suites', 'seams', 'risks', 'fixtures', 'contracts'] as const;
  for (const key of vocabularyKeys) {
    const byId = new Map<string, unknown>();
    for (const graph of graphs) {
      for (const node of graph[key]) {
        const existing = byId.get(node.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(node)) {
          throw new Error(`conflicting ${key} definition for ${node.id}`);
        }
        byId.set(node.id, node);
      }
    }
    // The union is rebuilt from validated inputs, so the element type is unchanged.
    (merged[key] as unknown[]) = [...byId.values()];
  }

  for (const graph of graphs) {
    merged.tests.push(...graph.tests);
    merged.decisions.push(...graph.decisions);
  }

  return parseAuditGraph(merged);
}

export interface TestQuery {
  domainId?: string;
  suiteId?: string;
  recommendation?: AuditRecommendation;
  undecidedOnly?: boolean;
}

export interface TestQueryResult {
  test: AuditTest;
  primary?: AuditDecision;
  decisions: AuditDecision[];
}

export function queryTests(graph: AuditGraph, query: TestQuery): TestQueryResult[] {
  return graph.tests
    .map((test) => {
      const decisions = graph.decisions.filter((decision) => decision.testId === test.id);
      return { test, primary: decisions.find(({ role }) => role === 'primary'), decisions };
    })
    .filter(({ test, primary }) => {
      if (query.domainId && test.domainId !== query.domainId) return false;
      if (query.suiteId && test.suiteId !== query.suiteId) return false;
      if (query.recommendation && primary?.recommendation !== query.recommendation) return false;
      if (query.undecidedOnly && primary) return false;
      return true;
    });
}

export function renderAuditReport(graph: AuditGraph): string {
  const recommendationCounts = new Map<AuditRecommendation, number>();
  let undecided = 0;
  let disputed = 0;

  for (const test of graph.tests) {
    const decisions = graph.decisions.filter((decision) => decision.testId === test.id);
    const primary = decisions.find(({ role }) => role === 'primary');
    if (!primary) {
      undecided += 1;
      continue;
    }
    recommendationCounts.set(primary.recommendation, (recommendationCounts.get(primary.recommendation) ?? 0) + 1);
    if (decisions.some((decision) => decision.recommendation !== primary.recommendation)) disputed += 1;
  }

  const lines = [
    '# Test suite audit report',
    '',
    `Tests: ${graph.tests.length}`,
    `Behavior contracts: ${graph.contracts.length}`,
    `Decisions: ${graph.decisions.length}`,
    `Undecided tests: ${undecided}`,
    `Tests where a second opinion disagrees: ${disputed}`,
    '',
    '## Recommendations',
    '',
  ];

  if (recommendationCounts.size === 0) {
    lines.push('No recommendations recorded.');
  } else {
    for (const [recommendation, count] of [...recommendationCounts].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lines.push(`- ${recommendation}: ${count}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
