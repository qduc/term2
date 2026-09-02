import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import envPaths from 'env-paths';
import { DELTA_SIDECAR_SUFFIX, deltaSidecarPathFor, isTruncatedLogEvent } from '../logging/conversation-log-events.js';
import { decodeLogEnvelope, type PersistedLogEnvelope } from './conversation-decoder.js';
import { replayEvents, type RestoredState } from './conversation-replay.js';
import { auditSessionLog, type SessionAudit } from './session-audit.js';

import type { SavedAppMode } from './conversation-persistence-types.js';
export type { SavedAppMode, SavedMessage } from './conversation-persistence-types.js';
export type { RestoredState } from './conversation-replay.js';

const paths = envPaths('term2');
const CONVERSATIONS_DIR = path.join(paths.data, 'conversations');
const LOG_CONVERSATIONS_DIR = path.join(paths.log, 'conversations');
const MIGRATION_SENTINEL = '.migrated-from-log';
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
let conversationsDirOverride: string | null = null;
let pidAlivenessOverride: ((pid: number) => boolean) | null = null;

export type LoadConversationForProjectResult =
  | { status: 'loaded'; conversation: RestoredState; sourceVersion?: string }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: Array<{ id: string; shortRef: string }> }
  | { status: 'project_mismatch'; conversation: RestoredState }
  | { status: 'unreadable'; error: unknown };

/** Read-only browser enumeration; malformed logs are counted without exposing paths or errors. */
export type BrowseConversationsForProjectResult = {
  conversations: RestoredState[];
  unavailable: number;
  sourceVersions: Map<string, string>;
  directoryVersion?: string;
};

export function getConversationsDir(): string {
  return conversationsDirOverride ?? process.env['TERM2_CONVERSATIONS_DIR'] ?? CONVERSATIONS_DIR;
}

export function getConversationsDirForTest(): string {
  return getConversationsDir();
}

export function setConversationsDirForTest(dir: string | null): void {
  conversationsDirOverride = dir;
}

/**
 * Deterministic process-liveness probe used by the advisory-lock liveness
 * path. Signal 0 never delivers a signal: `ESRCH` means the PID is gone,
 * `EPERM` means a process exists that this user may not own. Only same-host
 * lock PIDs are ever probed.
 */
export function isPidAlive(pid: number): boolean {
  if (pidAlivenessOverride !== null) {
    return pidAlivenessOverride(pid);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Test-only override so liveness proofs never probe real processes. */
export function setPidAlivenessCheckForTest(check: ((pid: number) => boolean) | null): void {
  pidAlivenessOverride = check;
}

function ensureConversationsDir(): string {
  const dir = getConversationsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const defaultDbDir = process.env['TERM2_TEST_DB_DIR'] || CONVERSATIONS_DIR;
  const defaultLogDir = process.env['TERM2_TEST_LOG_DIR'] || LOG_CONVERSATIONS_DIR;
  const migrationSentinelPath = path.join(defaultDbDir, MIGRATION_SENTINEL);

  // Migrate files from the legacy log directory only once when using the default data path.
  if (dir === defaultDbDir && !fs.existsSync(migrationSentinelPath) && fs.existsSync(defaultLogDir)) {
    try {
      const files = fs.readdirSync(defaultLogDir);
      for (const file of files) {
        if (file.endsWith('.jsonl') || file === 'last.json') {
          const src = path.join(defaultLogDir, file);
          const dst = path.join(defaultDbDir, file);
          if (!fs.existsSync(dst)) {
            try {
              fs.renameSync(src, dst);
            } catch {
              fs.copyFileSync(src, dst);
              fs.unlinkSync(src);
            }
          } else {
            try {
              fs.unlinkSync(src);
            } catch {
              // best-effort cleanup to prevent re-migration of stale files
            }
          }
        }
      }
      fs.writeFileSync(migrationSentinelPath, '', 'utf-8');
    } catch {
      // ignore errors during automatic migration
    }
  }

  return dir;
}

function getConversationPath(id: string): string {
  return path.join(getConversationsDir(), `${id}.jsonl`);
}

function getLockPath(id: string): string {
  return path.join(getConversationsDir(), `${id}.lock`);
}

function getLastConversationPath(): string {
  return path.join(getConversationsDir(), 'last.json');
}

function statVersion(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch {
    return null;
  }
}

/**
 * Cheap read-only version of the complete source replayed by the browser.
 * The delta sidecar is included because an interrupted live turn can change
 * the restored transcript without changing the canonical JSONL file.
 */
export function getConversationSourceVersionReadOnly(id: string): string | null {
  if (!SAFE_SESSION_ID.test(id)) return null;
  const fileVersion = statVersion(getConversationPath(id));
  if (!fileVersion) return null;
  const sidecarPath = deltaSidecarPathFor(getConversationPath(id));
  const sidecarVersion = fs.existsSync(sidecarPath) ? statVersion(sidecarPath) : 'absent';
  if (!sidecarVersion) return null;
  return JSON.stringify([fileVersion, sidecarVersion]);
}

/** Directory membership version used to invalidate cached short references. */
export function getConversationsDirectoryVersionReadOnly(): string | null {
  return statVersion(getConversationsDir());
}

function normalizeProjectPath(projectPath: string): string {
  const normalized = path.normalize(projectPath);
  return normalized.endsWith(path.sep) && normalized !== path.sep ? normalized.slice(0, -1) : normalized;
}

function normalizeSshHost(host: string): string {
  return host.trim().toLowerCase();
}

function conversationMatchesProject(
  conversation: RestoredState,
  expectedProjectPath?: string,
  expectedSshHost?: string,
): boolean {
  if (expectedProjectPath === undefined && expectedSshHost === undefined) {
    return true;
  }

  if (expectedProjectPath) {
    if (!conversation.projectPath) {
      return false;
    }
    if (normalizeProjectPath(conversation.projectPath) !== normalizeProjectPath(expectedProjectPath)) {
      return false;
    }
  }

  if (expectedSshHost) {
    if (!conversation.sshHost) {
      return false;
    }
    return normalizeSshHost(conversation.sshHost) === normalizeSshHost(expectedSshHost);
  }

  if (conversation.sshHost) {
    return false;
  }

  return true;
}

export function generateId(): string {
  return crypto.randomUUID();
}

function decodeEnvelopeLines(content: string): PersistedLogEnvelope[] {
  const lines = content.split('\n');
  const envelopes: PersistedLogEnvelope[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const envelope = decodeLogEnvelope(parsed);
      if (envelope) {
        envelopes.push(envelope);
      }
    } catch {
      // skip corrupt line
    }
  }
  return envelopes;
}

/**
 * Read a conversation log, merging its delta sidecar when one is present.
 *
 * A sidecar only survives a session that ended with an unsettled turn — i.e. a
 * crash mid-stream — so in the steady state this reads a single file. When one
 * does exist, its deltas are interleaved by `seq` so `applyInterruptedTurnJournals`
 * sees the same ordering it would have seen from a single inline log.
 *
 * Both files share one sequence counter, so the merge is a stable sort. Logs
 * written before the sidecar split carry their deltas inline and are unaffected.
 */
function readEnvelopes(filePath: string): PersistedLogEnvelope[] {
  const envelopes = decodeEnvelopeLines(fs.readFileSync(filePath, 'utf-8'));

  const sidecarPath = deltaSidecarPathFor(filePath);
  if (!fs.existsSync(sidecarPath)) {
    return envelopes;
  }

  let deltas: PersistedLogEnvelope[];
  try {
    deltas = decodeEnvelopeLines(fs.readFileSync(sidecarPath, 'utf-8'));
  } catch {
    // An unreadable sidecar degrades an interrupted turn; it must never make
    // an otherwise-loadable conversation fail to open.
    return envelopes;
  }
  if (deltas.length === 0) {
    return envelopes;
  }

  return [...envelopes, ...deltas].sort((a, b) => a.seq - b.seq);
}

function restoredUpdatedAt(filePath: string, envelopes: PersistedLogEnvelope[]): string | undefined {
  const latestEnvelopeTs = [...envelopes]
    .reverse()
    .map((envelope) => envelope.ts)
    .find((ts) => typeof ts === 'string' && ts.length > 0);
  if (latestEnvelopeTs) {
    return latestEnvelopeTs;
  }
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Delete delta sidecars whose canonical conversation log no longer exists.
 *
 * Deliberately **not** keyed on lock liveness. A sidecar with no held lock is
 * the crash case — the session died mid-turn — and its deltas are exactly what
 * `--resume` needs to reconstruct the interrupted turn. Collecting those would
 * destroy the data the sidecar exists to preserve.
 *
 * A sidecar whose `.jsonl` is gone can never be resumed, so it is unambiguous
 * garbage. Sidecars for still-resumable crashed sessions are left alone; they
 * are dropped by the next clean `close()` of that session.
 *
 * Returns the number of files removed.
 */
export function collectOrphanedDeltaSidecars(): number {
  const dir = getConversationsDir();
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith(DELTA_SIDECAR_SUFFIX)) continue;
    const canonical = path.join(dir, `${entry.slice(0, -DELTA_SIDECAR_SUFFIX.length)}.jsonl`);
    if (fs.existsSync(canonical)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry));
      removed += 1;
    } catch {
      // Best effort; a sidecar we cannot remove is inert.
    }
  }
  return removed;
}

export function loadConversation(
  id: string,
  expectedProjectPath?: string,
  expectedSshHost?: string,
): RestoredState | null {
  ensureConversationsDir();
  const filePath = getConversationPath(id);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const envelopes = readEnvelopes(filePath);
    const restored = replayEvents(envelopes);
    restored.updatedAt = restoredUpdatedAt(filePath, envelopes);
    if (!restored.id) {
      restored.id = id;
    }
    if (!conversationMatchesProject(restored, expectedProjectPath, expectedSshHost)) {
      return null;
    }
    return restored;
  } catch {
    return null;
  }
}

export function loadConversationForProject(
  id: string,
  expectedProjectPath: string,
  expectedSshHost?: string,
): LoadConversationForProjectResult {
  ensureConversationsDir();
  if (fs.existsSync(getConversationPath(id))) {
    return loadConversationForProjectReadOnly(id, expectedProjectPath, expectedSshHost);
  }
  const resolution = resolveConversationReference(
    id,
    browseConversationsForProject(expectedProjectPath, expectedSshHost).conversations,
  );
  if (resolution.kind === 'ambiguous') return { status: 'ambiguous', candidates: resolution.candidates };
  return loadConversationForProjectReadOnly(resolution.id, expectedProjectPath, expectedSshHost);
}

/** Browser-only load that must not trigger directory creation or legacy migration. */
export function loadConversationForProjectReadOnly(
  id: string,
  expectedProjectPath: string,
  expectedSshHost?: string,
): LoadConversationForProjectResult {
  const filePath = getConversationPath(id);
  if (!fs.existsSync(filePath)) {
    return { status: 'not_found' };
  }
  try {
    const sourceVersionBefore = getConversationSourceVersionReadOnly(id);
    const envelopes = readEnvelopes(filePath);
    const conversation = replayEvents(envelopes);
    conversation.updatedAt = restoredUpdatedAt(filePath, envelopes);
    if (!conversation.id) {
      conversation.id = id;
    }
    if (!conversationMatchesProject(conversation, expectedProjectPath, expectedSshHost)) {
      return { status: 'project_mismatch', conversation };
    }
    const sourceVersionAfter = getConversationSourceVersionReadOnly(id);
    return {
      status: 'loaded',
      conversation,
      ...(sourceVersionBefore && sourceVersionBefore === sourceVersionAfter
        ? { sourceVersion: sourceVersionBefore }
        : {}),
    };
  } catch (error) {
    // A raw read failure must settle as a typed unreadable result so the CLI
    // can print an actionable diagnostic instead of crashing with an fs stack.
    return { status: 'unreadable', error };
  }
}

/**
 * Enumerates canonical local logs through the same decoder/replay/context path
 * as resume. Unlike the UI list, this reports malformed candidates generically.
 */
export function browseConversationsForProject(
  expectedProjectPath: string,
  expectedSshHost?: string,
): BrowseConversationsForProjectResult {
  const dir = getConversationsDir();
  const directoryVersionBefore = getConversationsDirectoryVersionReadOnly();
  let files: string[];
  try {
    if (!fs.existsSync(dir)) return { conversations: [], unavailable: 0, sourceVersions: new Map() };
    files = fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl'));
  } catch {
    return { conversations: [], unavailable: 0, sourceVersions: new Map() };
  }
  const conversations: RestoredState[] = [];
  const sourceVersions = new Map<string, string>();
  let unavailable = 0;
  for (const file of files) {
    const id = file.slice(0, -'.jsonl'.length);
    if (!SAFE_SESSION_ID.test(id)) {
      // An unsafe filename cannot be context-checked without deriving a path
      // from an untrusted identifier, so it is neither exposed nor counted.
      continue;
    }
    const loaded = loadConversationForProjectReadOnly(id, expectedProjectPath, expectedSshHost);
    if (loaded.status === 'loaded' && loaded.conversation.id === id && loaded.conversation.createdAt) {
      conversations.push(loaded.conversation);
      if (loaded.sourceVersion) sourceVersions.set(id, loaded.sourceVersion);
    } else if (
      loaded.status === 'unreadable' ||
      (loaded.status === 'loaded' && (loaded.conversation.id !== id || !loaded.conversation.createdAt))
    ) {
      unavailable++;
    }
  }
  const directoryVersionAfter = getConversationsDirectoryVersionReadOnly();
  return {
    conversations,
    unavailable,
    sourceVersions,
    ...(directoryVersionBefore && directoryVersionBefore === directoryVersionAfter
      ? { directoryVersion: directoryVersionBefore }
      : {}),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PREFIX = /^[0-9a-f-]{4,36}$/i;

export function resolveConversationReference(
  reference: string,
  conversations: readonly Pick<RestoredState, 'id'>[],
): { kind: 'resolved'; id: string } | { kind: 'ambiguous'; candidates: Array<{ id: string; shortRef: string }> } {
  const exact = conversations.find((conversation) => conversation.id === reference);
  if (exact || UUID.test(reference) || !UUID_PREFIX.test(reference)) {
    return { kind: 'resolved', id: exact?.id ?? reference };
  }
  const matches = conversations.filter(
    (conversation) => UUID.test(conversation.id) && conversation.id.toLowerCase().startsWith(reference.toLowerCase()),
  );
  if (matches.length === 1) return { kind: 'resolved', id: matches[0].id };
  if (matches.length > 1) {
    const refs = uniqueConversationShortRefs(conversations);
    return {
      kind: 'ambiguous',
      candidates: matches.map((conversation) => ({
        id: conversation.id,
        shortRef: refs.get(conversation.id) ?? conversation.id,
      })),
    };
  }
  return { kind: 'resolved', id: reference };
}

export function uniqueConversationShortRefs(conversations: readonly Pick<RestoredState, 'id'>[]): Map<string, string> {
  const ids = conversations.map((conversation) => conversation.id);
  return new Map(
    ids.map((id) => {
      if (!UUID.test(id)) return [id, id];
      let length = Math.min(8, id.length);
      while (
        length < id.length &&
        ids.some(
          (candidate) => candidate !== id && candidate.toLowerCase().startsWith(id.slice(0, length).toLowerCase()),
        )
      ) {
        length += 1;
      }
      return [id, id.slice(0, length)];
    }),
  );
}

export function loadLastConversation(expectedProjectPath?: string, expectedSshHost?: string): RestoredState | null {
  ensureConversationsDir();
  const file = readLastConversationFile();
  const candidates = file.entries.filter((e) => matchesEntryContext(e, expectedProjectPath, expectedSshHost));
  const mostRecent = candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (mostRecent) {
    return loadConversation(mostRecent.id, expectedProjectPath, expectedSshHost);
  }
  // Fallback: scan all conversations when no last.json entry matches.
  const hasFilters = !!expectedProjectPath || !!expectedSshHost;
  if (hasFilters) {
    return (
      listConversations()
        .map(({ id }) => loadConversation(id, expectedProjectPath, expectedSshHost))
        .find((conversation): conversation is RestoredState => conversation !== null) ?? null
    );
  }
  return null;
}

export type ConversationLockDiagnostic =
  | { status: 'held'; pid: number; startedAt: string; host: string }
  | { status: 'stale'; pid: number; startedAt: string; host: string }
  | { status: 'corrupt' };

export function isConversationLocked(id: string): ConversationLockDiagnostic | null {
  const lp = getLockPath(id);
  if (!fs.existsSync(lp)) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(lp, 'utf-8'));
  } catch {
    // Unparseable lock payloads must not masquerade as a live holder or as an
    // absent lock; they are reported as corrupt.
    return { status: 'corrupt' };
  }
  if (payload === null || typeof payload !== 'object') {
    return { status: 'corrupt' };
  }
  const { pid, startedAt, host } = payload as Record<string, unknown>;
  if (typeof pid !== 'number' || pid <= 0 || typeof startedAt !== 'string' || typeof host !== 'string') {
    // A non-positive PID is not a valid writer payload and must never reach the
    // liveness probe (process.kill(0, ...) would probe the caller's process group).
    return { status: 'corrupt' };
  }
  const base = { pid, startedAt, host };
  // Liveness is only provable for a lock from this host. A lock from another
  // machine may legitimately be held, so it is reported as held.
  if (host === os.hostname() && !isPidAlive(pid)) {
    return { status: 'stale', ...base };
  }
  return { status: 'held', ...base };
}

export function deleteConversation(id: string): boolean {
  const filePath = getConversationPath(id);
  const lockFile = getLockPath(id);
  const deltaFile = deltaSidecarPathFor(filePath);
  let removed = false;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      removed = true;
    }
  } catch {
    // ignore
  }
  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
    }
  } catch {
    // ignore
  }
  // The residual `.deltas` sidecar is removed synchronously with the explicit
  // delete: deletion is the user's privacy boundary and must not leave turn
  // text behind for the next launch's orphan GC.
  try {
    if (fs.existsSync(deltaFile)) {
      fs.unlinkSync(deltaFile);
    }
  } catch {
    // ignore
  }
  // Remove any last.json entries pointing to this id
  const file = readLastConversationFile();
  const filtered = file.entries.filter((e) => e.id !== id);
  if (filtered.length !== file.entries.length) {
    if (filtered.length === 0) {
      try {
        fs.unlinkSync(getLastConversationPath());
      } catch {
        // ignore
      }
    } else {
      writeLastConversationFile({ entries: filtered });
    }
  }
  return removed;
}

export interface ConversationListEntry {
  id: string;
  shortRef?: string;
  updatedAt: string;
  projectPath?: string;
  sshHost?: string;
  firstUserMessage?: string;
  appMode?: SavedAppMode;
  model?: string;
  provider?: string;
  messageCount?: number;
}

export function listConversations(expectedProjectPath?: string, expectedSshHost?: string): ConversationListEntry[] {
  ensureConversationsDir();
  const dir = getConversationsDir();
  try {
    if (!fs.existsSync(dir)) {
      return [];
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    const entries: ConversationListEntry[] = [];
    for (const f of files) {
      const fp = path.join(dir, f);
      try {
        const stat = fs.statSync(fp);
        const content = fs.readFileSync(fp, 'utf-8');
        const lines = content.split('\n');

        let initEnvelope: PersistedLogEnvelope | null = null;
        let firstUserMessage: string | undefined;
        let messageCount = 0;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            const envelope = decodeLogEnvelope(parsed);
            if (!envelope) continue;
            // Truncated events carry no lifecycle fields; skip them entirely.
            if (isTruncatedLogEvent(envelope.event)) continue;

            if (!initEnvelope && envelope.event.type === 'session_init') {
              initEnvelope = envelope;
            }
            if (envelope.event.type === 'user_message') {
              messageCount++;
              if (!firstUserMessage && envelope.event.message?.text) {
                firstUserMessage = envelope.event.message.text;
              }
            } else if (envelope.event.type === 'assistant_turn') {
              messageCount++;
            } else if (envelope.event.type === 'undo') {
              const undone = envelope.event.removedUserTurns || 0;
              messageCount = Math.max(0, messageCount - undone * 2);
            }
          } catch {
            // skip corrupt line
          }
        }

        if (!initEnvelope || isTruncatedLogEvent(initEnvelope.event) || initEnvelope.event.type !== 'session_init') {
          continue;
        }

        const init = initEnvelope.event;
        const entry: ConversationListEntry = {
          id: init.id,
          updatedAt: stat.mtime.toISOString(),
          ...(init.projectPath ? { projectPath: init.projectPath } : {}),
          ...(init.sshHost ? { sshHost: init.sshHost } : {}),
          firstUserMessage,
          appMode: init.appMode,
          model: init.model,
          provider: init.provider,
          messageCount,
        };

        if (expectedProjectPath !== undefined || expectedSshHost !== undefined) {
          if (!matchesEntryContext(entry, expectedProjectPath, expectedSshHost)) {
            continue;
          }
        }

        entries.push(entry);
      } catch {
        // skip
      }
    }
    const sorted = entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const shortRefs = uniqueConversationShortRefs(sorted);
    return sorted.map((entry) => ({ ...entry, shortRef: shortRefs.get(entry.id) ?? entry.id }));
  } catch {
    return [];
  }
}

export function getResumeCommand(id: string, sshHost?: string, remoteDir?: string, sshPort?: number): string {
  const parts: string[] = ['term2'];
  if (sshHost) {
    parts.push(`--ssh ${sshHost}`);
  }
  if (remoteDir) {
    parts.push(`--remote-dir ${remoteDir}`);
  }
  if (sshPort && sshPort !== 22) {
    parts.push(`--ssh-port ${sshPort}`);
  }
  parts.push(`--resume ${id}`);
  return parts.join(' ');
}

/**
 * Fork a conversation, retaining its event history while giving the persisted copy
 * its own identity and direct source provenance.
 */
export function forkConversation(sourceId: string, newId: string): boolean {
  const dir = ensureConversationsDir();
  const srcPath = path.join(dir, `${sourceId}.jsonl`);
  const dstPath = path.join(dir, `${newId}.jsonl`);
  if (!fs.existsSync(srcPath)) {
    return false;
  }

  const lines = fs.readFileSync(srcPath, 'utf-8').split('\n');
  let rewroteIdentity = false;
  const forkedLines = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const parsed = JSON.parse(line) as unknown;
      const envelope = decodeLogEnvelope(parsed);
      if (!envelope || isTruncatedLogEvent(envelope.event) || envelope.event.type !== 'session_init') return line;
      rewroteIdentity = true;
      return JSON.stringify({
        ...envelope,
        event: { ...envelope.event, id: newId, forkedFrom: sourceId },
      });
    } catch {
      return line;
    }
  });
  if (!rewroteIdentity) {
    return false;
  }

  const tempPath = path.join(dir, `.${newId}.${crypto.randomUUID()}.tmp`);
  const forkedContent = forkedLines.join('\n');
  try {
    fs.writeFileSync(tempPath, forkedContent.endsWith('\n') ? forkedContent : `${forkedContent}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
    });
    fs.renameSync(tempPath, dstPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The rename succeeded or there is no temporary file to clean up.
    }
  }
  return true;
}

/**
 * Report how a saved session ended, without resuming it.
 *
 * Reads the same merged envelope stream `loadConversation` does, sidecar
 * included, so the verdict describes exactly the log a resume would replay.
 * Returns null when the conversation does not exist or cannot be read.
 */
export function auditConversation(id: string): SessionAudit | null {
  ensureConversationsDir();
  const filePath = getConversationPath(id);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return auditSessionLog(readEnvelopes(filePath));
  } catch {
    return null;
  }
}

const CONTENT_EVENT_TYPES = new Set(['user_message', 'assistant_turn', 'command_message', 'subagent_started', 'error']);

export function hasConversationContent(id: string): boolean {
  const filePath = getConversationPath(id);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const envelope = decodeLogEnvelope(parsed);
      if (envelope?.event && CONTENT_EVENT_TYPES.has(envelope.event.type)) {
        return true;
      }
    } catch {
      // skip corrupt line
    }
  }
  return false;
}

interface LastConversationEntry {
  id: string;
  updatedAt: string;
  projectPath?: string;
  sshHost?: string;
}

interface LastConversationFile {
  entries: LastConversationEntry[];
}

function readLastConversationFile(): LastConversationFile {
  const lp = getLastConversationPath();
  try {
    if (!fs.existsSync(lp)) {
      return { entries: [] };
    }
    const content = fs.readFileSync(lp, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object') {
      if ('entries' in parsed && Array.isArray((parsed as LastConversationFile).entries)) {
        return parsed as LastConversationFile;
      }
      // Old format: { id, updatedAt }
      if ('id' in parsed && typeof (parsed as { id: unknown }).id === 'string') {
        const old = parsed as { id: string; updatedAt?: string };
        return {
          entries: [{ id: old.id, updatedAt: old.updatedAt ?? new Date().toISOString() }],
        };
      }
    }
  } catch {
    // ignore
  }
  return { entries: [] };
}

function writeLastConversationFile(file: LastConversationFile): void {
  const lp = getLastConversationPath();
  // Distinct staging path per save invocation so consecutive or concurrent
  // saves never collide on one fixed temp file.
  const tmp = `${lp}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
    fs.renameSync(tmp, lp);
  } catch {
    // best-effort; the previously published file remains loadable
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Rename succeeded or there is no temp file to clean up.
    }
  }
}

function matchesEntryContext(
  entry: LastConversationEntry,
  expectedProjectPath?: string,
  expectedSshHost?: string,
): boolean {
  if (expectedProjectPath !== undefined) {
    if (!entry.projectPath) {
      return false;
    }
    if (normalizeProjectPath(entry.projectPath) !== normalizeProjectPath(expectedProjectPath)) {
      return false;
    }
  } else if (entry.projectPath) {
    return false;
  }

  if (expectedSshHost !== undefined) {
    if (!entry.sshHost) {
      return false;
    }
    if (normalizeSshHost(entry.sshHost) !== normalizeSshHost(expectedSshHost)) {
      return false;
    }
  } else if (entry.sshHost) {
    return false;
  }

  return true;
}

export function saveLastConversation(id: string, projectPath?: string, sshHost?: string): void {
  ensureConversationsDir();
  if (!hasConversationContent(id)) {
    return;
  }
  const file = readLastConversationFile();
  // Remove any existing entry with the same id to avoid duplicates when context changes.
  file.entries = file.entries.filter((e) => e.id !== id);
  file.entries.push({
    id,
    updatedAt: new Date().toISOString(),
    ...(projectPath !== undefined ? { projectPath } : {}),
    ...(sshHost !== undefined ? { sshHost } : {}),
  });
  writeLastConversationFile(file);
}

export const __testing = {
  getConversationPath,
  getLockPath,
};
