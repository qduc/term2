/** Filesystem store for the separate direct log namespace; never opens adopted data. */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ModelRef } from '../model/index.js';
import type { Workspace } from '../tools/index.js';
import { createConversation, openConversation } from './conversation.js';
import type { ConversationDeps, TurnRequest } from './direct-types.js';
import type { DirectBinding, DirectSessionStore } from './facade-types.js';
import type { Fact, FactLine, SessionStartedFact } from './facts.js';
import { createDirectSession, type DirectLiveSession } from './direct-session.js';
import { createLog, openLog, readFacts, readFactLines, type ConversationLog } from './log.js';
import { replay } from './replay.js';

export type DirectRuntimeContext = {
  readonly id: string;
  readonly workspace: Workspace;
  readonly model: ModelRef;
  readonly binding?: DirectBinding;
  /** Existing metadata must select the actual restored profile/settings on open. */
  readonly metadata?: SessionStartedFact;
};
export type DirectConversationRuntime = {
  readonly deps: Omit<ConversationDeps, 'log'>;
  readonly request: Omit<TurnRequest, 'input' | 'model' | 'submission'>;
  readonly profile: SessionStartedFact['profile'];
  readonly appVersion: string;
  dispose?(): void | Promise<void>;
};
export type DirectSessionStoreOptions = {
  /** Required, separate conversations-next directory. No default to old storage. */
  readonly directory: string;
  /** Obtain a CURRENT grant. Stored identity is a comparison hint, never authority. */
  readonly resolveWorkspace: (root: string, identity?: Workspace) => Workspace | Promise<Workspace>;
  /** App assembles models/tools/settings. Construction must not run a provider or tool. */
  readonly createRuntime: (
    context: DirectRuntimeContext,
  ) => DirectConversationRuntime | Promise<DirectConversationRuntime>;
};
export interface DirectLocalStore extends DirectSessionStore {
  create(workspace: Workspace, model: ModelRef, binding?: DirectBinding): Promise<DirectLiveSession>;
  open(id: string, binding?: DirectBinding): Promise<DirectLiveSession>;
}

type Summary = { readonly id: string; readonly workspace: Workspace; readonly model: ModelRef };
const DIRECT_ID = /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One live writable facade per ID in this store. Opening replays without writing
 * or resuming execution. No index, side journal, migration or second writer exists.
 * Binding metadata is immutable; an expected binding is checked before writable open.
 */
export function createDirectSessionStore(options: DirectSessionStoreOptions): DirectLocalStore {
  const directory = path.resolve(options.directory);
  const sessions = new Map<string, Promise<DirectLiveSession>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const assertOpen = (): void => {
    if (closed) throw new Error('direct Session store is closed');
  };
  const resolveWorkspace = async (root: string, identity?: Workspace): Promise<Workspace> => {
    const workspace = await options.resolveWorkspace(root, identity);
    if (identity) {
      if (identity.root !== root || !sameWorkspace(workspace, identity))
        throw new Error('current workspace grant does not match the stored/requested identity');
    } else if (workspace.target !== 'local' || path.resolve(workspace.root) !== path.resolve(root)) {
      // Path-only direct records cannot identify an SSH endpoint or retain remote access.
      throw new Error('path-only direct Session requires a matching current local workspace grant');
    }
    return workspace.target === 'local' ? { ...workspace, root: path.resolve(workspace.root) } : { ...workspace };
  };
  const remember = (id: string, construct: () => Promise<DirectLiveSession>): Promise<DirectLiveSession> => {
    const existing = sessions.get(id);
    if (existing) return existing;
    const pending = Promise.resolve().then(construct);
    sessions.set(id, pending);
    void pending.catch(() => {
      if (sessions.get(id) === pending) sessions.delete(id);
    });
    return pending;
  };
  const construct = async (context: DirectRuntimeContext, entries: readonly FactLine[]): Promise<DirectLiveSession> => {
    const initial = entries.map((entry) => entry.fact);
    let runtime: DirectConversationRuntime | undefined;
    let log: ConversationLog | undefined;
    try {
      runtime = await options.createRuntime(context);
      if (runtime.deps.toolContext && !sameWorkspace(runtime.deps.toolContext.workspace, context.workspace)) {
        throw new Error('direct tool runtime workspace does not match Session authority');
      }
      if (
        context.metadata &&
        (!sameProfile(runtime.profile, context.metadata.profile) ||
          runtime.request.reasoning !== context.metadata.reasoning)
      ) {
        throw new Error('direct runtime did not restore the stored profile/reasoning');
      }
      // Refuse newly introduced foreign files before acquiring this writer too.
      await directNames(directory);
      log = context.metadata ? openLog(logPath(directory, context.id)) : createLog(directory, context.id);
      const ownedRuntime = runtime;
      const ownedLog = log;
      return createDirectSession({
        id: context.id,
        workspace: context.workspace,
        model: context.model,
        log: ownedLog,
        entries,
        request: ownedRuntime.request,
        attach(observedLog, publish) {
          const liveDeps = {
            ...ownedRuntime.deps,
            publishTask: (event: import('./direct-background-types.js').DirectBackgroundProgress) => {
              ownedRuntime.deps.publishTask?.(event);
              publish(event);
            },
            publishNotice: (notice: import('./direct-memory.js').DirectAutomaticMemoryNotice) => {
              ownedRuntime.deps.publishNotice?.(notice);
              publish({ type: 'automatic_memory_notice', notice });
            },
          };
          if (context.metadata) return openConversation({ ...liveDeps, log: observedLog, facts: initial });
          return createConversation({
            ...liveDeps,
            log: observedLog,
            meta: {
              id: context.id,
              workspace: context.workspace.root,
              workspaceIdentity: context.workspace,
              model: context.model,
              profile: ownedRuntime.profile,
              appVersion: ownedRuntime.appVersion,
              ...(context.binding ? { binding: context.binding } : {}),
              ...(ownedRuntime.request.reasoning !== undefined ? { reasoning: ownedRuntime.request.reasoning } : {}),
            },
          });
        },
        dispose: () => ownedRuntime.dispose?.(),
        released: () => {
          sessions.delete(context.id);
        },
      });
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        log?.close();
      } catch (closeError) {
        failures.push(closeError);
      }
      try {
        await runtime?.dispose?.();
      } catch (disposeError) {
        failures.push(disposeError);
      }
      if (failures.length > 1) throw new AggregateError(failures, 'direct Session construction and cleanup failed');
      throw error;
    }
  };

  return {
    async create(workspace, model, binding) {
      assertOpen();
      binding = binding ? structuredClone(binding) : undefined;
      workspace = { ...workspace };
      model = { ...model };
      validateBinding(binding);
      const authority = await resolveWorkspace(workspace.root, workspace);
      if (!sameWorkspace(authority, workspace))
        throw new Error('requested workspace does not match resolved authority');
      // Inspect names before mkdir or parsing anything. An old directory is never imported.
      await directNames(directory);
      await mkdir(directory, { recursive: true });
      assertOpen();
      const id = `conv_${randomUUID()}`;
      return remember(id, () =>
        construct(
          {
            id,
            workspace: authority,
            model: structuredClone(model),
            ...(binding ? { binding: structuredClone(binding) } : {}),
          },
          [],
        ),
      );
    },
    async open(id, binding) {
      assertOpen();
      binding = binding ? structuredClone(binding) : undefined;
      validateBinding(binding);
      requireDirectId(id);
      await directNames(directory);
      const entries = readFactLines(logPath(directory, id));
      const facts = entries.map((entry) => entry.fact);
      const metadata = sessionMetadata(id, facts);
      validateExpectedBinding(metadata.binding, binding);
      replay(facts); // validates actual direct history; never repairs on open
      assertOpen();
      // Every caller's binding is checked before joining a shared live writer.
      // remember installs its construction promise before workspace/runtime assembly.
      return remember(id, async () => {
        const workspace = await resolveWorkspace(metadata.workspace, metadata.workspaceIdentity);
        return construct(
          {
            id,
            workspace,
            model: metadata.model,
            metadata,
            ...(metadata.binding ? { binding: metadata.binding } : {}),
          },
          entries,
        );
      });
    },
    async list(cursor) {
      assertOpen();
      if (cursor !== undefined) requireDirectId(cursor);
      const ids = (await directNames(directory)).map((name) => name.slice(0, -'.jsonl'.length)).sort();
      const summaries: Summary[] = [];
      // No arbitrary page size/retention policy: return the complete remaining direct namespace.
      for (const id of ids) {
        if (cursor !== undefined && id <= cursor) continue;
        const metadata = sessionMetadata(id, readFacts(logPath(directory, id)));
        summaries.push({
          id,
          workspace: await resolveWorkspace(metadata.workspace, metadata.workspaceIdentity),
          model: metadata.model,
        });
      }
      return { sessions: summaries };
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        // Pending opens are owned too: await assembly, then drain and release each.
        const results = await Promise.allSettled(
          [...sessions.values()].map(async (pending) => (await pending).close()),
        );
        const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
        if (errors.length) throw new AggregateError(errors, 'direct Session store could not release every runtime');
      })();
      return closePromise;
    },
  };
}

function validateBinding(binding: DirectBinding | undefined): void {
  if (
    binding !== undefined &&
    (typeof binding.client !== 'string' ||
      !binding.client.trim() ||
      typeof binding.id !== 'string' ||
      !binding.id.trim())
  ) {
    throw new Error('direct Session binding requires nonempty client and id');
  }
}

function validateExpectedBinding(stored: DirectBinding | undefined, expected: DirectBinding | undefined): void {
  validateBinding(stored);
  if (expected && (!stored || expected.client !== stored.client || expected.id !== stored.id)) {
    throw new Error('direct Session binding does not match the expected client owner');
  }
}

function requireDirectId(id: string): void {
  if (!DIRECT_ID.test(id)) throw new Error('expected an exact direct conv_<uuid> Session ID');
}

function logPath(directory: string, id: string): string {
  requireDirectId(id);
  return path.join(directory, `${id}.jsonl`);
}

function sessionMetadata(id: string, facts: readonly Fact[]): SessionStartedFact {
  const first = facts[0];
  if (
    first?.type !== 'session_started' ||
    first.id !== id ||
    facts.slice(1).some((fact) => fact.type === 'session_started')
  ) {
    throw new Error(`direct Session ${id} has invalid or mismatched session_started metadata`);
  }
  return first;
}

function sameWorkspace(left: Workspace, right: Workspace): boolean {
  return (
    left.access === right.access &&
    left.target === right.target &&
    (left.target === 'local' ? path.resolve(left.root) === path.resolve(right.root) : left.root === right.root)
  );
}

/** Reads names first and refuses foreign entries without opening any old data. */
async function directNames(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl') || !DIRECT_ID.test(name.slice(0, -'.jsonl'.length))) {
      throw new Error(`refusing direct conversations directory with foreign entry ${JSON.stringify(name)}`);
    }
    if (!(await lstat(path.join(directory, name))).isFile())
      throw new Error(`direct log is not a regular file: ${name}`);
  }
  return names;
}

function sameProfile(left: SessionStartedFact['profile'], right: SessionStartedFact['profile']): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}
