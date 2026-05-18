import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import envPaths from 'env-paths';

const paths = envPaths('term2');
const CONVERSATIONS_DIR = path.join(paths.log, 'conversations');
let conversationsDirOverride: string | null = null;

export interface SavedMessage {
  id: string;
  sender: string;
  text?: string;
  [key: string]: unknown;
}

export interface SavedConversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  previousResponseId: string | null;
  history: unknown[];
  messages: SavedMessage[];
}

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

export function generateId(): string {
  return crypto.randomUUID();
}

export function saveConversation(conversation: SavedConversation): string {
  ensureConversationsDir();
  const filePath = getConversationPath(conversation.id);

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
    ...conversation,
    messages: normalizedMessages,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

  // Update last conversation pointer
  const lastPath = getLastConversationPath();
  fs.writeFileSync(lastPath, JSON.stringify({ id: conversation.id }), 'utf-8');

  return filePath;
}

export function loadConversation(id: string): SavedConversation | null {
  const filePath = getConversationPath(id);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as SavedConversation;
    return data;
  } catch {
    return null;
  }
}

export function loadLastConversation(): SavedConversation | null {
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

export function getResumeCommand(id: string): string {
  return `term2 --resume ${id}`;
}
