/**
 * Safety classifier for companion mode Auto commands.
 *
 * Classifies commands into safety levels:
 * - GREEN: Safe, auto-approve
 * - YELLOW: Potentially risky, show for confirmation
 * - RED: Dangerous, block or require explicit approval
 */

export type SafetyLevel = 'green' | 'yellow' | 'red';

export interface SafetyClassification {
    level: SafetyLevel;
    reason: string;
    command: string;
}

// Patterns for dangerous operations (RED)
const DANGEROUS_PATTERNS: Array<{pattern: RegExp; reason: string}> = [
    {pattern: /\brm\s+(-rf?|--recursive)?\s*\/\s*$/i, reason: 'Recursive delete of root'},
    {pattern: /\brm\s+(-rf?|--recursive)?\s*~\s*$/i, reason: 'Recursive delete of home'},
    {pattern: /\brm\s+(-rf?|--recursive)?\s*\.\s*$/i, reason: 'Recursive delete of current directory'},
    {pattern: /\bsudo\s+rm\b/i, reason: 'Sudo delete operation'},
    {pattern: /\bsudo\s+dd\b/i, reason: 'Sudo disk write operation'},
    {pattern: /\bmkfs\b/i, reason: 'Filesystem creation'},
    {pattern: /\bformat\s+[a-z]:/i, reason: 'Drive format'},
    {pattern: /\bshutdown\b/i, reason: 'System shutdown'},
    {pattern: /\breboot\b/i, reason: 'System reboot'},
    {pattern: /\bsystemctl\s+(stop|disable|mask)\b/i, reason: 'System service modification'},
    {pattern: /\bchmod\s+777\b/i, reason: 'Overly permissive chmod'},
    {pattern: /\bchown\s+-R\s+root\b/i, reason: 'Recursive chown to root'},
    {pattern: />\s*\/dev\/(sd[a-z]|nvme|hd[a-z])/i, reason: 'Direct disk write'},
    {pattern: /\bcurl\b.*\|\s*(bash|sh)\b/i, reason: 'Pipe remote script to shell'},
    {pattern: /\bwget\b.*\|\s*(bash|sh)\b/i, reason: 'Pipe remote script to shell'},
    {pattern: /\beval\s+.*\$\(/i, reason: 'Eval with command substitution'},
    {pattern: /\bkill\s+-9\s+1\b/i, reason: 'Kill init process'},
    {pattern: /\b:()\s*{\s*:\s*\|\s*:\s*&\s*}\s*;\s*:/i, reason: 'Fork bomb'},
];

// Patterns for risky operations (YELLOW)
const RISKY_PATTERNS: Array<{pattern: RegExp; reason: string}> = [
    {pattern: /\brm\s+(-r|-f|-rf)/i, reason: 'Recursive or forced delete'},
    {pattern: /\bsudo\b/i, reason: 'Sudo command'},
    {pattern: /\bgit\s+(push|force-push|reset\s+--hard)/i, reason: 'Git destructive operation'},
    {pattern: /\bgit\s+checkout\s+--\s*\./i, reason: 'Git discard all changes'},
    {pattern: /\bnpm\s+(publish|unpublish)/i, reason: 'npm publish operation'},
    {pattern: /\bdocker\s+(rm|rmi|stop|kill)/i, reason: 'Docker destructive operation'},
    {pattern: /\bchmod\s+[0-7]{3}/i, reason: 'Permission change'},
    {pattern: /\bchown\b/i, reason: 'Ownership change'},
    {pattern: />\s*[^|&]/i, reason: 'File overwrite redirection'},
    {pattern: /\bmv\b.*\//i, reason: 'File move operation'},
    {pattern: /\bcp\s+-r/i, reason: 'Recursive copy'},
    {pattern: /\btar\s+.*-x/i, reason: 'Archive extraction'},
    {pattern: /\bunzip\b/i, reason: 'Archive extraction'},
    {pattern: /\bpip\s+install\b(?!.*--user)/i, reason: 'System-wide pip install'},
    {pattern: /\bnpm\s+install\s+-g/i, reason: 'Global npm install'},
    {pattern: /\bapt\s+(install|remove|purge)/i, reason: 'System package operation'},
    {pattern: /\bbrew\s+(install|uninstall|remove)/i, reason: 'Homebrew package operation'},
];

// Patterns for safe operations (GREEN)
const SAFE_PATTERNS: Array<{pattern: RegExp; reason: string}> = [
    {pattern: /^\s*(ls|ll|la|dir)\b/i, reason: 'List files'},
    {pattern: /^\s*cd\b/i, reason: 'Change directory'},
    {pattern: /^\s*pwd\b/i, reason: 'Print working directory'},
    {pattern: /^\s*echo\b/i, reason: 'Echo output'},
    {pattern: /^\s*cat\b/i, reason: 'View file'},
    {pattern: /^\s*head\b/i, reason: 'View file head'},
    {pattern: /^\s*tail\b/i, reason: 'View file tail'},
    {pattern: /^\s*less\b/i, reason: 'View file with pager'},
    {pattern: /^\s*more\b/i, reason: 'View file with pager'},
    {pattern: /^\s*grep\b/i, reason: 'Search text'},
    {pattern: /^\s*find\b/i, reason: 'Find files'},
    {pattern: /^\s*which\b/i, reason: 'Locate command'},
    {pattern: /^\s*whereis\b/i, reason: 'Locate command'},
    {pattern: /^\s*type\b/i, reason: 'Describe command'},
    {pattern: /^\s*whoami\b/i, reason: 'Show current user'},
    {pattern: /^\s*hostname\b/i, reason: 'Show hostname'},
    {pattern: /^\s*date\b/i, reason: 'Show date'},
    {pattern: /^\s*uptime\b/i, reason: 'Show uptime'},
    {pattern: /^\s*df\b/i, reason: 'Show disk usage'},
    {pattern: /^\s*du\b/i, reason: 'Show directory usage'},
    {pattern: /^\s*free\b/i, reason: 'Show memory usage'},
    {pattern: /^\s*top\b/i, reason: 'Show processes'},
    {pattern: /^\s*ps\b/i, reason: 'Show processes'},
    {pattern: /^\s*git\s+(status|log|diff|branch|show|stash\s+list)\b/i, reason: 'Git read-only'},
    {pattern: /^\s*npm\s+(ls|list|outdated|audit|view|info)\b/i, reason: 'npm read-only'},
    {pattern: /^\s*node\s+--version/i, reason: 'Version check'},
    {pattern: /^\s*npm\s+--version/i, reason: 'Version check'},
    {pattern: /^\s*python\s+--version/i, reason: 'Version check'},
    {pattern: /^\s*npm\s+test\b/i, reason: 'Run tests'},
    {pattern: /^\s*npm\s+run\s+(test|lint|check|build)\b/i, reason: 'Run npm script'},
    {pattern: /^\s*npm\s+install\b(?!.*-g)/i, reason: 'Local npm install'},
    {pattern: /^\s*yarn\s+(install|add)\b(?!.*--global)/i, reason: 'Local yarn install'},
    {pattern: /^\s*pnpm\s+(install|add)\b(?!.*--global)/i, reason: 'Local pnpm install'},
    {pattern: /^\s*pip\s+install\s+--user\b/i, reason: 'User pip install'},
    {pattern: /^\s*pip\s+list\b/i, reason: 'pip read-only'},
];

/**
 * Classify a command's safety level.
 */
export function classifyCommandSafety(command: string): SafetyClassification {
    const trimmed = command.trim();

    // Check for dangerous patterns first (RED) - always takes precedence
    for (const {pattern, reason} of DANGEROUS_PATTERNS) {
        if (pattern.test(trimmed)) {
            return {level: 'red', reason, command: trimmed};
        }
    }

    // Check for risky patterns (YELLOW) - before safe patterns
    // This ensures operations like redirects are caught even with safe base commands
    for (const {pattern, reason} of RISKY_PATTERNS) {
        if (pattern.test(trimmed)) {
            return {level: 'yellow', reason, command: trimmed};
        }
    }

    // Check for safe patterns (GREEN)
    for (const {pattern, reason} of SAFE_PATTERNS) {
        if (pattern.test(trimmed)) {
            return {level: 'green', reason, command: trimmed};
        }
    }

    // Default to YELLOW for unknown commands
    return {level: 'yellow', reason: 'Unknown command', command: trimmed};
}

/**
 * Check if a command should be auto-approved.
 */
export function shouldAutoApprove(classification: SafetyClassification): boolean {
    return classification.level === 'green';
}

/**
 * Check if a command should be blocked.
 */
export function shouldBlock(classification: SafetyClassification): boolean {
    return classification.level === 'red';
}

/**
 * Get user-friendly description of safety level.
 */
export function getSafetyDescription(level: SafetyLevel): string {
    switch (level) {
        case 'green':
            return 'Safe - will auto-execute';
        case 'yellow':
            return 'Needs confirmation';
        case 'red':
            return 'Blocked - potentially dangerous';
    }
}
