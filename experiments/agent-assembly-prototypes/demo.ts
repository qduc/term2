import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { blueprint, createHost, ready, type Backend } from './assemblies.js';
import type { Blueprint, Report, RunContext, Trace } from './contracts.js';
import { FileStorage } from './pieces.js';
import { runAgent } from './loop.js';

type Scenario = 'approved' | 'denied' | 'cancelled' | 'order' | 'missing' | 'dependency-order' | 'isolation' | 'custom';
const scenarios: Scenario[] = ['approved', 'denied', 'cancelled', 'order', 'missing', 'dependency-order', 'isolation'];
const args = process.argv.slice(2);
const option = (name: string) => {
  const position = args.indexOf(name);
  return position < 0 ? undefined : args[position + 1];
};
const backendOption = option('--backend') ?? 'all';
if (!['all', 'awilix', 'fastify'].includes(backendOption)) throw new Error('Unknown backend');
const backends: Backend[] = backendOption === 'all' ? ['awilix', 'fastify'] : [backendOption as Backend];
const scenarioOption = option('--scenario');
if (scenarioOption && ![...scenarios, 'custom'].includes(scenarioOption as Scenario))
  throw new Error('Unknown scenario');
const selected = scenarioOption ? [scenarioOption as Scenario] : scenarios;
const output = option('--out') ? resolve(option('--out')!) : await mkdtemp(join(tmpdir(), 'term2-assemblies-'));
await mkdir(output, { recursive: true });
const terminal = args.includes('--interactive') ? createInterface({ input: stdin, output: stdout }) : undefined;

function configuration(scenario: Scenario): Blueprint[] {
  switch (scenario) {
    case 'approved':
      return [blueprint('main', ['memory', 'redact', 'rewrite', 'approval', 'cache'])];
    case 'denied':
    case 'cancelled':
      return [blueprint('main', ['rewrite', 'approval'])];
    case 'order':
      return [blueprint('main', ['rewrite', 'approval', 'cache'], ['cache', 'rewrite', 'approval'])];
    case 'missing': {
      const broken = blueprint('main', ['memory']);
      broken.bindings = {};
      return [broken];
    }
    case 'dependency-order':
      return [blueprint('main', ['redact', 'memory'])];
    case 'isolation':
      return [blueprint('main', ['memory', 'redact']), blueprint('peer', ['memory']), blueprint('explorer', [])];
    default:
      throw new Error('Custom configuration is loaded separately');
  }
}

/** Run the same observable workflow through each independently composed host. */
async function demonstrate(backend: Backend, scenario: Scenario) {
  const traces: Trace[] = [];
  const emit = (type: string, detail?: unknown) => traces.push({ type, detail });
  const directory = join(output, backend, scenario);
  const disk = new FileStorage(join(directory, 'disk'));
  const alternate = new FileStorage(join(directory, 'alternate'));
  const host = createHost(backend, { disk, alternate });
  const controller = new AbortController();
  const run: RunContext = {
    signal: controller.signal,
    emit,
    async ask(question) {
      emit('interaction.start', question);
      try {
        if (scenario === 'cancelled') {
          controller.abort(new Error('Cancelled during approval'));
          controller.signal.throwIfAborted();
        }
        const answer = terminal
          ? (await terminal.question(`${question} [y/N] `)).toLowerCase() === 'y'
          : scenario !== 'denied';
        emit('interaction.answer', answer);
        return answer;
      } finally {
        emit('interaction.end', controller.signal.aborted ? 'cancelled' : 'answered');
      }
    },
  };
  const reports: Report[] = [];
  let startupError: string | undefined;
  let assemblyFacts: unknown;

  try {
    const configurations: Blueprint[] =
      scenario === 'custom'
        ? JSON.parse(await readFile(resolve(option('--config') ?? 'assemblies.json'), 'utf8'))
        : configuration(scenario);
    const assemblies = [];
    for (const config of configurations) assemblies.push(await host.create(config));
    await ready(host);
    emit('session.start', backend);

    for (const assembly of assemblies) {
      reports.push(await runAgent(assembly.agent, 'remember secret=token', run));
    }
    if (scenario === 'approved') {
      // A second run demonstrates reading memory saved by the first run.
      reports.push(await runAgent(assemblies[0].agent, 'remember next', run));
    }
    assemblyFacts = {
      agents: await Promise.all(
        assemblies.map(async (assembly) => ({
          name: assembly.agent.name,
          memory: Boolean(assembly.memory),
          saved: assembly.storage ? await assembly.storage.get(assembly.agent.name) : undefined,
        })),
      ),
      sameStorage: assemblies.length > 1 ? assemblies[0].storage === assemblies[1].storage : undefined,
      separateMemory: assemblies.length > 1 ? assemblies[0].memory !== assemblies[1].memory : undefined,
    };
    emit('session.end');
  } catch (error) {
    startupError = String(error);
    emit('assembly.error', startupError);
  } finally {
    await host.close();
    emit('host.closed');
  }

  const result = { backend, scenario, reports, assemblyFacts, startupError, traces };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  const status = startupError
    ? `STARTUP REJECTED: ${startupError}`
    : reports.map((report) => `${report.status}: ${report.answer ?? ''}`).join(' | ');
  console.log(`${backend.padEnd(8)} ${scenario.padEnd(17)} ${status}`);
  if (args.includes('--trace')) {
    for (const event of traces)
      console.log(`  ${event.type}${event.detail === undefined ? '' : ` ${JSON.stringify(event.detail)}`}`);
  }
  return result;
}

try {
  const results = [];
  for (const backend of backends) {
    for (const scenario of selected) results.push(await demonstrate(backend, scenario));
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`Artifacts: ${output}`);
} finally {
  terminal?.close();
}
