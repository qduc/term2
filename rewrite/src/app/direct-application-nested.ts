/**
 * Who pays for a nested run. The surface built the request, so it alone knows the
 * child's role, tools and workspace, and it refuses a request it did not build.
 * This checks the one thing the surface must not decide alone: the model has to
 * be the session's or one the user's settings name for helper work, so a nested
 * run can never choose who gets billed.
 */
import {
  getTierModelPoolEntries,
  type AncillaryModelTier,
} from '../../../source/services/agent-runtime/model-resolver.js';
import type { DirectNestedAuthority, DirectNestedAuthorizer } from '../session/direct-branches.js';
import type { NestedRunRequest } from '../tools/index.js';
import type { ModelRef } from '../model/index.js';
import type { ProfileSelection } from './tool-contract.js';

const HELPER_TIERS: readonly AncillaryModelTier[] = ['smart', 'balanced', 'cheap', 'chore'];

export function createNestedAuthorizer(
  settings: ProfileSelection['settings'],
  sessionModel: ModelRef,
  resolve: (request: NestedRunRequest) => DirectNestedAuthority | Promise<DirectNestedAuthority>,
): DirectNestedAuthorizer {
  return async (request) => {
    const authority = await resolve(request);
    const { provider, model } = authority.request.model;
    // Mentor draws from its own pool; no other role may reach it.
    const named = [
      sessionModel,
      ...HELPER_TIERS.flatMap((tier) => getTierModelPoolEntries(tier, settings)),
      ...(authority.role === 'mentor' ? settings.get('agent.mentorPool') : []),
    ];
    if (!named.some((entry) => entry.provider === provider && entry.model === model)) {
      throw new Error(`Nested runs may not use ${provider}/${model}: no setting names that model.`);
    }
    return authority;
  };
}
