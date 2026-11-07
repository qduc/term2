// Replace dist's entry module with a single-file esbuild bundle of everything it imports.
//
// Startup is mostly Node's ESM loader resolving and compiling some thousand separate modules:
// 1.6 s to an idle composer unbundled, about 1.05 s bundled (with a compile cache). The bundle is
// CommonJS (cli.bundle.cjs, beside the entry) so that scripts/bundle-loader.mjs, copied to the
// entry's own path, can run it through vm.Script and cache the code compiled during startup. So
// dist/cli.js, restart (argv[1]) and every test that launches dist/src/app/cli.js run it unchanged.
// The other emitted modules stay beside it: worker threads, prompts and other assets are still
// loaded from their own files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const loader = fileURLToPath(new URL('./bundle-loader.mjs', import.meta.url));

export async function bundleEntry(dist) {
  const entry = path.join(dist, 'src/app/cli.js');
  const entryDir = path.dirname(entry);
  const bundle = path.join(entryDir, 'cli.bundle.cjs');
  const tmp = path.join(dist, '.cli.bundle.mjs');
  // Our modules locate assets, workers and dynamic imports from import.meta. Rewrite each use to
  // the module's own emitted path (which still exists), so it resolves exactly as unbundled.
  const ownLocations = {
    name: 'own-import-meta',
    setup(b) {
      b.onLoad({ filter: /\.js$/ }, async (args) => {
        if (!args.path.startsWith(dist + path.sep) || args.path.includes(`${path.sep}node_modules${path.sep}`)) return;
        const code = await fs.promises.readFile(args.path, 'utf8');
        if (!code.includes('import.meta.')) return { contents: code, loader: 'js' };
        const rel = JSON.stringify(path.relative(entryDir, args.path).split(path.sep).join('/'));
        return {
          loader: 'js',
          contents: code
            .replace(/\bimport\.meta\.url\b/g, `__term2ModuleUrl(${rel})`)
            .replace(/\bimport\.meta\.filename\b/g, `__term2ModuleFile(${rel})`)
            .replace(/\bimport\.meta\.dirname\b/g, `__term2ModuleDir(${rel})`),
        };
      });
    },
  };
  // react, react-reconciler and scheduler choose their development or production build from
  // NODE_ENV when first required. env-setup.ts defaults it to production, but the test suites launch
  // dist with NODE_ENV=test (settings and OAuth branch on it), so they rendered with the development
  // reconciler (~36 ms more per launch) and checked a React build users do not run. Each selector is
  // pinned to its production branch; esbuild then leaves the development files out of the bundle.
  const reactProductionBuild = {
    name: 'react-production-build',
    setup(b) {
      const selector = "process.env.NODE_ENV === 'production'";
      b.onLoad(
        { filter: /[\\/]node_modules[\\/](react|react-reconciler|scheduler)[\\/][^\\/]+\.js$/ },
        async (args) => {
          const code = await fs.promises.readFile(args.path, 'utf8');
          if (!code.includes(selector)) return undefined;
          return { contents: code.replaceAll(selector, 'true'), loader: 'js' };
        },
      );
    },
  };
  const devtoolsStub = path.join(dist, '.devtools-stub.js');
  // Ink imports react-devtools-core only when DEV=true and the package is installed; it is not.
  fs.writeFileSync(devtoolsStub, 'export default { initialize() {}, connectToDevTools() {} };\n');
  await build({
    entryPoints: [entry],
    outfile: tmp,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
    legalComments: 'none',
    // Native addons and packages that load their own files beside them (binaries, workers,
    // prebuilt bindings) stay ordinary node_modules imports.
    // @qduc/web-fetch is reached only through web_fetch's dynamic import(), yet bundled it put about
    // 5 MB (jsdom, parse5, domino, ...) in front of every start: each launch read, decoded and
    // compiled it before any code ran. Loaded from node_modules, it costs only the first fetch. It
    // must stay external regardless: jsdom resolves xhr-sync-worker.js beside itself, and bundled,
    // every web_fetch call failed with "Cannot find module './xhr-sync-worker.js'".
    external: [
      '*.node',
      'better-sqlite3',
      'ssh2',
      'cpu-features',
      'koffi',
      'jiti',
      '@anthropic-ai/sandbox-runtime',
      '@qduc/web-fetch',
    ],
    alias: { 'react-devtools-core': devtoolsStub },
    plugins: [reactProductionBuild, ownLocations],
    // CommonJS dependencies expect __filename and __dirname. `define` maps only their free uses, so a
    // module's own `const __dirname = ...` keeps its own binding.
    define: { __filename: '__term2BundleFile', __dirname: '__term2BundleDir' },
  });
  fs.rmSync(devtoolsStub);
  // Then to CommonJS. Bundling straight to CommonJS fails on Ink's and yoga's top-level awaits; the
  // ES module bundle has already turned those into async module initializers, so only an await at
  // the entry's own top level can fail this step, and it fails the build.
  let code = fs.readFileSync(tmp, 'utf8');
  // A script inside the loader's function wrapper cannot start with a hashbang.
  if (code.startsWith('#!')) code = code.slice(code.indexOf('\n') + 1);
  // esbuild heads each inlined module with a `// dist/<path>` comment, which tests use to patch one
  // module (tests/helpers/patch-compiled-module.ts). A transform drops comments but keeps legal
  // ones (`//!`) in place, so the markers cross as legal comments and are restored afterwards.
  code = code.replace(/^\/\/ dist\//gm, '//! dist/');
  const cjs = await transform(code, {
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
    legalComments: 'inline',
    // Dependencies' import.meta (yoga's script URL, Ink's package.json lookup, a DEV-only resolve)
    // gets the bundle's location, as it had in the ES module bundle.
    define: { 'import.meta.url': '__term2BundleUrl', 'import.meta.resolve': '__term2Resolve' },
    // The first line stays empty: the loader's function wrapper goes there, so every other line and
    // column of a stack trace matches the file. The modules were ES modules, so strict mode.
    banner: [
      '',
      "'use strict';",
      "const { fileURLToPath: __term2FileUrlToPath, pathToFileURL: __term2PathToFileUrl } = require('node:url');",
      "const { dirname: __term2Dirname } = require('node:path');",
      'const __term2BundleFile = __filename;',
      'const __term2BundleDir = __dirname;',
      'const __term2BundleUrl = __term2PathToFileUrl(__filename).href;',
      'const __term2Resolve = (specifier) => __term2PathToFileUrl(require.resolve(specifier)).href;',
      'const __term2ModuleUrl = (rel) => new URL(rel, __term2BundleUrl).href;',
      'const __term2ModuleFile = (rel) => __term2FileUrlToPath(__term2ModuleUrl(rel));',
      'const __term2ModuleDir = (rel) => __term2Dirname(__term2ModuleFile(rel));',
    ].join('\n'),
  });
  fs.writeFileSync(bundle, cjs.code.replace(/^\/\/! dist\//gm, '// dist/'));
  fs.rmSync(tmp);
  fs.rmSync(`${entry}.map`, { force: true }); // described the unbundled module
  fs.copyFileSync(loader, entry);
  fs.chmodSync(entry, 0o755);
}
