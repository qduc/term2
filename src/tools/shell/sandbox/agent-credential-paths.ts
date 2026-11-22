import path from 'node:path';
import envPaths from 'env-paths';
import { resolveSettingsDirectory } from '../../../config/settings/settings-path.js';

/**
 * Paths a sandboxed command must not read because they hold Term2's own secrets
 * or another coding agent's tokens (docs/plans/approvals-and-sandbox/headless-approval-redesign.md,
 * decision 5).
 *
 * Term2's directories are denied whole, not file by file: the settings directory
 * holds `settings.json` (the only place API keys live) and its lock, temp and
 * `.corrupt-*` copies; the config directory holds `codex-auth.json`,
 * `grok-auth.json` and `mcp-oauth.json`. A file added to either later is hidden
 * without updating this list, which is how `settings.json` went unlisted when
 * keys moved into it. The data directory stays readable (conversations, memory),
 * except the direct MCP token store kept there.
 *
 * Other agents are listed by file, because their directories also hold config and
 * skills the agent legitimately reads. Both the default location and the
 * environment override each tool honours are listed; the sandbox skips paths
 * that do not exist.
 */
export function agentCredentialPaths(home: string, env: NodeJS.ProcessEnv): string[] {
  const term2 = envPaths('term2');
  const settingsDirectories = [
    resolveSettingsDirectory({ homeDir: home, env }),
    // `sandboxUserStateRoot` ignores XDG_STATE_HOME; cover the home-derived location too.
    resolveSettingsDirectory({ homeDir: home, env: {} }),
  ];
  const configDirectories = [env.TERM2_CONFIG_DIR, term2.config];
  // `application-mcp.ts` keeps it beside the conversations directory, which TERM2_CONVERSATIONS_DIR can move.
  const mcpTokenStores = [
    path.join(term2.data, 'direct-mcp-oauth.json'),
    env.TERM2_CONVERSATIONS_DIR && path.join(path.dirname(env.TERM2_CONVERSATIONS_DIR), 'direct-mcp-oauth.json'),
  ];
  const otherAgents = [
    env.CODEX_HOME && path.join(env.CODEX_HOME, 'auth.json'),
    path.join(home, '.codex', 'auth.json'),
    env.CHATGPT_LOCAL_HOME && path.join(env.CHATGPT_LOCAL_HOME, 'auth.json'),
    path.join(home, '.chatgpt-local', 'auth.json'),
    env.GROK_HOME && path.join(env.GROK_HOME, 'auth.json'),
    path.join(home, '.grok', 'auth.json'),
    env.CLAUDE_CONFIG_DIR && path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json'),
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.gemini', 'oauth_creds.json'),
    path.join(home, '.local', 'share', 'opencode', 'auth.json'),
  ];
  return Array.from(
    new Set(
      [...settingsDirectories, ...configDirectories, ...mcpTokenStores, ...otherAgents]
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        .map((entry) => path.resolve(entry)),
    ),
  );
}
