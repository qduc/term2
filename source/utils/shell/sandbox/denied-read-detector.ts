import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Information extracted from a sandbox denied-read failure.
 * `path` is the resolved real path of the denied file/dir (for display only).
 * `suggestedParent` is the smallest stable useful parent to add to `allowRead`
 *   when the user chooses "allow once" or "allow and remember".
 * `sensitive` suppresses the "allow and remember" option for credential-shaped paths.
 */
export interface DeniedReadInfo {
  path: string;
  suggestedParent: string;
  sensitive: boolean;
}

const home = os.homedir();
const SENSITIVE_SUBPATHS: readonly string[] = [
  path.join(home, '.ssh'),
  path.join(home, '.aws'),
  path.join(home, '.azure'),
  path.join(home, '.config', 'gcloud'),
  path.join(home, '.docker', 'config.json'),
  path.join(home, '.docker'),
  path.join(home, '.netrc'),
  path.join(home, '.git-credentials'),
  path.join(home, '.bash_history'),
  path.join(home, '.zsh_history'),
  path.join(home, '.npmrc'),
  path.join(home, '.pypirc'),
  path.join(home, '.kube'),
  path.join(home, '.gnupg'),
  path.join(home, '.config', 'gh'),
  path.join(home, '.config', 'hub'),
  path.join(home, '.gem'),
  path.join(home, '.gemrc'),
  path.join(home, '.config'),
  path.join(home, '.local'),
];

/**
 * Carve-outs under sensitive broad roots (e.g. ~/.local) that are NOT sensitive.
 * Checked before the sensitive list so package-manager caches are allowable.
 */
const NON_SENSITIVE_SUBPATHS: readonly string[] = [
  path.join(home, '.local', 'share', 'pnpm', 'store'),
  path.join(home, '.local', 'share', 'pnpm'),
  path.join(home, '.cargo'),
  path.join(home, '.rustup'),
  path.join(home, '.m2', 'repository'),
  path.join(home, '.m2'),
  path.join(home, '.gradle'),
  path.join(home, '.npm', '_cacache'),
  path.join(home, '.pyenv'),
  path.join(home, '.rbenv'),
  path.join(home, '.nvm'),
];

const SENSITIVE_REGEX_PREFIXES: readonly string[] = [
  // Browser profile dirs
  path.join(home, '.mozilla'),
  path.join(home, '.config', 'google-chrome'),
  path.join(home, '.config', 'chromium'),
  path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
  path.join(home, 'Library', 'Application Support', 'Chromium'),
  path.join(home, 'Library', 'Application Support', 'Firefox'),
];

/**
 * Whether the given denied path is a credential-shaped or broad config root
 * for which "allow and remember" must be suppressed.
 */
export function isSensitiveReadPath(p: string): boolean {
  const normalized = path.resolve(p);
  // Carve-outs (package-manager caches) take precedence over the broad-root rule.
  for (const sub of NON_SENSITIVE_SUBPATHS) {
    if (normalized === sub || normalized.startsWith(sub + path.sep)) {
      return false;
    }
  }
  for (const sub of SENSITIVE_SUBPATHS) {
    if (normalized === sub || normalized.startsWith(sub + path.sep)) {
      return true;
    }
  }
  for (const prefix of SENSITIVE_REGEX_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix + path.sep)) {
      return true;
    }
  }
  // Allow-listed package-manager caches under ~/.local are not sensitive.
  // ~/.local/share/pnpm/store is explicitly non-sensitive.
  return false;
}

interface StoreMapping {
  prefix: string;
  parent: string;
}

const STORE_PARENTS: StoreMapping[] = [
  {
    prefix: path.join(home, '.local', 'share', 'pnpm', 'store'),
    parent: path.join(home, '.local', 'share', 'pnpm', 'store'),
  },
  { prefix: path.join(home, '.cargo'), parent: path.join(home, '.cargo') },
  { prefix: path.join(home, '.rustup'), parent: path.join(home, '.rustup') },
  {
    prefix: path.join(home, '.m2', 'repository'),
    parent: path.join(home, '.m2', 'repository'),
  },
  { prefix: path.join(home, '.m2'), parent: path.join(home, '.m2') },
  { prefix: path.join(home, '.config', 'gh'), parent: path.join(home, '.config', 'gh') },
  { prefix: path.join(home, '.gradle'), parent: path.join(home, '.gradle') },
  { prefix: path.join(home, '.npm', '_cacache'), parent: path.join(home, '.npm', '_cacache') },
  { prefix: path.join(home, '.pyenv'), parent: path.join(home, '.pyenv') },
  { prefix: path.join(home, '.rbenv'), parent: path.join(home, '.rbenv') },
  { prefix: path.join(home, '.nvm'), parent: path.join(home, '.nvm') },
  { prefix: path.join(home, '.cargo'), parent: path.join(home, '.cargo') },
  { prefix: path.join(home, '.rustup'), parent: path.join(home, '.rustup') },
];

/**
 * Picks the smallest stable useful parent for a denied path.
 * For known package-manager stores (pnpm, cargo, rustup, m2, etc.), returns the store root.
 * For others, falls back to `dirname` of the denied path.
 * Never collapses to the home root or broad config ancestors.
 */
export function suggestStableParent(p: string): string {
  const normalized = path.resolve(p);

  // Known store mappings — prefer the most specific matching prefix.
  let best: StoreMapping | undefined;
  for (const mapping of STORE_PARENTS) {
    if (normalized === mapping.prefix || normalized.startsWith(mapping.prefix + path.sep)) {
      if (!best || mapping.prefix.length > best.prefix.length) {
        best = mapping;
      }
    }
  }
  if (best) {
    return best.parent;
  }

  // Floor: never suggest the home root or broad config roots.
  // If dirname would collapse to home, return the path itself (do not broaden).
  const dir = path.dirname(normalized);
  if (dir === home || dir === path.join(home) || normalized === home) {
    return normalized;
  }
  // Avoid broad config roots as the suggested parent.
  if (
    dir === path.join(home, '.config') ||
    dir === path.join(home, '.local') ||
    dir === path.join(home, '.local', 'share')
  ) {
    return normalized;
  }
  return dir;
}

/**
 * macOS sandbox violation line patterns.
 * Examples handled:
 *   Sandbox: term2(123) deny(1) file-read* /Users/user/.local/share/pnpm/store
 *   Sandbox: node(678) deny file-read-data /Users/me/.cargo/registry/cache
 */
const MACOS_READ_DENY_REGEXES: readonly RegExp[] = [/deny(?:\(\d+\))?\s+file-read\S*\s+(\/\S+)/];

function extractMacosViolationPath(stderr: string): string | null {
  const violationsStart = stderr.indexOf('<sandbox_violations>');
  const violationsEnd = stderr.indexOf('</sandbox_violations>');
  if (violationsStart === -1 || violationsEnd === -1) return null;
  const block = stderr.slice(violationsStart, violationsEnd);
  const lines = block.split('\n');
  for (const line of lines) {
    if (!line.includes('deny')) continue;
    for (const regex of MACOS_READ_DENY_REGEXES) {
      const match = regex.exec(line);
      if (match?.[1]) {
        return resolvePathSafely(match[1]);
      }
    }
  }
  return null;
}

/**
 * Linux generic tool error patterns (bwrap does not emit structured annotations;
 * denials surface as PERMISSION_DENIED / EACCES in the command's own stderr).
 *   cat: /home/user/.m2/...: Permission denied
 *   cat: cannot open '/home/...': Permission denied
 *   grep: /home/user/.cargo/registry: Operation not permitted
 */
const LINUX_PERMISSION_REGEXES: readonly RegExp[] = [
  /(?:cannot open '|\s)(\/[^\s']+: Permission denied)/,
  /cannot open '(\/[^']+)'/,
  /(?::\s)(\/[^\s:']+)(?:: Permission denied|: Operation not permitted)/,
  /\s(\/\S+): (?:Permission denied|Operation not permitted)/,
  /^(\/\S+): (?:Permission denied|Operation not permitted)/m,
];

function extractLinuxPermissionPath(stderr: string): string | null {
  for (const regex of LINUX_PERMISSION_REGEXES) {
    const match = regex.exec(stderr);
    if (match?.[1]) {
      return resolvePathSafely(match[1].replace(/: Permission denied|: Operation not permitted$/, ''));
    }
  }
  return null;
}

function resolvePathSafely(p: string): string {
  const trimmed = p.trim().replace(/["']/g, '');
  try {
    return fs.realpathSync(trimmed);
  } catch {
    return path.resolve(trimmed);
  }
}

function appearsToFileReadDenial(line: string): boolean {
  return line.includes('deny') && /file-read/.test(line);
}

function hasNetworkOnlyDenial(stderr: string): boolean {
  const violationsStart = stderr.indexOf('<sandbox_violations>');
  const violationsEnd = stderr.indexOf('</sandbox_violations>');
  if (violationsStart === -1 || violationsEnd === -1) return false;
  const block = stderr.slice(violationsStart, violationsEnd);
  const lines = block.split('\n').filter((l) => l.includes('deny'));
  if (lines.length === 0) return false;
  // Every violation is network-only (no file-read).
  return lines.every((l) => !appearsToFileReadDenial(l) && /network/.test(l));
}

/**
 * Attempt to detect a denied-read failure from sandbox runtime output.
 * Returns null if no path can be extracted (falls back to the generic escape instruction).
 *
 * macOS: parses the `<sandbox_violations>` block emitted by SandboxManager.annotateStderrWithSandboxFailures.
 * Linux (bwrap): parses common tool error patterns (Permission denied / Operation not permitted),
 *   since bwrap does not emit structured annotation events.
 */
export function detectDeniedRead(_command: string, stderr: string): DeniedReadInfo | null {
  // macOS structured violations block takes precedence.
  const macosPath = extractMacosViolationPath(stderr);
  const candidate = macosPath ?? extractLinuxPermissionPath(stderr);
  if (!candidate) {
    // If the only denials are network, this is not a read denial.
    if (hasNetworkOnlyDenial(stderr)) return null;
    return null;
  }

  const suggestedParent = suggestStableParent(candidate);
  const sensitive = isSensitiveReadPath(candidate);
  return { path: candidate, suggestedParent, sensitive };
}

/**
 * Instruction shown to the agent when a sandbox denied-read is detected,
 * encouraging a same-parameter retry so the user can approve the read.
 */
export const DETAILED_DENIED_READ_INSTRUCTION =
  'Sandbox blocked a read access. Retry the same command; the user will be prompted to allow the read for this project.';
