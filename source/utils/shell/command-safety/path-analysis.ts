import path from 'path';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import {
  SafetyStatus,
  SYSTEM_PATHS,
  SENSITIVE_EXTENSIONS,
  HOME_PATTERNS,
  SENSITIVE_PATHS,
  SAFE_JSON_FILES,
  SUSPICIOUS_JSON_PATTERNS,
} from './constants.js';

const nullLoggingService: ILoggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

// Dot-directories that almost always contain credentials, private keys, or secrets.
// Access to these should be blocked (RED) regardless of the specific file inside.
const HIGHLY_SENSITIVE_HOME_DIRS = new Set([
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.config/gcloud',
  '.kube',
  '.docker',
  '.netrc',
  '.pgpass',
  '.password-store',
  '.cert',
  '.certs',
  '.keys',
  '.secrets',
]);

// Sensitive dotfiles at the root of the home directory (RED).
const HIGHLY_SENSITIVE_HOME_FILES = new Set([
  '.netrc',
  '.pgpass',
  '.npmrc', // can contain auth tokens
  '.pypirc', // can contain auth tokens
  '.gitconfig', // may contain credentials / signing keys
  '.git-credentials',
  '.bash_history',
  '.zsh_history',
  '.python_history',
  '.node_repl_history',
  '.mysql_history',
  '.psql_history',
  '.lesshst',
]);

// Dot-directories that are commonly used as working/cache/data directories.
// These should NOT be RED — they're YELLOW at worst, often GREEN-ish.
// Users frequently work in these (installing tools, inspecting caches, etc.).
const COMMON_WORKING_DOT_DIRS = new Set([
  '.local',
  '.cache',
  '.config', // root .config is broad; specific sensitive subdirs handled above
  '.npm',
  '.yarn',
  '.pnpm',
  '.nvm',
  '.node_modules',
  '.vscode',
  '.idea',
  '.cursor',
  '.vim',
  '.emacs.d',
  '.mozilla',
  '.themes',
  '.icons',
  '.fonts',
  '.gradle',
  '.m2',
  '.cargo',
  '.rustup',
  '.pyenv',
  '.rbenv',
  '.virtualenvs',
  '.docker-desktop',
]);

const SENSITIVE_LOCAL_PATH_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.git', '.env']);

function getLogger(loggingService?: ILoggingService): ILoggingService {
  return loggingService ?? nullLoggingService;
}

/**
 * Given a sliced home-relative path (e.g. "/.ssh/id_rsa" or "/.local/bin/foo"),
 * return the first dot-segment (e.g. ".ssh", ".local") or undefined.
 */
function firstDotSegment(sliced: string): string | undefined {
  const segments = sliced.split('/').filter(Boolean);
  const first = segments[0];
  return first && first.startsWith('.') ? first : undefined;
}

/**
 * Check whether a sliced home path falls within a highly sensitive directory.
 * Handles nested keys like ".config/gcloud".
 */
function isInHighlySensitiveDir(sliced: string): boolean {
  const trimmed = sliced.replace(/^\/+/, '');
  for (const dir of HIGHLY_SENSITIVE_HOME_DIRS) {
    if (trimmed === dir || trimmed.startsWith(dir + '/')) {
      return true;
    }
  }
  return false;
}

export function analyzePathRisk(inputPath: string | undefined, loggingService?: ILoggingService): SafetyStatus {
  const logger = getLogger(loggingService);
  const candidate = inputPath?.trim();
  if (!candidate) return SafetyStatus.GREEN;

  // GREEN: Safe pseudo-devices
  const safeDevices = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/zero', '/dev/random', '/dev/urandom']);
  if (safeDevices.has(candidate)) {
    return SafetyStatus.GREEN;
  }

  // GREEN: the current directory itself ("." / "./"). Without this, the later
  // "hidden file" check fires because path.basename('.') === '.' (starts with a dot),
  // wrongly flagging read-only commands like `rg "x" .` or `grep -r "x" .` as YELLOW.
  if (candidate === '.' || candidate === './') {
    return SafetyStatus.GREEN;
  }

  const cwd = process.cwd();

  // Pre-calculate project membership for absolute paths
  const isAbsolute = path.isAbsolute(candidate);
  const normalizedCandidate = path.normalize(candidate);
  const normalizedCwd = path.normalize(cwd);
  const isWithinProject =
    isAbsolute && (normalizedCandidate.startsWith(normalizedCwd + path.sep) || normalizedCandidate === normalizedCwd);

  // RED: Home directory and sensitive paths
  // Check for various home directory representations
  const isHomeRelated = HOME_PATTERNS.some((pattern) => pattern.test(candidate));

  if (isHomeRelated && !isWithinProject) {
    // Extract the path after home prefix for further analysis
    const sliced = candidate
      .replace(/^~/, '')
      .replace(/^\$\{?HOME\}?/, '')
      .replace(/^\$\{?USER\}?/, '')
      .replace(/^\$\{?LOGNAME\}?/, '')
      .replace(/^\/home\/[^/]+/, '')
      .replace(/^\/Users\/[^/]+/, '')
      .replace(/^\/root/, '');

    // Plain home directory access without any suffix is broad and privacy-sensitive,
    // but not inherently destructive. Let the model judge the task context.
    if (sliced === '' || sliced === '/') {
      logger.security('Path risk: home directory access', { path: candidate });
      return SafetyStatus.YELLOW;
    }

    const filename = path.basename(candidate);
    const topDot = firstDotSegment(sliced);

    // RED: highly sensitive credential directories (anywhere inside)
    if (isInHighlySensitiveDir(sliced)) {
      logger.security('Path risk: sensitive credential directory', { path: candidate });
      return SafetyStatus.RED;
    }

    // RED: highly sensitive dotfiles at home root
    // (only when the file sits directly under home, not deep inside another dir)
    const slicedSegments = sliced.split('/').filter(Boolean);
    if (slicedSegments.length === 1 && HIGHLY_SENSITIVE_HOME_FILES.has(slicedSegments[0])) {
      logger.security('Path risk: sensitive home dotfile', { path: candidate });
      return SafetyStatus.RED;
    }

    // Legacy explicit sensitive-path substring match (kept for back-compat with constants.ts)
    if (SENSITIVE_PATHS.some((sensitive) => sliced.includes(sensitive))) {
      logger.security('Path risk: known sensitive path', { path: candidate });
      return SafetyStatus.RED;
    }

    // Suspicious filename patterns (credentials.json, *_token.json, etc.) anywhere in home -> RED
    if (/\.json$/i.test(filename) && SUSPICIOUS_JSON_PATTERNS.some((pattern) => pattern.test(filename))) {
      logger.security('Path risk: suspicious JSON file in home directory', { path: candidate });
      return SafetyStatus.RED;
    }

    // Sensitive extensions (private keys, pem, etc.) anywhere in home -> RED
    if (SENSITIVE_EXTENSIONS.some((ext) => filename.endsWith(ext))) {
      logger.security('Path risk: sensitive file in home directory', { path: candidate });
      return SafetyStatus.RED;
    }

    // YELLOW: common working dot-directories (~/.local, ~/.cache, ~/.config/..., etc.)
    // Users legitimately operate here often — flag as cautious, not blocked.
    if (topDot && COMMON_WORKING_DOT_DIRS.has(topDot)) {
      logger.security('Path risk: home working dot-directory', { path: candidate, segment: topDot });
      return SafetyStatus.YELLOW;
    }

    // YELLOW: any other unknown dotfile/dotdir directly under home — be cautious
    // but don't block, since many tools create custom dot-directories.
    if (topDot) {
      logger.security('Path risk: unknown home dot-entry', { path: candidate, segment: topDot });
      return SafetyStatus.YELLOW;
    }

    // Non-dot files/folders inside home -> YELLOW (privacy-sensitive but not destructive)
    logger.security('Path risk: home directory file', { path: candidate });
    return SafetyStatus.YELLOW;
  }

  // YELLOW: Absolute System Paths
  if (path.isAbsolute(candidate)) {
    if (SYSTEM_PATHS.some((sys) => candidate.startsWith(sys))) {
      logger.security('Path risk: absolute system path', { path: candidate });
      return SafetyStatus.YELLOW;
    }
    // Absolute paths into highly sensitive home dirs are still RED
    const absHomeMatch =
      candidate.match(/^\/(?:home|Users)\/[^/]+(\/.*)?$/) ||
      (candidate.startsWith('/root') ? ([candidate, candidate.slice(5)] as RegExpMatchArray) : null);
    if (absHomeMatch) {
      const tail = absHomeMatch[1] ?? '';
      if (isInHighlySensitiveDir(tail)) {
        logger.security('Path risk: absolute sensitive home dir', { path: candidate });
        return SafetyStatus.RED;
      }
      const tailSegments = tail.split('/').filter(Boolean);
      if (tailSegments.length === 1 && HIGHLY_SENSITIVE_HOME_FILES.has(tailSegments[0])) {
        logger.security('Path risk: absolute sensitive home file', { path: candidate });
        return SafetyStatus.RED;
      }
    }

    // Check if absolute path is within current project directory or in a safe temporary directory
    const isTempDir =
      normalizedCandidate === '/tmp' ||
      normalizedCandidate.startsWith('/tmp' + path.sep) ||
      normalizedCandidate === '/private/tmp' ||
      normalizedCandidate.startsWith('/private/tmp' + path.sep);

    if (!isWithinProject && !isTempDir) {
      // Absolute paths outside project are suspicious -> audit
      logger.security('Path risk: absolute non-system path', { path: candidate });
      return SafetyStatus.YELLOW;
    }

    // If within project, continue with normal flow (treat like relative path)
    // Fall through to continue checking for sensitive files, hidden files, etc.
  }

  // YELLOW: Directory Traversal
  if (candidate.includes('..')) {
    logger.security('Path risk: directory traversal detected', { path: candidate });
    return SafetyStatus.YELLOW;
  }

  const pathSegments = normalizedCandidate.split(/[\\/]+/).filter(Boolean);
  if (pathSegments.some((segment) => SENSITIVE_LOCAL_PATH_SEGMENTS.has(segment))) {
    logger.security('Path risk: sensitive local dot-directory', { path: candidate });
    return SafetyStatus.YELLOW;
  }

  const filename = path.basename(candidate);

  // JSON files: check allowlist and suspicious patterns BEFORE hidden file check
  // This ensures safe JSON files like .eslintrc.json are GREEN
  // Use case-insensitive check for .json extension
  if (/\.json$/i.test(filename)) {
    // Safe project config files are always GREEN
    // Check case-insensitively by converting to lowercase
    if (SAFE_JSON_FILES.has(filename.toLowerCase())) {
      return SafetyStatus.GREEN;
    }

    // Check for suspicious credential/token patterns
    if (SUSPICIOUS_JSON_PATTERNS.some((pattern) => pattern.test(filename))) {
      logger.security('Path risk: suspicious JSON filename', {
        path: candidate,
      });
      return SafetyStatus.YELLOW;
    }

    // Other JSON files are GREEN by default (permissive)
    return SafetyStatus.GREEN;
  }

  // Hidden files -> YELLOW
  if (filename.startsWith('.')) {
    logger.security('Path risk: hidden file', { path: candidate });
    return SafetyStatus.YELLOW;
  }

  // Sensitive extensions
  if (SENSITIVE_EXTENSIONS.some((ext) => filename.endsWith(ext))) {
    logger.security('Path risk: sensitive extension', {
      path: candidate,
    });
    return SafetyStatus.YELLOW;
  }

  return SafetyStatus.GREEN;
}
