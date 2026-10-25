// Probe-only dependency resolution: never redirect relative candidate source imports.
import { pathToFileURL } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error.code !== 'ERR_MODULE_NOT_FOUND' ||
      specifier.startsWith('.') ||
      specifier.startsWith('/') ||
      specifier.includes(':')
    )
      throw error;
    return nextResolve(specifier, { ...context, parentURL: pathToFileURL('/home/qduc/term2/package.json').href });
  }
}
