import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { WireDecision, WireInteraction } from '../../protocol/direct-wire.js';

// Direct Session currently supports allow/deny, not remembered scoped grants.
// Preserve the existing ACP option ids; never advertise unsupported allow_always.
const OPTIONS: readonly acp.PermissionOption[] = [
  { optionId: 'approve', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
];

/**
 * Request one exact wire-owned approval. Cancellation, unsupported methods and
 * unknown selections deny; grants and answer validity remain Session-owned.
 * ACP questions are explicitly stopped, not silently converted to approvals.
 */
export async function requestPermission(input: {
  readonly sessionId: string;
  readonly interaction: WireInteraction;
  readonly client: acp.AgentContext;
  readonly signal: AbortSignal;
}): Promise<WireDecision> {
  const interaction = input.interaction;
  if (interaction.kind === 'question') {
    return { kind: 'deny', reason: 'Questions are not supported over direct ACP.', stopAfterApprovalResolution: true };
  }
  try {
    const response = await input.client.request(
      acp.methods.client.session.requestPermission,
      {
        sessionId: input.sessionId,
        title: interaction.toolName,
        description: interaction.detail ?? interaction.summary,
        subject: {
          type: 'tool_call',
          toolCall: {
            toolCallId: interaction.executionId ?? interaction.requestId,
            title: interaction.toolName,
            name: interaction.toolName,
            rawInput: interaction.input,
            status: 'pending',
          },
        },
        options: [...OPTIONS],
      },
      { cancellationSignal: input.signal },
    );
    if (input.signal.aborted || response?.outcome.outcome !== 'selected') {
      return { kind: 'deny', reason: 'Permission request was cancelled.' };
    }
    // Older clients used allow-once for the approve option; retain that alias.
    switch (response.outcome.optionId) {
      case 'approve':
      case 'allow-once':
        return { kind: 'allow' };
      case 'reject':
        return { kind: 'deny', reason: 'Permission denied by client.' };
      default:
        return { kind: 'deny', reason: 'Client selected an unknown permission option.' };
    }
  } catch {
    return { kind: 'deny', reason: 'Permission request failed or is not supported by the client.' };
  }
}
