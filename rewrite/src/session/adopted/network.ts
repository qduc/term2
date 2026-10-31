/** Private Session-owned network facts and ordered projection. */
import { validateCompactionSequence } from '../../../../source/services/conversation/conversation-decoder.js';
import {
  isSandboxNetworkHost,
  isSandboxNetworkPort,
} from '../../../../source/utils/shell/sandbox/sandbox-network-validation.js';
import type { NetworkApprovalAnswer } from '../../../../source/utils/shell/sandbox/sandbox-network-approval.js';

export type NetworkRequestFact = {
  readonly type: 'session_network_requested';
  readonly version: 1;
  readonly requestId: string;
  readonly generation: string;
  readonly host: string;
  readonly port?: number;
};
export type NetworkResolution =
  | { readonly kind: 'answered'; readonly answer: NetworkApprovalAnswer }
  | {
      readonly kind: 'cancelled';
      readonly reason: 'execution_ended' | 'helper_lost' | 'session_closed' | 'graph_replaced';
    }
  | { readonly kind: 'recovered'; readonly reason: 'process_restarted' };
export type NetworkResolutionFact = {
  readonly type: 'session_network_resolved';
  readonly version: 1;
  readonly requestId: string;
  readonly generation: string;
  readonly resolution: NetworkResolution;
};
export type NetworkFact = NetworkRequestFact | NetworkResolutionFact;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
export const isNetworkIdentity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value);
export const isNetworkAnswer = (value: unknown): value is NetworkApprovalAnswer =>
  typeof value === 'boolean' ||
  value === 'deny' ||
  value === 'allow-once' ||
  value === 'allow-session' ||
  value === 'allow-project';
export function validateNetworkFact(value: Record<string, unknown>): void {
  if (value['version'] !== 1 || !isNetworkIdentity(value['requestId']) || !isNetworkIdentity(value['generation']))
    throw new Error('invalid network fact identity or version');
  if (value['type'] === 'session_network_requested') {
    if (
      !keys(value, ['type', 'version', 'requestId', 'generation', 'host', 'port']) ||
      !isSandboxNetworkHost(value['host']) ||
      (Object.hasOwn(value, 'port') && !isSandboxNetworkPort(value['port']))
    )
      throw new Error('invalid network request fact');
    return;
  }
  const resolution = value['resolution'];
  if (!keys(value, ['type', 'version', 'requestId', 'generation', 'resolution']) || !object(resolution))
    throw new Error('invalid network resolution fact');
  if (
    resolution['kind'] === 'answered' &&
    keys(resolution, ['kind', 'answer']) &&
    isNetworkAnswer(resolution['answer'])
  )
    return;
  if (
    resolution['kind'] === 'cancelled' &&
    keys(resolution, ['kind', 'reason']) &&
    typeof resolution['reason'] === 'string' &&
    ['execution_ended', 'helper_lost', 'session_closed', 'graph_replaced'].includes(resolution['reason'])
  )
    return;
  if (
    resolution['kind'] === 'recovered' &&
    keys(resolution, ['kind', 'reason']) &&
    resolution['reason'] === 'process_restarted'
  )
    return;
  throw new Error('invalid network resolution');
}

/** Reject impossible history rather than silently making an orphan actionable. */
export function projectNetworkFacts(facts: readonly { readonly type: string }[]): readonly NetworkRequestFact[] {
  validateCompactionSequence(facts, { requireSessionBound: true });
  const seen = new Set<string>();
  const pending: NetworkRequestFact[] = [];
  for (const raw of facts) {
    if (raw.type === 'context_compaction_recorded') {
      if (pending.length > 0) throw new Error('context_compaction_recorded while network approval is pending');
    } else if (raw.type === 'session_network_requested') {
      const fact = raw as NetworkRequestFact;
      if (seen.has(fact.requestId)) throw new Error('duplicate network request id');
      seen.add(fact.requestId);
      pending.push(fact);
    } else if (raw.type === 'session_network_resolved') {
      const fact = raw as NetworkResolutionFact;
      const index = pending.findIndex(
        (request) => request.requestId === fact.requestId && request.generation === fact.generation,
      );
      if (index < 0 || (fact.resolution.kind === 'answered' && index !== 0))
        throw new Error('invalid network resolution order or identity');
      pending.splice(index, 1);
    }
  }
  return pending;
}
