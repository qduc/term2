#!/usr/bin/env node
// The engine waits instead of calling up (docs/architecture/layers.md, audit F1): a turn's durable facts reach the
// log through its events, which session/conversation-turn.ts (or the branch reader in session/branches.ts) appends
// before accepting each one. A callback the engine invokes (a function-typed member of TurnDeps or TurnBudget in
// the harness package's engine/types.ts) that writes the log is a second write path whose position in the log depends on when the engine
// chose to call it, so each one is recorded in rule-baseline.json (engineCallbackWrites) with the reason it must
// stay synchronous.
//
// How: a TypeScript program (no emit) finds every place outside engine/ that supplies one of those members, then
// follows the supplied function through calls it can resolve to a body (including closures created inside it, and
// values chosen by a conditional or `??`). A call to an interface or type-literal member is followed into every
// object literal or `implements` class that implements it. The callback is reported if it reaches a writer:
// ConversationJournal.commit/recover, a log's append, or a port signature named commit, accept or append
// (optionally followed by a capitalised suffix: commitGoal, acceptCost) outside engine/. `accepted` observers are
// not writers.
// Limits: a write behind a port with another name that nothing in src/ implements by declaration, or reached only
// through a value the checker cannot resolve, is not seen. Closures and error paths count whether or not they run,
// so the check over-approximates, and the printed trail is one path, not necessarily the main one.
import path from 'node:path';
import ts from 'typescript';
import { exceptionKeys, failureMap, repo, reportAndExit } from './gates/rules.mjs';
import fs from 'node:fs';

const baseline = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/rule-baseline.json'), 'utf8'));
const { map: failures, add } = failureMap();
const report = add('engine-callback-writes');
const listed = exceptionKeys(baseline.engineCallbackWrites, 'callback', report);

const config = ts.getParsedCommandLineOfConfigFile(
  path.join(repo, 'tsconfig.json'),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  },
);
// Resolve the package to source for this analysis: the declarations consumed by
// application builds must not hide callback bodies or point at stale dist files.
const harness = path.join(repo, 'packages/agent-harness-core/src');
const program = ts.createProgram({
  rootNames: config.fileNames,
  options: {
    ...config.options,
    noEmit: true,
    baseUrl: repo,
    paths: { ...config.options.paths, '@qduc/agent-harness-core': [path.join(harness, 'index.ts')] },
  },
});
const checker = program.getTypeChecker();
const src = path.join(repo, 'src') + path.sep;
const rel = (file) => path.relative(repo, file).split(path.sep).join('/');
const inSrc = (node) => node.getSourceFile().fileName.startsWith(src);
const inEngine = (node) => {
  const file = rel(node.getSourceFile().fileName);
  return file.startsWith('src/engine/') || file.startsWith('packages/agent-harness-core/src/');
};
const where = (node) => {
  const sf = node.getSourceFile();
  return `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
};

// 1. The callbacks: function-typed members of TurnDeps and TurnBudget, plus the methods of object-typed members
// (contextMilestones.observe). Keyed by their declaration so a supply site can be matched exactly.
const types = program.getSourceFile(path.join(harness, 'engine/types.ts'));
if (!types) report('engine-callbacks: could not load harness engine/types.ts');
const callbacks = new Map(); // declaration node -> "TurnDeps.name"
const callable = (type) => checker.getNonNullableType(type).getCallSignatures().length > 0;
for (const statement of types?.statements ?? []) {
  if (!ts.isTypeAliasDeclaration(statement) || !['TurnDeps', 'TurnBudget'].includes(statement.name.text)) continue;
  const owner = statement.name.text;
  for (const member of checker.getPropertiesOfType(checker.getTypeAtLocation(statement.name))) {
    const declaration = member.declarations?.[0];
    if (!declaration) continue;
    const type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(member, declaration));
    if (callable(type)) callbacks.set(declaration, `${owner}.${member.name}`);
    else if (type.getProperties().length > 0 && member.name !== 'budget')
      for (const inner of type.getProperties()) {
        const innerDeclaration = inner.declarations?.[0];
        if (
          innerDeclaration &&
          innerDeclaration.getSourceFile() === types &&
          callable(checker.getTypeOfSymbolAtLocation(inner, innerDeclaration))
        )
          callbacks.set(innerDeclaration, `${owner}.${member.name}.${inner.name}`);
      }
  }
}
if (callbacks.size < 8) report(`engine-callbacks: found only ${callbacks.size} callbacks in harness engine/types.ts`);

// 2. Writers.
const journal = program.getSourceFile(path.join(repo, 'src/session/conversation-journal.ts'));
const writerDeclarations = new Set();
for (const statement of journal?.statements ?? [])
  if (ts.isClassDeclaration(statement) && statement.name?.text === 'ConversationJournal')
    for (const member of statement.members)
      if (member.name && ['commit', 'recover'].includes(member.name.getText())) writerDeclarations.add(member);
if (writerDeclarations.size !== 2) report('engine-callbacks: could not find ConversationJournal.commit and recover');
const isPort = (declaration) =>
  (ts.isPropertySignature(declaration) || ts.isMethodSignature(declaration) || ts.isParameter(declaration)) &&
  !inEngine(declaration) &&
  /^(commit|accept|append)([A-Z]\w*)?$/.test(declaration.name.getText());
const isWriter = (declaration) =>
  writerDeclarations.has(declaration) ||
  isPort(declaration) ||
  ((ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) &&
    declaration.name.getText() === 'append' &&
    /^src\/session\/(log|rolling-log)\.ts$/.test(rel(declaration.getSourceFile().fileName)));

// Resolve a referenced value to the declarations that give it a body.
const resolve = (node) => {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return [];
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declarations = [];
  for (const declaration of symbol.declarations ?? []) {
    // `const { commit } = journal` names the journal's member, not a new value.
    if (ts.isBindingElement(declaration) && ts.isVariableDeclaration(declaration.parent.parent)) {
      const source = declaration.parent.parent.initializer;
      const name = (declaration.propertyName ?? declaration.name).getText();
      const property = source && checker.getTypeAtLocation(source).getProperty(name);
      declarations.push(...(property?.declarations ?? []));
    } else if (ts.isShorthandPropertyAssignment(declaration)) {
      const value = checker.getShorthandAssignmentValueSymbol(declaration);
      declarations.push(...(value?.declarations ?? []));
    } else declarations.push(declaration);
  }
  return declarations;
};
const bodyOf = (declaration) => {
  if (ts.isFunctionLike(declaration) && 'body' in declaration && declaration.body) return declaration;
  if (
    (ts.isVariableDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration) ||
      ts.isPropertyDeclaration(declaration)) &&
    declaration.initializer
  )
    return declaration.initializer;
  return undefined;
};

// An interface or type-literal member has no body; what runs is whatever implements it. Index every object literal
// member and class member outside engine/ by name once (parse only), and ask the checker only for those whose name
// matches the member being followed.
const membersByName = new Map();
for (const sf of program.getSourceFiles()) {
  if (!sf.fileName.startsWith(src) || rel(sf.fileName).startsWith('src/engine/')) continue;
  const visit = (node) => {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      (ts.isObjectLiteralExpression(node.parent) || ts.isClassLike(node.parent))
    ) {
      const name = node.name.getText();
      if (!membersByName.has(name)) membersByName.set(name, []);
      membersByName.get(name).push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
const implementations = new Map();
const ownerTypes = new Map(); // object literal or class -> the types its members implement
const ownerTypesOf = (owner) => {
  if (!ownerTypes.has(owner)) {
    const contextual = ts.isObjectLiteralExpression(owner) ? checker.getContextualType(owner) : undefined;
    ownerTypes.set(
      owner,
      ts.isObjectLiteralExpression(owner)
        ? contextual
          ? [checker.getNonNullableType(contextual)]
          : []
        : (owner.heritageClauses ?? [])
            .flatMap((clause) => clause.types)
            .map((type) => checker.getTypeAtLocation(type)),
    );
  }
  return ownerTypes.get(owner);
};
const implementationsOf = (signature) => {
  if (implementations.has(signature)) return implementations.get(signature);
  const found = [];
  for (const member of membersByName.get(signature.name.getText()) ?? []) {
    // A class without `implements` cannot implement the signature by declaration; skip it cheaply.
    if (ts.isClassLike(member.parent) && !member.parent.heritageClauses) continue;
    const targets = ownerTypesOf(member.parent).map((type) => type.getProperty(member.name.getText()));
    if (targets.some((target) => target?.declarations?.includes(signature))) found.push(member);
  }
  implementations.set(signature, found);
  return found;
};
const isSignature = (declaration) => ts.isPropertySignature(declaration) || ts.isMethodSignature(declaration);

// A function value that is handed on (an argument, a property value, a returned or bound value) may be invoked
// later, so it counts as called. A plain read such as a receiver (`commands.owner`) does not. A value chosen by a
// conditional or `??`/`||`/`&&`, or wrapped in parentheses or a cast, is handed on if the whole expression is.
const handedOn = (reference) => {
  const parent = reference.parent;
  if (
    (ts.isConditionalExpression(parent) && parent.condition !== reference) ||
    (ts.isBinaryExpression(parent) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(
        parent.operatorToken.kind,
      )) ||
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent)
  )
    return handedOn(parent);
  return (
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && !!parent.arguments?.includes(reference)) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === reference) ||
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isReturnStatement(parent) ||
    (ts.isArrowFunction(parent) && parent.body === reference) ||
    (ts.isVariableDeclaration(parent) && parent.initializer === reference)
  );
};

// 3. Does a supplied value reach a writer? Returns the first path found, as "a -> b -> writer".
const reaches = (start) => {
  const seen = new Set();
  const search = (node, trail, depth) => {
    if (!node || depth > 12 || seen.has(node)) return undefined;
    seen.add(node);
    let found;
    const calleeOf = (child) =>
      ts.isCallExpression(child)
        ? child.expression
        : (ts.isIdentifier(child) || ts.isPropertyAccessExpression(child)) && (child === node || handedOn(child))
        ? child
        : undefined;
    const targetOf = (callee) => (ts.isPropertyAccessExpression(callee) ? callee.name : callee);
    // A writer called in this body itself is reported before any deeper path, so the trail shows the nearest write.
    const direct = (child) => {
      if (found) return;
      const callee = calleeOf(child);
      const target = callee && targetOf(callee);
      if (target && ts.isIdentifier(target) && resolve(target).some(isWriter)) {
        found = [...trail, `${callee.getText().replace(/\s+/g, ' ')} (${where(child)})`];
        return;
      }
      ts.forEachChild(child, direct);
    };
    direct(node);
    if (found) return found;
    const visit = (child) => {
      if (found) return;
      const callee = calleeOf(child);
      if (callee) {
        const target = targetOf(callee);
        for (const declaration of ts.isIdentifier(target) ? resolve(target) : []) {
          if (isWriter(declaration)) continue; // reported by `direct` above
          if (!inSrc(declaration) || inEngine(declaration)) continue;
          if (isSignature(declaration)) {
            for (const implementation of implementationsOf(declaration)) {
              const value = ts.isPropertyAssignment(implementation)
                ? implementation.initializer
                : ts.isShorthandPropertyAssignment(implementation)
                ? implementation.name
                : implementation;
              const deeper = search(value, [...trail, `${target.getText()} (${where(child)})`], depth + 1);
              if (deeper) {
                found = deeper;
                return;
              }
            }
            continue;
          }
          const body = bodyOf(declaration);
          if (body && !ts.isLiteralExpression(body)) {
            const deeper = search(body, [...trail, `${target.getText()} (${where(child)})`], depth + 1);
            if (deeper) {
              found = deeper;
              return;
            }
          }
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  return search(start, [], 0);
};

// 4. Supply sites: object literal members outside engine/ whose contextual target is a callback declaration.
const reached = new Map(); // callback -> first evidence
const callbackNames = new Set([...callbacks.values()].map((key) => key.split('.').at(-1)));
for (const sf of program.getSourceFiles()) {
  if (!sf.fileName.startsWith(src) || rel(sf.fileName).startsWith('src/engine/')) continue;
  const visit = (node) => {
    // Asking the checker only about literals that name a callback keeps this pass cheap.
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some((p) => p.name && callbackNames.has(p.name.getText()))
    ) {
      const contextual = checker.getContextualType(node);
      if (contextual)
        for (const property of node.properties) {
          if (!property.name || ts.isSpreadAssignment(property)) continue;
          const target = checker.getNonNullableType(contextual).getProperty(property.name.getText());
          const callback = target?.declarations?.map((d) => callbacks.get(d)).find(Boolean);
          if (!callback || reached.has(callback)) continue;
          const value = ts.isPropertyAssignment(property)
            ? property.initializer
            : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : property;
          const evidence = reaches(value);
          if (evidence) reached.set(callback, `${where(property)}: ${evidence.join(' -> ')}`);
        }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

for (const [callback, evidence] of reached)
  if (!listed.has(callback)) report(`${callback} writes the log from an engine callback: ${evidence}`);
const stale = [...listed].filter((callback) => !reached.has(callback));
if (stale.length)
  console.log(
    `rule-baseline.json lists ${stale.length} engine callbacks that no longer reach a writer; remove:\n  ${stale.join(
      '\n  ',
    )}`,
  );
reportAndExit(
  failures,
  `engine callback check passed (${callbacks.size} callbacks, ${listed.size} recorded writers: ${[...listed].join(
    ', ',
  )})`,
);
