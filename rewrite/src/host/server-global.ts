/** Host/config-only RPCs. No global setting or credential mutation becomes a Session fact. */
import type {
  ServerHostDependencies,
  ServerRequest,
  ServerResult,
  Principal,
  SafeSettingValue,
} from './server-contracts.js';
import type { PrivateRoute } from './server-routes.js';
import { publicError } from './server-errors.js';
import * as validate from './server-validation.js';

/** Serializes the existing two mutation lanes; delegates actual transactions to the app authority. */
export class ServerGlobalRoutes {
  #settingsMutation: Promise<unknown> = Promise.resolve();
  #oauthMutation: Promise<unknown> = Promise.resolve();
  constructor(readonly dependencies: ServerHostDependencies) {}
  async handle(route: PrivateRoute, input: ServerRequest, principal: Principal): Promise<ServerResult | null> {
    const { body, url } = input;
    const { workspaces, configuration: config } = this.dependencies;
    switch (route.purpose) {
      case 'workspace_list': {
        const limit = validate.parseQueryLimit(url.searchParams.get('limit')) ?? 20;
        if (limit < 1 || limit > 50 || url.searchParams.has('cursor'))
          return publicError(400, 'invalid_cursor', 'workspace cursor is invalid');
        if (!workspaces) return missing('workspace admission');
        return {
          status: 200,
          body: { workspaces: (await workspaces.list(principal)).slice(0, limit), nextCursor: null },
        };
      }
      case 'workspace_candidate_validate':
        if (!validate.isWorkspaceCandidateValidateBody(body)) return invalid('workspace');
        return workspaces?.validate
          ? { status: 200, body: await workspaces.validate(principal, body.absolutePath) }
          : missing('workspace candidates');
      case 'workspace_candidate_browse':
        if (!validate.isWorkspaceCandidateBrowseBody(body)) return invalid('workspace');
        return workspaces?.browse
          ? { status: 200, body: await workspaces.browse(principal, body.candidateId, body.child) }
          : missing('workspace candidates');
      case 'workspace_candidate_select':
        if (!validate.isWorkspaceCandidateSelectBody(body)) return invalid('workspace');
        return workspaces?.select
          ? { status: 200, body: await workspaces.select(principal, body.candidateId, body.access) }
          : missing('workspace candidates');
      case 'model_list':
        return this.dependencies.models
          ? { status: 200, body: { models: await this.dependencies.models() } }
          : publicError(503, 'model_catalog_unavailable', 'model catalog unavailable', true);
      case 'settings_read':
        return config?.read ? { status: 200, body: await config.read() } : settingsMissing();
      case 'settings_write':
        if (!config?.write) return settingsMissing();
        if (!validate.isSettingsWriteBody(body)) return invalid('settings');
        return this.#serialize('settings', async () => {
          const projection = await config.write!(
            body.expectedRevision,
            body.changes as { key: string; value: SafeSettingValue }[],
          );
          return { status: 200, body: { committed: true, revision: projection.revision, projection } };
        });
      case 'credential_write':
        if (!config?.setCredential) return settingsMissing();
        if (!validate.isCredentialWriteBody(body)) return invalid('credential');
        return this.#serialize('settings', async () => ({
          status: 200,
          body: await config.setCredential!(route.interactionId!, body.value),
        }));
      case 'credential_delete':
        return config?.deleteCredential
          ? this.#serialize('settings', async () => ({
              status: 200,
              body: await config.deleteCredential!(route.interactionId!),
            }))
          : settingsMissing();
      case 'oauth_login':
      case 'oauth_select':
      case 'oauth_delete': {
        const [provider, resource] = route.interactionId!.split('\u0000');
        if (provider !== 'codex' && provider !== 'grok') return invalid('OAuth');
        if (route.purpose === 'oauth_select' && !validate.isOAuthSelectBody(body)) return invalid('OAuth');
        if (route.purpose === 'oauth_login')
          return config?.oauthLogin
            ? this.#serialize('oauth', async () => {
                // The gateway intentionally reports an incomplete login without exposing provider errors.
                try {
                  return { status: 200, body: await config.oauthLogin!(provider) };
                } catch {
                  return { status: 200, body: { status: 'not_completed' } };
                }
              })
            : settingsMissing();
        if (route.purpose === 'oauth_select') {
          const selection = body as { accountId: string };
          return config?.oauthSelect
            ? this.#serialize('oauth', async () => ({
                status: 200,
                body: await config.oauthSelect!(provider, selection.accountId),
              }))
            : settingsMissing();
        }
        return config?.oauthDelete
          ? this.#serialize('oauth', async () => ({
              status: 200,
              body: await config.oauthDelete!(provider, resource),
            }))
          : settingsMissing();
      }
      default:
        return null;
    }
  }
  async #serialize(lane: 'settings' | 'oauth', operation: () => Promise<ServerResult>): Promise<ServerResult> {
    const previous = lane === 'settings' ? this.#settingsMutation : this.#oauthMutation;
    const result = previous.then(operation, operation);
    if (lane === 'settings') this.#settingsMutation = result.catch(() => undefined);
    else this.#oauthMutation = result.catch(() => undefined);
    return result;
  }
}
function invalid(kind: string): ServerResult {
  return publicError(400, 'validation_error', `${kind} request is invalid`);
}
function missing(kind: string): ServerResult {
  return publicError(503, 'gateway_unavailable', `${kind} is unavailable`, true);
}
function settingsMissing(): ServerResult {
  return publicError(503, 'settings_unavailable', 'settings unavailable', true);
}
