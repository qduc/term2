/** The session-owned catalogue, bound to the app's transcript projection (which needs the protocol layer). */
import {
  nativeCataloguePath,
  nativeSearchScope,
  withNativeCatalogue as withCatalogue,
  type NativeCatalogueEntry,
  type NativeCatalogueScope,
} from '../session/native-catalogue.js';
import { nativeTranscript } from './native-transcript.js';

export { nativeCataloguePath, nativeSearchScope };
export type { NativeCatalogueEntry, NativeCatalogueScope };

export function withNativeCatalogue<T>(
  directory: string,
  operation: Parameters<typeof withCatalogue<T>>[2],
  options?: Parameters<typeof withCatalogue<T>>[3],
): T {
  return withCatalogue(directory, nativeTranscript, operation, options);
}
