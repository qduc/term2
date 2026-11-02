/** Filesystem store for the separate direct log namespace; never opens adopted data. */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ModelRef } from '../model/index.js';
import type { Workspace } from '../tools/index.js';
import { createConversation, openConversation } from './conversation.js';
import type { ConversationDeps, TurnRequest } from './direct-types.js';
import type { DirectBinding, DirectSessionStore } from './facade-types.js';
import type { Fact, FactLine, SessionStartedFact } from './facts.js';
import { createDirectSession, type DirectLiveSession } from './direct-session.js';
import type { ConversationLog } from './log.js';
import {
  createDirectRollingLog,
  directLogNames,
  readDirectLogLineage,
  readDirectLogLineages,
  type DirectLogLineage,
} from './direct-rolling-log.js';
import { replay } from './replay.js';
import { initialDirectState, reduceDirectFact } from './direct-state.js';
import { acquireDirectWriterLock } from './direct-writer-lock.js';
import { latestDirectConfiguration, type DirectConfigurationState } from './direct-configuration.js';

export type DirectRuntimeContext = {
  readonly id: string;
  readonly workspace: Workspace;
  readonly model: ModelRef;
  readonly binding?: DirectBinding;
  readonly rolloverFrom?: string;
  /** Existing metadata must select the actual restored profile/settings on open. */
  readonly metadata?: SessionStartedFact;
  /** Latest accepted effective selection AND raw intent, not launcher defaults. */
  readonly configuration?: DirectConfigurationState;
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
  create(
    workspace: Workspace,
    model: ModelRef,
    binding?: DirectBinding,
    lineage?: { readonly rolloverFrom: string },
  ): Promise<DirectLiveSession>;
  open(id: string, binding?: DirectBinding): Promise<DirectLiveSession>;
}

type Summary = {
  readonly id: string;
  readonly workspace: Workspace;
  readonly model: ModelRef;
  /** The first user message, flattened and shortened, so a list can tell conversations apart. */
  readonly title?: string;
  /** When the last accepted fact was written. */
  readonly updatedAt?: string;
  readonly messageCount?: number;
};

function firstPrompt(facts: readonly Fact[]): string | undefined {
  for (const fact of facts) {
    if (fact.type !== 'turn_started') continue;
    for (const item of fact.input) {
      if (item.type !== 'user_message') continue;
      const text = item.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) return text.length > 60 ? `${text.slice(0, 59)}…` : text;
    }
  }
  return undefined;
}
const DIRECT_ID = /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One writable facade per logical ID across cooperating stores/processes. Its
 * per-root authority survives physical rotation and process death releases it.
 * Opening replays without writing or resuming execution; no migration occurs.
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
  const construct = async (
    context: DirectRuntimeContext,
    entries: readonly FactLine[],
    lineage?: DirectLogLineage,
    acquired?: () => void,
  ): Promise<DirectLiveSession> => {
    const initial = entries.map((entry) => entry.fact);
    let runtime: DirectConversationRuntime | undefined;
    let log: ConversationLog | undefined;
    let release = acquired;
    try {
      runtime = await options.createRuntime(context);
      if (runtime.deps.toolContext && !sameWorkspace(runtime.deps.toolContext.workspace, context.workspace)) {
        throw new Error('direct tool runtime workspace does not match Session authority');
      }
      if (
        context.metadata &&
        (!sameProfile(runtime.profile, context.configuration?.profile ?? context.metadata.profile) ||
          runtime.request.reasoning !==
            (context.configuration ? context.configuration.configuration.reasoning : context.metadata.reasoning) ||
          (context.configuration && runtime.request.temperature !== context.configuration.configuration.temperature))
      ) {
        throw new Error('direct runtime did not restore the stored profile/reasoning');
      }
      // Refuse newly introduced foreign files before acquiring this writer too.
      directLogNames(directory);
      const rollingLog = createDirectRollingLog(directory, context.id, lineage);
      log = rollingLog;
      // New roots have no readable header until attach appends session_started.
      // Acquire authority before that publication; opened roots arrive locked.
      release ??= acquireDirectWriterLock(rollingLog.path);
      const ownedRelease = release;
      log = {
        get path() {
          return rollingLog.path;
        },
        append: (facts) => rollingLog.append(facts),
        close() {
          // Never release the authority if closing the underlying writer fails.
          rollingLog.close();
          ownedRelease();
        },
      };
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
            rotationBoundary: () => rollingLog.head(),
            publishTask: (event: import('./direct-background-types.js').DirectBackgroundProgress) => {
              ownedRuntime.deps.publishTask?.(event);
              publish(event);
            },
            publishBranch: (event: import('./facade-types.js').DirectBranchTransient) => {
              ownedRuntime.deps.publishBranch?.(event);
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
              ...(context.rolloverFrom ? { rolloverFrom: context.rolloverFrom } : {}),
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
      if (!log) release?.();
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
    async create(workspace, model, binding, lineage) {
      assertOpen();
      const rolloverFrom = lineage?.rolloverFrom;
      if (rolloverFrom !== undefined) requireDirectId(rolloverFrom);
      binding = binding ? structuredClone(binding) : undefined;
      workspace = { ...workspace };
      model = { ...model };
      validateBinding(binding);
      const authority = await resolveWorkspace(workspace.root, workspace);
      if (!sameWorkspace(authority, workspace))
        throw new Error('requested workspace does not match resolved authority');
      // Inspect names before mkdir or parsing anything. An old directory is never imported.
      directLogNames(directory);
      await mkdir(directory, { recursive: true });
      assertOpen();
      const id = `conv_${randomUUID()}`;
      return remember(id, () =>
        construct(
          {
            id,
            ...(rolloverFrom ? { rolloverFrom } : {}),
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
      directLogNames(directory);
      const lineage = readDirectLogLineage(directory, id);
      const { entries, metadata, logicalSessionId } = lineage;
      const facts = entries.map((entry) => entry.fact);
      validateExpectedBinding(metadata.binding, binding);
      replay(facts); // validates actual direct history; never repairs on open
      assertOpen();
      // Resolve aliases before locking, then reread under the logical root lock:
      // another process may have appended or rotated since discovery.
      return remember(logicalSessionId, async () => {
        const release = acquireDirectWriterLock(path.join(directory, `${logicalSessionId}.jsonl`));
        let handedOff = false;
        try {
          const current = readDirectLogLineage(directory, logicalSessionId);
          const currentFacts = current.entries.map((entry) => entry.fact);
          const currentMetadata = current.metadata;
          const currentConfiguration = latestDirectConfiguration(currentFacts);
          validateExpectedBinding(currentMetadata.binding, binding);
          replay(currentFacts);
          const workspace = await resolveWorkspace(currentMetadata.workspace, currentMetadata.workspaceIdentity);
          handedOff = true;
          return await construct(
            {
              id: logicalSessionId,
              workspace,
              model: currentConfiguration?.configuration.model ?? currentMetadata.model,
              metadata: currentMetadata,
              ...(currentConfiguration ? { configuration: currentConfiguration } : {}),
              ...(currentMetadata.binding ? { binding: currentMetadata.binding } : {}),
            },
            current.entries,
            current,
            release,
          );
        } catch (error) {
          if (!handedOff) release();
          throw error;
        }
      });
    },
    async list(cursor) {
      assertOpen();
      if (cursor !== undefined) requireDirectId(cursor);
      const summaries: Summary[] = [];
      // No arbitrary page size/retention policy: return the complete remaining direct namespace.
      for (const lineage of readDirectLogLineages(directory)) {
        const id = lineage.logicalSessionId;
        if (cursor !== undefined && id <= cursor) continue;
        const facts = lineage.entries.map((entry) => entry.fact);
        const metadata = lineage.metadata;
        let workspace: Workspace;
        try {
          // A shared directory is a catalogue, not a grant. Foreign workspaces
          // are invisible here; selecting an ID still uses strict open above.
          workspace = await resolveWorkspace(metadata.workspace, metadata.workspaceIdentity);
        } catch {
          continue;
        }
        summaries.push({
          id,
          workspace,
          messageCount: facts.reduce(
            (state, fact) => reduceDirectFact(state, fact),
            initialDirectState(id, workspace, metadata.model),
          ).messages.length,
          model: latestDirectConfiguration(facts)?.configuration.model ?? metadata.model,
          ...(firstPrompt(facts) ? { title: firstPrompt(facts) } : {}),
          ...(lineage.entries.length ? { updatedAt: lineage.entries[lineage.entries.length - 1]!.at } : {}),
        });
      }
      return { sessions: summaries.sort((left, right) => left.id.localeCompare(right.id)) };
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

function sameWorkspace(left: Workspace, right: Workspace): boolean {
  return (
    left.access === right.access &&
    left.target === right.target &&
    (left.target === 'local' ? path.resolve(left.root) === path.resolve(right.root) : left.root === right.root)
  );
}

function sameProfile(left: SessionStartedFact['profile'], right: SessionStartedFact['profile']): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}
