import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import envPaths from 'env-paths';
import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

/**
 * Credential storage for MCP servers that authenticate with OAuth.
 *
 * One file holds every server's credentials, keyed by the server URL from the
 * config rather than by the config entry's name: renaming `"linear"` to
 * `"linear-remote"` in `.mcp.json` must not lose the login, and pointing a
 * different entry at another URL must never reach a token issued for this one.
 *
 * Within a server, client information and tokens are sub-keyed by the
 * authorization server's `issuer` (stamped by the SDK on every save), because a
 * client id is only meaningful to the authorization server that issued it. The
 * PKCE code verifier and the discovery state have no issuer — the SDK passes no
 * context for them — so they belong to the server entry itself.
 *
 * This is the persistence half of `OAuthClientProvider`; the policy half (when
 * to log in, whether to open a browser) lives in `mcp-oauth-provider.ts` and its
 * caller.
 */
export const MCP_OAUTH_STORE_VERSION = 1;

export type McpOAuthCredentialScope = 'all' | 'client' | 'tokens' | 'verifier' | 'discovery';

export type McpOAuthIssuerEntry = {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
};

export type McpOAuthServerEntry = {
  byIssuer: Record<string, McpOAuthIssuerEntry>;
  /**
   * The issuer whose tokens were saved most recently. The transport reads
   * `tokens()` with no context on every request, and a server has one usable
   * token set at a time, so that read must be unambiguous.
   */
  lastIssuer?: string;
  /** Survives the redirect round-trip; the token exchange needs it back. */
  codeVerifier?: string;
  /** Cached RFC 9728/RFC 8414 discovery, so re-auth skips the HTTP probes. */
  discovery?: OAuthDiscoveryState;
};

export type McpOAuthStoreFile = {
  version: number;
  servers: Record<string, McpOAuthServerEntry>;
};

export type McpOAuthStoreOptions = {
  /** Absolute path to the credential file. Defaults to `defaultMcpOAuthStorePath()`. */
  filePath?: string;
  /** Injectable filesystem seam for failure/cleanup tests. */
  filesystem?: typeof fs;
};

/** term2's own MCP credential file, beside `grok-auth.json` and `codex-auth.json`. */
export function defaultMcpOAuthStorePath(): string {
  const dir = process.env.TERM2_CONFIG_DIR || envPaths('term2').config;
  return path.join(dir, 'mcp-oauth.json');
}

/**
 * The storage key for a server URL: lowercase scheme and host, no default port,
 * no trailing slash, no query or fragment.
 *
 * The path keeps its case — URLs are only case-insensitive before the path — and
 * a URL that cannot be parsed is keyed by its trimmed text, which keeps the
 * function total while still giving two spellings of one bad string the same key.
 */
export function normalizeMcpServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.trim();
  }
  url.search = '';
  url.hash = '';
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  // The URL parser already drops a default port for the schemes it knows; the
  // explicit checks keep the normalization true for one it does not.
  if (url.protocol === 'https:' && url.port === '443') url.port = '';
  if (url.protocol === 'http:' && url.port === '80') url.port = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  // A root path normalizes back to '/', so the trailing-slash rule needs one
  // more pass than the pathname assignment.
  return url.toString().replace(/\/$/, '');
}

function emptyStore(): McpOAuthStoreFile {
  return { version: MCP_OAUTH_STORE_VERSION, servers: {} };
}

function emptyServerEntry(): McpOAuthServerEntry {
  return { byIssuer: {} };
}

function isEmptyServerEntry(entry: McpOAuthServerEntry): boolean {
  return Object.keys(entry.byIssuer).length === 0 && entry.codeVerifier === undefined && entry.discovery === undefined;
}

export class McpOAuthStore {
  private readonly filesystem: typeof fs;
  private readonly filePath: string;

  constructor(options: McpOAuthStoreOptions = {}) {
    this.filesystem = options.filesystem ?? fs;
    this.filePath = options.filePath ?? defaultMcpOAuthStorePath();
    this.sweepTemporaryFiles();
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Reads the store. A missing, unreadable, or corrupt file is an empty store:
   * a credential file is not worth crashing a session over, and the next write
   * replaces the damaged body.
   */
  read(): McpOAuthStoreFile {
    let parsed: any;
    try {
      parsed = JSON.parse(this.filesystem.readFileSync(this.filePath, 'utf8'));
    } catch {
      return emptyStore();
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.servers !== 'object' || parsed.servers === null) {
      return emptyStore();
    }
    const servers: Record<string, McpOAuthServerEntry> = {};
    for (const [serverKey, value] of Object.entries(parsed.servers as Record<string, any>)) {
      if (!value || typeof value !== 'object') continue;
      const byIssuer: Record<string, McpOAuthIssuerEntry> = {};
      if (value.byIssuer && typeof value.byIssuer === 'object') {
        for (const [issuer, issuerEntry] of Object.entries(value.byIssuer as Record<string, any>)) {
          if (!issuerEntry || typeof issuerEntry !== 'object') continue;
          byIssuer[issuer] = { client: issuerEntry.client, tokens: issuerEntry.tokens };
        }
      }
      servers[serverKey] = {
        byIssuer,
        ...(typeof value.lastIssuer === 'string' ? { lastIssuer: value.lastIssuer } : {}),
        ...(typeof value.codeVerifier === 'string' ? { codeVerifier: value.codeVerifier } : {}),
        ...(value.discovery && typeof value.discovery === 'object' ? { discovery: value.discovery } : {}),
      };
    }
    return { version: MCP_OAUTH_STORE_VERSION, servers };
  }

  getClientInformation(serverUrl: string, issuer: string): StoredOAuthClientInformation | undefined {
    return this.serverEntry(serverUrl)?.byIssuer[issuer]?.client;
  }

  saveClientInformation(serverUrl: string, issuer: string, client: StoredOAuthClientInformation): void {
    this.update(serverUrl, (entry) => {
      entry.byIssuer[issuer] = { ...entry.byIssuer[issuer], client };
      return entry;
    });
  }

  /**
   * Reads stored tokens. With no issuer, returns the most recently saved set —
   * the transport's per-request read, which must not come back empty just
   * because it has no context.
   */
  getTokens(serverUrl: string, issuer?: string): StoredOAuthTokens | undefined {
    const entry = this.serverEntry(serverUrl);
    if (!entry) return undefined;
    if (issuer !== undefined) return entry.byIssuer[issuer]?.tokens;
    const key = entry.lastIssuer ?? Object.keys(entry.byIssuer).at(-1);
    return key ? entry.byIssuer[key]?.tokens : undefined;
  }

  saveTokens(serverUrl: string, issuer: string, tokens: StoredOAuthTokens): void {
    this.update(serverUrl, (entry) => {
      entry.byIssuer[issuer] = { ...entry.byIssuer[issuer], tokens };
      entry.lastIssuer = issuer;
      return entry;
    });
  }

  getCodeVerifier(serverUrl: string): string | undefined {
    return this.serverEntry(serverUrl)?.codeVerifier;
  }

  saveCodeVerifier(serverUrl: string, codeVerifier: string): void {
    this.update(serverUrl, (entry) => {
      entry.codeVerifier = codeVerifier;
      return entry;
    });
  }

  getDiscoveryState(serverUrl: string): OAuthDiscoveryState | undefined {
    return this.serverEntry(serverUrl)?.discovery;
  }

  saveDiscoveryState(serverUrl: string, discovery: OAuthDiscoveryState): void {
    this.update(serverUrl, (entry) => {
      entry.discovery = discovery;
      return entry;
    });
  }

  /**
   * Forgets one class of credential for a server. Scopes are the SDK's: the
   * transport calls `'client'` and `'tokens'` when the server rejects them,
   * and hosts call `'discovery'` after repeated 401s so a changed
   * `authorization_servers` list is picked up.
   *
   * `'client'` and `'tokens'` clear every issuer's entry, because the call
   * carries no issuer and the rejected credential may be any of them.
   */
  invalidateCredentials(serverUrl: string, scope: McpOAuthCredentialScope): void {
    if (scope === 'all') {
      this.update(serverUrl, () => null);
      return;
    }
    this.update(serverUrl, (entry) => {
      if (scope === 'verifier') entry.codeVerifier = undefined;
      else if (scope === 'discovery') entry.discovery = undefined;
      else {
        for (const issuer of Object.keys(entry.byIssuer)) {
          const issuerEntry = entry.byIssuer[issuer];
          if (scope === 'client') delete issuerEntry.client;
          else delete issuerEntry.tokens;
          if (!issuerEntry.client && !issuerEntry.tokens) delete entry.byIssuer[issuer];
        }
        if (entry.lastIssuer !== undefined && !entry.byIssuer[entry.lastIssuer]?.tokens) {
          entry.lastIssuer = undefined;
        }
      }
      return entry;
    });
  }

  private serverEntry(serverUrl: string): McpOAuthServerEntry | undefined {
    return this.read().servers[normalizeMcpServerUrl(serverUrl)];
  }

  /** Applies one mutation and writes the whole store back atomically. */
  private update(serverUrl: string, mutate: (entry: McpOAuthServerEntry) => McpOAuthServerEntry | null): void {
    const store = this.read();
    const key = normalizeMcpServerUrl(serverUrl);
    const next = mutate(store.servers[key] ?? emptyServerEntry());
    if (next === null || isEmptyServerEntry(next)) delete store.servers[key];
    else store.servers[key] = next;
    this.write({ version: MCP_OAUTH_STORE_VERSION, servers: store.servers });
  }

  /**
   * Writes through a temporary file in the same directory, fsynced before the
   * rename, so a reader — including another term2 instance — sees either the old
   * file or the complete new one, never a half-written credential file.
   */
  private write(store: McpOAuthStoreFile): void {
    this.filesystem.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    let renamed = false;
    try {
      fd = this.filesystem.openSync(tmpPath, 'w', 0o600);
      this.filesystem.writeFileSync(fd, JSON.stringify(store, null, 2), { encoding: 'utf8' });
      this.filesystem.fsyncSync(fd);
      this.filesystem.closeSync(fd);
      fd = undefined;
      this.filesystem.renameSync(tmpPath, this.filePath);
      renamed = true;
    } finally {
      if (fd !== undefined) {
        try {
          this.filesystem.closeSync(fd);
        } catch {
          // Preserve the original write failure.
        }
      }
      if (!renamed) {
        try {
          this.filesystem.unlinkSync(tmpPath);
        } catch {
          // Best-effort cleanup; the next startup sweep retries it.
        }
      }
    }
  }

  private sweepTemporaryFiles(): void {
    const directory = path.dirname(this.filePath);
    const base = path.basename(this.filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const unique = new RegExp(`^${base}\\.[^.]+\\.[A-Fa-f0-9-]{36}\\.tmp$`);
    try {
      for (const name of this.filesystem.readdirSync(directory)) {
        if (name === `${path.basename(this.filePath)}.tmp` || unique.test(name)) {
          try {
            this.filesystem.unlinkSync(path.join(directory, name));
          } catch {
            // A concurrent writer or permission failure is handled on its own path.
          }
        }
      }
    } catch {
      // A missing store directory has no temporary credentials to recover.
    }
  }
}
