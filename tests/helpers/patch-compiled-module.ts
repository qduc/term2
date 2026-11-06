import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Patch one emitted module in a private copy of dist/, refusing stale or no-op fault stimuli.
 *
 * The entry (dist/src/app/cli.js) is a single-file bundle of every module it imports, and
 * esbuild heads each inlined module with a `// dist/<path>` comment. When `file` is inlined, the
 * same text is patched inside its section of the bundle, which is the code a (re)started CLI runs.
 */
async function compiledSection(file: string) {
  const normalized = file.split(path.sep).join('/');
  // The dist root is the first *dist/ folder followed by src/ (dist/, or a copy such as direct-dist/).
  const found = /dist\/src\//.exec(normalized);
  const at = found ? found.index + 'dist'.length : -1;
  const distRoot = at < 0 ? undefined : normalized.slice(0, at);
  const entry = distRoot === undefined ? undefined : `${distRoot}/src/app/cli.js`;
  // The entry itself is the bundle: patch it as one file.
  const marker = distRoot === undefined || normalized === entry ? '' : `// dist${normalized.slice(at)}\n`;
  const bundle = entry === undefined ? '' : await readFile(entry, 'utf8');
  const start = marker ? bundle.indexOf(marker) : -1;
  const target = start >= 0 ? entry! : file;
  const code = start >= 0 ? bundle : await readFile(file, 'utf8');
  // Search only the module's own section: from its marker to the next module's marker.
  const from = start >= 0 ? start + marker.length : 0;
  const next = start >= 0 ? code.indexOf('\n// dist/', from) : -1;
  const to = next < 0 ? code.length : next;
  return { target, code, from, to };
}

export async function patchCompiledModule(file: string, before: string, after: string): Promise<void> {
  const { target, code, from, to } = await compiledSection(file);
  const index = code.slice(from, to).indexOf(before);
  if (index < 0) throw new Error(`Missing fixture mutation anchor in ${file}: ${before}`);
  await writeFile(target, code.slice(0, from + index) + after + code.slice(from + index + before.length));
}

/**
 * The name a module-local identifier has in the code the CLI runs. Bundling renames locals that
 * collide across modules (`pending` may become `pending2`), so injected fault code must use this.
 */
export async function compiledIdentifier(file: string, name: string): Promise<string> {
  const { code, from, to } = await compiledSection(file);
  const found = new RegExp(`\\b${name}\\d*\\b`).exec(code.slice(from, to));
  if (!found) throw new Error(`Missing identifier ${name} in ${file}`);
  return found[0];
}
