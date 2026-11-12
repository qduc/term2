/* global process, console */
import fs from 'node:fs';

// This is descriptive aggregation, not a causal ablation or equivalence test.
const summaries = process.argv.slice(2).map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
if (summaries.length !== 2) throw new Error('Supply historical and current-main summary paths');
const cohorts = summaries.map((summary, index) => {
  if (summary.completedRuns !== 24 || !summary.allAccountingIdsMatch || !summary.allArtifactsMatch)
    throw new Error('Incomplete or unreconciled cohort');
  const arms = ['t2', 'pi'].map((arm) => {
    const selected = summary.groups.filter((g) => g.arm === arm);
    return {
      arm,
      passes: selected.reduce((n, g) => n + g.qualityPasses, 0),
      runs: selected.reduce((n, g) => n + g.runs, 0),
      usd: selected.reduce((n, g) => n + g.usd, 0),
    };
  });
  const [t2, pi] = arms;
  return {
    cohort: index === 0 ? 'historical' : 'current-main',
    sourceCommits: [...new Set(summary.runs.map((r) => r.manifest.sourceCommit))],
    arms,
    term2CostPremiumPercent: (t2.usd / pi.usd - 1) * 100,
    sampleGoalMet: t2.passes >= pi.passes && t2.usd <= pi.usd,
    groups: summary.groups,
  };
});
console.log(
  JSON.stringify(
    {
      cohorts,
      budget: summaries[1].budget,
      interpretation:
        'Frozen rubric outcomes and full captured usage including failed tasks. Published-rate costs are not invoices; setup exposure remains separately reserved. Cohort differences do not isolate source changes.',
    },
    null,
    2,
  ),
);
