// Replace dist's entry module with a single-file esbuild bundle of everything it imports.
//
// Startup is mostly Node's ESM loader resolving and compiling some thousand separate modules:
// 1.6 s to an idle composer unbundled, about 1.05 s bundled (with a compile cache). The
// bundle takes the entry's own path, so dist/cli.js, restart (argv[1]) and every test that
// launches dist/src/app/cli.js run it unchanged. The other emitted modules stay
// beside it: worker threads, prompts and other assets are still loaded from their own files.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

export async function bundleEntry(dist) {
  const entry = path.join(dist, 'src/app/cli.js');
  const entryDir = path.dirname(entry);
  const tmp = path.join(dist, '.cli.bundle.js');
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
    external: ['*.node', 'better-sqlite3', 'ssh2', 'cpu-features', 'koffi', 'jiti', '@anthropic-ai/sandbox-runtime'],
    alias: { 'react-devtools-core': devtoolsStub },
    plugins: [ownLocations],
    // CommonJS dependencies expect require, __filename and __dirname. `define` maps only their free
    // uses, so a module's own `const __dirname = ...` keeps its own binding.
    define: { __filename: '__term2BundleFile', __dirname: '__term2BundleDir' },
    banner: {
      js: [
        "import { createRequire as __term2CreateRequire } from 'node:module';",
        "import { fileURLToPath as __term2FileUrlToPath } from 'node:url';",
        "import { dirname as __term2Dirname } from 'node:path';",
        'const require = __term2CreateRequire(import.meta.url);',
        'const __term2BundleFile = __term2FileUrlToPath(import.meta.url);',
        'const __term2BundleDir = __term2Dirname(__term2BundleFile);',
        'const __term2ModuleUrl = (rel) => new URL(rel, import.meta.url).href;',
        'const __term2ModuleFile = (rel) => __term2FileUrlToPath(__term2ModuleUrl(rel));',
        'const __term2ModuleDir = (rel) => __term2Dirname(__term2ModuleFile(rel));',
      ].join('\n'),
    },
  });
  fs.rmSync(devtoolsStub);
  fs.renameSync(tmp, entry);
  fs.rmSync(`${entry}.map`, { force: true }); // described the unbundled module
}
