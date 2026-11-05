/** Local app-owned MCP lifetime and catalog-triggered generation replacement. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { openInBrowser } from '../shared/lib/oauth-loopback.js';
import { McpOAuthStore } from '../tools/mcp/mcp-oauth-store.js';
import type { DirectCommandOutcome } from '../session/command-types.js';
import type { DirectSession, DirectSessionState } from '../session/facade-types.js';
import { createDirectMcp, createDirectMcpOAuth, type DirectMcp } from './mcp.js';
import type { DirectSessionTarget } from './application-target.js';

/** Open once per local application, not per session/generation. Caller closes
 * after app.close(); SSH never reads controller-local MCP config/credentials. */
export async function openDirectApplicationMcp(options: {
  readonly target: DirectSessionTarget;
  readonly conversationsDir: string;
  readonly interactive: boolean;
  readonly onNotice: (message: string) => void;
}): Promise<DirectMcp | undefined> {
  if (options.target.surface.remote) return undefined;
  const store = new McpOAuthStore({
    filePath: path.join(path.dirname(options.conversationsDir), 'direct-mcp-oauth.json'),
  });
  const oauth = options.interactive ? createDirectMcpOAuth({ store, openBrowser: openInBrowser }) : { store };
  const mcp = await createDirectMcp({
    workspace: { root: options.target.root, target: 'local', access: options.target.grant.access },
    interactive: options.interactive,
    oauth,
    onNotice: options.onNotice,
  });
  try {
    mcp.start();
    return mcp;
  } catch (error) {
    await mcp.close();
    throw error;
  }
}

type RefreshAttempt = { readonly commandId: string; readonly epoch: number };
type RefreshSession = {
  readonly session: DirectSession;
  state: DirectSessionState;
  applied: number;
  scheduled: boolean;
  pending?: RefreshAttempt;
  readonly unsubscribe: () => void;
};

/** Observe only already-open sessions. Catalog changes stay stale until an
 * accepted native configure installs a new generation. No timers, replayed
 * tools, in-place graph mutation or new Session authority live here. */
export function createDirectMcpRefresh(
  catalog: Pick<DirectMcp, 'onCatalogChanged'>,
  onWarning: (message: string) => void,
) {
  let epoch = 0;
  let stopped = false;
  const sessions = new Map<string, RefreshSession>();
  const settle = (entry: RefreshSession, attempt: RefreshAttempt, outcome: DirectCommandOutcome): void => {
    if (stopped || entry.pending !== attempt) return;
    entry.pending = undefined;
    if (outcome.kind === 'configured') {
      entry.applied = attempt.epoch;
      schedule(entry);
    } else if (outcome.kind !== 'rejected' || outcome.code !== 'busy') {
      onWarning(
        `MCP catalog refresh ${attempt.commandId} for ${entry.session.id} was not installed: ${
          outcome.kind === 'rejected' ? outcome.message : outcome.kind
        }`,
      );
    }
    // Busy/conflict/failure leaves the mark intact. A later accepted Session
    // update or catalog change retries; never spin on our own rejection.
  };
  const schedule = (entry: RefreshSession): void => {
    if (
      stopped ||
      entry.scheduled ||
      entry.pending ||
      entry.applied >= epoch ||
      entry.state.activeTurnId !== null ||
      entry.state.status === 'closed'
    )
      return;
    entry.scheduled = true;
    queueMicrotask(() => {
      entry.scheduled = false;
      if (
        stopped ||
        entry.pending ||
        entry.applied >= epoch ||
        entry.state.activeTurnId !== null ||
        entry.state.status === 'closed'
      )
        return;
      const attempt = { commandId: randomUUID(), epoch };
      entry.pending = attempt;
      void entry.session
        .command({
          commandId: attempt.commandId,
          operation: { kind: 'configure', configuration: { model: entry.state.model } },
        })
        .then((result) => {
          if (stopped || entry.pending !== attempt) return;
          if (result.kind === 'finished' && result.receipt.outcome) {
            settle(entry, attempt, result.receipt.outcome);
          } else if (result.kind !== 'pending') {
            entry.pending = undefined;
            onWarning(
              `MCP catalog refresh ${attempt.commandId} for ${entry.session.id}: ${
                result.kind === 'not_admitting' ? result.reason : result.kind
              }`,
            );
          }
          // A pending receipt is not success: its terminal outcome is read from
          // native state below, never by resubmitting an accepted command.
        })
        .catch((error: unknown) => {
          if (stopped || entry.pending !== attempt) return;
          entry.pending = undefined;
          onWarning(`MCP catalog refresh for ${entry.session.id} failed: ${String(error)}`);
        });
    });
  };
  const unsubscribe = catalog.onCatalogChanged(() => {
    if (stopped) return;
    epoch++;
    for (const entry of sessions.values()) schedule(entry);
  });
  return {
    get epoch() {
      return epoch;
    },
    track(session: DirectSession, openedAtEpoch: number) {
      if (stopped || sessions.has(session.id)) return;
      const capture = session.capture((update) => {
        if (stopped || update.type !== 'state') return;
        const entry = sessions.get(session.id);
        if (!entry) return;
        entry.state = update.state;
        if (entry.pending) {
          const attempt = entry.pending;
          const outcome = update.state.commands.find(
            (receipt) => receipt.request.commandId === attempt.commandId,
          )?.outcome;
          if (outcome) settle(entry, attempt, outcome);
          return;
        }
        schedule(entry);
      });
      const entry: RefreshSession = {
        session,
        state: capture.state,
        applied: openedAtEpoch,
        scheduled: false,
        unsubscribe: capture.unsubscribe,
      };
      sessions.set(session.id, entry);
      schedule(entry);
    },
    close() {
      stopped = true;
      unsubscribe();
      for (const entry of sessions.values()) entry.unsubscribe();
      sessions.clear();
      // Session/host disposal, not this listener, owns admitted command drain.
    },
  };
}
