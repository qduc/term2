#!/usr/bin/env node
// The shared fold's public interface as a sorted, one-member-per-line report (docs/contracts/wire-fold.api.txt):
// everything src/protocol/fold/index.ts exports, plus the direct-wire-v2 frame envelope from src/host/server-sse.ts.
// A change to the future @qduc/agent-wire interface shows up as a diff in a file a person can read; an added line
// is a new optional field or event type, a changed or removed line is a breaking change.
//
//   node scripts/wire-fold-api.mjs           print the report
//   node scripts/wire-fold-api.mjs --write   regenerate docs/contracts/wire-fold.api.txt
// check-rules.mjs (architecture-rules.mjs) fails when the committed report is stale.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const API_REPORT = 'docs/contracts/wire-fold.api.txt';
const FOLD_ENTRY = path.join(repo, 'src/protocol/fold/index.ts');
const ENVELOPE_FILE = path.join(repo, 'src/host/server-sse.ts');
const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrayAsGenericType;

const oneLine = (text) => text.replace(/\s+/gu, ' ').trim();

function membersOf(checker, type, prefix) {
  const lines = [];
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : '';
    const readonly =
      declaration && ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly ? 'readonly ' : '';
    const propertyType = declaration
      ? checker.getTypeOfSymbolAtLocation(property, declaration)
      : checker.getDeclaredTypeOfSymbol(property);
    lines.push(
      `${prefix}.${readonly}${property.name}${optional}: ${oneLine(
        checker.typeToString(propertyType, undefined, FLAGS),
      )}`,
    );
  }
  return lines;
}

function describeType(checker, name, type) {
  if (type.isUnion() && type.types.every((member) => member.getFlags() & ts.TypeFlags.Object)) {
    // A union of objects told apart by a literal `kind` or `type`: one block per variant.
    const lines = [];
    for (const member of type.types) {
      const tag = ['kind', 'type'].map((key) => member.getProperty(key)).find(Boolean);
      const tagType = tag ? checker.getTypeOfSymbol(tag) : undefined;
      const label = tagType?.isStringLiteral() ? `${tag.name}=${tagType.value}` : oneLine(checker.typeToString(member));
      lines.push(...membersOf(checker, member, `${name}[${label}]`));
    }
    return lines;
  }
  if (
    type.getFlags() & ts.TypeFlags.Object &&
    !type.getCallSignatures().length &&
    checker.getPropertiesOfType(type).length
  )
    return membersOf(checker, type, name);
  return [`type ${name} = ${oneLine(checker.typeToString(type, undefined, FLAGS | ts.TypeFormatFlags.InTypeAlias))}`];
}

export function wireFoldApi() {
  const program = ts.createProgram([FOLD_ENTRY, ENVELOPE_FILE], {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const lines = [];
  const entry = checker.getSymbolAtLocation(program.getSourceFile(FOLD_ENTRY));
  for (const exported of checker.getExportsOfModule(entry)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const name = exported.name;
    if (symbol.flags & ts.SymbolFlags.Function) {
      for (const signature of checker.getSignaturesOfType(checker.getTypeOfSymbol(symbol), ts.SignatureKind.Call))
        lines.push(`function ${name}${oneLine(checker.signatureToString(signature, undefined, FLAGS))}`);
    } else if (symbol.flags & ts.SymbolFlags.Variable) {
      lines.push(`const ${name}: ${oneLine(checker.typeToString(checker.getTypeOfSymbol(symbol), undefined, FLAGS))}`);
    } else if (symbol.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface)) {
      lines.push(...describeType(checker, name, checker.getDeclaredTypeOfSymbol(symbol)));
    }
  }
  const envelopeFile = checker.getSymbolAtLocation(program.getSourceFile(ENVELOPE_FILE));
  const envelope = checker.getExportsOfModule(envelopeFile).find((symbol) => symbol.name === 'DirectWireV2Envelope');
  if (!envelope) throw new Error('src/host/server-sse.ts no longer exports DirectWireV2Envelope');
  lines.push(...describeType(checker, 'DirectWireV2Envelope', checker.getDeclaredTypeOfSymbol(envelope)));
  return [...new Set(lines)].sort().join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = wireFoldApi();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(repo, API_REPORT), report);
    console.log(`wrote ${API_REPORT} (${report.split('\n').length - 1} lines)`);
  } else process.stdout.write(report);
}
