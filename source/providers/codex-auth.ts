import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';
import { runPkceLoopbackLogin } from './oauth-pkce.js';
import type { PkceLoginConfig } from './oauth-pkce.js';

/**
 * Codex (ChatGPT) OAuth 2.0 + PKCE login and token storage.
 *
 * The client id and loopback redirect are the ones the official `codex` CLI
 * registers with https://auth.openai.com. They are public by design (a native
 * app cannot keep a secret) but load-bearing: the authorization server rejects
 * an unregistered redirect_uri or client_id outright.
 */
export const CODEX_OAUTH_ISSUER = 'https://auth.openai.com';
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTHORIZE_ENDPOINT = `${CODEX_OAUTH_ISSUER}/oauth/authorize`;
export const CODEX_TOKEN_ENDPOINT = `${CODEX_OAUTH_ISSUER}/oauth/token`;
/** The authorization server only accepts this exact loopback callback. */
export const CODEX_REDIRECT_PORT = 1455;
export const CODEX_REDIRECT_URI = `http://localhost:${CODEX_REDIRECT_PORT}/auth/callback`;
export const CODEX_SCOPES = ['openid', 'profile', 'email', 'offline_access'];

export type CodexTokens = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  /** True when this came from the codex CLI's store, so we hold no refresh token. */
  imported?: boolean;
};

/** term2's own credential file. We never write to the codex CLI's store. */
export function resolveTerm2CodexAuthPath(): string {
  const dir = process.env.TERM2_CONFIG_DIR || envPaths('term2').config;
  return path.join(dir, 'codex-auth.json');
}

/**
 * Resolve the *codex CLI's* auth file by presence only. Reading or validating
 * the token contents belongs to the runtime request path.
 */
export function resolveCodexTokenPath(): string | null {
  const candidates: string[] = [];

  if (process.env.CHATGPT_LOCAL_HOME) {
    candidates.push(path.join(process.env.CHATGPT_LOCAL_HOME, 'auth.json'));
    candidates.push(process.env.CHATGPT_LOCAL_HOME);
  }
  if (process.env.CODEX_HOME) {
    candidates.push(path.join(process.env.CODEX_HOME, 'auth.json'));
    candidates.push(process.env.CODEX_HOME);
  }

  const home = os.homedir();
  if (home) {
    candidates.push(path.join(home, '.chatgpt-local', 'auth.json'));
    candidates.push(path.join(home, '.codex', 'auth.json'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore inaccessible candidates and continue through the precedence list.
    }
  }
  return null;
}

export function readStoredCodexTokens(filePath = resolveTerm2CodexAuthPath()): CodexTokens | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const tokens = parsed?.tokens ?? parsed;
    if (tokens && typeof tokens.access_token === 'string' && tokens.access_token) {
      return {
        access_token: tokens.access_token,
        refresh_token: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
        id_token: typeof tokens.id_token === 'string' ? tokens.id_token : undefined,
        account_id: typeof tokens.account_id === 'string' ? tokens.account_id : undefined,
      };
    }
  } catch {
    // Fall through to the CLI store.
  }
  return null;
}

/**
 * Import a credential from the codex CLI's store — **the access token only.**
 *
 * OpenAI rotates refresh tokens: each refresh invalidates the one before it. If
 * term2 carried the CLI's refresh token, the two processes would be two writers
 * on one rotation chain and the loser would be silently logged out. So this is
 * a one-way, short-lived grace: an already-logged-in host works immediately,
 * and once that access token expires the user runs `term2 --codex-login` to get
 * a rotation chain of our own.
 */
export function readCodexCliTokens(filePath: string): CodexTokens | null {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  const tokens = parsed?.tokens;
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) return null;
  return {
    access_token: tokens.access_token,
    id_token: typeof tokens.id_token === 'string' ? tokens.id_token : undefined,
    account_id: typeof tokens.account_id === 'string' ? tokens.account_id : undefined,
    imported: true,
  };
}

export function saveCodexTokens(tokens: CodexTokens, filePath = resolveTerm2CodexAuthPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const payload = { tokens, last_refresh: new Date().toISOString() };
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600, encoding: 'utf8' });
  fs.renameSync(tmpPath, filePath);
}

/** True when term2 or the codex CLI has a Codex credential on this host. */
export function hasCodexLogin(): boolean {
  if (readStoredCodexTokens()) return true;
  return resolveCodexTokenPath() !== null;
}

export const CODEX_PKCE_CONFIG: PkceLoginConfig = {
  label: 'Codex',
  clientId: CODEX_OAUTH_CLIENT_ID,
  authorizeEndpoint: CODEX_AUTHORIZE_ENDPOINT,
  tokenEndpoint: CODEX_TOKEN_ENDPOINT,
  redirectUri: CODEX_REDIRECT_URI,
  redirectPort: CODEX_REDIRECT_PORT,
  callbackPath: '/auth/callback',
  scopes: CODEX_SCOPES,
  // The codex CLI sends both; the account-id claim the request path needs is
  // only present in the id_token when organizations are requested.
  extraAuthorizeParams: {
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  },
  portConflictHint: 'often a running `codex login`',
};

/**
 * Runs the browser OAuth + PKCE flow and persists the resulting tokens into
 * term2's own store. Resolves only after the human finishes in the browser.
 */
export async function loginToCodex(options?: {
  fetchImpl?: typeof fetch;
  authPath?: string;
  openBrowser?: (url: string) => void;
  onPrompt?: (url: string) => void;
  signal?: AbortSignal;
}): Promise<CodexTokens> {
  const body = await runPkceLoopbackLogin(CODEX_PKCE_CONFIG, {
    fetchImpl: options?.fetchImpl,
    openBrowser: options?.openBrowser,
    onPrompt: options?.onPrompt,
    signal: options?.signal,
  });

  const tokens: CodexTokens = {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    id_token: typeof body.id_token === 'string' ? body.id_token : undefined,
  };
  saveCodexTokens(tokens, options?.authPath ?? resolveTerm2CodexAuthPath());
  return tokens;
}
