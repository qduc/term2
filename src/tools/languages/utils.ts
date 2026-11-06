import path from 'path';
import * as fs from 'fs/promises';

export const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
export const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];
export const CODE_EXTENSIONS = [...TS_EXTENSIONS, ...JS_EXTENSIONS, '.json'];

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

export async function fileExists(absolutePath: string): Promise<boolean> {
  return fs
    .stat(absolutePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

export function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

export function normalizeImportNames(rawNames: string): string[] {
  return rawNames
    .replace(/[{}]/g, '')
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .map((part) => (part.startsWith('type ') ? part.slice(5).trim() : part))
    .filter(Boolean);
}

export async function resolveLocalImport(specifier: string, fromPath: string, root: string): Promise<string | null> {
  if (!isLocalSpecifier(specifier)) return null;

  const fromDir = path.dirname(path.join(root, fromPath));
  const base = path.resolve(fromDir, specifier);
  // A `.js`/`.mjs`/`.jsx` specifier resolves to its `.ts`/`.mts`/`.tsx`
  // source under the TS ESM convention, so also try the extension-stripped form.
  const baseExtension = path.extname(base);
  const strippedBase = CODE_EXTENSIONS.includes(baseExtension) ? base.slice(0, -baseExtension.length) : base;
  const candidates = [
    base,
    ...CODE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...(strippedBase !== base ? CODE_EXTENSIONS.map((extension) => `${strippedBase}${extension}`) : []),
    ...CODE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];

  for (const candidate of candidates) {
    const resolved = normalizeRelativePath(path.relative(root, candidate));
    if (!resolved.startsWith('..') && (await fileExists(candidate))) {
      return resolved;
    }
  }

  return null;
}

export function buildTestPatterns(filePath: string): { forSource: string[] } {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext).replace(/\.(test|spec)$/, '');
  const extensions = ['.ts', '.tsx', '.js', '.jsx'];
  const forSource = extensions.flatMap((extension) => [
    normalizeRelativePath(path.join(dir, `${base}.test${extension}`)),
    normalizeRelativePath(path.join(dir, `${base}.spec${extension}`)),
    normalizeRelativePath(path.join(dir, '__tests__', `${base}.test${extension}`)),
    normalizeRelativePath(path.join('tests', `${base}.test${extension}`)),
  ]);
  return { forSource };
}
