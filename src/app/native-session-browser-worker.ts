/**
 * Runs the session browser off the UI thread: a cold store replays every native log in scope, and legacy
 * kept its own browse worker for the same reason. Each scope keeps one browser, so read cursors persist.
 */
import { parentPort } from 'node:worker_threads';
import type { NativeCatalogueScope } from './native-catalogue.js';
import { nativeSessionBrowserStore } from './native-session-browser-store.js';
import { SessionBrowser, type SessionBrowserContext } from './source-tools.js';

export type NativeBrowserRequest = {
  readonly id: number;
  readonly directory: string;
  readonly scope: NativeCatalogueScope;
  readonly context: SessionBrowserContext;
  readonly operation: 'list' | 'search' | 'read';
  readonly input: unknown;
};
export type NativeBrowserReply =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: string };

const browsers = new Map<string, { browser: SessionBrowser; context: { current: SessionBrowserContext } }>();

function browserFor(request: NativeBrowserRequest): SessionBrowser {
  const key = JSON.stringify([request.directory, request.scope]);
  let held = browsers.get(key);
  if (!held) {
    const store = nativeSessionBrowserStore(request.directory, request.scope);
    const context = { current: request.context };
    held = { browser: new SessionBrowser(() => context.current, { backend: 'canonical', store }), context };
    browsers.set(key, held);
  }
  held.context.current = request.context;
  return held.browser;
}

parentPort?.on('message', async (request: NativeBrowserRequest) => {
  let reply: NativeBrowserReply;
  try {
    const browser = browserFor(request);
    const input = request.input as never;
    const result =
      request.operation === 'list'
        ? await browser.list(input)
        : request.operation === 'search'
        ? await browser.search(input)
        : await browser.read(input);
    reply = { id: request.id, result };
  } catch (error) {
    reply = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  parentPort!.postMessage(reply);
});
