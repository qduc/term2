// The settled web-transcript architecture, as static rules (docs/plans/web-client/web-transcript-single-source-spec.md,
// section 8). They are a reminder for an accidental step, with no exceptions: changing this file, or the generated
// interface report it checks, asks for the owner's `architecture-change` label (scripts/check-architecture-change.mjs).
//   fold-boundary            nothing under src/protocol/fold/ imports from outside it
//   web-fold-imports         in web-client/, only session-store.ts imports the fold bundle; present.ts may import
//                            its types; nothing else imports either
//   browser-owns-no-reducer  web-client/lib/term2/event-adapter.ts and native-state.ts do not exist
//   wire-fold-api-current    docs/contracts/wire-fold.api.txt matches scripts/wire-fold-api.mjs
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { API_REPORT, wireFoldApi } from '../wire-fold-api.mjs';

const walk = (dir, skip = () => false) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (skip(full)) return [];
        if (entry.isDirectory()) return walk(full, skip);
        return /\.(tsx?|mts|mjs|cts)$/u.test(entry.name) ? [full] : [];
      })
    : [];

/** Every module a file names, with whether the reference is for types only. */
function moduleReferences(sf) {
  const found = [];
  const add = (node, specifier, typeOnly) =>
    found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, specifier, typeOnly });
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const typeOnly = ts.isImportDeclaration(node)
        ? Boolean(node.importClause?.isTypeOnly) ||
          Boolean(
            node.importClause &&
              !node.importClause.name &&
              node.importClause.namedBindings &&
              ts.isNamedImports(node.importClause.namedBindings) &&
              node.importClause.namedBindings.elements.every((element) => element.isTypeOnly),
          )
        : node.isTypeOnly;
      add(node, node.moduleSpecifier.text, typeOnly);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
      add(node, node.argument.literal.text, true);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [first] = node.arguments;
      add(node, first && ts.isStringLiteralLike(first) ? first.text : '<computed>', false);
    }
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) add(node, node.name.text, true);
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    )
      add(node, node.moduleReference.expression.text, false);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const reference of [...sf.referencedFiles, ...sf.typeReferenceDirectives])
    found.push({ line: 1, specifier: reference.fileName, typeOnly: true, tripleSlash: true });
  return found;
}

const parse = (file) => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

/** Runs the rules; `report(ruleId)` returns the function that records one violation for that rule. */
export function checkArchitecture(repo, report) {
  const rel = (file) => path.relative(repo, file).split(path.sep).join('/');

  // fold-boundary
  const foldBoundary = report('fold-boundary');
  const foldDir = path.join(repo, 'src', 'protocol', 'fold');
  for (const file of walk(foldDir)) {
    for (const reference of moduleReferences(parse(file))) {
      if (reference.tripleSlash) {
        foldBoundary(`${rel(file)}: references '${reference.specifier}' with a triple-slash directive`);
        continue;
      }
      const inside =
        reference.specifier.startsWith('./') &&
        path.resolve(path.dirname(file), reference.specifier).startsWith(foldDir + path.sep);
      if (!inside)
        foldBoundary(
          `${rel(file)}:${reference.line}: imports '${reference.specifier}' from outside src/protocol/fold/`,
        );
    }
  }

  // web-fold-imports
  const webImports = report('web-fold-imports');
  const web = path.join(repo, 'web-client');
  const generated = path.join(web, 'lib', 'term2', 'generated');
  const STORE = 'web-client/lib/term2/session-store.ts';
  const PRESENT = 'web-client/lib/term2/present.ts';
  const webFiles = walk(web, (full) => /[/\\](node_modules|\.next)$/u.test(full) || full === generated);
  for (const file of webFiles) {
    const name = rel(file);
    for (const reference of moduleReferences(parse(file))) {
      const target = reference.specifier.startsWith('.') ? path.resolve(path.dirname(file), reference.specifier) : '';
      const intoBundle =
        target === generated ||
        target.startsWith(generated + path.sep) ||
        /generated\/wire-fold/u.test(reference.specifier);
      if (!intoBundle) continue;
      if (name === STORE) continue;
      if (name === PRESENT && reference.typeOnly) continue;
      webImports(
        name === PRESENT
          ? `${name}:${reference.line}: imports a value from the fold bundle; present.ts may import its types only`
          : `${name}:${reference.line}: imports the fold bundle or wire types ('${reference.specifier}'); only session-store.ts (and present.ts, for types) may`,
      );
    }
  }

  // browser-owns-no-reducer
  const noReducer = report('browser-owns-no-reducer');
  for (const removed of ['web-client/lib/term2/event-adapter.ts', 'web-client/lib/term2/native-state.ts'])
    if (fs.existsSync(path.join(repo, removed))) noReducer(`${removed} exists again`);

  // wire-fold-api-current
  const apiCurrent = report('wire-fold-api-current');
  const reportPath = path.join(repo, API_REPORT);
  const committed = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : null;
  if (committed === null) apiCurrent(`${API_REPORT} is missing`);
  else if (committed !== wireFoldApi())
    apiCurrent(
      `${API_REPORT} does not match the fold's exports; run node scripts/wire-fold-api.mjs --write and review the diff`,
    );
}
