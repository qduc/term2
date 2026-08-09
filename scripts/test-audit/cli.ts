#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  mergeAuditGraphs,
  parseAuditGraph,
  queryTests,
  renderAuditReport,
  type AuditGraph,
  type AuditRecommendation,
  type TestQuery,
} from './graph.js';

const usage = `Usage: pnpm test-audit <command> [options]

Commands:
  validate                         Validate the graph and all typed references
  list [filters]                   List tests and their recommendations
  show <test-id>                   Show one test, its contracts, and every decision
  report                           Render the current audit summary as Markdown
  merge <path...> [--out <path>]   Merge explorer artifacts into one validated graph

Options:
  --graph <path>                   Graph file (default: docs/test-audit/graph.yaml)
  --domain <id>                    Filter list by domain
  --suite <id>                     Filter list by suite
  --recommendation <value>         Filter list by recommendation
  --undecided                      List only tests with no decision of record
`;

const recommendationValues = new Set<AuditRecommendation>([
  'keep',
  'rewrite_candidate',
  'consolidation_candidate',
  'retier_candidate',
  'deletion_candidate',
  'architecture_signal',
  'needs_review',
]);

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

async function loadGraph(path: string): Promise<AuditGraph> {
  const source = await readFile(path, 'utf8');
  return parseAuditGraph(parse(source));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const graphPath = resolve(takeOption(args, '--graph') ?? 'docs/test-audit/graph.yaml');
  const command = args.shift();
  if (!command || command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }

  // merge reads its own inputs and must not require the default graph to exist.
  if (command === 'merge') {
    const outPath = takeOption(args, '--out');
    if (args.length === 0) throw new Error('merge requires at least one artifact path');
    const graphs = await Promise.all(args.map((path) => loadGraph(resolve(path))));
    const merged = mergeAuditGraphs(graphs);
    const rendered = stringify(merged);
    if (outPath) {
      await writeFile(resolve(outPath), rendered, 'utf8');
      console.log(
        `Merged ${graphs.length} artifacts into ${outPath}: ${merged.tests.length} tests, ${merged.decisions.length} decisions`,
      );
    } else {
      process.stdout.write(rendered);
    }
    return;
  }

  const graph = await loadGraph(graphPath);

  if (command === 'validate') {
    if (args.length > 0) throw new Error(`unexpected arguments: ${args.join(' ')}`);
    console.log(
      `Valid audit graph: ${graph.tests.length} tests, ${graph.contracts.length} contracts, ${graph.decisions.length} decisions`,
    );
    return;
  }

  if (command === 'list') {
    const recommendation = takeOption(args, '--recommendation');
    if (recommendation && !recommendationValues.has(recommendation as AuditRecommendation)) {
      throw new Error(`unknown recommendation ${recommendation}`);
    }
    const query: TestQuery = {
      domainId: takeOption(args, '--domain'),
      suiteId: takeOption(args, '--suite'),
      recommendation: recommendation as AuditRecommendation | undefined,
      undecidedOnly: takeFlag(args, '--undecided'),
    };
    if (args.length > 0) throw new Error(`unexpected arguments: ${args.join(' ')}`);
    for (const { test, primary, decisions } of queryTests(graph, query)) {
      const dispute = decisions.some((decision) => decision.recommendation !== primary?.recommendation)
        ? '\tdisputed'
        : '';
      console.log(`${test.id}\t${test.file}\t${primary?.recommendation ?? 'unreviewed'}${dispute}`);
    }
    return;
  }

  if (command === 'show') {
    const testId = args.shift();
    if (!testId || args.length > 0) throw new Error('show requires exactly one test id');
    const result = queryTests(graph, {}).find(({ test }) => test.id === testId);
    if (!result) throw new Error(`unknown test ${testId}`);
    const contracts = graph.contracts.filter(({ id }) => result.test.contractIds.includes(id));
    const seamIds = new Set(contracts.flatMap(({ seamIds: ids }) => ids));
    const riskIds = new Set(contracts.flatMap(({ riskIds: ids }) => ids));
    console.log(
      JSON.stringify(
        {
          ...result,
          contracts,
          seams: graph.seams.filter(({ id }) => seamIds.has(id)),
          risks: graph.risks.filter(({ id }) => riskIds.has(id)),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === 'report') {
    if (args.length > 0) throw new Error(`unexpected arguments: ${args.join(' ')}`);
    process.stdout.write(renderAuditReport(graph));
    return;
  }

  throw new Error(`unknown command ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`test-audit: ${message}`);
  process.exitCode = 1;
});
