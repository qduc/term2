/**
 * Who may run a nested request from a session. A child runs in the session's own
 * workspace with its own tools, so it can never reach further than its parent.
 * Its model must be the session's, or one the user's settings name for helper
 * work: naming a model anywhere else would choose who gets billed.
 */
import {
  getTierModelPoolEntries,
  type AncillaryModelTier,
} from '../../../source/services/agent-runtime/model-resolver.js';
import type { DirectNestedAuthorizer } from '../session/direct-branches.js';
import type { DirectRuntimeContext } from '../session/direct-store.js';
import type { ToolRegistry } from '../tools/index.js';
import type { ProfileSelection } from './tool-contract.js';

const HELPER_TIERS: readonly AncillaryModelTier[] = ['smart', 'balanced', 'cheap', 'chore'];

export function createNestedAuthorizer(
  settings: ProfileSelection['settings'],
  { model, workspace }: DirectRuntimeContext,
  tools: ToolRegistry,
): DirectNestedAuthorizer {
  return (request) => {
    const allowed = [model, ...HELPER_TIERS.flatMap((tier) => getTierModelPoolEntries(tier, settings))];
    const { provider, model: id } = request.model;
    if (!allowed.some((entry) => entry.provider === provider && entry.model === id)) {
      throw new Error(`Nested runs may not use ${provider}/${id}: no setting names that model.`);
    }
    // The request carries no role, so this names what it is rather than guessing one.
    return { request, workspace, tools, role: 'nested', label: `Nested run on ${provider}/${id}` };
  };
}
