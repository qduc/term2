import * as v1 from '@agentclientprotocol/sdk';
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import type { AcpClient } from './contract.js';
import { v1Tool, V1Output } from './v1-output.js';

/** Preserve the existing v2 context behind the backend's transport-independent operations. */
export function v2Client(client: v2.AgentContext): AcpClient {
  return {
    update: (notification) => client.notify(v2.methods.client.session.update, notification),
    permission: (request, signal) =>
      client.request(v2.methods.client.session.requestPermission, request, { cancellationSignal: signal }),
    supportsForms: async () => (await client.initialized).request.capabilities?.elicitation?.form != null,
    elicit: (request, signal) =>
      client.request(v2.methods.client.elicitation.create, request, { cancellationSignal: signal }),
  };
}

/** Translate permissions and append-only display for v1; unsupported forms keep the native stop fallback. */
export function v1Client(
  client: v1.AgentContext,
  options: {
    readonly cwd: string;
    readonly capabilities?: v1.InitializeRequest['clientCapabilities'];
  },
): AcpClient {
  const output = new V1Output(options);
  return {
    supportsShellEscape: true,
    promptAccepted: (sessionId, messageId) => output.promptAccepted(sessionId, messageId),
    async update({ sessionId, update }) {
      for (const translated of output.translate(sessionId, update))
        await client.notify(v1.methods.client.session.update, { sessionId, update: translated });
    },
    async permission(request, signal) {
      if (request.subject?.type !== 'tool_call') throw v1.RequestError.invalidParams();
      const subject = request.subject as v2.ToolCallPermissionSubject;
      const response: v1.RequestPermissionResponse = await client.request(
        v1.methods.client.session.requestPermission,
        {
          sessionId: request.sessionId,
          toolCall: {
            ...v1Tool(subject.toolCall),
            title: request.description ?? request.title ?? subject.toolCall.title,
          },
          options: request.options,
        },
        { cancellationSignal: signal },
      );
      // A legacy alias must never authorize a choice this v1 client was not offered.
      if (response.outcome.outcome === 'selected') {
        const optionId = response.outcome.optionId;
        if (!request.options.some((option) => option.optionId === optionId))
          throw v1.RequestError.invalidParams(undefined, 'Permission option was not offered');
      }
      return response;
    },
    supportsForms: async () => options.capabilities?.elicitation?.form != null,
    elicit: (request, signal) =>
      client.request(v1.methods.client.elicitation.create, request, { cancellationSignal: signal }),
  };
}
