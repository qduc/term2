#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { parseAuditGraph, queryTests, renderAuditReport, type AuditRecommendation, type TestQuery } from './graph.js';

const usage = `Usage: pnpm test-audit <command> [options]

Commands:
  validate                         Validate the graph and all typed references
  list [filters]                   List tests and their recommendations
  show <test-id>                   Show one test and its connected nodes
  report                           Render the current audit summary as Markdown

Options:
  --graph <path>                   Graph file (default: docs/test-audit/graph.yaml)
  --domain <id>                    Filter list by domain
  --suite <id>                     Filter list by suite
  --recommendation <value>         Filter list by recommendation
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

async function loadGraph(path: string) {
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
    };
    if (args.length > 0) throw new Error(`unexpected arguments: ${args.join(' ')}`);
    for (const { test, decision } of queryTests(graph, query)) {
      console.log(`${test.id}\t${test.file}\t${decision?.recommendation ?? 'unreviewed'}`);
    }
    return;
  }

  if (command === 'show') {
    const testId = args.shift();
    if (!testId || args.length > 0) throw new Error('show requires exactly one test id');
    const result = queryTests(graph, {}).find(({ test }) => test.id === testId);
    if (!result) throw new Error(`unknown test ${testId}`);
    const contracts = graph.contracts.filter(({ id }) => result.test.contractIds.includes(id));
    console.log(JSON.stringify({ ...result, contracts }, null, 2));
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
