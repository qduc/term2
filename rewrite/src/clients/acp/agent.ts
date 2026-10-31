import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { AcpBackend, AcpLogger, PromptExecution } from './contract.js';
import { errorMessage } from './contract.js';

export type AcpAgentOptions = {
  readonly backend: AcpBackend;
  readonly logger: AcpLogger;
  readonly version: string;
};

type ActivePrompt = {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  settle(): void;
};

function reserve(active: Map<string, ActivePrompt>, sessionId: string): ActivePrompt {
  if (active.has(sessionId)) throw new acp.RequestError(-32000, 'Session is already processing foreground work');
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const prompt = { controller: new AbortController(), done, settle };
  active.set(sessionId, prompt);
  return prompt;
}

function assertSessionExtensions(request: Pick<acp.NewSessionRequest, 'additionalDirectories' | 'mcpServers'>): void {
  if (request.additionalDirectories?.length) {
    throw acp.RequestError.invalidParams(undefined, 'additionalDirectories are not supported');
  }
  if (request.mcpServers?.length) throw acp.RequestError.invalidParams(undefined, 'MCP servers are not supported');
}

/**
 * Build the existing experimental ACP v2 message surface around the direct
 * backend. Prompt requests acknowledge admission; output/idle arrive separately
 * through session/update. All runtime actions remain Host wire commands.
 */
export function createAcpAgent(options: AcpAgentOptions): acp.AgentApp {
  const active = new Map<string, ActivePrompt>();
  const app = acp.agent({ name: 'term2' });

  app.onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    info: { name: 'term2', title: 'term2', version: options.version },
    capabilities: { session: {} },
  }));
  app.onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
    assertSessionExtensions(params);
    return await options.backend.createSession({ cwd: params.cwd }, client);
  });
  app.onRequest(acp.methods.agent.session.list, async ({ params }) => await options.backend.listSessions(params));
  app.onRequest(acp.methods.agent.session.resume, async ({ params, client }) => {
    assertSessionExtensions(params);
    if (active.has(params.sessionId)) throw new acp.RequestError(-32000, 'Cannot resume an active ACP prompt');
    return await options.backend.resumeSession(params, client);
  });
  app.onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const prompt = reserve(active, params.sessionId);
    let execution: PromptExecution;
    try {
      execution = await options.backend.preparePrompt(params);
    } catch (error) {
      active.delete(params.sessionId);
      prompt.settle();
      throw error;
    }
    try {
      if (!prompt.controller.signal.aborted)
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'state_update', state: 'running' },
        });
    } catch (error) {
      prompt.controller.abort();
      try {
        await options.backend.cancelSession(params.sessionId);
      } catch (cancelError) {
        options.logger.error('Direct ACP cancellation failed', { errorMessage: errorMessage(cancelError) });
      }
      throw error;
    } finally {
      // Match the existing v2 contract: acknowledge before streaming. This is a
      // task-queue ordering boundary, not a deadline or execution timeout.
      setTimeout(() => {
        void runPrompt({ options, execution, prompt, active, client, sessionId: params.sessionId });
      }, 0);
    }
    return {};
  });
  app.onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
    active.get(params.sessionId)?.controller.abort();
    await options.backend.cancelSession(params.sessionId);
  });
  app.onRequest(acp.methods.agent.session.close, async ({ params }) => {
    const prompt = active.get(params.sessionId);
    prompt?.controller.abort();
    try {
      await options.backend.closeSession(params.sessionId);
    } finally {
      // close detaches even when cancellation fails, which settles this
      // client's run without claiming that shared Session work has stopped.
      await prompt?.done;
    }
    return {};
  });
  return app;
}

async function runPrompt(input: {
  readonly options: AcpAgentOptions;
  readonly execution: PromptExecution;
  readonly prompt: ActivePrompt;
  readonly active: Map<string, ActivePrompt>;
  readonly client: acp.AgentContext;
  readonly sessionId: string;
}): Promise<void> {
  let stopReason: acp.StopReason = '_term2_error';
  try {
    const result = await input.execution.run(async (update) => {
      await input.client.notify(acp.methods.client.session.update, { sessionId: input.sessionId, update });
    }, input.prompt.controller.signal);
    stopReason = result.stopReason;
  } catch (error) {
    input.options.logger.error('Direct ACP prompt execution failed', {
      eventType: 'acp.prompt.failed',
      sessionId: input.sessionId,
      errorMessage: errorMessage(error),
    });
  } finally {
    try {
      await input.client.notify(acp.methods.client.session.update, {
        sessionId: input.sessionId,
        update: { sessionUpdate: 'state_update', state: 'idle', stopReason },
      });
    } catch {
      // A disconnected client cannot receive idle; the direct log remains the
      // source of truth and the host owns continued Session lifetime.
    } finally {
      if (input.active.get(input.sessionId) === input.prompt) input.active.delete(input.sessionId);
      input.prompt.settle();
    }
  }
}
