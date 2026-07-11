import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

// ─── Public scope types ──────────────────────────────────────────

/**
 * A single filesystem scope pattern.
 * MVP: glob-like patterns with `**` for any-depth matching and `*` for single-segment.
 * Patterns are always relative to workspace root. Absolute patterns are rejected.
 */
export type FilesystemPattern = string;

/**
 * Resolved, immutable filesystem scopes carried through ResolvedAgentDefinition.
 * Both `read` and `write` are arrays of normalized relative patterns.
 * - `undefined` means "no scopes provided" (coarse flag-derived authority only)
 * - `[]` means "explicitly empty" (no filesystem authority even if coarse flags are true)
 * - non-empty array: allowlisted patterns
 */
export interface ResolvedFilesystemScope {
  read: FilesystemPattern[];
  write: FilesystemPattern[];
}

/**
 * A single network host pattern.
 * Format: `hostname` or `hostname:port`.
 * Hostnames are normalized to lowercase. Ports are decimal numbers.
 * Suffix-confusion is prevented: `evil-example.com` must NOT match `example.com`.
 */
export type NetworkHostPattern = string;

/**
 * Resolved, immutable network scopes carried through ResolvedAgentDefinition.
 * - `undefined` means "no scopes provided" (coarse flag-derived authority only)
 * - `[]` means "explicitly empty" (no network authority even if coarse flags are true)
 * - non-empty array: allowlisted host patterns
 */
export type ResolvedNetworkScope = NetworkHostPattern[];

// ─── Workspace root ──────────────────────────────────────────────

/**
 * Cached workspace root for path normalization.
 * Defaults to the current working directory but can be overridden for testing.
 */
let workspaceRoot: string | undefined;

export function setWorkspaceRoot(root: string): void {
  workspaceRoot = path.resolve(root);
}

export function getWorkspaceRoot(): string {
  return workspaceRoot ?? process.cwd();
}

// ─── Path safety ─────────────────────────────────────────────────

/**
 * Normalize a tool-targeted file path against the workspace root.
 * Rejects traversal (..) that escapes the workspace, absolute paths outside
 * the workspace, and paths containing null bytes.
 *
 * Returns the normalized absolute path, or null if the path is unsafe.
 */
export function normalizeToolPath(rawPath: string): string | null {
  if (!rawPath || rawPath.includes('\0')) return null;
  const root = getWorkspaceRoot();
  const resolved = path.resolve(root, rawPath);

  // Reject if the resolved path escapes the workspace root
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }

  return resolved;
}

/**
 * Check if a raw path (from a tool invocation) is within the workspace.
 * Returns true if the normalized path is safe.
 */
export function isPathWithinWorkspace(rawPath: string): boolean {
  return normalizeToolPath(rawPath) !== null;
}

/**
 * Symlink-safe resolution of a tool-targeted path.
 *
 * Uses fs.realpath to resolve symlinks in the path. For paths that
 * don't yet exist (writes to new files), resolves the nearest existing
 * ancestor and checks that the final composed path stays within the
 * root/scope.
 *
 * Returns the real absolute path, or null if:
 * - The path escapes the workspace root
 * - A symlink points outside the workspace
 * - The composed path (for nonexistent targets) would escape
 */
export async function resolveRealToolPath(rawPath: string): Promise<string | null> {
  if (!rawPath || rawPath.includes('\0')) return null;
  const root = getWorkspaceRoot();

  // First, normalize the raw path to an absolute path
  const nominal = path.resolve(root, rawPath);

  // Reject if the nominal path escapes the workspace root
  if (nominal !== root && !nominal.startsWith(root + path.sep)) {
    return null;
  }

  // Try realpath to resolve symlinks
  try {
    const real = await realpath(nominal);
    // Check that the real path stays within root
    if (real !== root && !real.startsWith(root + path.sep)) {
      return null;
    }
    return real;
  } catch {
    // Path doesn't exist (e.g., write target).
    // Resolve the nearest existing ancestor.
    return resolveNonexistentTarget(nominal, root);
  }
}

/**
 * Resolve a nonexistent target path by finding the nearest existing
 * ancestor via realpath, then composing the remaining segments and
 * verifying the final path stays within root.
 */
async function resolveNonexistentTarget(target: string, root: string): Promise<string | null> {
  let current = target;
  const missingSegments: string[] = [];

  while (current !== root && current !== path.dirname(current)) {
    try {
      await stat(current);
      // Current segment exists, resolve its real path
      const real = await realpath(current);
      if (real !== root && !real.startsWith(root + path.sep)) {
        return null;
      }
      // Compose the full path
      const composed = path.join(real, ...missingSegments.reverse());
      // Normalize and verify
      const normalized = path.resolve(composed);
      if (normalized !== root && !normalized.startsWith(root + path.sep)) {
        return null;
      }
      return normalized;
    } catch {
      // Segment doesn't exist, go up one level
      missingSegments.push(path.basename(current));
      current = path.dirname(current);
    }
  }

  // If we reached root without finding an existing ancestor,
  // the closest existing thing is root
  const real = await realpath(root);
  const composed = path.join(real, ...missingSegments.reverse());
  const normalized = path.resolve(composed);
  if (normalized !== real && !normalized.startsWith(real + path.sep)) {
    return null;
  }
  return normalized;
}

/**
 * Symlink-safe version of isPathInScope.
 * Resolves the actual filesystem path (following symlinks) and
 * checks it against the scope patterns.
 */
export async function isPathInScopeSafe(rawPath: string, scopePatterns: string[]): Promise<boolean> {
  if (scopePatterns.length === 0) return true;

  const real = await resolveRealToolPath(rawPath);
  if (!real) return false;

  const root = getWorkspaceRoot();
  const relative = path.relative(root, real);
  if (relative.startsWith('..')) return false;

  return scopePatterns.some((pattern) => matchGlobPattern(relative, pattern));
}

// ─── Filesystem scope normalization ──────────────────────────────

/**
 * Normalize a filesystem scope pattern.
 * - Strips leading/trailing whitespace
 * - Normalizes to forward slashes
 * - Rejects patterns with traversal (..)
 * - Rejects absolute patterns (must be relative)
 * - Rejects empty patterns after trimming
 *
 * Returns the normalized relative pattern, or null if invalid.
 */
export function normalizeScopePattern(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Must be a relative path pattern
  if (path.isAbsolute(trimmed)) return null;

  // Reject traversal
  const segments = trimmed.split(/[/\\]/);
  if (segments.some((s) => s === '..')) return null;

  // Normalize to forward slashes
  return segments.join('/');
}

/**
 * Resolve filesystem scopes: intersect child with parent.
 *
 * Rules:
 * - If child is undefined, inherit parent scopes
 * - If parent is undefined but child is defined, use child after normalization
 * - If both are defined, intersect: child scopes are filtered to only include
 *   patterns that are within or match parent patterns
 * - Empty array means explicitly no authority
 * - Invalid patterns (traversal, absolute, empty) produce errors
 */
export interface ScopeResolutionResult<T> {
  resolved: T;
  errors: ScopeResolutionError[];
}

export interface ScopeResolutionError {
  code: 'invalid_scope_pattern';
  field: string;
  pattern: string;
  message: string;
}

export function resolveFilesystemScopes(
  child?: { read?: string[]; write?: string[] },
  parent?: { read?: string[]; write?: string[] },
): ScopeResolutionResult<ResolvedFilesystemScope | undefined> {
  const errors: ScopeResolutionError[] = [];

  /**
   * Normalize a list of scope patterns.
   * Returns the normalized list (empty array if all invalid or input was []) or undefined if input was absent.
   */
  function normalizeList(patterns: string[] | undefined, field: string): string[] | undefined {
    if (patterns === undefined) return undefined; // not present
    const normalized: string[] = [];
    for (const p of patterns) {
      const n = normalizeScopePattern(p);
      if (n === null) {
        errors.push({
          code: 'invalid_scope_pattern',
          field,
          pattern: p,
          message: `Invalid filesystem scope pattern "${p}" for ${field}. Patterns must be relative, non-empty, and must not contain traversal (..).`,
        });
        continue;
      }
      normalized.push(n);
    }
    return normalized;
  }

  const childHasRead = child?.read !== undefined;
  const childHasWrite = child?.write !== undefined;
  const parentHasRead = parent?.read !== undefined;
  const parentHasWrite = parent?.write !== undefined;

  const childReadNorm = normalizeList(child?.read, 'filesystem.read');
  const childWriteNorm = normalizeList(child?.write, 'filesystem.write');
  const parentReadNorm = normalizeList(parent?.read, 'filesystem.read');
  const parentWriteNorm = normalizeList(parent?.write, 'filesystem.write');

  // If child has no scopes defined at all, inherit parent
  if (!childHasRead && !childHasWrite) {
    if (!parentHasRead && !parentHasWrite) {
      return { resolved: undefined, errors };
    }
    return {
      resolved: {
        read: parentReadNorm ?? [],
        write: parentWriteNorm ?? [],
      },
      errors,
    };
  }

  // Child has explicit scopes — resolve each axis
  let resolvedRead: string[];
  let resolvedWrite: string[];

  // Resolve read axis
  if (childHasRead) {
    if (parentHasRead) {
      // Both present — intersect. Empty parent ([]) means no authority.
      resolvedRead = parentReadNorm!.length === 0 ? [] : intersectFilePatterns(childReadNorm ?? [], parentReadNorm!);
    } else {
      // No parent restriction
      resolvedRead = childReadNorm ?? [];
    }
  } else if (parentHasRead) {
    resolvedRead = parentReadNorm ?? [];
  } else {
    resolvedRead = [];
  }

  // Resolve write axis
  if (childHasWrite) {
    if (parentHasWrite) {
      resolvedWrite =
        parentWriteNorm!.length === 0 ? [] : intersectFilePatterns(childWriteNorm ?? [], parentWriteNorm!);
    } else {
      resolvedWrite = childWriteNorm ?? [];
    }
  } else if (parentHasWrite) {
    resolvedWrite = parentWriteNorm ?? [];
  } else {
    resolvedWrite = [];
  }

  return {
    resolved: { read: resolvedRead, write: resolvedWrite },
    errors,
  };
}

/**
 * Check if a child pattern is covered by any parent pattern.
 * A parent pattern covers a child pattern if the child's path prefix matches
 * the parent pattern prefix (before any wildcard).
 *
 * Example: parent "src/**" covers child "src/lib/**" but NOT child "test/**"
 */
function isSubPattern(child: string, parent: string): boolean {
  // Exact match
  if (child === parent) return true;

  // Extract the literal prefix of the parent pattern (before any wildcard)
  const parentPrefix = parent.replace(/[*?].*$/, '');
  const childPrefix = child.replace(/[*?].*$/, '');

  // Child must start with parent prefix and not escape
  if (parentPrefix.endsWith('/')) {
    return childPrefix.startsWith(parentPrefix);
  }

  // If parent has a glob at the root (like "**.ts"), match by extension/base
  if (parent.startsWith('*')) {
    return child.startsWith('*') || childPrefix.startsWith(parentPrefix) || (parentPrefix === '' && childPrefix !== '');
  }

  // Child must be within parent directory or match exactly
  if (childPrefix === parentPrefix) return true;
  if (childPrefix.startsWith(parentPrefix + '/')) return true;

  // Child glob pattern might match files within parent directory
  const childDir = childPrefix.substring(0, childPrefix.lastIndexOf('/'));
  if (childDir && childDir.startsWith(parentPrefix + '/')) return true;

  return false;
}

function intersectFilePatterns(child: string[], parent: string[]): string[] {
  if (parent.length === 0) return []; // Parent with empty scopes denies everything
  if (child.length === 0) return []; // Child with empty scopes has no authority

  return child.filter((c) => parent.some((p) => isSubPattern(c, p)));
}

// ─── Filesystem scope enforcement ────────────────────────────────

/**
 * Check if a tool-targeted file path is within the given filesystem scope patterns.
 *
 * @param rawPath - The raw path from a tool invocation
 * @param scopePatterns - Resolved scope patterns (relative to workspace root)
 * @returns true if the path matches at least one scope pattern
 */
export function isPathInScope(rawPath: string, scopePatterns: string[]): boolean {
  if (scopePatterns.length === 0) return true; // Empty patterns = no restriction (but coarse flags may still deny)

  const normalized = normalizeToolPath(rawPath);
  if (!normalized) return false;

  const root = getWorkspaceRoot();
  const relative = path.relative(root, normalized);
  if (relative.startsWith('..')) return false;

  return scopePatterns.some((pattern) => matchGlobPattern(relative, pattern));
}

/**
 * Simple glob matching for filesystem scopes.
 * Supports:
 * - `**` matches any number of path segments
 * - `*` matches any characters within a single segment except `/`
 * - Literal text matches exactly
 */
function matchGlobPattern(target: string, pattern: string): boolean {
  // Normalize separators
  const normalizedTarget = target.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  return matchGlobSegments(normalizedTarget, normalizedPattern);
}

function matchGlobSegments(target: string, pattern: string): boolean {
  const tSegs = target.split('/');
  const pSegs = pattern.split('/');

  // DP: match position i in target with position j in pattern
  const dp: boolean[][] = Array.from({ length: tSegs.length + 1 }, () => new Array(pSegs.length + 1).fill(false));
  dp[0][0] = true;

  // Handle leading ** that can match zero segments
  for (let j = 1; j <= pSegs.length; j++) {
    if (pSegs[j - 1] === '**') {
      dp[0][j] = dp[0][j - 1];
    }
  }

  for (let i = 1; i <= tSegs.length; i++) {
    for (let j = 1; j <= pSegs.length; j++) {
      const tSeg = tSegs[i - 1];
      const pSeg = pSegs[j - 1];

      if (pSeg === '**') {
        // ** matches zero or more segments
        dp[i][j] = dp[i][j - 1] || dp[i - 1][j];
      } else if (matchSingleSegment(tSeg, pSeg)) {
        dp[i][j] = dp[i - 1][j - 1];
      }
    }
  }

  // Also match file patterns without directory prefix
  // (e.g., pattern "*.ts" should match "src/foo.ts")
  if (!pattern.includes('/') || (pSegs.length === 1 && !dp[tSegs.length][pSegs.length])) {
    // Try matching just the last segment
    const lastSeg = tSegs[tSegs.length - 1];
    if (pSegs.length === 1 && matchSingleSegment(lastSeg, pSegs[0])) {
      return true;
    }
  }

  return dp[tSegs.length][pSegs.length];
}

function matchSingleSegment(segment: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === '**') return true;

  // Convert glob pattern to regex for the segment
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const re = new RegExp(`^${escaped}$`);
  return re.test(segment);
}

// ─── Network host normalization ──────────────────────────────────

/**
 * Normalize a network host pattern.
 * - Lowercase
 * - Strip protocol prefix if present
 * - Strip trailing slash
 * - Parse hostname and optional port
 * - Reject invalid characters, empty hostname, IP addresses with ports
 *
 * Returns normalized `hostname[:port]` or null if invalid.
 */
export function normalizeHostPattern(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  // Strip protocol if present
  let hostPort = trimmed;
  if (hostPort.startsWith('https://') || hostPort.startsWith('http://')) {
    hostPort = hostPort.slice(hostPort.indexOf('://') + 3);
  }

  // Strip trailing slash
  if (hostPort.endsWith('/')) {
    hostPort = hostPort.slice(0, -1);
  }

  // Reject path components
  if (hostPort.includes('/')) return null;
  // Reject empty hostname
  if (!hostPort) return null;

  // Parse hostname:port
  const colonIdx = hostPort.lastIndexOf(':');
  let hostname: string;
  let port: string | undefined;

  if (colonIdx > 0) {
    hostname = hostPort.slice(0, colonIdx);
    port = hostPort.slice(colonIdx + 1);

    // Validate port is a number
    if (!/^\d{1,5}$/.test(port)) return null;
    const portNum = parseInt(port, 10);
    if (portNum < 1 || portNum > 65535) return null;
  } else {
    hostname = hostPort;
  }

  // Validate hostname
  if (!isValidHostname(hostname)) return null;

  return port ? `${hostname}:${port}` : hostname;
}

function isValidHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;

  // Allow wildcard at start for subdomain matching
  const isWildcard = hostname.startsWith('*.');
  const nameToCheck = isWildcard ? hostname.slice(2) : hostname;

  // Each label must be 1-63 chars, alphanumeric + hyphens, not starting/ending with hyphen
  const labels = nameToCheck.split('.');
  if (labels.length === 0) return false;

  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label) && !/^[a-z0-9]$/.test(label)) return false;
  }

  return true;
}

/**
 * Check if a target hostname matches an allowed host pattern.
 * Strict: `evil-example.com` must NOT match `example.com`.
 * Wildcard: `*.example.com` matches `sub.example.com` but NOT `example.com`.
 */
export function isHostInScope(targetUrl: string, allowedPatterns: string[]): boolean {
  if (allowedPatterns.length === 0) return true; // No restriction

  // The literal '*' wildcard means "all hosts".
  if (allowedPatterns.includes('*')) return true;

  const urlStr = targetUrl.trim().toLowerCase();

  // Extract hostname from URL
  let hostname: string;
  let port: string | undefined;

  if (urlStr.startsWith('https://') || urlStr.startsWith('http://')) {
    try {
      const url = new URL(urlStr);
      hostname = url.hostname;
      port = url.port || undefined;
    } catch {
      return false;
    }
  } else {
    // Treat as bare hostname
    const colonIdx = urlStr.lastIndexOf(':');
    if (colonIdx > 0) {
      hostname = urlStr.slice(0, colonIdx);
      port = urlStr.slice(colonIdx + 1);
    } else {
      hostname = urlStr;
    }
  }

  if (!isValidHostname(hostname)) return false;

  return allowedPatterns.some((pattern) => {
    // Check if pattern includes port
    const colonIdx = pattern.lastIndexOf(':');
    let patternHost: string;
    let patternPort: string | undefined;

    if (colonIdx > 0 && /^\d{1,5}$/.test(pattern.slice(colonIdx + 1))) {
      patternHost = pattern.slice(0, colonIdx);
      patternPort = pattern.slice(colonIdx + 1);
    } else {
      patternHost = pattern;
    }

    // Port must match if specified in pattern
    if (patternPort && patternPort !== port) return false;

    // Wildcard matching: *.example.com
    if (patternHost.startsWith('*.')) {
      const suffix = patternHost.slice(2); // "example.com"
      // Must match subdomain, not the exact domain
      return hostname.endsWith('.' + suffix) && hostname !== suffix;
    }

    // Exact hostname match
    return hostname === patternHost;
  });
}

// ─── Network scope resolution ────────────────────────────────────

export function resolveNetworkScopes(
  child?: { hosts?: string[] },
  parent?: { hosts?: string[] },
): ScopeResolutionResult<ResolvedNetworkScope | undefined> {
  const errors: ScopeResolutionError[] = [];

  function normalizeHostList(hosts: string[] | undefined, field: string): string[] | undefined {
    if (!hosts) return undefined;
    const normalized: string[] = [];
    for (const h of hosts) {
      const n = normalizeHostPattern(h);
      if (n === null) {
        errors.push({
          code: 'invalid_scope_pattern',
          field,
          pattern: h,
          message: `Invalid network host pattern "${h}". Hosts must be valid hostnames with optional port (e.g., "api.example.com:443").`,
        });
        continue;
      }
      normalized.push(n);
    }
    return normalized.length > 0 ? normalized : undefined;
  }

  const childHosts = child?.hosts;
  const parentHosts = parent?.hosts;

  // If child has no host scopes defined, inherit parent
  if (childHosts === undefined) {
    if (parentHosts !== undefined) {
      const normalized = normalizeHostList(parentHosts, 'network.hosts');
      return { resolved: normalized ?? [], errors };
    }
    return { resolved: undefined, errors };
  }

  // Child has explicit host scopes
  const childNormalized = normalizeHostList(childHosts, 'network.hosts');

  if (parentHosts !== undefined) {
    const parentNormalized = normalizeHostList(parentHosts, 'network.hosts');
    if (parentNormalized && childNormalized) {
      // Intersect: child hosts must be in parent's list
      const intersected = childNormalized.filter((c) => parentNormalized.some((p) => hostCoveredBy(c, p)));
      return { resolved: intersected, errors };
    }
    if (parentNormalized && parentNormalized.length > 0) {
      // Parent has hosts but child has none → empty
      return { resolved: [], errors };
    }
  }

  return { resolved: childNormalized ?? [], errors };
}

/**
 * Check if a child host pattern is covered by a parent host pattern.
 * - Exact match
 * - Parent wildcard covers child exact (parent `*.example.com` covers child `sub.example.com`)
 */
function hostCoveredBy(child: string, parent: string): boolean {
  if (child === parent) return true;

  const colonIdxP = parent.lastIndexOf(':');
  const parentHost =
    colonIdxP > 0 && /^\d{1,5}$/.test(parent.slice(colonIdxP + 1)) ? parent.slice(0, colonIdxP) : parent;
  const parentPort =
    colonIdxP > 0 && /^\d{1,5}$/.test(parent.slice(colonIdxP + 1)) ? parent.slice(colonIdxP + 1) : undefined;

  const colonIdxC = child.lastIndexOf(':');
  const childHost = colonIdxC > 0 && /^\d{1,5}$/.test(child.slice(colonIdxC + 1)) ? child.slice(0, colonIdxC) : child;
  const childPort =
    colonIdxC > 0 && /^\d{1,5}$/.test(child.slice(colonIdxC + 1)) ? child.slice(colonIdxC + 1) : undefined;

  // Port must match if parent specifies one
  if (parentPort && parentPort !== childPort) return false;

  // Wildcard coverage
  if (parentHost.startsWith('*.')) {
    const suffix = parentHost.slice(2);
    return childHost.endsWith('.' + suffix) && childHost !== suffix;
  }

  return childHost === parentHost;
}

// ─── Empty scope utilities ───────────────────────────────────────

/**
 * Check if filesystem scopes are explicitly empty (no authority).
 * Used to determine if tool invocation should be denied even if
 * coarse flags would otherwise allow it.
 */
export function isFilesystemScopeEmpty(scope?: ResolvedFilesystemScope): boolean {
  if (!scope) return false; // Not defined = no restriction
  return scope.read.length === 0 && scope.write.length === 0;
}

/**
 * Check if network scopes are explicitly empty (no authority).
 */
export function isNetworkScopeEmpty(scope?: ResolvedNetworkScope): boolean {
  if (!scope) return false; // Not defined = no restriction
  return scope.length === 0;
}
