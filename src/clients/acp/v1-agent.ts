import * as acp from '@agentclientprotocol/sdk';
import type { AcpAgentOptions } from './agent.js';
import { v1Client } from './client.js';
import type { AcpClient } from './contract.js';
import { v1Error } from './v1-errors.js';
import { v1Prompt } from './input.js';

/**
 * Stable ACP v1 over the same Host backend as v2. Prompts remain pending until
 * the native terminal, and session/load replays retained history as v1 chunks.
 * Credentials come from Term2; model selection configures its native session.
 */
export function createAcpV1Agent(options: AcpAgentOptions): acp.AgentApp {
  const app = acp.agent({ name: 'term2' });
  let capabilities: acp.InitializeRequest['clientCapabilities'];
  const onRequest = <Method extends acp.AgentRequestMethod>(
    method: Method,
    handler: acp.AgentRequestHandlersByMethod[Method],
  ): void => {
    const guarded: acp.AgentRequestHandler<
      acp.AgentRequestParamsByMethod[Method],
      acp.AgentRequestResponsesByMethod[Method]
    > = async (context) => {
      try {
        return await (handler as unknown as typeof guarded)(context);
      } catch (error) {
        throw v1Error(error);
      }
    };
    app.onRequest(method, guarded as unknown as acp.AgentRequestHandlersByMethod[Method]);
  };
  const clients = new Map<string, AcpClient>();
  const active = new Map<string, AbortController>();
  const configurationVersions = new Map<string, number>();
  const configurationChanges = new Map<string, Promise<acp.SessionConfigOption[]>>();
  const configuration = async (sessionId: string, adapted: AcpClient, client: acp.AgentContext) => {
    if (!options.backend.configOptions) return {};
    const configOptions = await options.backend.configOptions(sessionId);
    // Setup never waits for provider network I/O. Publish discovery only once
    // the client knows this session, and discard results for old attachments.
    setTimeout(() => {
      void options.backend.configOptions!(sessionId, true)
        .then(async () => {
          // Discovery may finish while a choice is being prepared. Read its
          // accepted selection after settlement, including rejected choices,
          // so a fast choice cannot hide the newly discovered catalog.
          while (clients.get(sessionId) === adapted) {
            await configurationChanges.get(sessionId)?.catch(() => undefined);
            const version = configurationVersions.get(sessionId);
            const refreshed = await options.backend.configOptions!(sessionId);
            if (clients.get(sessionId) !== adapted) return;
            if (configurationVersions.get(sessionId) !== version || configurationChanges.has(sessionId)) continue;
            await client.notify(acp.methods.client.session.update, {
              sessionId,
              update: { sessionUpdate: 'config_option_update', configOptions: refreshed },
            });
            return;
          }
        })
        .catch((error: unknown) =>
          options.logger.error('ACP model catalog refresh failed', {
            sessionId,
            errorMessage: error instanceof Error ? error.message : String(error),
          }),
        );
    }, 0);
    const mode = configOptions.find((option) => option.id === 'mode');
    const modes =
      mode?.type === 'select'
        ? {
            currentModeId: mode.currentValue,
            availableModes: mode.options.flatMap((option) => {
              if (!('value' in option)) return [];
              const { value, ...details } = option;
              return [{ id: value, ...details }];
            }),
          }
        : undefined;
    return { configOptions, ...(modes ? { modes } : {}) };
  };
  const extensions = (params: { mcpServers?: unknown[]; additionalDirectories?: unknown[] }): void => {
    if (params.additionalDirectories?.length)
      throw acp.RequestError.invalidParams(undefined, 'Additional directories are not supported');
  };
  onRequest(acp.methods.agent.initialize, ({ params }) => {
    capabilities = params.clientCapabilities;
    return {
      protocolVersion: 1,
      agentInfo: { name: 'term2', title: 'Term2', version: options.version },
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        ...(options.backend.mcpCapabilities ? { mcpCapabilities: options.backend.mcpCapabilities } : {}),
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
    };
  });
  onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
    extensions(params);
    const adapted = v1Client(client, { cwd: params.cwd, capabilities });
    const session = await options.backend.createSession({ cwd: params.cwd, mcpServers: params.mcpServers }, adapted);
    clients.set(session.sessionId, adapted);
    return { sessionId: session.sessionId, ...(await configuration(session.sessionId, adapted, client)) };
  });
  onRequest(acp.methods.agent.session.list, async ({ params }) => await options.backend.listSessions(params));
  onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    extensions(params);
    if (active.has(params.sessionId)) throw new acp.RequestError(-32000, 'Cannot load an active ACP prompt');
    const adapted = v1Client(client, { cwd: params.cwd, capabilities });
    await options.backend.resumeSession({ ...params, replayFrom: { type: 'start' } }, adapted);
    clients.set(params.sessionId, adapted);
    return await configuration(params.sessionId, adapted, client);
  });
  onRequest(acp.methods.agent.session.resume, async ({ params, client }) => {
    extensions(params);
    if (active.has(params.sessionId)) throw new acp.RequestError(-32000, 'Cannot resume an active ACP prompt');
    const adapted = v1Client(client, { cwd: params.cwd, capabilities });
    await options.backend.resumeSession(
      { sessionId: params.sessionId, cwd: params.cwd, mcpServers: params.mcpServers },
      adapted,
    );
    clients.set(params.sessionId, adapted);
    return await configuration(params.sessionId, adapted, client);
  });
  const setConfigOption = async (params: acp.SetSessionConfigOptionRequest) => {
    if (!clients.has(params.sessionId)) throw new acp.RequestError(-32001, `Session not found: ${params.sessionId}`);
    if (!options.backend.setConfigOption) throw acp.RequestError.methodNotFound('session/set_config_option');
    configurationVersions.set(params.sessionId, (configurationVersions.get(params.sessionId) ?? 0) + 1);
    const change = options.backend.setConfigOption(params);
    configurationChanges.set(params.sessionId, change);
    try {
      return { configOptions: await change };
    } finally {
      if (configurationChanges.get(params.sessionId) === change) configurationChanges.delete(params.sessionId);
    }
  };
  onRequest(acp.methods.agent.session.setConfigOption, async ({ params, client }) => {
    const result = await setConfigOption(params);
    if (params.configId === 'mode' && typeof params.value === 'string') {
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: params.value },
      });
    }
    return result;
  });
  onRequest(acp.methods.agent.session.setMode, async ({ params, client }) => {
    const { configOptions } = await setConfigOption({
      sessionId: params.sessionId,
      configId: 'mode',
      value: params.modeId,
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions },
    });
    return {};
  });
  onRequest(acp.methods.agent.session.prompt, async ({ params }) => {
    if (active.has(params.sessionId))
      throw new acp.RequestError(-32000, 'Session is already processing foreground work');
    const adapted = clients.get(params.sessionId);
    if (!adapted) throw new acp.RequestError(-32001, `Session not found: ${params.sessionId}`);
    const controller = new AbortController();
    active.set(params.sessionId, controller);
    try {
      const execution = await options.backend.preparePrompt({ ...params, prompt: v1Prompt(params.prompt) });
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
  onRequest(acp.methods.agent.session.close, async ({ params }) => {
    active.get(params.sessionId)?.abort();
    await options.backend.closeSession(params.sessionId);
    clients.delete(params.sessionId);
    configurationVersions.delete(params.sessionId);
    return {};
  });
  return app;
}
