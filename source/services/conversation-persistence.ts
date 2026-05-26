import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import envPaths from 'env-paths';
import type { LogEnvelope } from './conversation-log-events.js';
import { replayEvents, type RestoredState } from './conversation-replay.js';

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
  return conversationsDirOverride ?? CONVERSATIONS_DIR;
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
  if (!conversation.id) {
    conversation.id = id;
  }
  if (!conversationMatchesProject(conversation, expectedProjectPath, expectedSshHost)) {
    return { status: 'project_mismatch', conversation };
  }
  return { status: 'loaded', conversation };
}

export function loadLastConversation(expectedProjectPath?: string, expectedSshHost?: string): RestoredState | null {
  const hasFilters = !!expectedProjectPath || !!expectedSshHost;
  if (hasFilters) {
    return (
      listConversations()
        .map(({ id }) => loadConversation(id, expectedProjectPath, expectedSshHost))
        .find((conversation): conversation is RestoredState => conversation !== null) ?? null
    );
  }

  const lastPath = getLastConversationPath();
  try {
    if (!fs.existsSync(lastPath)) {
      return null;
    }
    const content = fs.readFileSync(lastPath, 'utf-8');
    const { id } = JSON.parse(content) as { id: string };
    if (!id) {
      return null;
    }
    return loadConversation(id);
  } catch {
    return null;
  }
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
  // Clear last.json pointer if it points to this id
  const lp = getLastConversationPath();
  try {
    if (fs.existsSync(lp)) {
      const data = JSON.parse(fs.readFileSync(lp, 'utf-8'));
      if (data?.id === id) {
        fs.unlinkSync(lp);
      }
    }
  } catch {
    // ignore
  }
  return removed;
}

interface ConversationListEntry {
  id: string;
  updatedAt: string;
  projectPath?: string;
  sshHost?: string;
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
        const firstLine = readFirstLine(fp);
        if (!firstLine) continue;
        const envelope = JSON.parse(firstLine) as LogEnvelope;
        if (envelope?.event?.type !== 'session_init') continue;
        const init = envelope.event;
        entries.push({
          id: init.id,
          updatedAt: stat.mtime.toISOString(),
          ...(init.projectPath ? { projectPath: init.projectPath } : {}),
          ...(init.sshHost ? { sshHost: init.sshHost } : {}),
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

function readFirstLine(filePath: string): string | null {
  const buf = Buffer.alloc(8192);
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    if (read <= 0) return null;
    const text = buf.subarray(0, read).toString('utf-8');
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
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

export const __testing = {
  getConversationPath,
  getLockPath,
};
