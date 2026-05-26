import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import envPaths from 'env-paths';
import { repairConversationHistory, type ConversationHistoryRepairSummary } from './conversation-history-repair.js';
import type { NormalizedUsage } from '../utils/token-usage.js';
import type { SavedToolExecution } from './tool-execution-ledger.js';

const paths = envPaths('term2');
const CONVERSATIONS_DIR = path.join(paths.log, 'conversations');
let conversationsDirOverride: string | null = null;

export interface SavedMessage {
  id: string;
  sender: string;
  text?: string;
  [key: string]: unknown;
}

export interface SavedAppMode {
  mentorMode: boolean;
  liteMode: boolean;
  planMode: boolean;
  /** Optional: absent in saves from before orchestrator mode was introduced. Treat undefined as false. */
  orchestratorMode?: boolean;
}

export interface SavedConversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectPath?: string;
  sshHost?: string;
  appMode?: SavedAppMode;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  previousResponseId: string | null;
  history: unknown[];
  toolLedger?: SavedToolExecution[];
  messages: SavedMessage[];
  historyRepair?: ConversationHistoryRepairSummary;
  usage?: NormalizedUsage;
  subagentUsage?: NormalizedUsage;
}

export type LoadConversationForProjectResult =
  | { status: 'loaded'; conversation: SavedConversation }
  | { status: 'not_found' }
  | { status: 'project_mismatch'; conversation: SavedConversation };

function getConversationsDir(): string {
  return conversationsDirOverride ?? CONVERSATIONS_DIR;
}

/**
 * Expose the conversations directory for testing purposes.
 */
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
  return path.join(getConversationsDir(), `${id}.json`);
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
  conversation: SavedConversation,
  expectedProjectPath?: string,
  expectedSshHost?: string,
): boolean {
  // If no expectations provided, skip all checks
  if (expectedProjectPath === undefined && expectedSshHost === undefined) {
    return true;
  }

  // Check project path
  if (expectedProjectPath) {
    if (!conversation.projectPath) {
      return false;
    }
    if (normalizeProjectPath(conversation.projectPath) !== normalizeProjectPath(expectedProjectPath)) {
      return false;
    }
  }

  // Check SSH host: use normalized matching
  if (expectedSshHost) {
    if (!conversation.sshHost) {
      return false;
    }
    return normalizeSshHost(conversation.sshHost) === normalizeSshHost(expectedSshHost);
  }

  // expectedSshHost is undefined/falsy but expectation exists (projectPath given)
  // so conversation.sshHost must also be falsy
  if (conversation.sshHost) {
    return false;
  }

  return true;
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function saveConversation(conversation: SavedConversation): string {
  ensureConversationsDir();
  const filePath = getConversationPath(conversation.id);
  const { historyRepair: _historyRepair, ...persistedConversation } = conversation;

  // Normalize messages: mark any streaming/running states as terminal
  const normalizedMessages = conversation.messages.map((msg) => {
    if (msg.sender === 'bot' && msg.status === 'streaming') {
      return { ...msg, status: 'finalized' };
    }
    if (msg.sender === 'command' && (msg.status === 'pending' || msg.status === 'running')) {
      return { ...msg, status: 'completed', success: msg.success ?? false };
    }
    return msg;
  });

  const data: SavedConversation = {
    ...persistedConversation,
    history: repairConversationHistory(persistedConversation.history).history,
    messages: normalizedMessages,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

  // Update last conversation pointer
  const lastPath = getLastConversationPath();
  fs.writeFileSync(lastPath, JSON.stringify({ id: conversation.id }), 'utf-8');

  return filePath;
}

export function loadConversation(
  id: string,
  expectedProjectPath?: string,
  expectedSshHost?: string,
): SavedConversation | null {
  const filePath = getConversationPath(id);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as SavedConversation;
    if (!conversationMatchesProject(data, expectedProjectPath, expectedSshHost)) {
      return null;
    }
    const { historyRepair: _historyRepair, ...persistedData } = data;
    const repair = repairConversationHistory(Array.isArray(persistedData.history) ? persistedData.history : []);
    return {
      ...persistedData,
      history: repair.history,
      ...(repair.repaired
        ? {
            historyRepair: {
              repaired: repair.repaired,
              removedItems: repair.removedItems,
              repairs: repair.repairs,
              statsBefore: repair.statsBefore,
              statsAfter: repair.statsAfter,
            },
          }
        : {}),
    };
  } catch {
    return null;
  }
}

export function loadConversationForProject(
  id: string,
  expectedProjectPath: string,
  expectedSshHost?: string,
): LoadConversationForProjectResult {
  const conversation = loadConversation(id);
  if (!conversation) {
    return { status: 'not_found' };
  }
  if (!conversationMatchesProject(conversation, expectedProjectPath, expectedSshHost)) {
    return { status: 'project_mismatch', conversation };
  }
  return { status: 'loaded', conversation };
}

export function loadLastConversation(expectedProjectPath?: string, expectedSshHost?: string): SavedConversation | null {
  const hasFilters = !!expectedProjectPath || !!expectedSshHost;

  if (hasFilters) {
    return (
      listConversations()
        .map(({ id }) => loadConversation(id, expectedProjectPath, expectedSshHost))
        .find((conversation): conversation is SavedConversation => conversation !== null) ?? null
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

export function deleteConversation(id: string): boolean {
  const filePath = getConversationPath(id);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function listConversations(): Array<{ id: string; updatedAt: string }> {
  const dir = getConversationsDir();
  try {
    if (!fs.existsSync(dir)) {
      return [];
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'last.json');
    return files
      .map((f) => {
        try {
          const content = fs.readFileSync(path.join(dir, f), 'utf-8');
          const data = JSON.parse(content) as SavedConversation;
          return { id: data.id, updatedAt: data.updatedAt };
        } catch {
          return null;
        }
      })
      .filter((item): item is { id: string; updatedAt: string } => item !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
