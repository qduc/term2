/**
 * Who pays for a nested run. The surface built the request, so it alone knows the
 * child's role, tools and workspace, and it refuses a request it did not build.
 * This checks the one thing the surface must not decide alone: the model has to
 * be the session's or one the role's own setting names, as the source picks it,
 * so a nested run can never choose who gets billed.
 */
import {
  getTierModelPoolEntries,
  type AncillaryModelTier,
} from '../../../source/services/agent-runtime/model-resolver.js';
import { getAncillaryTierForRole } from '../../../source/services/subagents/subagent-pool-config.js';
import type { DirectNestedAuthority, DirectNestedAuthorizer } from '../session/direct-branches.js';
import type { NestedRunRequest } from '../tools/index.js';
import type { ModelRef } from '../model/index.js';
import type { ProfileSelection } from './tool-contract.js';

const HELPER_TIERS: readonly AncillaryModelTier[] = ['smart', 'balanced', 'cheap', 'chore'];

export function createNestedAuthorizer(
  settings: ProfileSelection['settings'],
  sessionModel: ModelRef,
  resolve: (request: NestedRunRequest) => DirectNestedAuthority,
): DirectNestedAuthorizer {
  return (request) => {
    const authority = resolve(request);
    const { provider, model } = authority.request.model;
    // Read per run, as the source does. Mentor has a tier like any role, used when its
    // own pool is empty. An AgentSpec names its own model, so any helper tier will do.
    const tiers = authority.role === 'agent' ? HELPER_TIERS : [getAncillaryTierForRole(authority.role)];
    const pool = [
      ...tiers.flatMap((tier) => getTierModelPoolEntries(tier, settings)),
      ...(authority.role === 'mentor' ? settings.get('agent.mentorPool') : []),
    ];
    if (![sessionModel, ...pool].some((entry) => entry.provider === provider && entry.model === model)) {
      throw new Error(`A ${authority.role} run may not use ${provider}/${model}: no setting names that model.`);
    }
    return authority;
  };
}
