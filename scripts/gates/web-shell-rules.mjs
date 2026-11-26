// The chat shell's component rules (docs/plans/web-client/web-shell-decomposition.md, section 7.2). Reminders for an
// accidental step, in the existing gate pattern. Both scan web-client/components/term2/Term2SessionShell.tsx and
// every file under web-client/components/term2/shell/. Parse-only.
//   web-shell-effects   no useState/useReducer setter or `dispatch` call directly in an effect body (the hooks
//                       called bare or as React.useEffect / React.useState)
//                       (per-file ceiling in rule-baseline.json webShellEffects; ShellFeeds.tsx holds the feeds)
//   web-shell-requests  no value import from lib/api/term2 (server data lives in lib/term2/data/server-data.ts)
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { exceptionKeys } from './rules.mjs';

const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);

function scannedFiles(repo) {
  const files = [path.join(repo, 'web-client/components/term2/Term2SessionShell.tsx')];
  const dir = path.join(repo, 'web-client/components/term2/shell');
  const walk = (folder) => {
    if (!fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|mts)$/u.test(entry.name)) files.push(full);
    }
  };
  walk(dir);
  return files.filter((file) => fs.existsSync(file));
}

const calleeName = (expression) => (ts.isIdentifier(expression) ? expression.text : undefined);
/** A React hook's name, called bare (`useEffect`) or through the namespace (`React.useEffect`). */
const hookName = (expression) =>
  ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'React'
    ? expression.name.text
    : undefined;

/** Setter names bound by `const [x, setX] = useState(...)` or `useReducer(...)` in this file. */
function stateSetters(sf) {
  const setters = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ['useState', 'useReducer'].includes(hookName(node.initializer.expression) ?? '')
    ) {
      const second = node.name.elements[1];
      if (second && ts.isBindingElement(second) && ts.isIdentifier(second.name)) setters.add(second.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return setters;
}

/** Calls made directly in an effect's body: nested functions (listeners, timers, promise callbacks, cleanup) skipped. */
function effectWrites(sf) {
  const setters = stateSetters(sf);
  const found = [];
  const scanBody = (node) => {
    if (ts.isFunctionLike(node) && node.parent !== undefined) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = calleeName(callee);
      const shape =
        name && setters.has(name)
          ? `state setter ${name}()`
          : name === 'dispatch' || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'dispatch')
          ? 'dispatch()'
          : null;
      if (shape) found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, shape });
    }
    ts.forEachChild(node, scanBody);
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && EFFECT_HOOKS.has(hookName(node.expression) ?? '')) {
      const [effect] = node.arguments;
      if (effect && (ts.isArrowFunction(effect) || ts.isFunctionExpression(effect))) {
        // The effect function itself is scanned; functions inside it are not.
        if (ts.isBlock(effect.body)) ts.forEachChild(effect.body, scanBody);
        else scanBody(effect.body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Value imports of the browser HTTP facade. */
function facadeImports(sf, file) {
  const found = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : specifier;
    const isFacade = /lib\/api\/term2$/u.test(specifier) || /web-client\/lib\/api\/term2$/u.test(resolved);
    if (!isFacade) continue;
    const clause = statement.importClause;
    const typeOnly =
      Boolean(clause?.isTypeOnly) ||
      Boolean(
        clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly),
      );
    if (!typeOnly) found.push({ line: sf.getLineAndCharacterOfPosition(statement.getStart()).line + 1, specifier });
  }
  return found;
}

/** Runs both rules; `report(ruleId)` returns the function that records one violation for that rule. */
export function checkWebShell(repo, report, baseline) {
  const rel = (file) => path.relative(repo, file).split(path.sep).join('/');
  const effects = report('web-shell-effects');
  const requests = report('web-shell-requests');

  const ceilings = new Map();
  for (const entry of baseline.webShellEffects ?? []) {
    const [file] = exceptionKeys([entry], 'file', effects);
    if (file === undefined) continue;
    if (!Number.isInteger(entry.count) || entry.count < 1)
      effects(`rule-baseline.json webShellEffects ${file} needs a positive integer "count"`);
    else ceilings.set(file, entry.count);
  }
  const allowedRequests = new Set(exceptionKeys(baseline.webShellRequests ?? [], 'file', requests));

  const counts = new Map();
  for (const full of scannedFiles(repo)) {
    const file = rel(full);
    const sf = ts.createSourceFile(
      full,
      fs.readFileSync(full, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const writes = effectWrites(sf);
    counts.set(file, writes.length);
    const ceiling = ceilings.get(file) ?? 0;
    if (writes.length > ceiling)
      for (const { line, shape } of writes)
        effects(`${file}:${line}: ${shape} in an effect body; ${writes.length} in this file, ${ceiling} recorded`);
    if (!allowedRequests.has(file))
      for (const { line, specifier } of facadeImports(sf, full))
        requests(`${file}:${line}: imports the HTTP facade ('${specifier}') into a shell component`);
  }
  for (const [file, ceiling] of ceilings) {
    const now = counts.get(file);
    if (now === undefined) effects(`rule-baseline.json webShellEffects names ${file}, which is not scanned; remove it`);
    else if (now < ceiling)
      effects(
        `rule-baseline.json webShellEffects ${file}: ${now} effect writes now, ${ceiling} recorded; lower the count`,
      );
  }
}
