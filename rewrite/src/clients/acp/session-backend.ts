import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import type { AcpBackend, BackendOptions } from './contract.js';
import { AcpAttachment } from './attachment.js';

async function canonicalCwd(cwd: string): Promise<string> {
  if (!path.isAbsolute(cwd)) throw acp.RequestError.invalidParams(undefined, 'cwd must be an absolute path');
  try {
    const canonical = await realpath(cwd);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw acp.RequestError.invalidParams(undefined, 'cwd must exist and be a directory');
  }
}

function promptText(blocks: acp.PromptRequest['prompt']): string {
  const text = blocks
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'resource_link') return `[Resource: ${String(block.uri)}]`;
      if (block.type === 'resource') {
        const resource = block.resource as { type?: string; text?: string };
        if (resource.type === 'text' && typeof resource.text === 'string') return resource.text;
      }
      throw acp.RequestError.invalidParams(undefined, `Unsupported prompt content block: ${block.type}`);
    })
    .join('\n');
  if (!text.trim()) throw acp.RequestError.invalidParams(undefined, 'prompt must contain text');
  return text;
}

/**
 * Create the direct ACP backend over an injected DirectHost and workspace authority.
 * No host factory, Session, provider, persistence or legacy runtime is created.
 */
export function createAcpBackend(options: BackendOptions): AcpBackend {
  const attachments = new Map<string, AcpAttachment>();
  // Lifecycle mutations for a session must not race replacement and close.
  const changing = new Set<string>();
  const createRequestId = options.createRequestId ?? randomUUID;
  let stopped = false;

  const available = (): void => {
    if (stopped) throw new acp.RequestError(-32000, 'ACP backend is shut down');
  };
  const attached = (id: string): AcpAttachment => {
    available();
    if (changing.has(id)) throw new acp.RequestError(-32000, 'Session attachment is changing');
    const attachment = attachments.get(id);
    if (!attachment) throw new acp.RequestError(-32001, `Session not found: ${id}`);
    return attachment;
  };
  const attach = async (connection: DirectConnection, client: acp.AgentContext, replay: boolean): Promise<void> => {
    const attachment = new AcpAttachment(connection, client, options.logger);
    try {
      available();
      if (attachments.has(connection.sessionId)) throw new acp.RequestError(-32000, 'Session is already attached');
      attachments.set(connection.sessionId, attachment);
      await attachment.start(replay);
      available();
    } catch (error) {
      if (attachments.get(connection.sessionId) === attachment) attachments.delete(connection.sessionId);
      attachment.detach();
      throw error;
    }
  };

  return {
    async createSession(request, client) {
      available();
      const cwd = await canonicalCwd(request.cwd);
      const grant = await options.workspaces.authorize(cwd);
      const connection = await options.host.createSession(options.principal, grant);
      await attach(connection, client, false);
      return { sessionId: connection.sessionId };
    },
    async listSessions(request) {
      available();
      const cwd = request.cwd ? await canonicalCwd(request.cwd) : null;
      const page = await options.host.listSessions(options.principal, request.cursor ?? undefined);
      const sessions = [];
      for (const session of page.sessions) {
        const sessionCwd = session.workspace.root;
        if (cwd && sessionCwd !== cwd) continue;
        sessions.push({
          sessionId: session.id,
          cwd: sessionCwd,
        });
      }
      return { sessions, ...(page.cursor ? { nextCursor: page.cursor } : {}) };
    },
    async resumeSession(request, client) {
      available();
      if (changing.has(request.sessionId)) throw new acp.RequestError(-32000, 'Session attachment is changing');
      changing.add(request.sessionId);
      try {
        const cwd = await canonicalCwd(request.cwd);
        await options.workspaces.authorize(cwd);
        if ((await options.workspaces.cwd(request.sessionId)) !== cwd) {
          throw acp.RequestError.invalidParams(undefined, 'cwd does not match the session workspace');
        }
        // The SDK supports cursors beyond 'start', but Host has not committed
        // atomic historical attachment semantics. Do not fake cursor replay.
        if (request.replayFrom && request.replayFrom.type !== 'start') {
          throw acp.RequestError.invalidParams(undefined, 'Only replayFrom: start is supported by direct ACP');
        }
        // Connect first so a failed authorization/open does not destroy this
        // client's existing attachment. Replacement never closes the Session.
        const connection = await options.host.connect(options.principal, request.sessionId);
        try {
          attachments.get(request.sessionId)?.detach();
          attachments.delete(request.sessionId);
          await attach(connection, client, Boolean(request.replayFrom));
        } catch (error) {
          connection.close();
          throw error;
        }
        return {};
      } finally {
        changing.delete(request.sessionId);
      }
    },
    async preparePrompt(request) {
      return await attached(request.sessionId).prepare(createRequestId(), promptText(request.prompt));
    },
    async cancelSession(sessionId) {
      await attached(sessionId).cancel();
    },
    async closeSession(sessionId) {
      available();
      if (changing.has(sessionId)) throw new acp.RequestError(-32000, 'Session attachment is changing');
      const attachment = attachments.get(sessionId);
      if (!attachment) return;
      changing.add(sessionId);
      try {
        await attachment.close();
      } finally {
        attachments.delete(sessionId);
        changing.delete(sessionId);
      }
    },
    async shutdown() {
      stopped = true;
      const failures: unknown[] = [];
      for (const attachment of attachments.values()) {
        try {
          attachment.detach();
        } catch (error) {
          failures.push(error);
        }
      }
      attachments.clear();
      if (failures.length) throw new AggregateError(failures, 'Direct ACP detach failed');
    },
  };
}
