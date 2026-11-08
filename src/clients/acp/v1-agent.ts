import * as acp from '@agentclientprotocol/sdk';
import type { AcpAgentOptions } from './agent.js';
import { v1Client } from './client.js';
import type { AcpClient } from './contract.js';

/**
 * Stable ACP v1 over the same Host backend as v2. Prompts remain pending until
 * the native terminal, and session/load replays retained history as v1 chunks.
 * Credentials and model selection come from Term2, not an IDE login flow.
 */
export function createAcpV1Agent(options: AcpAgentOptions): acp.AgentApp {
  const app = acp.agent({ name: 'term2' });
  const clients = new Map<string, AcpClient>();
  const active = new Map<string, AbortController>();
  const extensions = (params: { mcpServers?: unknown[]; additionalDirectories?: unknown[] }): void => {
    if (params.mcpServers?.length || params.additionalDirectories?.length)
      throw acp.RequestError.invalidParams(undefined, 'MCP servers and additional directories are not supported');
  };
  app.onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: 1,
    agentInfo: { name: 'term2', title: 'Term2', version: options.version },
    authMethods: [],
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {}, close: {} },
    },
  }));
  app.onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
    extensions(params);
    const adapted = v1Client(client);
    const session = await options.backend.createSession({ cwd: params.cwd }, adapted);
    clients.set(session.sessionId, adapted);
    return { sessionId: session.sessionId };
  });
  app.onRequest(acp.methods.agent.session.list, async ({ params }) => await options.backend.listSessions(params));
  app.onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    extensions(params);
    if (active.has(params.sessionId)) throw new acp.RequestError(-32000, 'Cannot load an active ACP prompt');
    const adapted = v1Client(client);
    await options.backend.resumeSession({ ...params, replayFrom: { type: 'start' } }, adapted);
    clients.set(params.sessionId, adapted);
    return {};
  });
  app.onRequest(acp.methods.agent.session.resume, async ({ params, client }) => {
    extensions(params);
    if (active.has(params.sessionId)) throw new acp.RequestError(-32000, 'Cannot resume an active ACP prompt');
    const adapted = v1Client(client);
    await options.backend.resumeSession({ sessionId: params.sessionId, cwd: params.cwd }, adapted);
    clients.set(params.sessionId, adapted);
    return {};
  });
  app.onRequest(acp.methods.agent.session.prompt, async ({ params }) => {
    if (active.has(params.sessionId))
      throw new acp.RequestError(-32000, 'Session is already processing foreground work');
    const adapted = clients.get(params.sessionId);
    if (!adapted) throw new acp.RequestError(-32001, `Session not found: ${params.sessionId}`);
    const controller = new AbortController();
    active.set(params.sessionId, controller);
    try {
      const execution = await options.backend.preparePrompt(params);
      const result = await execution.run(
        (update) => adapted.update({ sessionId: params.sessionId, update }),
        controller.signal,
      );
      if (result.stopReason === '_term2_error') throw new acp.RequestError(-32603, 'Term2 turn failed; see Term2 logs');
      switch (result.stopReason) {
        case 'end_turn':
        case 'cancelled':
        case 'max_tokens':
        case 'max_turn_requests':
        case 'refusal':
          return { stopReason: result.stopReason };
        default:
          throw new acp.RequestError(-32603, `Unsupported turn outcome: ${result.stopReason}`);
      }
    } finally {
      if (active.get(params.sessionId) === controller) active.delete(params.sessionId);
    }
  });
  app.onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
    active.get(params.sessionId)?.abort();
    await options.backend.cancelSession(params.sessionId);
  });
  app.onRequest(acp.methods.agent.session.close, async ({ params }) => {
    active.get(params.sessionId)?.abort();
    await options.backend.closeSession(params.sessionId);
    clients.delete(params.sessionId);
    return {};
  });
  return app;
}
