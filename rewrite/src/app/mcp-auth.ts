/** Explicit app-owned MCP OAuth authority. Reuses the existing credential writer. */
import { runMcpOAuthLogin, type McpOAuthLoginResult } from '../../../source/services/mcp/mcp-oauth-login.js';
import { normalizeMcpServerUrl, type McpOAuthStore } from '../../../source/services/mcp/mcp-oauth-store.js';
import type { McpOAuthTarget } from '../../../source/services/mcp/mcp-connection-manager.js';

export type DirectMcpOAuth = {
  /** Supplied by the app credential owner; never constructed at a default path here. */
  readonly store: McpOAuthStore;
  login?(
    target: McpOAuthTarget,
    signal: AbortSignal,
    onAuthorizationUrl?: (url: string) => void,
  ): Promise<McpOAuthLoginResult>;
};

/**
 * Create once per credential owner, not per surface generation. Only an explicit
 * local command may call login; connecting/refreshing never opens a browser.
 * The source store retains URL/issuer scoping, atomic writes and permissions.
 */
export function createDirectMcpOAuth(options: {
  readonly store: McpOAuthStore;
  /** Explicit local capability; no implicit source default browser launcher. */
  readonly openBrowser: (url: string) => void;
  readonly onAuthorizationUrl?: (url: string) => void;
}): DirectMcpOAuth {
  const pending = new Set<string>();
  return {
    store: options.store,
    async login(target, signal, onAuthorizationUrl) {
      signal.throwIfAborted();
      const key = normalizeMcpServerUrl(target.serverUrl);
      // Two flows for one URL share the source store's PKCE verifier slot.
      // Reject duplicate human requests rather than overwrite that authority.
      if (pending.has(key)) throw new Error(`MCP login is already in progress for ${target.serverName}.`);
      pending.add(key);
      try {
        return await runMcpOAuthLogin({
          ...target,
          store: options.store,
          signal,
          openBrowser: options.openBrowser,
          ...(onAuthorizationUrl ?? options.onAuthorizationUrl
            ? { onAuthorizationUrl: onAuthorizationUrl ?? options.onAuthorizationUrl }
            : {}),
        });
      } finally {
        pending.delete(key);
      }
    },
  };
}
