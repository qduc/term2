// Fixed sleeps in the slow test tiers (integration, e2e, provider black-box). A sleep costs its full length on
// every CI run, while a wait for a condition costs only what the condition takes. See the testing skill,
// "Keeping the slow tiers fast". Parse-only: the scope comes from the tiers' Vitest `include` globs.
//
// Shapes detected (a sleep that is none of these is not seen; the list is not complete):
//   promise-sleep   `new Promise((resolve) => setTimeout(resolve, n))`, including `setTimeout(() => resolve(), n)`
//   sleep-helper    a call to a function named sleep or delay (`await sleep(n)`, `await delay(n)`)
//   timers-promises `await setTimeout(n)` with setTimeout imported from node:timers/promises
//   poll-loop       any of the above inside a for/while/do loop (a fixed-interval poll)
// Not flagged: callback timers that are fixture behaviour, such as a fake server pausing a stream
// (`setTimeout(() => res.end(...), n)`), because nothing awaits them.
//
// Escape hatch: a comment directly above the statement holding the sleep (or above an enclosing if/loop):
//   // sleep-ok: <what absence or window is observed>; <why this length is enough>
// Both parts must be non-empty.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const SLEEP_SHAPES = ['promise-sleep', 'sleep-helper', 'timers-promises', 'poll-loop'];
const CONFIGS = ['vitest.integration.config.ts', 'vitest.e2e.config.ts', 'vitest.provider-black-box.config.ts'];

/** Test files of the slow tiers, from each config's `include` array. */
export function slowTierFiles(repo) {
  const files = new Set();
  for (const config of CONFIGS) {
    const text = fs.readFileSync(path.join(repo, config), 'utf8');
    const include = /include:\s*\[([^\]]*)\]/.exec(text);
    if (!include) throw new Error(`fixed-sleeps: no include array in ${config}`);
    for (const [, glob] of include[1].matchAll(/'([^']+)'/g))
      for (const file of fs.globSync(glob, { cwd: repo, exclude: (name) => name.includes('node_modules') }))
        files.add(file.split(path.sep).join('/'));
  }
  if (files.size === 0) throw new Error('fixed-sleeps: the tier include globs matched no files');
  return [...files].sort();
}

const isTimersPromises = (spec) => spec === 'node:timers/promises' || spec === 'timers/promises';
const calleeName = (call) =>
  ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : undefined;
const LOOPS = new Set([
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
]);
const isFunction = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node);

/** True when `fn` (a setTimeout callback) only settles the promise whose resolver is `resolver`. */
function resolvesOnly(fn, resolver) {
  if (ts.isIdentifier(fn)) return fn.text === resolver;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  let body = fn.body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1 || !ts.isExpressionStatement(body.statements[0])) return false;
    body = body.statements[0].expression;
  }
  return ts.isCallExpression(body) && ts.isIdentifier(body.expression) && body.expression.text === resolver;
}

/** A `new Promise(executor)` whose executor settles only through a setTimeout. */
function isPromiseSleep(node) {
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'Promise')
    return false;
  const executor = node.arguments?.[0];
  if (!executor || (!ts.isArrowFunction(executor) && !ts.isFunctionExpression(executor))) return false;
  const resolver = executor.parameters[0]?.name;
  if (!resolver || !ts.isIdentifier(resolver)) return false;
  let found = false;
  const visit = (child) => {
    if (
      ts.isCallExpression(child) &&
      calleeName(child) === 'setTimeout' &&
      child.arguments[0] &&
      resolvesOnly(child.arguments[0], resolver.text)
    )
      found = true;
    else ts.forEachChild(child, visit);
  };
  visit(executor.body);
  return found;
}

const HELPER_NAMES = new Set(['sleep', 'delay']);
function insideSleepHelper(node) {
  for (let at = node.parent; at; at = at.parent)
    if (isFunction(at)) {
      const named = at.name ?? (ts.isVariableDeclaration(at.parent) ? at.parent.name : undefined);
      return Boolean(named && ts.isIdentifier(named) && HELPER_NAMES.has(named.text));
    }
  return false;
}

/** The comment block on the lines directly above `line` (1-based), joined. */
function commentAbove(lines, line) {
  const block = [];
  for (let i = line - 2; i >= 0; i--) {
    const text = lines[i].trim();
    if (!text.startsWith('//')) break;
    block.unshift(text.replace(/^\/\/\s?/, ''));
  }
  return block.join(' ');
}

/** null when the comment justifies the sleep, else what is wrong with it; undefined when there is none. */
function sleepOkProblem(comment) {
  const match = /sleep-ok:(.*)$/.exec(comment);
  if (!match) return undefined;
  const [observed, ...rest] = match[1].split(';');
  const why = rest.join(';');
  if (!observed.trim() || !why.trim())
    return "has a sleep-ok comment without both parts: '// sleep-ok: <what is observed>; <why this length is enough>'";
  return null;
}

/**
 * Every fixed sleep in `files` (paths relative to `repo`). Returns
 * { unjustified: [{ file, line, shape }], badComments: [{ file, line, problem }], justified: number }.
 */
export function findFixedSleeps(repo, files) {
  const unjustified = [];
  const badComments = [];
  let justified = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8');
    const lines = text.split('\n');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const timerNames = new Set();
    for (const st of sf.statements)
      if (
        ts.isImportDeclaration(st) &&
        ts.isStringLiteral(st.moduleSpecifier) &&
        isTimersPromises(st.moduleSpecifier.text) &&
        st.importClause?.namedBindings &&
        ts.isNamedImports(st.importClause.namedBindings)
      )
        for (const el of st.importClause.namedBindings.elements)
          if ((el.propertyName ?? el.name).text === 'setTimeout') timerNames.add(el.name.text);
    const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const record = (node, shape) => {
      // Statements a comment may sit above: the one holding the sleep, then enclosing if/loop statements,
      // up to the enclosing block or function.
      const candidates = [];
      let inLoop = false;
      for (let at = node.parent; at && !isFunction(at) && !ts.isSourceFile(at); at = at.parent)
        if (LOOPS.has(at.kind)) inLoop = true;
      for (let at = node.parent; at && !isFunction(at) && !ts.isSourceFile(at); at = at.parent) {
        if (ts.isBlock(at)) {
          if (candidates.length) break;
          continue;
        }
        if (ts.isStatement(at) || LOOPS.has(at.kind)) candidates.push(at);
      }
      const where = lineOf(node);
      const problems = candidates.map((st) => sleepOkProblem(commentAbove(lines, lineOf(st))));
      if (problems.includes(null)) justified += 1;
      else if (problems.some((p) => p)) badComments.push({ file, line: where, problem: problems.find((p) => p) });
      else unjustified.push({ file, line: where, shape: inLoop ? 'poll-loop' : shape });
    };
    const visit = (node) => {
      // The body of a sleep/delay helper is not a wait itself; its calls are flagged as sleep-helper.
      if (isPromiseSleep(node) && !insideSleepHelper(node)) return record(node, 'promise-sleep');
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (HELPER_NAMES.has(name)) return record(node, 'sleep-helper');
        if (
          ts.isIdentifier(node.expression) &&
          timerNames.has(node.expression.text) &&
          ts.isAwaitExpression(node.parent)
        )
          return record(node, 'timers-promises');
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { unjustified, badComments, justified };
}
