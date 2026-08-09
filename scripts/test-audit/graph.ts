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

const auditGraphSchema = z.object({
  schemaVersion: z.literal(1),
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
  decisions: z.array(
    z.object({
      testId: idSchema,
      recommendation: recommendationSchema,
      confidence: z.enum(['low', 'medium', 'high']),
      reason: z.string().trim().min(1),
      evidence: z.array(z.string().trim().min(1)).min(1),
      replacementTestIds: referenceListSchema,
      status: z.enum(['proposed', 'reviewed', 'approved', 'rejected']),
    }),
  ),
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

function validateGraph(graph: AuditGraph): void {
  assertUniqueIds('domain', graph.domains);
  assertUniqueIds('suite', graph.suites);
  assertUniqueIds('seam', graph.seams);
  assertUniqueIds('risk', graph.risks);
  assertUniqueIds('fixture', graph.fixtures);
  assertUniqueIds('contract', graph.contracts);
  assertUniqueIds('test', graph.tests);

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
    for (const contractId of test.contractIds) {
      assertReference(`test ${test.id}`, 'contract', contractId, contractIds);
    }
    for (const fixtureId of test.fixtureIds) {
      assertReference(`test ${test.id}`, 'fixture', fixtureId, fixtureIds);
    }
  }

  const decisionsByTest = new Map<string, AuditDecision>();
  for (const decision of graph.decisions) {
    assertReference(`decision for ${decision.testId}`, 'test', decision.testId, testIds);
    if (decisionsByTest.has(decision.testId)) throw new Error(`duplicate decision for test ${decision.testId}`);
    decisionsByTest.set(decision.testId, decision);
    for (const replacementId of decision.replacementTestIds) {
      assertReference(`decision for ${decision.testId}`, 'replacement test', replacementId, testIds);
      if (replacementId === decision.testId) {
        throw new Error(`decision for ${decision.testId} cannot replace a test with itself`);
      }
    }
  }

  // A rejected deletion proposal keeps its test, so it must still count as evidence.
  const isPendingDeletion = (decision: AuditDecision | undefined): boolean =>
    decision?.recommendation === 'deletion_candidate' && decision.status !== 'rejected';

  const retainedTests = graph.tests.filter((test) => !isPendingDeletion(decisionsByTest.get(test.id)));
  for (const decision of graph.decisions) {
    if (!isPendingDeletion(decision)) continue;
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

export interface TestQuery {
  domainId?: string;
  suiteId?: string;
  recommendation?: AuditRecommendation;
}

export function queryTests(graph: AuditGraph, query: TestQuery): Array<{ test: AuditTest; decision?: AuditDecision }> {
  const decisionsByTest = new Map(graph.decisions.map((decision) => [decision.testId, decision]));
  return graph.tests
    .map((test) => ({ test, decision: decisionsByTest.get(test.id) }))
    .filter(({ test, decision }) => {
      if (query.domainId && test.domainId !== query.domainId) return false;
      if (query.suiteId && test.suiteId !== query.suiteId) return false;
      if (query.recommendation && decision?.recommendation !== query.recommendation) return false;
      return true;
    });
}

export function renderAuditReport(graph: AuditGraph): string {
  const recommendationCounts = new Map<AuditRecommendation, number>();
  for (const decision of graph.decisions) {
    recommendationCounts.set(decision.recommendation, (recommendationCounts.get(decision.recommendation) ?? 0) + 1);
  }

  const lines = [
    '# Test suite audit report',
    '',
    `Tests: ${graph.tests.length}`,
    `Behavior contracts: ${graph.contracts.length}`,
    `Decisions: ${graph.decisions.length}`,
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
