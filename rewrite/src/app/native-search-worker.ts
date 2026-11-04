/**
 * Runs one catalogue search off the UI thread. Refreshing the index for a grown or never-indexed session can take
 * seconds, and better-sqlite3 is synchronous; legacy kept its own index worker for the same reason.
 */
import { parentPort } from 'node:worker_threads';
import type { NativeCatalogueScope } from './native-catalogue.js';
import { withNativeCatalogue } from './native-catalogue.js';

export type NativeSearchRequest = {
  readonly id: number;
  readonly directory: string;
  readonly scope: NativeCatalogueScope;
  readonly query: string;
  readonly kind?: string;
  readonly limit?: number;
};
export type NativeSearchReply =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: string };

parentPort?.on('message', (request: NativeSearchRequest) => {
  let reply: NativeSearchReply;
  try {
    const result = withNativeCatalogue(request.directory, (catalogue) =>
      catalogue.search(request.scope, request.query, request.kind, request.limit),
    );
    reply = { id: request.id, result };
  } catch (error) {
    reply = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  parentPort!.postMessage(reply);
});
