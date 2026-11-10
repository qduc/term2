import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = path.resolve('src/engine');

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sources(file)));
    else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) files.push(file);
  }
  return files;
}

it('keeps engine imports within the shrinking boundary', async () => {
  const baseline = JSON.parse(await readFile('tests/guards/engine-import-baseline.json', 'utf8')) as string[];
  const actual = new Set<string>();
  const violations: string[] = [];
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
  for (const file of await sources(root)) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const relative = path.relative(root, file);
    const check = (specifier: string): void => {
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(file), specifier);
        if (target !== root && !target.startsWith(root + path.sep)) actual.add(`${relative}: ${specifier}`);
      } else if (
        specifier !== 'zod' &&
        specifier !== '@qduc/agent-core' &&
        !builtins.has(specifier.replace(/^node:/, ''))
      ) {
        violations.push(`${relative}: ${specifier}`);
      }
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
        else violations.push(`${relative}: nonliteral import`);
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const expression = node.moduleReference.expression;
        if (expression && ts.isStringLiteral(expression)) check(expression.text);
        else violations.push(`${relative}: nonliteral require`);
      }
      if (ts.isIdentifier(node) && node.text === 'createRequire') violations.push(`${relative}: createRequire`);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) check(argument.text);
        else violations.push(`${relative}: nonliteral dynamic import`);
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
        check(node.argument.literal.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
  expect([...actual].sort()).toEqual(baseline);
});
