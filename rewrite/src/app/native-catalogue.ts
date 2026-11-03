/** The session-owned catalogue, bound to the app's transcript projection (which needs the protocol layer). */
import {
  nativeCataloguePath,
  nativeSearchScope,
  withNativeCatalogue as withCatalogue,
  type NativeCatalogueEntry,
  type NativeCatalogueScope,
  type NativeIndexer,
} from '../session/native-catalogue.js';
import { contentText, publicContent } from '../protocol/direct-public.js';
import { nativeTranscript } from './native-transcript.js';

export { nativeCataloguePath, nativeSearchScope };
export type { NativeCatalogueEntry, NativeCatalogueScope, NativeIndexer };

/** Search documents hold only non-blank text, so the user's message count does too. */
export const nativeIndexer: NativeIndexer = {
  transcript: nativeTranscript,
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
