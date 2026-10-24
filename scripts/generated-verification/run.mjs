import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import fc from 'fast-check';
import { historyProperties } from './history.mjs';
import { queueProperties } from './queue.mjs';

// No provider, credential, model, or network dependency: only production APIs
// and fast-check. JSON on stdout is the durable replay/evaluation artifact.
try {
  const { values } = parseArgs({
    options: {
      target: { type: 'string', default: 'all' },
      property: { type: 'string' },
      seed: { type: 'string' },
      path: { type: 'string' },
      runs: { type: 'string', default: '1000' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'pnpm verify:generated [--target all|history|queue] [--property NAME] [--runs N] [--seed INT] [--path SHRINK_PATH] [--output FILE]',
    );
  } else {
    const runs = Number(values.runs);
    const seed = values.seed === undefined ? undefined : Number(values.seed);
    if (
      !Number.isSafeInteger(runs) ||
      runs < 1 ||
      (seed !== undefined && (!Number.isInteger(seed) || seed < -2147483648 || seed > 2147483647))
    )
      throw new Error('runs must be a positive safe integer; seed must be int32');
    if (!['all', 'history', 'queue'].includes(values.target)) throw new Error('unknown target');
    let properties =
      values.target === 'history'
        ? historyProperties
        : values.target === 'queue'
        ? queueProperties
        : [...historyProperties, ...queueProperties];
    if (values.property) properties = properties.filter((p) => p.name === values.property);
    if (!properties.length) throw new Error('unknown property for target');
    if (values.path !== undefined && (properties.length !== 1 || seed === undefined))
      throw new Error('replay path requires --property and --seed');
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    const revision = git('rev-parse', 'HEAD');
    const dirty = git('status', '--porcelain').length > 0;
    const started = performance.now();
    const results = [];
    for (const { name, property } of properties) {
      const start = performance.now();
      const result = await fc.check(property, {
        numRuns: runs,
        ...(seed === undefined ? {} : { seed }),
        ...(values.path === undefined ? {} : { path: values.path }),
      });
      results.push({
        property: name,
        failed: result.failed,
        seed: result.seed,
        path: result.counterexamplePath,
        cases: result.numRuns,
        skips: result.numSkips,
        shrinks: result.numShrinks,
        runtimeMs: performance.now() - start,
        counterexample: result.counterexample,
        error: result.errorInstance ? String(result.errorInstance.stack ?? result.errorInstance) : null,
        replay: result.failed
          ? `pnpm verify:generated --property ${name} --seed ${result.seed} --path '${result.counterexamplePath}' --runs ${runs}`
          : null,
      });
    }
    const report = {
      schemaVersion: 1,
      revision,
      dirty,
      node: process.version,
      requestedRunsPerProperty: runs,
      maxSequenceLength: 30,
      runtimeMs: performance.now() - started,
      results,
    };
    const json = JSON.stringify(report, null, 2) + '\n';
    if (values.output) writeFileSync(values.output, json, { flag: 'wx' });
    process.stdout.write(json);
    if (results.some((r) => r.failed)) process.exitCode = 1;
  }
} catch (error) {
  console.error(String(error.stack ?? error));
  process.exitCode = 2;
}
