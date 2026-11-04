/** App-owned read-only search capability. Session registers it but owns no file access. */
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { Tool, Workspace } from '../tools/index.js';
import type { DirectBinding } from '../session/facade-types.js';
import { nativeSearchScope, type NativeCatalogueScope } from './native-catalogue.js';
import type { NativeSearchReply, NativeSearchRequest } from './native-search-worker.js';

const inputSchema = z
  .object({
    query: z.string().min(1),
    kind: z.enum(['user', 'assistant', 'system', 'tool', 'reasoning', 'subagent', 'approval', 'notice']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

let worker: Worker | undefined;
let nextId = 0;
let inFlight = 0;

/** One shared worker, started on first use and never keeping the process alive. */
function searchWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL('./native-search-worker.js', import.meta.url));
  created.unref();
  created.once('exit', () => {
    if (worker === created) worker = undefined;
  });
  return (worker = created);
}

function searchOffThread(
  request: Omit<NativeSearchRequest, 'id'>,
  signal: AbortSignal,
): Promise<{ total: number; hits: readonly unknown[] }> {
  return new Promise((resolve, reject) => {
    const target = searchWorker();
    const id = ++nextId;
    // Only a search in flight keeps the process alive (a headless run waits on it).
    target.ref();
    inFlight++;
    const finish = () => {
      if (--inFlight === 0) target.unref();
      target.off('message', onMessage);
      target.off('error', onError);
      target.off('exit', onExit);
      signal.removeEventListener('abort', onAbort);
    };
    const onMessage = (reply: NativeSearchReply) => {
      if (reply.id !== id) return;
      finish();
      if ('error' in reply) reject(new Error(reply.error));
      else resolve(reply.result as { total: number; hits: readonly unknown[] });
    };
    const onError = (error: Error) => {
      finish();
      reject(error);
    };
    const onExit = () => {
      finish();
      reject(new Error('Native search worker stopped'));
    };
    // An aborted search discards the worker, which may be mid-way through a long index refresh,
    // unless another search is waiting on it: then that one finishes and this one's reply is ignored.
    const onAbort = () => {
      finish();
      if (inFlight === 0) void target.terminate();
      reject(signal.reason ?? new Error('Search cancelled'));
    };
    target.on('message', onMessage);
    target.on('error', onError);
    target.on('exit', onExit);
    signal.addEventListener('abort', onAbort, { once: true });
    target.postMessage({ ...request, id });
  });
}

/** Bind directory and authority once; the model cannot supply paths or workspace filters. */
export function createNativeSearchTool(directory: string, workspace: Workspace, binding?: DirectBinding): Tool {
  const scope = nativeSearchScope(workspace, binding);
  return {
    spec: {
      name: 'session_search',
      description:
        'Search visible native conversation transcripts in this authorized workspace. Whitespace-separated terms are literal OR alternatives, not MATCH syntax. Optional kind filters content. Returns total matched identities and up to 50 native log snippets (500 characters each). No session browser/open/read methods are provided.',
      inputSchema: z.toJSONSchema(inputSchema),
    },
    parse: (raw) => inputSchema.parse(raw),
    approval: () => ({ kind: 'none' }),
    async execute(raw, context) {
      context.signal.throwIfAborted();
      if (context.workspace.target !== workspace.target || context.workspace.root !== workspace.root)
        throw new Error('Native search workspace authority changed');
      const { query, kind, limit } = inputSchema.parse(raw);
      const result = await searchOffThread(
        {
          directory,
          scope: scope as NativeCatalogueScope,
          query,
          ...(kind ? { kind } : {}),
          ...(limit ? { limit } : {}),
        },
        context.signal,
      );
      return { output: JSON.stringify(result), isError: false };
    },
  };
}
