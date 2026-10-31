/** Snapshot projection of the actual M2 facade. Missing later fields are not inferred from private state. */
import type { DirectSessionState } from '../session/facade-types.js';
import { DIRECT_PROTOCOL_VERSION, type WireSnapshot } from './direct-wire.js';
import { contentText, publicContent, publicInteraction, publicJson, publicToolContent } from './direct-public.js';

export function snapshotDirectState(state: DirectSessionState, previous?: WireSnapshot): WireSnapshot {
  return {
    protocolVersion: DIRECT_PROTOCOL_VERSION, sessionId: state.id, seq: previous?.seq ?? null,
    status: state.status, model: { provider: state.model.provider, model: state.model.model },
    configuration: { ...previous?.configuration, model: { provider: state.model.provider, model: state.model.model } },
    activeTurnId: state.status === 'idle' || state.status === 'closed' ? null : state.activeTurnId,
    messages: state.messages.map(item => {
      const content = publicContent(item.content);
      const known = previous?.messages.find(message => message.id === item.id);
      const draft = state.drafts.find(draft => draft.id === item.id);
      return { ...known, ...(draft ? { draft: true, turnId: draft.turnId, modelStep: draft.modelStep } : {}), id: item.id, role: item.role, content, text: contentText(content) };
    }),
    tools: state.tools.map(tool => {
      const known = previous?.tools.find(item => item.executionId === tool.executionId);
      const detail = state.tools.find(item => item.executionId === tool.executionId);
      return { ...known, executionId: tool.executionId, turnId: tool.turnId, toolName: tool.toolName,
        ...(detail ? { callId: detail.callId, ...(detail.parentExecutionId ? { parentExecutionId: detail.parentExecutionId } : {}), ...(detail.isError !== undefined ? { isError: detail.isError } : {}) } : {}),
        ...(tool.display !== undefined ? { display: publicJson(tool.display) } : {}),
        ...(tool.providerOutput ? { content: publicToolContent(tool.providerOutput) } : {}),
        input: publicJson(tool.input), status: tool.status, ...(tool.output !== undefined ? { output: tool.output } : {}) };
    }),
    pendingInteractions: state.pendingInteractions.map(publicInteraction),
    admissions: state.admissions.map(admission => ({ ...admission })),
    usage: { ...state.usage }, reasoning: state.reasoning,
    retryEligibility: previous?.retryEligibility ?? { turn: false, tool: false },
    queue: previous?.queue ?? [], queueState: previous?.queueState ?? 'idle', tasks: previous?.tasks ?? [],
    cost: previous?.cost ?? null, goal: previous?.goal ?? null, verification: previous?.verification ?? null,
    notices: previous?.notices ?? [], lastError: state.terminal?.error ?? null,
    terminal: state.terminal, timeline: previous?.timeline ?? null,
  };
}
