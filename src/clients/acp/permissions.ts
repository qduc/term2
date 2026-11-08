import type { AcpClient } from './contract.js';
import type * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { WireGrant, WireInteraction } from '../../protocol/wire.js';

import type { AcpAnswer } from './contract.js';
import { requestQuestion } from './questions.js';

// Preserve existing option ids. Scoped choices are offered only when Session
// explicitly advertises support; never cache or expand grants client-side.
const OPTIONS: readonly acp.PermissionOption[] = [
  { optionId: 'approve', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
];

const GRANTS: Partial<Record<WireGrant, { name: string; kind: acp.PermissionOptionKind }>> = {
  'allow-remember': { name: 'Allow with the offered remembered scope', kind: 'allow_always' },
  'allow-folder-session': { name: 'Allow this folder for the session', kind: 'allow_always' },
  'allow-edit-file-session': { name: 'Allow editing this file for the session', kind: 'allow_always' },
  'allow-edit-folder-session': { name: 'Allow editing this folder for the session', kind: 'allow_always' },
  'docker-allow-once': { name: 'Allow once in Docker', kind: 'allow_once' },
  'docker-allow-session': { name: 'Allow in Docker for the session', kind: 'allow_always' },
  'docker-allow-project': { name: 'Allow in Docker for this project', kind: 'allow_always' },
};

/**
 * Request one exact wire-owned approval. Cancellation, unsupported methods and
 * unknown selections deny; grants and answer validity remain Session-owned.
 * Questions use standard structured form elicitation, not approval prompts.
 */
export async function requestPermission(input: {
  readonly sessionId: string;
  readonly interaction: WireInteraction;
  readonly client: AcpClient;
  readonly signal: AbortSignal;
}): Promise<AcpAnswer> {
  const interaction = input.interaction;
  if (interaction.kind === 'question') return await requestQuestion(input);
  // Unsandboxed grants remain excluded from ACP's security posture even if an
  // incorrectly composed Session advertises them. Other grants need exact scope
  // validation by the actual wire capability, never a conversion to allow.
  const grants = interaction.supportedGrants.filter((grant) => GRANTS[grant]);
  const options = [...OPTIONS, ...grants.map((grant) => ({ optionId: grant, ...GRANTS[grant]! }))];
  try {
    const response = await input.client.permission(
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
        options,
      },
      input.signal,
    );
    if (input.signal.aborted) {
      return {
        decision: { kind: 'deny', reason: 'Permission request was cancelled.' },
        provenance: { source: 'system' },
      };
    }
    if (response?.outcome.outcome === 'cancelled') {
      return {
        decision: { kind: 'deny', reason: 'Permission request was cancelled.' },
        provenance: { source: 'user' },
      };
    }
    if (response?.outcome.outcome !== 'selected') {
      return { decision: { kind: 'deny', reason: 'Invalid permission response.' }, provenance: { source: 'system' } };
    }
    const optionId = response.outcome.optionId;
    // Older clients used allow-once for the approve option; retain that alias.
    switch (optionId) {
      case 'approve':
      case 'allow-once':
        return { decision: { kind: 'allow' }, provenance: { source: 'user' } };
      case 'reject':
        return { decision: { kind: 'deny', reason: 'Permission denied by client.' }, provenance: { source: 'user' } };
      default: {
        const grant = grants.find((grant) => grant === optionId);
        return grant
          ? { decision: { kind: 'grant', grant }, provenance: { source: 'user' } }
          : {
              decision: { kind: 'deny', reason: 'Client selected an unknown permission option.' },
              provenance: { source: 'system' },
            };
      }
    }
  } catch {
    return {
      decision: { kind: 'deny', reason: 'Permission request failed or is not supported by the client.' },
      provenance: { source: 'system' },
    };
  }
}
