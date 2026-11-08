import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { WireAnswerProvenance, WireBudgetDecision, WireBudgetRequest } from '../../protocol/wire.js';

type BudgetAnswer = { readonly decision: WireBudgetDecision; readonly provenance: WireAnswerProvenance };
const stop = (source: 'user' | 'system'): BudgetAnswer => ({ decision: { kind: 'stop' }, provenance: { source } });

/** Ask about an actual native budget pause; only an explicit client choice requests a human extension. */
export async function requestBudget(input: {
  readonly sessionId: string;
  readonly request: WireBudgetRequest;
  readonly client: acp.AgentContext;
  readonly signal: AbortSignal;
}): Promise<BudgetAnswer> {
  try {
    const { request } = await input.client.initialized;
    if (request.capabilities?.elicitation?.form == null) return stop('system');
    const response = await input.client.request(
      acp.methods.client.elicitation.create,
      {
        mode: 'form',
        sessionId: input.sessionId,
        message: `Run budget requires a decision. Accepted evidence: ${JSON.stringify({
          evidence: input.request.evidence,
          snapshot: input.request.snapshot,
        })}`,
        requestedSchema: {
          type: 'object',
          properties: {
            decision: {
              type: 'string',
              title: 'Run budget',
              oneOf: [
                { const: 'extend', title: 'Continue with a human-approved budget extension' },
                { const: 'stop', title: 'Stop this run' },
              ],
            },
          },
          required: ['decision'],
        },
      },
      { cancellationSignal: input.signal },
    );
    if (input.signal.aborted) return stop('system');
    if (response.action === 'decline' || response.action === 'cancel') return stop('user');
    if (
      response.action !== 'accept' ||
      !response.content ||
      typeof response.content !== 'object' ||
      Array.isArray(response.content)
    )
      return stop('system');
    const content = response.content as Record<string, unknown>;
    if (Object.keys(content).length !== 1) return stop('system');
    if (content.decision === 'extend')
      return { decision: { kind: 'extend', grantedBy: 'human' }, provenance: { source: 'user' } };
    if (content.decision === 'stop') return stop('user');
    return stop('system');
  } catch {
    return stop('system');
  }
}
