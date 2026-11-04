#!/usr/bin/env node
// Static checks for the rules in rewrite/README.md that no other script covers. Parse-only, no build, well under a second.
// Every failure names file:line and the rule, so the author can fix it alone.
//   1. One projection: a WireEvent (the {sessionId, seq, turnId, type, payload} envelope) is only built in protocol/.
//   2. Names are jobs: no file or folder under src/ is called service, adapter or orchestrator.
//   3. No new unused runtime exports: an exported function/const/class must be named somewhere else in src/ or bench/.
//      Existing ones are recorded in rule-baseline.json (reason: still to delete or wire); the list only shrinks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scripts, '../..');
const src = path.join(repo, 'rewrite/src');
const baselinePath = path.join(scripts, 'rule-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const problems = [];

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
const benchFiles = walk(path.join(repo, 'rewrite/bench'));
const texts = new Map([...files, ...benchFiles].map((file) => [file, fs.readFileSync(file, 'utf8')]));
const parse = (file) => ts.createSourceFile(file, texts.get(file), ts.ScriptTarget.Latest, true);
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;

// 1. WireEvent construction.
const eventsText = fs.readFileSync(path.join(src, 'protocol/direct-wire-events.ts'), 'utf8');
const payloads = eventsText.slice(
  eventsText.indexOf('export type WireEventPayloads'),
  eventsText.indexOf('export type WireEventType'),
);
const wireTypes = new Set([...payloads.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]));
if (wireTypes.size < 20)
  problems.push('rule-check: could not read WireEventPayloads from protocol/direct-wire-events.ts');
const wireAllowed = new Set(baseline.wireEventOutsideProtocol.map((entry) => `${entry.file} ${entry.type}`));
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
          problems.push(
            `${name}:${lineOf(sf, node)}: builds a WireEvent '${
              type.text
            }' outside protocol/ (rule: one projection, wire events are built only in protocol/)`,
          );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// 2. Names are jobs.
for (const file of files)
  if (/service|adapter|orchestrator/i.test(rel(file)))
    problems.push(`${rel(file)}:1: path names a layer or file service/adapter/orchestrator (rule: names are jobs)`);

// 3. Unused runtime exports.
const counts = new Map();
for (const [file, text] of texts)
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    let perFile = counts.get(match[0]);
    if (!perFile) counts.set(match[0], (perFile = new Map()));
    perFile.set(file, (perFile.get(file) ?? 0) + 1);
  }
const known = new Set(baseline.unusedExports);
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
        problems.push(
          `${rel(file)}:${lineOf(
            sf,
            st,
          )}: export '${id}' is not used anywhere (rule: no unused exports; delete it, or use it)`,
        );
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

if (problems.length) {
  console.error(problems.sort().join('\n'));
  process.exit(1);
}
console.log(
  `rule check passed (${found.size} recorded unused exports, ${wireAllowed.size} recorded wire-event exceptions)`,
);
