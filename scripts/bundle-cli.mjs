import { build, transform } from 'esbuild';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundle the shipped entry point, not a test substitute. Keep emitted modules
// beside it for worker entry points, hooks/types, assets, and public deep imports.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const emittedDir = resolve(process.argv[2] ?? 'dist');
const bundleDir = join(emittedDir, 'cli-bundle');
const isInside = (root, file) => {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const relativeUrl = (file) => './' + relative(bundleDir, file).split(sep).map(encodeURIComponent).join('/');

await rm(bundleDir, { recursive: true, force: true });
await build({
  entryPoints: [join(emittedDir, 'cli.js')],
  outdir: bundleDir,
  entryNames: 'cli',
  chunkNames: 'chunk-[hash]',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  keepNames: true,
  sourcemap: true,
  // Native addons, runtime code loaders and independently loaded React must
  // keep their package identity. Optional Ink devtools remains a lazy import.
  external: [
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
          let original = path;
          if (!isInside(emittedDir, path)) {
            // Ink uses its own package.json for developer-tools renderer metadata.
            // Use the package's public installation location, never a pnpm-store path.
            const inkSuffix = `${sep}node_modules${sep}ink${sep}build${sep}reconciler.js`;
            if (!path.endsWith(inkSuffix)) return;
            original = join(projectRoot, 'node_modules', 'ink', 'build', 'reconciler.js');
          }
          const source = await readFile(path, 'utf8');
          if (!source.includes('import.meta.')) return;
          const { code } = await transform(source, {
            loader: 'js',
            format: 'esm',
            target: 'node20',
            keepNames: true,
            // Let the parser replace expressions, never text in strings/comments.
            define: {
              'import.meta.url': '__term2OriginalUrl',
              'import.meta.dirname': '__term2OriginalDir',
              'import.meta.filename': '__term2OriginalFile',
            },
          });
          return {
            loader: 'js',
            contents: [
              "import { fileURLToPath as __term2FileURLToPath } from 'node:url';",
              `const __term2OriginalUrl = new URL(${JSON.stringify(relativeUrl(original))}, import.meta.url).href;`,
              `const __term2OriginalDir = __term2FileURLToPath(new URL(${JSON.stringify(
                relativeUrl(dirname(original)) + '/',
              )}, import.meta.url));`,
              'const __term2OriginalFile = __term2FileURLToPath(__term2OriginalUrl);',
              code.replace(/^#!.*\n/, ''),
            ].join('\n'),
          };
        });
      },
    },
  ],
});

// Environment setup must execute before evaluating dependencies, including
// external React. Eager bundle imports would otherwise change production mode.
const launcher = join(emittedDir, process.argv.includes('--replace-entry') ? 'cli.js' : 'cli-launcher.mjs');
await writeFile(launcher, "#!/usr/bin/env node\nimport './env-setup.js';\nawait import('./cli-bundle/cli.js');\n");
await chmod(launcher, 0o755);
