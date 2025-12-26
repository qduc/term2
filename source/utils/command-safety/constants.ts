// 1. CONSTANTS
// Note: 'sed' is useful for read-only transformations. We allow it by default
// but add guards below to prevent in-place edits (-i) and unapproved redirections.
export const ALLOWED_COMMANDS = new Set([
    'ls',
    'pwd',
    'grep',
    'rg',
    'cat',
    'echo',
    'head',
    'tail',
    'sed',
    'find',
    'wc',
    // Git read-only commands
    'git',
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

export const SENSITIVE_EXTENSIONS = ['.env', '.pem', '.key'];

// Safe JSON files that are common project configuration files
export const SAFE_JSON_FILES = new Set([
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'jsconfig.json',
    'eslint.config.json',
    '.eslintrc.json',
    'prettier.config.json',
    '.prettierrc.json',
    'jest.config.json',
    'babel.config.json',
    '.babelrc.json',
    'ava.config.json',
    'xo.config.json',
    'tslint.json',
    'renovate.json',
    'nx.json',
    'project.json',
    'vercel.json',
    'now.json',
    'composer.json',
]);

// Patterns that indicate potentially sensitive JSON files (credentials, tokens, etc.)
export const SUSPICIOUS_JSON_PATTERNS = [
    // Credentials and secrets (exact and with suffixes)
    /^secrets?\.json$/i,
    /^secrets?[-_.].*\.json$/i,
    /^credentials?\.json$/i,
    /^credentials?[-_.].*\.json$/i,
    /^tokens?\.json$/i,
    /^tokens?[-_.].*\.json$/i,
    /^auth\.json$/i,
    /^auth[-_.].*\.json$/i,
    /^api[-_]?keys?\.json$/i,
    /^api[-_]?keys?[-_.].*\.json$/i,
    /^service[-_]?accounts?\.json$/i,
    /^service[-_]?accounts?[-_.].*\.json$/i,

    // Private keys
    /^private\.json$/i,
    /^private[-_.].*\.json$/i,
    /^key\.json$/i,
    /^key[-_.].*\.json$/i,
    /^id_rsa.*\.json$/i,

    // Cloud provider credentials
    /^firebase[-_]?adminsdk.*\.json$/i,
    /^google[-_]?credentials.*\.json$/i,
    /^gcloud.*\.json$/i,
    /^azure.*\.json$/i,
    /^aws.*\.json$/i,
    /^service[-_]account\.json$/i,
    /^client[-_]secret.*\.json$/i,
    /^oauth.*client.*\.json$/i,

    // SSO and authentication providers
    /^okta.*\.json$/i,
    /^sso.*\.json$/i,
    /^saml.*\.json$/i,

    // Monitoring and logging credentials
    /^sentry.*\.json$/i,
    /^newrelic.*\.json$/i,
    /^datadog.*\.json$/i,

    // Key storage formats
    /.*\.keystore\.json$/i,
    /.*\.keypair\.json$/i,
    /.*\.p8\.json$/i,
    /.*\.p12\.json$/i,

    // Vault and secret management
    /^vault.*\.json$/i,
];

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

// Git command classification
export const SAFE_GIT_COMMANDS = new Set([
    // Status and information
    'status',
    'log',
    'show',
    'diff',
    'reflog',
    // Inspection
    'ls-files',
    'ls-tree',
    'ls-remote',
    'describe',
    'rev-parse',
    'rev-list',
    'show-ref',
    'show-branch',
    'name-rev',
    // History viewing
    'blame',
    'shortlog',
    'whatchanged',
    // Object inspection
    'cat-file',
    'count-objects',
    'verify-pack',
    'verify-commit',
    'verify-tag',
    // Other read-only commands
    'grep',
    'help',
    'version',
    'fsck',
    'check-ignore',
    'check-attr',
    'check-ref-format',
]);

export const DANGEROUS_GIT_COMMANDS = new Set([
    // Write operations
    'push',
    'commit',
    'add',
    'rm',
    'mv',
    // Destructive operations
    'reset',
    'clean',
    'rebase',
    'merge',
    'cherry-pick',
    'revert',
    // History rewriting
    'filter-branch',
    'filter-repo',
    'replace',
    // Branch/tag management
    'checkout',
    'switch',
    'restore',
    'branch',
    'tag',
    // Configuration changes
    'config',
    'remote',
    // Submodule operations
    'submodule',
    'subtree',
    // Other write operations
    'stash',
    'apply',
    'fetch',
    'pull',
    'clone',
    'init',
    'gc',
    'prune',
    'worktree',
]);
