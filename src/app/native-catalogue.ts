/** The session-owned catalogue, bound to the app's transcript projection (which needs the protocol layer). */
import {
  nativeCataloguePath,
  nativeSearchScope,
  replayNativeLineage,
  withNativeCatalogue as withCatalogue,
  type NativeCatalogueEntry,
  type NativeCatalogueScope,
  type NativeIndexer,
} from '../session/native-catalogue.js';
import { contentText, publicContent } from '../protocol/public.js';

export { nativeCataloguePath, nativeSearchScope, replayNativeLineage };
export { directWriterLockHeld } from '../session/writer-lock.js';
export type { NativeCatalogueEntry, NativeCatalogueScope, NativeIndexer };

/** The user's message count holds only non-blank messages. */
export const nativeIndexer: NativeIndexer = {
  userMessages: (state) =>
    state.messages.filter(
      (message) => message.role === 'user' && contentText(publicContent(message.content as never)).trim().length > 0,
    ).length,
};

export function withNativeCatalogue<T>(
  directory: string,
  operation: Parameters<typeof withCatalogue<T>>[2],
  options?: Parameters<typeof withCatalogue<T>>[3],
): T {
  return withCatalogue(directory, nativeIndexer, operation, options);
}
