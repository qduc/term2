// 1. CONSTANTS
// Note: 'sed' is useful for read-only transformations. We allow it by default
// but add guards below to prevent in-place edits (-i) and unapproved redirections.
export const ALLOWED_COMMANDS = new Set([
    'ls',
    'pwd',
    'grep',
    'cat',
    'echo',
    'head',
    'tail',
    'sed',
    'find',
]);
export const BLOCKED_COMMANDS = new Set([
    // Filesystem
    'rm',
    'rmdir',
    'mkfs',
    'dd',
    'mv',
    'cp',
    // System
    'sudo',
    'su',
    'chmod',
    'chown',
    'shutdown',
    'reboot',
    // Network/Web
    'curl',
    'wget',
    'ssh',
    'scp',
    'netstat',
    // Package Managers / installers
    'apt',
    'yum',
    'npm',
    'yarn',
    'pnpm',
    'pip',
    'gem',
    // Dangerous wrappers / misc
    'eval',
    'exec',
    'kill',
    'killall',
]);

/**
 * Validate command safety using an AST parser.
 * Returns true when a command requires user approval.
 * Throws for invalid/empty inputs.
 */
export enum SafetyStatus {
    GREEN = 'GREEN',
    YELLOW = 'YELLOW',
    RED = 'RED',
}

// Constants for path analysis
export const SYSTEM_PATHS = [
    '/etc',
    '/dev',
    '/proc',
    '/var',
    '/usr',
    '/boot',
    '/bin',
];

export const SENSITIVE_EXTENSIONS = ['.env', '.pem', '.key', '.json'];

export const HOME_PATTERNS = [
    /^~/, // Tilde
    /^\$HOME/, // $HOME variable
    /^\$\{HOME\}/, // ${HOME} variable
    /^\$USER/, // $USER variable
    /^\$LOGNAME/, // $LOGNAME variable
    /^\$XDG_/, // XDG variables
    /^\/home\//, // Linux home directories
    /^\/Users\//, // macOS home directories
    /^\/root($|\/)/, // Root's home
];

export const SENSITIVE_PATHS = [
    '/.ssh',
    '/.gnupg',
    '/.aws',
    '/.kube',
    '/.env',
    '/.git',
    '/.config',
    '/.bash_history',
    '/.zsh_history',
];