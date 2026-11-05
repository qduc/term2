/** App-owned read-only session browser for legacy's session_list/search/read script tools. */
import { Worker } from 'node:worker_threads';
import type { Workspace } from '../tools/index.js';
import type { DirectBinding } from '../session/facade-types.js';
import { nativeSearchScope } from './native-catalogue.js';
import { nativeBrowserId } from './native-session-browser-store.js';
import type { NativeBrowserReply, NativeBrowserRequest } from './native-session-browser-worker.js';
import type { SessionBrowser } from './source-tools.js';

let worker: Worker | undefined;
let nextId = 0;
let inFlight = 0;

/** One shared worker, started on first use and never keeping the process alive. */
function browserWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL('./native-session-browser-worker.js', import.meta.url));
  created.unref();
  created.once('exit', () => {
    if (worker === created) worker = undefined;
  });
  return (worker = created);
}

function browseOffThread(request: Omit<NativeBrowserRequest, 'id'>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const target = browserWorker();
    const id = ++nextId;
    // Only a call in flight keeps the process alive.
    target.ref();
    inFlight++;
    const finish = () => {
      if (--inFlight === 0) target.unref();
      target.off('message', onMessage);
      target.off('error', onError);
      target.off('exit', onExit);
    };
    const onMessage = (reply: NativeBrowserReply) => {
      if (reply.id !== id) return;
      finish();
      if ('error' in reply) reject(new Error(reply.error));
      else resolve(reply.result);
    };
    const onError = (error: Error) => {
      finish();
      reject(error);
    };
    const onExit = () => {
      finish();
      reject(new Error('Session browser worker stopped'));
    };
    target.on('message', onMessage);
    target.on('error', onError);
    target.on('exit', onExit);
    target.postMessage({ ...request, id });
  });
}

/**
 * Bind directory and authority once; the model supplies only the tool inputs. Like legacy's browser, the
 * scope is the session's home workspace and the live session is read lazily.
 */
export function createNativeSessionBrowser(
  directory: string,
  workspace: Workspace,
  binding: DirectBinding | undefined,
  currentSessionId: () => string | undefined,
): Pick<SessionBrowser, 'list' | 'search' | 'read'> {
  const scope = nativeSearchScope(workspace, binding);
  const call = (operation: NativeBrowserRequest['operation']) => (input: unknown) => {
    const current = currentSessionId();
    return browseOffThread({
      directory,
      scope,
      context: { projectPath: workspace.root, ...(current ? { currentSessionId: nativeBrowserId(current) } : {}) },
      operation,
      input,
    });
  };
  return { list: call('list'), search: call('search'), read: call('read') };
}
