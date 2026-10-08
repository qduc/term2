#!/usr/bin/env node
// Static scan for test files that can leak process-level state into other files that share
// a worker (vitest.shared.config.ts / vitest.hybrid.config.ts), or that read the live
// repository tree other tests write into. It reads source only; nothing runs.
//
//   node scripts/test-impact/leak-scan.mjs [--json] [--rule R1,R7] [file ...]
//
// It is a heuristic filter, not a proof: a finding means "read this", and no finding does
// not mean safe. Rules and why each matters:
//   env-swap      `process.env = x` replaces Node's environment object; later assignments no
//                 longer reach the real environment (a new worker thread reads that one).
//   chdir         `process.chdir()` changes the working directory for every later file.
//   repo-write    writes under process.cwd() / the file's own directory: the files appear in
//                 the repository other tests list or scan (agent.test lists the root,
//                 application-stream-boundary scans source/).
//   tree-scan     walks the live repository (readdir on cwd / the source dir): a victim of
//                 repo-write in any other file.
//   fixed-tmp     writes to a fixed /tmp path: two files, or two workers, collide.
//   patch         assigns a member of a shared object (process, a node builtin, globalThis,
//                 console) with no visible restore.
//   global-write  adds a property to globalThis / global.
//   listener      process.on/once(...) with no matching off/removeListener.
//   handle        setInterval / Worker / spawn / fork / listen / fs.watch with no visible
//                 clear/terminate/kill/close.
//   fake-timers   vi.useFakeTimers() with no vi.useRealTimers().
// Suppress a reviewed finding with `// leak-scan-allow <rule>: <why>` on that line or the line
// above, or for a whole file with `// leak-scan-allow-file <rule>: <why>` in its first 40 lines.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const BUILTINS = new Set(['fs', 'os', 'path', 'child_process', 'http', 'https', 'net', 'crypto', 'url', 'util', 'timers', 'dns', 'tty', 'worker_threads', 'process', 'module']);
const SHARED_ROOTS = new Set(['process', 'globalThis', 'global', 'console', 'Math', 'Date', 'JSON', 'Object', 'Array', 'Promise', 'Buffer']);
const WRITE_FNS = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync', 'symlink', 'symlinkSync', 'createWriteStream']);

export function files() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(test|spec)\.(ts|tsx)$/.test(e.name) && !/\.(e2e|integration)\./.test(e.name)) out.push(path.relative(root, p));
    }
  };
  for (const d of ['source', 'scripts', 'docs']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  return out.filter((f) => !f.startsWith('scripts/provider-black-box/')).sort();
}

const text = (n, sf) => n.getText(sf);
const rootIdent = (n) => { while (n && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) n = n.expression; return n && ts.isIdentifier(n) ? n.text : null; };

export function scanFile(rel) {
  const abs = path.resolve(root, rel);
  const src = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.ES2022, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings = [];
  const add = (rule, node, detail) => findings.push({ rule, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, detail: detail.slice(0, 90) });

  // identifiers bound to repo-relative locations (cwd / own dir), one level of const propagation
  const repoish = new Set();
  const isRepoExpr = (n) => {
    if (!n) return false;
    const t = text(n, sf);
    if (/process\.cwd\(\)|import\.meta\.dirname|__dirname|import\.meta\.url|fileURLToPath/.test(t)) return true;
    if (ts.isIdentifier(n) && repoish.has(n.text)) return true;
    let hit = false;
    ts.forEachChild(n, (c) => { if (isRepoExpr(c)) hit = true; });
    return hit;
  };
  const tmpish = (n) => /os\.tmpdir|tmpdir\(\)|mkdtemp|TMPDIR/.test(text(n, sf));
  const declare = (node) => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isRepoExpr(node.initializer) && !tmpish(node.initializer)) repoish.add(node.name.text); };
  const pre = (n) => { declare(n); ts.forEachChild(n, pre); };
  pre(sf); pre(sf); // twice so a const defined from another const resolves

  const has = (re) => re.test(src);
  const hasRestoreHook = has(/\b(afterEach|afterAll|onTestFinished)\b/) || has(/\bfinally\b/);
  const sets = { intervals: 0, clearIntervals: has(/clearInterval/), listeners: 0, removes: has(/\.(off|removeListener|removeAllListeners)\(/) };

  const visit = (n) => {
    // process.env = x
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = text(n.left, sf);
      if (/^process\.env$/.test(l)) add('env-swap', n, text(n, sf));
      else if (/^(globalThis|global)\.[A-Za-z_$]/.test(l) || /^(globalThis|global)\[/.test(l)) {
        // React's act flag is idempotent and every test file sets the same value.
        if (/IS_REACT_ACT_ENVIRONMENT/.test(l)) { /* benign */ }
        else if (/^(globalThis|global)\.fetch$/.test(l)) {
          // restored if the original is captured and assigned back somewhere in the file
          const captured = /(?:const|let)\s+(\w+)\s*=\s*(?:globalThis|global)\.fetch\b/.exec(src);
          const restored = captured && new RegExp(`(?:globalThis|global)\\.fetch\\s*=\\s*${captured[1]}\\b`).test(src);
          if (!restored) add('patch', n, `${l} replaced, original not restored`);
        } else add('global-write', n, l);
      }
      else {
        const r = rootIdent(n.left);
        if (r && (SHARED_ROOTS.has(r) || BUILTINS.has(r)) && !/^process\.env\b/.test(l) && ts.isPropertyAccessExpression(n.left)) {
          const member = n.left.name.text;
          const restored = new RegExp(`(const|let)\\s+\\w+\\s*=\\s*${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(src) || has(new RegExp(`${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(orig|original|saved|prev|old)`));
          if (!restored && member !== 'exitCode') add('patch', n, l);
        }
      }
    }
    if (ts.isCallExpression(n)) {
      const callee = text(n.expression, sf);
      const name = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isIdentifier(n.expression) ? n.expression.text : '';
      if (callee === 'process.chdir') add('chdir', n, text(n, sf));
      if (/^process\.(on|once|addListener)$/.test(callee)) { sets.listeners++; if (!sets.removes) add('listener', n, text(n, sf)); }
      if (name === 'setInterval' && !sets.clearIntervals) add('handle', n, 'setInterval without clearInterval');
      if (/^(new )?Worker$/.test(name)) { /* handled in NewExpression */ }
      const onRegex = ts.isPropertyAccessExpression(n.expression) && (ts.isRegularExpressionLiteral(n.expression.expression) || /^(re|regex|pattern)$/i.test(text(n.expression.expression, sf)));
      if (/^(spawn|fork|execFile|exec)$/.test(name) && !onRegex && !has(/\.kill\(|\.terminate\(|await .*(exit|close)|\.once\('exit'/)) add('handle', n, `${callee}(…) without kill/exit handling`);
      if (name === 'listen' && !has(/\.close\(/)) add('handle', n, 'listen() without close()');
      if (/^fs\.watch$|^watch$/.test(callee) && !has(/\.close\(\)/)) add('handle', n, 'fs.watch without close');
      if (callee === 'vi.useFakeTimers' && !has(/vi\.useRealTimers\(/)) add('fake-timers', n, 'useFakeTimers without useRealTimers');
      if (callee === 'vi.stubGlobal' && !has(/unstubAllGlobals|unstubGlobals/)) add('global-write', n, 'stubGlobal without unstub');
      if (callee === 'Object.defineProperty' && n.arguments[0] && SHARED_ROOTS.has(text(n.arguments[0], sf).split('.')[0]) || (callee === 'Object.defineProperty' && n.arguments[0] && BUILTINS.has(text(n.arguments[0], sf)))) {
        if (!has(/descriptor|getOwnPropertyDescriptor|original/)) add('patch', n, text(n, sf));
      }
      // repo-write: writes whose first argument is repo-relative
      const fnName = name;
      if (WRITE_FNS.has(fnName) && n.arguments[0]) {
        const a = n.arguments[0];
        const t = text(a, sf);
        const literalRel = ts.isStringLiteral(a) && !path.isAbsolute(a.text) && !a.text.startsWith('/tmp');
        if ((isRepoExpr(a) && !tmpish(a)) || literalRel) add('repo-write', n, `${fnName}(${t})`);
        else if (ts.isStringLiteral(a) && /^\/tmp\//.test(a.text) && !/\$\{/.test(a.text) && !/^mkdtemp/.test(fnName)) add('fixed-tmp', n, `${fnName}(${t})`);
        if (ts.isTemplateExpression(a) === false && ts.isStringLiteral(a) && /^\/tmp\//.test(a.text) === false && false) { /* reserved */ }
      }
      // mkdtemp under cwd
      if ((fnName === 'mkdtempSync' || fnName === 'mkdtemp') && n.arguments[0] && isRepoExpr(n.arguments[0]) && !tmpish(n.arguments[0])) add('repo-write', n, text(n, sf));
      // tree-scan: readdir of a repo-ish dir, recursive or walker
      if ((fnName === 'readdir' || fnName === 'readdirSync') && n.arguments[0] && isRepoExpr(n.arguments[0]) && !tmpish(n.arguments[0])) add('tree-scan', n, `${fnName}(${text(n.arguments[0], sf)})`);
    }
    if (ts.isNewExpression(n) && /^Worker$/.test(text(n.expression, sf)) && !has(/\.terminate\(|worker\.on\('exit'|await .*close/)) add('handle', n, 'new Worker without terminate');
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const lines = src.split('\n');
  const fileAllowed = (rule) => lines.slice(0, 40).some((l) => new RegExp(`leak-scan-allow-file[^\\n]*\\b${rule}\\b`).test(l));
  const allowed = (f) =>
    fileAllowed(f.rule) || [lines[f.line - 1], lines[f.line - 2]].some((l) => l && new RegExp(`leak-scan-allow\\b(?!-file)[^\\n]*\\b${f.rule}\\b`).test(l));

  // fixed /tmp literal assigned to a const used for writes anywhere
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(['"`])(\/tmp\/[^'"`$]+)\2/g)) {
    if (new RegExp(`(mkdirSync|mkdir|writeFile|writeFileSync|rmSync)\\([^)]*\\b${m[1]}\\b`).test(src)) {
      const line = src.slice(0, m.index).split('\n').length;
      findings.push({ rule: 'fixed-tmp', line, detail: `${m[1]} = ${m[3]}` });
    }
  }
  return findings.filter((f) => !allowed(f));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const ruleArg = args.find((a) => a === '--rule') ? args[args.indexOf('--rule') + 1] : null;
  const only = ruleArg ? new Set(ruleArg.split(',')) : null;
  const targets = args.filter((a) => !a.startsWith('--') && a !== ruleArg);
  const list = targets.length ? targets : files();
  const result = {};
  for (const f of list) {
    let fi = scanFile(f);
    if (only) fi = fi.filter((x) => only.has(x.rule));
    if (fi.length) result[f] = fi;
  }
  if (json) console.log(JSON.stringify(result));
  else {
    const byRule = {};
    for (const [f, fi] of Object.entries(result)) for (const x of fi) (byRule[x.rule] ??= new Set()).add(f);
    console.log(`scanned ${list.length} test files; ${Object.keys(result).length} have at least one finding`);
    for (const [r, s] of Object.entries(byRule).sort((a, b) => b[1].size - a[1].size)) console.log(`  ${r.padEnd(13)} ${String(s.size).padStart(4)} files`);
  }
}
