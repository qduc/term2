#!/usr/bin/env node
// Static checks for the rules in docs/architecture/layers.md that no other script covers. Parse-only, no build, well under a second.
// Every failure names file:line and the rule, so the author can fix it alone.
//   1. One projection: a WireEvent (the {sessionId, seq, turnId, type, payload} envelope) is only built in protocol/.
//   2. Names are jobs: no file or folder under src/ is called service, adapter or orchestrator
//      (exceptions are recorded in rule-baseline.json; new ones need a reason, see scripts/gates/rules.mjs).
//   3. No new unused runtime exports: an exported function/const/class must be named somewhere else in src/ or bench/.
//      Existing ones are recorded in rule-baseline.json (reason: still to delete or wire); new ones need a reason.
//   4. One fold: only session/fold-fact.ts imports the leaf fact reducers (queue replay and the queue barrel are its legs).
//   5. Duplicate basenames: files under src/ do not share basenames (excluding index, types, README, INTEGRATION).
//   6. Fixed sleeps: integration, e2e and provider black-box tests wait for conditions; a sleep needs a
//      `// sleep-ok: <observed>; <why long enough>` comment or a per-file ceiling in rule-baseline.json
//      (shapes detected are listed in scripts/gates/fixed-sleeps.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { exceptionKeys, failureMap, reportAndExit } from './gates/rules.mjs';
import { findFixedSleeps, slowTierFiles } from './gates/fixed-sleeps.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scripts, '..');
const src = path.join(repo, 'src');
const baselinePath = path.join(scripts, 'rule-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const { map: failures, add } = failureMap();
const projection = add('one-projection');
const jobNames = add('names-are-jobs');
const unused = add('unused-exports');
const fold = add('one-fold');

const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name))
        : /\.(tsx?|mts|mjs|cts)$/.test(entry.name)
        ? [path.join(dir, entry.name)]
        : [],
    );
const rel = (file) => path.relative(src, file).split(path.sep).join('/');
const files = walk(src);
const benchFiles = walk(path.join(repo, 'bench'));
const texts = new Map([...files, ...benchFiles].map((file) => [file, fs.readFileSync(file, 'utf8')]));
const parse = (file) => ts.createSourceFile(file, texts.get(file), ts.ScriptTarget.Latest, true);
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;

// 1. WireEvent construction.
const eventsText = fs.readFileSync(path.join(src, 'protocol/wire-events.ts'), 'utf8');
const payloads = eventsText.slice(
  eventsText.indexOf('export type WireEventPayloads'),
  eventsText.indexOf('export type WireEventType'),
);
const wireTypes = new Set([...payloads.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]));
if (wireTypes.size < 20) projection('rule-check: could not read WireEventPayloads from protocol/wire-events.ts');
const wireAllowed = exceptionKeys(
  baseline.wireEventOutsideProtocol.map((entry) => ({ key: `${entry.file} ${entry.type}`, reason: entry.reason })),
  'key',
  projection,
);
for (const file of files) {
  const name = rel(file);
  if (name.startsWith('protocol/')) continue;
  const sf = parse(file);
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map(
        node.properties.filter(ts.isPropertyAssignment).map((p) => [p.name.getText(), p.initializer]),
      );
      const type = props.get('type');
      if (
        type &&
        ts.isStringLiteral(type) &&
        wireTypes.has(type.text) &&
        ['payload', 'turnId', 'seq', 'sessionId'].every((k) => props.has(k))
      )
        if (!wireAllowed.has(`${name} ${type.text}`))
          projection(`${name}:${lineOf(sf, node)}: builds a WireEvent '${type.text}' outside protocol/`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// 2. Names are jobs. Exceptions are recorded in rule-baseline.json: legacy strings, or { path, reason }.
const namedPaths = exceptionKeys(baseline.jobNameExceptions, 'path', jobNames);
for (const file of files)
  if (/service|adapter|orchestrator/i.test(rel(file)) && !namedPaths.has(rel(file)))
    jobNames(`${rel(file)}:1: path names a file or folder service/adapter/orchestrator`);
for (const name of namedPaths)
  if (!files.some((file) => rel(file) === name))
    jobNames(`rule-baseline.json jobNameExceptions names missing ${name}; remove it`);

// 3. Unused runtime exports.
const counts = new Map();
for (const [file, text] of texts)
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    let perFile = counts.get(match[0]);
    if (!perFile) counts.set(match[0], (perFile = new Map()));
    perFile.set(file, (perFile.get(file) ?? 0) + 1);
  }
const known = exceptionKeys(baseline.unusedExports, 'export', unused);
const found = new Set();
for (const file of files) {
  const sf = parse(file);
  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
    if (!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue;
    const ids = ts.isVariableStatement(st)
      ? st.declarationList.declarations.map((d) => d.name.getText())
      : [st.name?.getText()].filter(Boolean);
    for (const id of ids) {
      if ([...counts.get(id).keys()].some((other) => other !== file)) continue;
      const key = `${rel(file)} ${id}`;
      found.add(key);
      if (!known.has(key))
        unused(`${rel(file)}:${lineOf(sf, st)}: export '${id}' is not used anywhere (key: "${key}")`);
    }
  }
}
const stale = [...known].filter((key) => !found.has(key));
if (stale.length)
  console.log(
    `rule-baseline.json lists ${stale.length} unused exports that are now used or gone; remove:\n  ${stale.join(
      '\n  ',
    )}`,
  );

// 4. One fold: the order in which the leaf reducers combine lives in session/fold-fact.ts only.
// Keyed on the module a reducer comes from, so every way of reaching one counts: a named or aliased import, a
// namespace or default import, an `export *` / `export { x } from`, a dynamic import(), or a reducer name
// exported locally. Type-only imports and the modules' other exports (predicates, initial states) stay free.
const leafReducers = new Set([
  'reduceDirectCommandReceipts',
  'reduceDirectNotifications',
  'reduceDirectContext',
  'reduceDirectQueue',
  'reduceDirectBackground',
]);
const leafModules = new Set([
  'command-receipts',
  'notifications',
  'context',
  'queue-state',
  'queue',
  'background-replay',
]);
const foldAllowed = new Set(['session/fold-fact.ts', 'session/queue-replay.ts', 'session/queue.ts']);
const fromLeafModule = (specifier) =>
  specifier !== undefined &&
  ts.isStringLiteralLike(specifier) &&
  /^\.{1,2}\//.test(specifier.text) &&
  leafModules.has(path.basename(specifier.text).replace(/\.js$/, ''));
for (const file of files) {
  const name = rel(file);
  if (foldAllowed.has(name)) continue;
  const sf = parse(file);
  const flag = (node, what) => fold(`${name}:${lineOf(sf, node)}: ${what}`);
  const visit = (node) => {
    if (
      (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) &&
      leafReducers.has((node.propertyName ?? node.name).text)
    )
      flag(node, `imports leaf reducer '${(node.propertyName ?? node.name).text}'`);
    if (
      ts.isImportDeclaration(node) &&
      fromLeafModule(node.moduleSpecifier) &&
      node.importClause &&
      !node.importClause.isTypeOnly
    ) {
      if (node.importClause.name) flag(node, `default-imports a leaf-reducer module '${node.moduleSpecifier.text}'`);
      if (node.importClause.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings))
        flag(node, `namespace-imports a leaf-reducer module '${node.moduleSpecifier.text}'`);
    }
    if (ts.isExportDeclaration(node) && fromLeafModule(node.moduleSpecifier) && !node.isTypeOnly && !node.exportClause)
      flag(node, `re-exports everything from a leaf-reducer module '${node.moduleSpecifier.text}'`);
    if (
      ts.isExportDeclaration(node) &&
      fromLeafModule(node.moduleSpecifier) &&
      !node.isTypeOnly &&
      node.exportClause &&
      ts.isNamespaceExport(node.exportClause)
    )
      flag(node, `re-exports a leaf-reducer module as a namespace '${node.moduleSpecifier.text}'`);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      fromLeafModule(node.arguments[0])
    )
      flag(node, `dynamically imports a leaf-reducer module '${node.arguments[0].text}'`);
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// 5. Duplicate basenames under src/.
const duplicates = add('duplicate-basenames');
const duplicateAllowed = exceptionKeys(baseline.duplicateBasenames, 'file', duplicates);
const CONVENTIONS = new Set(['index.ts', 'index.tsx', 'types.ts', 'types.tsx', 'README.md', 'INTEGRATION.md']);
const allSrcFiles = [];
const walkSrcAll = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSrcAll(full);
    else if (/\.(tsx?|mts|mjs|cts|md)$/.test(entry.name)) allSrcFiles.push(full);
  }
};
walkSrcAll(src);

const byBase = new Map();
for (const file of allSrcFiles) {
  const base = path.basename(file);
  if (CONVENTIONS.has(base)) continue;
  if (!byBase.has(base)) byBase.set(base, []);
  byBase.get(base).push(rel(file));
}
const foundDups = new Set();
for (const [, list] of byBase) {
  if (list.length > 1) {
    for (const file of list) {
      foundDups.add(file);
      if (!duplicateAllowed.has(file)) {
        const others = list.filter((f) => f !== file);
        duplicates(`${file}: shares basename with ${others.join(', ')}`);
      }
    }
  }
}
const staleDups = [...duplicateAllowed].filter((file) => !foundDups.has(file));
if (staleDups.length)
  console.log(
    `rule-baseline.json lists ${
      staleDups.length
    } duplicate-basename exceptions that are no longer duplicated or gone; remove:\n  ${staleDups.join('\n  ')}`,
  );

// 6. Fixed sleeps in the slow test tiers. The baseline holds a per-file ceiling that only goes down.
const sleeps = add('fixed-sleeps');
const sleepCeilings = new Map();
for (const entry of baseline.fixedSleeps ?? []) {
  const [file] = exceptionKeys([entry], 'file', sleeps);
  if (file === undefined) continue;
  if (!Number.isInteger(entry.count) || entry.count < 1)
    sleeps(`rule-baseline.json fixedSleeps ${file} needs a positive integer "count"`);
  else sleepCeilings.set(file, entry.count);
}
const tierFiles = slowTierFiles(repo);
const sleepScan = findFixedSleeps(repo, tierFiles);
for (const { file, line, problem } of sleepScan.badComments) sleeps(`${file}:${line}: ${problem}`);
const sleepsByFile = Map.groupBy(sleepScan.unjustified, (site) => site.file);
for (const [file, sites] of sleepsByFile) {
  const ceiling = sleepCeilings.get(file) ?? 0;
  if (sites.length > ceiling)
    for (const { line, shape } of sites)
      sleeps(`${file}:${line}: fixed sleep (${shape}); ${sites.length} unjustified in this file, ${ceiling} recorded`);
}
for (const [file, ceiling] of sleepCeilings) {
  const now = sleepsByFile.get(file)?.length ?? 0;
  if (!tierFiles.includes(file))
    sleeps(`rule-baseline.json fixedSleeps names ${file}, not a slow-tier test; remove it`);
  else if (now < ceiling)
    sleeps(
      `rule-baseline.json fixedSleeps ${file}: ${now} unjustified sleeps now, ${ceiling} recorded; lower the count`,
    );
}

reportAndExit(
  failures,
  `rule check passed (${found.size} recorded unused exports, ${wireAllowed.size} recorded wire-event exceptions, ` +
    `${duplicateAllowed.size} recorded duplicate basenames, ${sleepScan.justified} sleep-ok sleeps, ` +
    `${sleepScan.unjustified.length} recorded fixed sleeps in ${sleepCeilings.size} files)`,
);
