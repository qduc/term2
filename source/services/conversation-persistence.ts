import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import envPaths from 'env-paths';
import type { LogEnvelope } from './conversation-log-events.js';
import { replayEvents, type RestoredState } from './conversation-replay.js';

import type { SavedAppMode } from './conversation-persistence-types.js';
export type { SavedAppMode, SavedMessage } from './conversation-persistence-types.js';
export type { RestoredState } from './conversation-replay.js';

const paths = envPaths('term2');
const CONVERSATIONS_DIR = path.join(paths.log, 'conversations');
let conversationsDirOverride: string | null = null;

export type LoadConversationForProjectResult =
  | { status: 'loaded'; conversation: RestoredState }
  | { status: 'not_found' }
  | { status: 'project_mismatch'; conversation: RestoredState }
  | { status: 'locked'; lockPath: string; lockInfo: { pid: number; startedAt: string; host: string } | null };

function getConversationsDir(): string {
  return conversationsDirOverride ?? process.env['TERM2_CONVERSATIONS_DIR'] ?? CONVERSATIONS_DIR;
}

export function getConversationsDirForTest(): string {
  return getConversationsDir();
}

export function setConversationsDirForTest(dir: string | null): void {
  conversationsDirOverride = dir;
}

function ensureConversationsDir(): string {
  const dir = getConversationsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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

function readEnvelopes(filePath: string): LogEnvelope[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const envelopes: LogEnvelope[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const envelope = JSON.parse(trimmed) as LogEnvelope;
      envelopes.push(envelope);
    } catch {
      // skip corrupt line
    }
  }
  return envelopes;
}

function restoredUpdatedAt(filePath: string, envelopes: LogEnvelope[]): string | undefined {
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

export function loadConversation(
  id: string,
  expectedProjectPath?: string,
  expectedSshHost?: string,
): RestoredState | null {
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
  const filePath = getConversationPath(id);
  if (!fs.existsSync(filePath)) {
    return { status: 'not_found' };
  }
  const envelopes = readEnvelopes(filePath);
  const conversation = replayEvents(envelopes);
  conversation.updatedAt = restoredUpdatedAt(filePath, envelopes);
  if (!conversation.id) {
    conversation.id = id;
  }
  if (!conversationMatchesProject(conversation, expectedProjectPath, expectedSshHost)) {
    return { status: 'project_mismatch', conversation };
  }
  return { status: 'loaded', conversation };
}

export function loadLastConversation(expectedProjectPath?: string, expectedSshHost?: string): RestoredState | null {
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

export function isConversationLocked(id: string): { pid: number; startedAt: string; host: string } | null {
  const lp = getLockPath(id);
  if (!fs.existsSync(lp)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(lp, 'utf-8'));
  } catch {
    return { pid: -1, startedAt: '', host: '' };
  }
}

export function deleteConversation(id: string): boolean {
  const filePath = getConversationPath(id);
  const lockFile = getLockPath(id);
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

interface ConversationListEntry {
  id: string;
  updatedAt: string;
  projectPath?: string;
  sshHost?: string;
  firstUserMessage?: string;
  appMode?: SavedAppMode;
  model?: string;
  provider?: string;
  messageCount?: number;
}

export function listConversations(): ConversationListEntry[] {
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

        let initEnvelope: LogEnvelope | null = null;
        let firstUserMessage: string | undefined;
        let messageCount = 0;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const envelope = JSON.parse(trimmed) as LogEnvelope;
            if (!initEnvelope && envelope?.event?.type === 'session_init') {
              initEnvelope = envelope;
            }
            if (envelope?.event?.type === 'user_message') {
              messageCount++;
              if (!firstUserMessage) {
                firstUserMessage = envelope.event.message.text;
              }
            } else if (envelope?.event?.type === 'assistant_final' || envelope?.event?.type === 'assistant_turn') {
              messageCount++;
            } else if (envelope?.event?.type === 'undo') {
              const undone = (envelope.event as any).removedUserTurns || 0;
              messageCount = Math.max(0, messageCount - undone * 2);
            }
          } catch {
            // skip corrupt line
          }
        }

        if (!initEnvelope || initEnvelope.event.type !== 'session_init') {
          continue;
        }

        const init = initEnvelope.event;
        entries.push({
          id: init.id,
          updatedAt: stat.mtime.toISOString(),
          ...(init.projectPath ? { projectPath: init.projectPath } : {}),
          ...(init.sshHost ? { sshHost: init.sshHost } : {}),
          firstUserMessage,
          appMode: init.appMode,
          model: init.model,
          provider: init.provider,
          messageCount,
        });
      } catch {
        // skip
      }
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
 * Fork a conversation: copy <sourceId>.jsonl to <newId>.jsonl and return the new id.
 * The source is untouched. The new file is ready to be opened by a fresh writer.
 */
export function forkConversation(sourceId: string, newId: string): boolean {
  const dir = ensureConversationsDir();
  const srcPath = path.join(dir, `${sourceId}.jsonl`);
  const dstPath = path.join(dir, `${newId}.jsonl`);
  if (!fs.existsSync(srcPath)) {
    return false;
  }
  fs.copyFileSync(srcPath, dstPath);
  return true;
}

const CONTENT_EVENT_TYPES = new Set([
  'user_message',
  'assistant_final',
  'assistant_turn',
  'command_message',
  'subagent_started',
  'error',
]);

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
      const envelope = JSON.parse(trimmed) as LogEnvelope;
      if (envelope.event && CONTENT_EVENT_TYPES.has(envelope.event.type)) {
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
  const tmp = `${lp}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
    fs.renameSync(tmp, lp);
  } catch {
    // best-effort
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
