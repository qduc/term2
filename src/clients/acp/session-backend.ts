import type { AcpClient } from './contract.js';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import type { AcpBackend, BackendOptions } from './contract.js';
import { AcpAttachment } from './attachment.js';
import { promptInput } from './input.js';
import { AcpModels } from './models.js';

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

/**
 * Create the direct ACP backend over an injected DirectHost and workspace authority.
 * No host factory, Session, provider, persistence or legacy runtime is created.
 */
export function createAcpBackend(options: BackendOptions): AcpBackend {
  const models = new AcpModels(options);
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
  const attach = async (connection: DirectConnection, client: AcpClient, replay: boolean): Promise<void> => {
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
  const release = async (sessionId: string): Promise<void> => {
    try {
      await options.host.closeSession?.(options.principal, sessionId);
    } finally {
      await options.sessions?.close(sessionId);
    }
  };

  return {
    ...(options.sessions ? { mcpCapabilities: { http: true, sse: true } } : {}),
    async configOptions(sessionId, refresh) {
      attached(sessionId);
      return await models.configOptions(sessionId, refresh);
    },
    async setConfigOption(request) {
      attached(request.sessionId);
      return await models.setConfigOption(request);
    },
    async createSession(request, client) {
      available();
      const cwd = await canonicalCwd(request.cwd);
      const grant = await options.workspaces.authorize(cwd);
      const connect = () => options.host.createSession(options.principal, grant);
      if (!options.sessions && request.mcpServers?.length)
        throw acp.RequestError.invalidParams(undefined, 'MCP session setup is unavailable');
      const connection = options.sessions ? await options.sessions.open({ ...request, cwd }, connect) : await connect();
      try {
        await attach(connection, client, false);
      } catch (error) {
        await release(connection.sessionId);
        throw error;
      }
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
          ...(session.title !== undefined ? { title: session.title } : {}),
          ...(session.updatedAt !== undefined ? { updatedAt: session.updatedAt } : {}),
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
        // Host numeric replay is tail-only and requires retained client state.
        // No ACP cursor variant defines that state/watermark contract yet.
        if (request.replayFrom && request.replayFrom.type !== 'start') {
          throw acp.RequestError.invalidParams(undefined, 'Only replayFrom: start is supported by direct ACP');
        }
        // Connect first so a failed authorization/open does not destroy this
        // client's existing attachment. Replacement never closes the Session.
        const connect = () => options.host.connect(options.principal, request.sessionId);
        if (!options.sessions && request.mcpServers?.length)
          throw acp.RequestError.invalidParams(undefined, 'MCP session setup is unavailable');
        const connection = options.sessions
          ? await options.sessions.open({ ...request, cwd }, connect)
          : await connect();
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
      return await attached(request.sessionId).prepare(createRequestId(), promptInput(request.prompt));
    },
    async cancelSession(sessionId) {
      await attached(sessionId).cancel();
    },
    async closeSession(sessionId) {
      available();
      if (changing.has(sessionId)) throw new acp.RequestError(-32000, 'Session attachment is changing');
      const attachment = attachments.get(sessionId);
      changing.add(sessionId);
      try {
        try {
          await attachment?.close();
        } finally {
          await release(sessionId);
        }
      } finally {
        attachments.delete(sessionId);
        changing.delete(sessionId);
      }
    },
    async shutdown() {
      stopped = true;
      models.shutdown();
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
