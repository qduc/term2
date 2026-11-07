#!/usr/bin/env node
// dist/src/app/cli.js: runs the entry bundle beside it (cli.bundle.cjs) with a V8 code cache that
// includes the functions compiled while term2 started. scripts/bundle-entry.mjs copies this file.
//
// Node's compile cache serializes a module right after compiling it, when V8 has compiled only its
// top level. Everything compiled lazily afterwards (module initializers, Ink, React, the first frame)
// was compiled again on every start, about 125 ms of a 530 ms start. vm.Script can serialize the
// same script later, once startup is done; a cache written then is about 4.7 MB instead of 1.5 MB.
//
// The cache lives in the directory Node's own compile cache uses (dist/cli.js enables it, as do
// NODE_COMPILE_CACHE and the test suites), so it follows the same opt-outs and per-user location.
// That directory is already specific to the Node version, architecture and V8 flags; the file name
// identifies the bundle by content. Without that directory, or on a Node without the vm loader
// constant or zlib.crc32, the bundle is required as an ordinary CommonJS module.
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

const bundleFile = fileURLToPath(new URL('./cli.bundle.cjs', import.meta.url));
const requireFromBundle = module.createRequire(bundleFile);
const compileCacheDir = module.getCompileCacheDir?.();
const mainContextLoader = vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER;

if (!compileCacheDir || !mainContextLoader || typeof zlib.crc32 !== 'function') requireFromBundle(bundleFile);
else runWithCodeCache(compileCacheDir, mainContextLoader);

function runWithCodeCache(compileCacheDir, mainContextLoader) {
  // Long enough after start for the TUI to be idle, so the cache covers its first frame.
  const SETTLED_AFTER_MS = 2000;
  // Each bundle's caches stay until this many newer files exist (a few MB each).
  const KEEP_FILES = 8;
  // V8 checks a cache's version and flags but only the length of its source, and only the header of
  // its data. Bytecode for other source of the same length runs as if it were this bundle's, and a
  // cache damaged past its header crashes V8 on every start. So the file name carries a checksum of
  // the bundle, and each file starts with a checksum of its data, checked before V8 sees it (about
  // 6 ms for both). Node's own compile cache checks the same two things.
  const bytes = fs.readFileSync(bundleFile);
  const source = bytes.toString('utf8');
  const dir = path.join(compileCacheDir, 'term2-bundle');
  const stem = path.join(dir, `${bytes.length.toString(36)}-${zlib.crc32(bytes).toString(36)}`);
  // `settled` was written after startup; `exit` by a process that ended sooner (--help, a headless
  // run), which still beats no cache. A settled cache is not rewritten.
  let tier;
  let cachedData;
  for (const candidate of ['settled', 'exit']) {
    let file;
    try {
      file = fs.readFileSync(`${stem}.${candidate}`);
    } catch {
      continue;
    }
    const data = file.subarray(4);
    if (file.length > 4 && file.readUInt32BE(0) === zlib.crc32(data)) {
      cachedData = data;
      tier = candidate;
      break;
    }
    fs.rmSync(`${stem}.${candidate}`, { force: true });
  }
  const options = { filename: bundleFile, importModuleDynamically: mainContextLoader };
  // Line 1 of the bundle is empty, so the wrapper keeps every line and column of stack traces.
  const script = new vm.Script(`(function (exports, require, module, __filename, __dirname) {${source}\n})`, {
    ...options,
    cachedData,
  });
  const accepted = cachedData !== undefined && !script.cachedDataRejected;
  if (cachedData !== undefined && !accepted) fs.rmSync(`${stem}.${tier}`, { force: true });

  let saved = false;
  const save = (name) => {
    if (saved) return;
    saved = true;
    try {
      const data = script.createCachedData();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${stem}.${process.pid}.tmp`;
      const header = Buffer.alloc(4);
      header.writeUInt32BE(zlib.crc32(data));
      fs.writeFileSync(tmp, Buffer.concat([header, data]), { mode: 0o600 });
      fs.renameSync(tmp, `${stem}.${name}`);
      const files = fs
        .readdirSync(dir)
        .map((file) => path.join(dir, file))
        .map((file) => ({ file, mtimeMs: fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const { file } of files.slice(KEEP_FILES)) fs.rmSync(file, { force: true });
    } catch {
      // A cache that cannot be written only costs the next start its compile time.
    }
  };
  if (!accepted || tier !== 'settled') setTimeout(() => save('settled'), SETTLED_AFTER_MS).unref();
  if (!accepted) process.once('exit', () => save('exit'));

  // The first dynamic import through the main context's loader emits a one-time ExperimentalWarning,
  // which would print into the terminal. Take that first import here, and drop only that warning.
  const emitWarning = process.emitWarning;
  const held = [];
  process.emitWarning = (...args) => void held.push(args);
  try {
    new vm.Script("import('node:path')", options).runInThisContext().catch(() => {});
  } finally {
    process.emitWarning = emitWarning;
  }
  for (const args of held)
    if (!String(args[0]?.message ?? args[0]).includes('USE_MAIN_CONTEXT_DEFAULT_LOADER')) process.emitWarning(...args);

  const bundleModule = { exports: {} };
  script
    .runInThisContext()
    .call(
      bundleModule.exports,
      bundleModule.exports,
      requireFromBundle,
      bundleModule,
      bundleFile,
      path.dirname(bundleFile),
    );
}
