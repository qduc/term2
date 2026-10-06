import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appendEvent, readLedger } from './ledger.js';
import { contentDigest, digest, type Method, type RunRecord } from './experiment.js';

const baseline: Method = {
  name: 'markdown-toc',
  revision: 'fixture-v1',
  source: 'deterministic-main-adapter',
  body: 'Make a table of contents from h2 headings using lowercase slugs.',
};
const candidate: Method = {
  ...baseline,
  revision: 'fixture-v2',
  body: baseline.body + ' Suffix repeated slugs with -1, -2, etc.',
};
// Freeze independent expected artifacts before either version runs.
const benchmark = [
  { id: 'a', input: '# Guide\n## Setup\n## Setup\n', expected: '- [Setup](#setup)\n- [Setup](#setup-1)\n' },
  {
    id: 'b',
    input: '# Guide\n## Usage\n## Usage\n## Usage\n',
    expected: '- [Usage](#usage)\n- [Usage](#usage-1)\n- [Usage](#usage-2)\n',
  },
  {
    id: 'c',
    input: '# Guide\n## Build\n## Test\n## Build\n',
    expected: '- [Build](#build)\n- [Test](#test)\n- [Build](#build-1)\n',
  },
];

/** A real local artifact transformation with deterministic main/Reviewer substitutes. */
export async function runDemo(directory: string) {
  await mkdir(directory, { recursive: true });
  const ledger = join(directory, 'experiment.json');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const conditions = 'deterministic Markdown TOC adapter; same inputs, no models, no retries';
  const criteria = {
    tasks: benchmark.map((task) => ({ id: task.id, inputDigest: digest(task.input) })),
    checks: ['exact-toc-artifact', 'input-preserved'],
    conditions,
    minimumPairs: 3,
    minimumWins: 2,
  };
  const fixtureEvidence = join(directory, 'frozen-benchmark.json');
  // init rejects an existing experiment before any artifact is overwritten.
  let state = await appendEvent(ledger, { type: 'init', id: 'toc-experiment', incumbent: baseline, criteria });
  await writeFile(fixtureEvidence, JSON.stringify(benchmark, null, 2), { flag: 'wx' });

  async function produce(
    id: string,
    purpose: 'work' | 'benchmark',
    task: (typeof benchmark)[number],
    method: Method,
  ): Promise<RunRecord> {
    const inputPath = join(directory, `${id}.md`);
    const outputPath = join(directory, `${id}.toc.md`);
    await writeFile(inputPath, task.input, { flag: 'wx' });
    const seen = new Map<string, number>();
    const toc = task.input
      .split('\n')
      .filter((line) => line.startsWith('## '))
      .map((line) => {
        const title = line.slice(3);
        const slug = title.toLowerCase().replaceAll(' ', '-');
        const count = seen.get(slug) ?? 0;
        seen.set(slug, count + 1);
        const anchor = method.body === candidate.body && count > 0 ? `${slug}-${count}` : slug;
        return `- [${title}](#${anchor})\n`;
      })
      .join('');
    await writeFile(outputPath, toc, { flag: 'wx' });
    // Oracle reads persisted artifacts rather than accepting the producer's claim.
    const outcome = await inspect(id, task);
    const record: RunRecord = {
      type: 'run',
      id,
      purpose,
      taskId: task.id,
      inputDigest: digest(task.input),
      methodId: digest(method),
      loadedMethod: method,
      harnessRevision: revision,
      conditionsId: digest(conditions),
      actor: { role: 'main', sessionId: `main-${id}` },
      metrics: outcome,
      evidence: [
        { ref: outputPath, digest: contentDigest(toc) },
        { ref: inputPath, digest: contentDigest(task.input) },
      ],
    };
    state = await appendEvent(ledger, record);
    return record;
  }

  async function inspect(id: string, task: (typeof benchmark)[number]): Promise<RunRecord['metrics']> {
    const output = await readFile(join(directory, `${id}.toc.md`), 'utf8');
    const input = await readFile(join(directory, `${id}.md`), 'utf8');
    return {
      outcome: output === task.expected && input === task.input ? 'pass' : 'fail',
      interventions: 0,
      retries: 0,
    };
  }

  await produce('observed-a', 'work', benchmark[0], baseline);
  await produce('observed-b', 'work', benchmark[1], baseline);
  state = await appendEvent(ledger, {
    type: 'propose',
    id: 'toc-candidate',
    candidate,
    weakness: 'Duplicate headings produced duplicate anchors on two observed documents.',
    hypothesis: 'Counting repeated slugs produces the frozen expected anchors.',
    mutation: 'Suffix duplicate slugs.',
    evidenceRunIds: ['observed-a', 'observed-b'],
  });
  const pairs = [];
  for (const task of benchmark) {
    await produce(`${task.id}-base`, 'benchmark', task, baseline);
    await produce(`${task.id}-candidate`, 'benchmark', task, candidate);
    // Deterministic independent Reviewer adapter re-reads both artifacts.
    pairs.push({
      incumbentRunId: `${task.id}-base`,
      candidateRunId: `${task.id}-candidate`,
      incumbent: await inspect(`${task.id}-base`, task),
      candidate: await inspect(`${task.id}-candidate`, task),
      checks: [
        {
          id: 'exact-toc-artifact',
          incumbent: (await inspect(`${task.id}-base`, task)).outcome,
          candidate: (await inspect(`${task.id}-candidate`, task)).outcome,
        },
        { id: 'input-preserved', incumbent: 'pass' as const, candidate: 'pass' as const },
      ],
      evidence: [{ ref: fixtureEvidence, digest: contentDigest(await readFile(fixtureEvidence)) }],
    });
  }
  state = await appendEvent(ledger, {
    type: 'compare',
    id: 'toc-review',
    criteriaId: state.criteriaId,
    reviewer: { role: 'reviewer', sessionId: 'deterministic-independent-reviewer' },
    pairs,
  });
  state = await appendEvent(ledger, {
    type: 'promote',
    id: 'toc-promotion',
    approval: {
      ref: 'fixture-only-approval-for-local-demo',
      candidateId: digest(candidate),
      reviewId: 'toc-review',
    },
  });
  await produce(
    'subsequent-work',
    'work',
    {
      id: 'next',
      input: '# Next\n## Install\n## Install\n',
      expected: '- [Install](#install)\n- [Install](#install-1)\n',
    },
    candidate,
  );
  state = await readLedger(ledger);
  return {
    ledger,
    decision: state.decision,
    incumbentId: state.incumbentId,
    candidateId: state.candidateId,
    activeMethodId: state.activeMethodId,
    adoption: state.adoption,
    efficacy: 'Deterministic control-flow and fixture transformation evidence; no model-quality claim.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory || process.argv.length !== 3) {
    process.stderr.write('Usage: demo.ts <new-output-directory>\n');
    process.exitCode = 1;
  } else {
    runDemo(directory)
      .then((result) => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
      .catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
