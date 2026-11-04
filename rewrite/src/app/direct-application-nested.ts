/**
 * Who pays for a nested run. The surface built the request, so it alone knows the
 * child's role, tools and workspace, and it refuses a request it did not build.
 * The model is the one legacy would run: the spec's own, the role's pool, or the
 * agent.modelSelection fallback. Legacy adds no allowlist; its only model refusal
 * (allowedModels) comes from its own permission resolver on the spec path.
 */
import type { DirectNestedAuthority, DirectNestedAuthorizer } from '../session/direct-branches.js';
import type { NestedRunRequest } from '../tools/index.js';

export function createNestedAuthorizer(
  resolve: (request: NestedRunRequest) => DirectNestedAuthority,
): DirectNestedAuthorizer {
  return (request) => resolve(request);
}
