import { randomUUID } from 'node:crypto';
import { SandboxNetworkApprovalCoordinator } from '../../../../source/utils/shell/sandbox/sandbox-network-approval-coordinator.js';
import type {
  SandboxNetworkAccessRequest,
  NetworkApprovalAnswer,
} from '../../../../source/utils/shell/sandbox/sandbox-network-approval.js';
import type { SandboxNetworkCompletion } from '../../../../source/utils/shell/sandbox/scoped-sandbox-network-access.js';
import type { SessionDriverContext } from '../local-store.js';
import { isNetworkAnswer } from './network.js';

type Entry = {
  id: string;
  request: SandboxNetworkAccessRequest;
  completion: Promise<SandboxNetworkCompletion>;
  signal: AbortSignal;
  host: string;
  port?: number;
};
/** Private session authority; the canonical log remains the only durable writer. */
export function createNetworkAuthority(
  context: SessionDriverContext,
  failClosed: () => void,
  cancelSource: (
    request: SandboxNetworkAccessRequest,
    reason: 'cancelled' | 'helper_lost' | 'closed',
  ) => void = () => {},
) {
  const generation = randomUUID();
  const coordinator = new SandboxNetworkApprovalCoordinator();
  const entries = new Map<SandboxNetworkAccessRequest, Entry>();
  const applying = new Set<Entry>();
  const listeners = new Set<() => void>();
  let queue = Promise.resolve();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let stopReason: 'execution_ended' | 'helper_lost' | 'session_closed' | 'graph_replaced' = 'execution_ended';
  let poisoned = false;
  let visible: Entry | undefined;
  let queued = 0;
  let pendingRequests = 0;
  const decisions = new Map<string, { answer: NetworkApprovalAnswer; result: Promise<SandboxNetworkCompletion> }>();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const publish = () => {
    const active = coordinator.getSnapshot().activeRequest;
    visible = active ? entries.get(active) : undefined;
    queued = Math.max(0, entries.size - (visible ? 1 : 0));
    for (const listener of listeners) {
      try {
        const result: unknown = listener();
        if (result && typeof (result as { then?: unknown }).then === 'function')
          void Promise.resolve(result).catch(() => {});
      } catch {
        /* Subscribers cannot undo durable state. */
      }
    }
  };
  const poison = () => {
    poisoned = true;
    coordinator.dispose();
    entries.clear();
    publish();
    failClosed();
  };
  const requestApproval = async (
    request: SandboxNetworkAccessRequest,
    completion: Promise<SandboxNetworkCompletion>,
    signal: AbortSignal,
  ): Promise<NetworkApprovalAnswer> => {
    const { host, port } = request;
    pendingRequests++;
    try {
      let answer: Promise<NetworkApprovalAnswer> | undefined;
      await serial(async () => {
        if (closed || poisoned || context.state().status === 'closed' || signal.aborted) return;
        const entry: Entry = {
          id: randomUUID(),
          request,
          completion,
          signal,
          host,
          ...(port === undefined ? {} : { port }),
        };
        try {
          await context.commit([
            {
              type: 'session_network_requested',
              version: 1,
              requestId: entry.id,
              generation,
              host: entry.host,
              ...(entry.port === undefined ? {} : { port: entry.port }),
            },
          ]);
          if (signal.aborted || closed || context.state().status === 'closed') {
            await context.commit([
              {
                type: 'session_network_resolved',
                version: 1,
                requestId: entry.id,
                generation,
                resolution: { kind: 'cancelled', reason: stopReason },
              },
            ]);
            return;
          }
          entries.set(request, entry);
          answer = coordinator.request(request);
          publish();
        } catch (error) {
          poison();
          throw error;
        }
      });
      return answer ? await answer : 'deny';
    } finally {
      pendingRequests--;
    }
  };
  const cancelAll = async (reason: 'execution_ended' | 'helper_lost' | 'session_closed' | 'graph_replaced') => {
    stopReason = reason;
    for (const entry of applying) {
      cancelSource(
        entry.request,
        reason === 'helper_lost' ? 'helper_lost' : reason === 'execution_ended' ? 'cancelled' : 'closed',
      );
    }
    return serial(async () => {
      for (const entry of [...entries.values()]) {
        try {
          await context.commit([
            {
              type: 'session_network_resolved',
              version: 1,
              requestId: entry.id,
              generation,
              resolution: { kind: 'cancelled', reason },
            },
          ]);
        } catch (error) {
          poison();
          throw error;
        }
        cancelSource(
          entry.request,
          reason === 'helper_lost' ? 'helper_lost' : reason === 'execution_ended' ? 'cancelled' : 'closed',
        );
        coordinator.cancel(entry.request);
        entries.delete(entry.request);
      }
      publish();
    });
  };
  const decide = (command: {
    requestId: string;
    generation: string;
    answer: NetworkApprovalAnswer;
  }): Promise<SandboxNetworkCompletion> => {
    if (
      !command ||
      typeof command !== 'object' ||
      Object.keys(command).some((key) => !['requestId', 'generation', 'answer'].includes(key)) ||
      typeof command.requestId !== 'string' ||
      typeof command.generation !== 'string' ||
      !isNetworkAnswer(command.answer)
    )
      return Promise.reject(new Error('Malformed network decision'));
    const owned = { requestId: command.requestId, generation: command.generation, answer: command.answer };
    if (closed || poisoned || context.state().status === 'closed')
      return Promise.reject(new Error('Network authority is closed'));
    const previous = decisions.get(owned.requestId);
    if (previous)
      return owned.generation === generation && owned.answer === previous.answer
        ? previous.result
        : Promise.reject(new Error('Conflicting network decision'));
    const result = serial<SandboxNetworkCompletion>(async () => {
      const entry = visible;
      if (
        closed ||
        poisoned ||
        context.state().status === 'closed' ||
        !entry ||
        owned.requestId !== entry.id ||
        owned.generation !== generation ||
        !isNetworkAnswer(owned.answer)
      )
        throw new Error('Stale network decision');
      try {
        await context.commit([
          {
            type: 'session_network_resolved',
            version: 1,
            requestId: entry.id,
            generation,
            resolution: { kind: 'answered', answer: owned.answer },
          },
        ]);
      } catch (error) {
        poison();
        throw error;
      }
      entries.delete(entry.request);
      if (entry.signal.aborted || closed || context.state().status === 'closed') {
        coordinator.cancel(entry.request);
        publish();
        return { kind: 'failed', reason: 'cancelled' };
      }
      applying.add(entry);
      try {
        coordinator.resolve(entry.request, owned.answer);
        publish();
        return await entry.completion;
      } finally {
        applying.delete(entry);
      }
    });
    decisions.set(owned.requestId, { answer: owned.answer, result });
    void result.catch(() => {
      if (decisions.get(owned.requestId)?.result === result) decisions.delete(owned.requestId);
    });
    return result;
  };
  return {
    requestApproval,
    isLive: () => !closed && !poisoned && context.state().status !== 'closed',
    hasPending: () => pendingRequests > 0,
    cancelAll,
    decide,
    getSnapshot: () => ({
      active: visible
        ? {
            requestId: visible.id,
            generation,
            choices: ['deny', 'allow-once', 'allow-session', 'allow-project'] as const,
            host: visible.host,
            ...(visible.port === undefined ? {} : { port: visible.port }),
          }
        : null,
      queued,
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        try {
          await cancelAll('session_closed');
        } finally {
          coordinator.dispose();
          listeners.clear();
        }
      })();
      return closePromise;
    },
  };
}
