import meow from 'meow';
import { loadDataset, filterDataset, Case } from './dataset.js';
import { createMockSettingsService } from '../../services/settings-service.mock.js';
import { LoggingService } from '../../services/logging-service.js';
import { OpenAIAgentClient } from '../../lib/openai-agent-client.js';
import { evaluateShellAutoApprovalAdvisories } from '../../services/shell-auto-approval-evaluator.js';
import { ResponseCache } from './cache.js';
import { computeMetrics } from './metrics.js';
import { generateReport } from './report.js';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const cli = meow(
  `
	Usage
	  $ node dist/scripts/eval-auto-approval/runner.js [options]

	Options
	  --model         Model to evaluate (e.g. gpt-4o)
	  --provider      Provider to use (openai, openrouter, etc.)
	  --dataset       Path to dataset JSON (default: eval/auto-approval/dataset.json)
	  --filter-cat    Filter by category
	  --filter-sev    Filter by severity
	  --concurrency   Max concurrent requests (default: 5)
	  --repeat        Number of times to repeat each case (default: 1)
	  --output        Path to output results JSON (default: eval/auto-approval/results-<timestamp>.json)
	  --dry-run       Print plan without executing
	  --yes           Skip confirmation prompt
	  --no-cache      Disable response caching
	  --clear-cache   Clear the response cache before running

	Examples
	  $ node dist/scripts/eval-auto-approval/runner.js --model gpt-4o --concurrency 10
`,
  {
    importMeta: import.meta,
    flags: {
      model: { type: 'string' },
      provider: { type: 'string', default: 'openai' },
      dataset: { type: 'string', default: 'eval/auto-approval/dataset.json' },
      filterCat: { type: 'string' },
      filterSev: { type: 'string' },
      concurrency: { type: 'number', default: 5 },
      repeat: { type: 'number', default: 1 },
      output: { type: 'string' },
      dryRun: { type: 'boolean' },
      yes: { type: 'boolean' },
      cache: { type: 'boolean', default: true },
      clearCache: { type: 'boolean' },
    },
  },
);

async function run() {
  const flags = cli.flags;

  if (flags.clearCache) {
    const cache = new ResponseCache('eval/auto-approval/.cache');
    cache.clear();
    console.log('Cache cleared.');
    if (flags.dryRun) return;
  }

  if (!process.env['RUN_LIVE_EVAL'] && !flags.dryRun) {
    console.error('Error: RUN_LIVE_EVAL=1 environment variable must be set to run live evaluations.');
    process.exit(1);
  }

  const datasetPath = flags.dataset;
  const cases = loadDataset(datasetPath);
  const filteredCases = filterDataset(cases, {
    category: flags.filterCat,
    severity: flags.filterSev,
  });

  if (filteredCases.length === 0) {
    console.log('No cases matched the filters.');
    return;
  }

  const totalRuns = filteredCases.length * flags.repeat;
  const model = flags.model || 'gpt-4o';

  console.log('--- Eval Plan ---');
  console.log(`Model:       ${model}`);
  console.log(`Provider:    ${flags.provider}`);
  console.log(`Dataset:     ${datasetPath}`);
  console.log(`Total Cases: ${filteredCases.length}`);
  console.log(`Repeats:     ${flags.repeat}`);
  console.log(`Total Runs:  ${totalRuns}`);
  console.log(`Concurrency: ${flags.concurrency}`);
  console.log(`Cache:       ${flags.cache ? 'Enabled' : 'Disabled'}`);
  console.log('-----------------');

  const estTokensPerRun = 1000;
  const estCostPer1K = 0.01; // Conservative average for gpt-4o
  const estTotalCost = (totalRuns * estTokensPerRun * estCostPer1K) / 1000;

  console.log(`Estimated cost: ~$${estTotalCost.toFixed(2)} (very rough estimate)`);

  if (flags.dryRun) {
    console.log('Dry run complete.');
    return;
  }

  if (!flags.yes) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise((resolve) => rl.question('Continue? (y/N): ', resolve));
    rl.close();

    if (String(answer).toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseOutputPath = flags.output || join('eval/auto-approval', `results-${timestamp}.json`);
  const reportPath = baseOutputPath.replace('.json', '.md');

  console.log(`Saving results to: ${baseOutputPath}`);

  const logger = new LoggingService({ disableLogging: true });
  const settingsService = createMockSettingsService({
    'agent.autoApproveModel': model,
    'agent.autoApproveProvider': flags.provider,
    'shell.autoApproveMode': 'auto',
  });

  const agentClient = new OpenAIAgentClient({
    model,
    deps: {
      logger,
      settings: settingsService,
    },
  });

  const cache = new ResponseCache('eval/auto-approval/.cache');
  const results: any[] = [];
  const queue = [...filteredCases.flatMap((c) => Array.from({ length: flags.repeat }, () => c))];
  const active: Promise<void>[] = [];

  let completed = 0;
  let cacheHits = 0;

  async function runCase(c: Case) {
    const cacheKey = {
      model,
      provider: flags.provider,
      command: c.command,
      history: c.history,
    };

    let cachedAdvisory = flags.cache ? cache.get(cacheKey) : null;
    let result: any;
    let error: string | undefined;
    let latencyMs = 0;

    if (cachedAdvisory) {
      cacheHits++;
      result = cachedAdvisory;
    } else {
      const start = performance.now();
      try {
        const advisories = await evaluateShellAutoApprovalAdvisories({
          commands: [{ id: c.id, command: c.command }],
          history: c.history as any,
          settingsService,
          agentClient,
          logger,
        });

        const advisory = advisories.get(c.id);
        if (advisory) {
          result = {
            predicted: advisory.approved ? 'approve' : 'reject',
            reasoning: advisory.reasoning,
            source: advisory.source,
          };
          if (flags.cache && advisory.source === 'llm') {
            cache.set(cacheKey, result);
          }
        } else {
          error = 'No advisory returned for command ID';
        }
      } catch (e: any) {
        error = e.message;
      }
      latencyMs = performance.now() - start;
    }

    const record = {
      caseId: c.id,
      command: c.command,
      expected: c.expected,
      predicted: result?.predicted,
      reasoning: result?.reasoning,
      source: result?.source,
      latencyMs,
      error,
      timestamp: new Date().toISOString(),
      model,
      provider: flags.provider,
      category: c.category,
      severity: c.severity,
      cached: !!cachedAdvisory,
    };

    appendFileSync(baseOutputPath + '.l', JSON.stringify(record) + '\n');
    results.push(record);
    completed++;
    const statusIcon = record.predicted === record.expected ? '✅' : '❌';
    const cacheIcon = record.cached ? ' 🧊' : '';
    console.log(`[${completed}/${totalRuns}] Case ${c.id}: ${statusIcon}${cacheIcon} (${Math.round(latencyMs)}ms)`);
  }

  while (queue.length > 0 || active.length > 0) {
    while (active.length < flags.concurrency && queue.length > 0) {
      const c = queue.shift()!;
      const p = runCase(c).then(() => {
        active.splice(active.indexOf(p), 1);
      });
      active.push(p);
    }
    if (active.length > 0) {
      await Promise.race(active);
    }
  }

  writeFileSync(baseOutputPath, JSON.stringify(results, null, 2));

  const metrics = computeMetrics(results);
  const report = generateReport(results, metrics);
  writeFileSync(reportPath, report);

  console.log(`\nDone! Results saved to ${baseOutputPath}`);
  console.log(`Report saved to ${reportPath}`);
  console.log(`Cache hits: ${cacheHits}/${totalRuns}`);
  console.log(`Accuracy: ${(metrics.accuracy * 100).toFixed(1)}%`);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
