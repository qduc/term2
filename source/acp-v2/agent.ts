import * as acp from '@agentclientprotocol/sdk/experimental/v2';

export type AcpV2PromptOutcome = Readonly<{
  stopReason: acp.StopReason;
}>;

export type AcpV2EmitUpdate = (update: acp.SessionUpdate) => Promise<void>;

/**
 * A prompt that has passed admission but has not started producing updates.
 * Keeping admission separate lets the ACP response acknowledge accepted work
 * before the runtime begins streaming it.
 */
export type AcpV2PromptExecution = Readonly<{
  run: (emit: AcpV2EmitUpdate, signal: AbortSignal) => Promise<AcpV2PromptOutcome>;
}>;

/**
 * Protocol-neutral lifecycle required by the ACP adapter. The production
 * implementation will be backed by term2's extracted headless session host;
 * this boundary keeps ACP transport and schema concerns out of that host.
 */
export interface AcpV2SessionBackend {
  createSession(request: Pick<acp.NewSessionRequest, 'cwd'>): Promise<acp.NewSessionResponse>;
  listSessions(request: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse>;
  resumeSession(
    request: Pick<acp.ResumeSessionRequest, 'sessionId' | 'cwd' | 'replayFrom'>,
    emit: AcpV2EmitUpdate,
  ): Promise<acp.ResumeSessionResponse>;
  closeSession(sessionId: acp.SessionId): Promise<void>;
  preparePrompt(request: acp.PromptRequest): Promise<AcpV2PromptExecution>;
  cancelSession(sessionId: acp.SessionId): Promise<void>;
}

export type CreateAcpV2AgentOptions = Readonly<{
  backend: AcpV2SessionBackend;
  version: string;
}>;

type ActivePrompt = Readonly<{
  controller: AbortController;
  done: Promise<void>;
  settle: () => void;
}>;

const unsupportedSessionExtensions = (
  request: Pick<acp.NewSessionRequest, 'additionalDirectories' | 'mcpServers'>,
): void => {
  if (request.additionalDirectories && request.additionalDirectories.length > 0) {
    throw acp.RequestError.invalidParams(undefined, 'additionalDirectories are not supported');
  }
  if (request.mcpServers && request.mcpServers.length > 0) {
    throw acp.RequestError.invalidParams(undefined, 'MCP servers are not supported');
  }
};

/** Build the experimental ACP v2 protocol adapter around a session backend. */
export function createAcpV2Agent(options: CreateAcpV2AgentOptions): acp.AgentApp {
  const activePrompts = new Map<acp.SessionId, ActivePrompt>();
  const app = acp.agent({ name: 'term2' });

  app.onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion === acp.PROTOCOL_VERSION ? params.protocolVersion : acp.PROTOCOL_VERSION,
    info: { name: 'term2', title: 'term2', version: options.version },
    capabilities: { session: {} },
  }));

  app.onRequest(acp.methods.agent.session.new, async ({ params }) => {
    unsupportedSessionExtensions(params);
    return await options.backend.createSession({ cwd: params.cwd });
  });

  app.onRequest(acp.methods.agent.session.list, async ({ params }) => await options.backend.listSessions(params));

  app.onRequest(acp.methods.agent.session.resume, async ({ params, client }) => {
    unsupportedSessionExtensions(params);
    return await options.backend.resumeSession(
      {
        sessionId: params.sessionId,
        cwd: params.cwd,
        ...(params.replayFrom === undefined ? {} : { replayFrom: params.replayFrom }),
      },
      async (update) => {
        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
      },
    );
  });

  app.onRequest(acp.methods.agent.session.close, async ({ params }) => {
    const active = activePrompts.get(params.sessionId);
    active?.controller.abort();
    if (active) await options.backend.cancelSession(params.sessionId);
    await active?.done;
    await options.backend.closeSession(params.sessionId);
    return {};
  });

  app.onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (activePrompts.has(params.sessionId)) {
      throw new acp.RequestError(-32000, 'Session is already processing foreground work');
    }

    const execution = await options.backend.preparePrompt(params);
    const controller = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const active = { controller, done, settle };
    activePrompts.set(params.sessionId, active);
    try {
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'state_update', state: 'running' },
      });
    } catch (error) {
      activePrompts.delete(params.sessionId);
      controller.abort();
      settle();
      await options.backend.cancelSession(params.sessionId);
      throw error;
    }

    setTimeout(() => {
      void runPrompt({
        sessionId: params.sessionId,
        execution,
        controller,
        client,
        activePrompts,
      }).finally(settle);
    }, 0);
    return {};
  });

  app.onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
    activePrompts.get(params.sessionId)?.controller.abort();
    await options.backend.cancelSession(params.sessionId);
  });

  return app;
}

async function runPrompt(input: {
  sessionId: acp.SessionId;
  execution: AcpV2PromptExecution;
  controller: AbortController;
  client: acp.AgentContext;
  activePrompts: Map<acp.SessionId, ActivePrompt>;
}): Promise<void> {
  let stopReason: acp.StopReason = '_term2_error';
  try {
    if (input.controller.signal.aborted) {
      stopReason = 'cancelled';
    } else {
      const result = await input.execution.run(async (update) => {
        await input.client.notify(acp.methods.client.session.update, { sessionId: input.sessionId, update });
      }, input.controller.signal);
      stopReason = input.controller.signal.aborted ? 'cancelled' : result.stopReason;
    }
  } catch {
    if (input.controller.signal.aborted) stopReason = 'cancelled';
  } finally {
    if (input.activePrompts.get(input.sessionId)?.controller === input.controller) {
      input.activePrompts.delete(input.sessionId);
    }
    try {
      await input.client.notify(acp.methods.client.session.update, {
        sessionId: input.sessionId,
        update: { sessionUpdate: 'state_update', state: 'idle', stopReason },
      });
    } catch {
      // A disconnected client cannot receive the terminal update. Session
      // persistence remains the source of truth for a later resume.
    }
  }
}
