#!/usr/bin/env node
// Feature inventory for the port: what the current architecture offers, and how much of it is ported.
//
//   node rewrite/parity/inventory.mjs           check: fail on untracked or inconsistent features
//   node rewrite/parity/inventory.mjs --write   add newly found features to features.json as "todo"
//
// Features are extracted from source/ by category. features.json records each one's port status
// and the parity scenarios that prove it. Features no extractor can see (a UI mode, a guard
// behaviour) are added by hand with "manual": true.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const manifestPath = path.join(here, 'features.json');
const scenariosDir = path.join(here, 'scenarios');

const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8');
const sourceFiles = (dir) =>
  fs
    .readdirSync(path.join(repo, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name))
    .map((entry) => path.relative(repo, path.join(entry.parentPath, entry.name)));
const matches = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]);
const between = (text, start, end) => {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`inventory: marker not found: ${start}`);
  const to = text.indexOf(end, from + start.length);
  return text.slice(from, to < 0 ? undefined : to);
};

/** Each extractor returns [name, source file] pairs. A failing extractor is an error, never an empty category. */
const EXTRACTORS = {
  // The help text's Options section is the user-facing contract; the meow flags block is what parses.
  'cli-flag': () => {
    const cli = read('source/cli.tsx');
    const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const parsed = matches(between(cli, '    flags: {', '\n    },\n'), /^ {6}([a-zA-Z]+): /gm).map(kebab);
    const documented = matches(between(cli, '    Options\n', 'Show version'), /--([a-z][a-z-]*)/g);
    return [...parsed, ...documented].map((name) => [name, 'source/cli.tsx']);
  },
  'cli-subcommand': () =>
    matches(read('source/cli.tsx'), /cli\.input\[0\] === '([a-z-]+)'/g).map((name) => [name, 'source/cli.tsx']),
  slash: () =>
    sourceFiles('source/commands').flatMap((file) =>
      matches(read(file), /^\s+name: '([a-z][a-z-]*)',/gm).map((name) => [name, file]),
    ),
  tool: () =>
    sourceFiles('source').flatMap((file) => {
      const text = read(file);
      const constants = matches(text, /export const TOOL_NAME_[A-Z_]+ = '([a-z_]+)'/g);
      // Tool definitions sit at 2 to 6 spaces; deeper `name:` keys belong to nested runtime objects.
      const defined = file.startsWith('source/tools/') ? matches(text, /^ {2,6}name: '([a-z_]+)',$/gm) : [];
      return [...constants, ...defined].map((name) => [name, file]);
    }),
  setting: () => {
    const file = 'source/services/settings/settings-schema.ts';
    return matches(between(read(file), 'export const SETTING_KEYS = {', '} as const'), /: '([^']+)',/g).map((name) => [
      name,
      file,
    ]);
  },
  provider: () =>
    fs
      .readdirSync(path.join(repo, 'source/providers'))
      .filter((name) => name.endsWith('.provider.ts'))
      .map((name) => [name.replace('.provider.ts', ''), `source/providers/${name}`]),
  'hook-event': () => {
    const file = 'source/services/hooks/hook-contracts.ts';
    return matches(between(read(file), 'TERM2_HOOK_EVENT_NAMES = [', '] as const'), /'([a-z.]+)'/g).map((name) => [
      name,
      file,
    ]);
  },
  'gateway-route': () => {
    const file = 'source/gateway/gateway.ts';
    const table = between(read(file), 'function matchPrivateRoute(', '\n}\n');
    // `purpose: 'x'`, and the one ternary `purpose: … ? 'x' : 'y'`.
    const plain = matches(table, /purpose: '([a-z_]+)'/g);
    const ternary = [...table.matchAll(/\? '([a-z_]+)' : '([a-z_]+)'/g)].flatMap((match) => [match[1], match[2]]);
    return [...plain, ...ternary].map((name) => [name, file]);
  },
  // Old conversations must stay resumable, so every persisted event type needs an importer.
  'log-event': () => {
    const file = 'source/services/logging/conversation-log-events.ts';
    return matches(read(file), /type: '([a-z_]+)'/g).map((name) => [name, file]);
  },
};

function extract() {
  const found = new Map();
  for (const [category, extractor] of Object.entries(EXTRACTORS)) {
    const pairs = extractor();
    if (pairs.length === 0) throw new Error(`inventory: extractor "${category}" found nothing; the source moved`);
    for (const [name, file] of pairs) {
      const id = `${category}:${name}`;
      if (!found.has(id)) found.set(id, { category, source: file });
    }
  }
  return found;
}

function loadManifest() {
  return fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { features: {} };
}

const STATUSES = new Set(['todo', 'in_progress', 'adopted', 'ported', 'dropped']);
const scenarioIds = () =>
  fs.existsSync(scenariosDir)
    ? new Set(
        fs
          .readdirSync(scenariosDir)
          .filter((name) => name.endsWith('.json'))
          .map((name) => name.slice(0, -5)),
      )
    : new Set();

function main() {
  const write = process.argv.includes('--write');
  const found = extract();
  const manifest = loadManifest();
  const features = manifest.features;
  const problems = [];

  for (const [id, info] of found) {
    if (!features[id]) {
      if (write) features[id] = { status: 'todo', source: info.source, parity: [] };
      else problems.push(`${id}: in source/ but not tracked (run with --write, then triage it)`);
    } else if (features[id].source !== info.source && write) {
      features[id].source = info.source;
    }
  }

  const scenarios = scenarioIds();
  for (const [id, entry] of Object.entries(features)) {
    if (!STATUSES.has(entry.status)) problems.push(`${id}: unknown status "${entry.status}"`);
    if (!found.has(id) && !entry.manual && entry.status !== 'dropped') {
      problems.push(`${id}: tracked but no longer in source/; mark it "dropped" with a note, or "manual"`);
    }
    if (entry.status === 'dropped' && !entry.note) problems.push(`${id}: dropped needs a note saying why`);
    if (['adopted', 'ported'].includes(entry.status) && (entry.parity ?? []).length === 0) {
      problems.push(`${id}: ${entry.status} but no parity scenario proves it`);
    }
    for (const scenario of entry.parity ?? []) {
      if (!scenarios.has(scenario)) problems.push(`${id}: parity scenario "${scenario}" does not exist`);
    }
  }

  if (write) {
    const sorted = Object.fromEntries(Object.entries(features).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, features: sorted }, null, 2) + '\n');
  }

  const byCategory = {};
  for (const [id, entry] of Object.entries(features)) {
    const category = id.slice(0, id.indexOf(':'));
    byCategory[category] ??= { total: 0, adopted: 0, ported: 0, dropped: 0, covered: 0 };
    const row = byCategory[category];
    row.total += 1;
    if (entry.status === 'adopted') row.adopted += 1;
    if (entry.status === 'ported') row.ported += 1;
    if (entry.status === 'dropped') row.dropped += 1;
    if ((entry.parity ?? []).length > 0) row.covered += 1;
  }
  console.log('category          total  covered adopted  ported  dropped');
  for (const [category, row] of Object.entries(byCategory).sort()) {
    console.log(
      `${category.padEnd(16)} ${String(row.total).padStart(6)} ${String(row.covered).padStart(8)} ${String(
        row.adopted,
      ).padStart(7)} ${String(row.ported).padStart(7)} ${String(row.dropped).padStart(8)}`,
    );
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('\ninventory check passed');
}

main();
