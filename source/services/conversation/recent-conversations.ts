import { getConversationsDir, listConversations, type ConversationListEntry } from './conversation-persistence.js';
import { SessionIndexWorkerClient } from './session-index/session-index-worker-client.js';

/**
 * The resume selector renders a fixed-size chooser; the terminal UI historically
 * rendered `listConversations(...).slice(0, 10)`, so an omitted limit preserves
 * that behavior.
 */
export const DEFAULT_RECENT_CONVERSATIONS_LIMIT = 10;

export interface RecentConversationsOptions {
  /** Worker request timeout; defaults to the session-index worker default. */
  workerTimeoutMs?: number;
  /** Lifecycle/test seam: builds the off-main-thread worker client. */
  createClient?: () => SessionIndexWorkerClient;
  /** Observes the degraded path where the worker thread could not serve the listing. */
  onFallback?: (reason: string) => void;
}

/**
 * Asynchronous counterpart of `listConversations` for the interactive resume
 * selector.
 *
 * The canonical listing replays every conversation log in the directory, which
 * is far too heavy to run on the UI thread. This runs that exact parse inside
 * the session-index worker thread (reusing its worker infrastructure rather
 * than introducing another index) so the returned entries — project/SSH scope,
 * update ordering, short refs, and metadata — are byte-for-byte what
 * `listConversations(projectPath, sshHost)` returns, just off the main thread.
 *
 * The index database is intentionally not consulted: its `list` projection
 * stores `updated_at` from the session state rather than file mtime, counts
 * projected records rather than user/assistant turns, and omits
 * `activeProfileId`/`appMode`/`sshHost`/`projectPath`, so it cannot reproduce
 * the resume selector's semantics.
 */
export async function listRecentConversations(
  projectPath?: string,
  sshHost?: string,
  limit: number = DEFAULT_RECENT_CONVERSATIONS_LIMIT,
  options?: RecentConversationsOptions,
): Promise<ConversationListEntry[]> {
  const entries = await listConversationsOffMainThread(projectPath, sshHost, options);
  if (!Number.isFinite(limit)) return entries;
  return entries.slice(0, Math.max(0, Math.floor(limit)));
}

async function listConversationsOffMainThread(
  projectPath: string | undefined,
  sshHost: string | undefined,
  options: RecentConversationsOptions | undefined,
): Promise<ConversationListEntry[]> {
  const createClient =
    options?.createClient ??
    (() => new SessionIndexWorkerClient(undefined, undefined, { timeoutMs: options?.workerTimeoutMs }));

  let client: SessionIndexWorkerClient | null = null;
  try {
    client = createClient();
    return await client.listConversationsInDirectory(getConversationsDir(), projectPath, sshHost);
  } catch (error) {
    options?.onFallback?.(error instanceof Error ? error.message : String(error));
    // Last resort only: the worker thread itself is unusable (for example the
    // runtime forbids worker threads). Parsing in-process keeps the listing
    // correct at the cost of briefly blocking, which is preferable to returning
    // a misleadingly empty list.
    return listConversations(projectPath, sshHost);
  } finally {
    await client?.close().catch(() => {});
  }
}
