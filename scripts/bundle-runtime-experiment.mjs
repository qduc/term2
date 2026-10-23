import { build, transform } from 'esbuild';
import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

// Experimental multi-entry production build. Preserve six known runtime entry
// paths, declarations, resources and external package boundaries; prune other JS.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const emittedDir = resolve(process.argv[2] ?? 'dist');
const bundleDir = join(emittedDir, 'cli-bundle');
const inputDir = emittedDir;
const allFiles = (await readdir(inputDir, { recursive: true }))
  .filter((f) => f.endsWith('.js') && !f.startsWith('node_modules/'))
  .sort();
const files = [
  'cli.js',
  'services/conversation/session-index/session-index-worker.js',
  'services/conversation/session-index/session-index-worker-client.js',
  'services/sandboxed-code-host/sandboxed-code-host.js',
  'utils/worker-bootstrap.js',
  'services/hooks/index.js',
];
const entries = Object.fromEntries(files.map((file, i) => ['entry-' + i, join(inputDir, file)]));
const isInside = (root, file) => {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const relativeUrl = (file) => './' + relative(bundleDir, file).split(sep).map(encodeURIComponent).join('/');

await rm(bundleDir, { recursive: true, force: true });
const result = await build({
  metafile: true,
  entryPoints: entries,
  outdir: bundleDir,
  entryNames: '[name]',
  chunkNames: 'chunk-[hash]',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  keepNames: true,
  sourcemap: true,
  sourcesContent: false,
  // Native addons, runtime code loaders and independently loaded React must
  // keep their package identity. Optional Ink devtools remains a lazy import.
  external: [
    'vitest',
    'vitest/*',
    'ink-testing-library',
    'better-sqlite3',
    'ssh2',
    'react',
    'react-devtools-core',
    'jiti',
    '@anthropic-ai/sandbox-runtime',
    '@qduc/agent-wire',
  ],
  banner: {
    js: "import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'preserve-module-locations',
      setup(builder) {
        builder.onLoad({ filter: /\.js$/ }, async ({ path }) => {
          let original = isInside(inputDir, path) ? join(emittedDir, relative(inputDir, path)) : path;
          if (!isInside(inputDir, path)) {
            // Ink uses its own package.json for developer-tools renderer metadata.
            // Use the package's public installation location, never a pnpm-store path.
            const inkSuffix = `${sep}node_modules${sep}ink${sep}build${sep}reconciler.js`;
            if (!path.endsWith(inkSuffix)) return;
            original = join(projectRoot, 'node_modules', 'ink', 'build', 'reconciler.js');
          }
          const source = await readFile(path, 'utf8');
          if (!source.includes('import.meta.')) return;
          const locationPrelude = [
            "import { fileURLToPath as __term2FileURLToPath } from 'node:url';",
            `const __term2OriginalUrl = new URL(${JSON.stringify(relativeUrl(original))}, import.meta.url).href;`,
            `const __term2OriginalDir = __term2FileURLToPath(new URL(${JSON.stringify(
              relativeUrl(dirname(original)) + '/',
            )}, import.meta.url));`,
            'const __term2OriginalFile = __term2FileURLToPath(__term2OriginalUrl);',
          ].join('\n');
          const { code } = await transform(source, {
            loader: 'js',
            format: 'esm',
            target: 'node20',
            keepNames: true,
            banner: locationPrelude,
            sourcefile: path,
            sourcemap: 'inline',
            sourcesContent: false,
            // Let the parser replace expressions, never text in strings/comments.
            define: {
              'import.meta.url': '__term2OriginalUrl',
              'import.meta.dirname': '__term2OriginalDir',
              'import.meta.filename': '__term2OriginalFile',
            },
          });
          return {
            loader: 'js',
            // Keep the source-map line offsets when removing the nested hashbang.
            contents: code.replace(/^#!.*\n/, '\n'),
          };
        });
      },
    },
  ],
});

console.log(JSON.stringify({ bundleEntries: files, outputFiles: Object.keys(result.metafile.outputs).length }));
for (const file of allFiles) {
  if (file === 'env-setup.js') continue;
  await rm(join(emittedDir, file), { force: true });
  await rm(join(emittedDir, file + '.map'), { force: true });
}
for (const [i, file] of files.entries()) {
  if (file === 'env-setup.js') continue;
  const output = join(bundleDir, 'entry-' + i + '.js');
  const url =
    './' +
    relative(dirname(join(emittedDir, file)), output)
      .split(sep)
      .join('/');
  const metadata = result.metafile.outputs[relative(process.cwd(), output)];
  const hasDefault = metadata.exports.includes('default');
  await writeFile(
    join(emittedDir, file),
    'export * from ' +
      JSON.stringify(url) +
      ';\n' +
      (hasDefault ? 'export { default } from ' + JSON.stringify(url) + ';\n' : ''),
  );
}
await writeFile(
  join(emittedDir, 'cli.js'),
  "#!/usr/bin/env node\nimport './env-setup.js';\nawait import('./cli-bundle/entry-" +
    files.indexOf('cli.js') +
    ".js');\n",
);
await chmod(join(emittedDir, 'cli.js'), 0o755);
