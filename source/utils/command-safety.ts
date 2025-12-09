import parse from 'bash-parser';
import path from 'path';
import {loggingService} from '../services/logging-service.js';

// 1. CONSTANTS
// Note: 'sed' is useful for read-only transformations. We allow it by default
// but add guards below to prevent in-place edits (-i) and unapproved redirections.
const ALLOWED_COMMANDS = new Set([
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
const BLOCKED_COMMANDS = new Set([
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

/* legacy containsDangerousCommand removed — replaced by classifyCommand + path analysis */

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

// Extract a best-effort string for a word/arg node, including expansions.
function extractWordText(word: any): string | undefined {
    if (!word) return undefined;
    if (typeof word === 'string') return word;
    if (typeof word.text === 'string') return word.text;
    if (typeof word.value === 'string') return word.value;
    if (typeof word.content === 'string') return word.content;
    if (word.parameter) return `$${word.parameter}`;
    if (Array.isArray(word.parts)) {
        return word.parts
            .map((part: any) => extractWordText(part) ?? '')
            .join('');
    }
    return undefined;
}

// 2. FIND COMMAND HELPERS

/**
 * Check if a find command has dangerous execution flags (-exec, -execdir, -ok, -okdir, -delete)
 */
function hasFindDangerousExecution(args: any[]): {
    dangerous: boolean;
    reason?: string;
} {
    for (let i = 0; i < args.length; i++) {
        const argText = extractWordText(args[i]);
        if (!argText) continue;

        // Check for -delete flag
        if (argText === '-delete') {
            return {dangerous: true, reason: 'find -delete (destructive)'};
        }

        // Check for execution flags
        const execFlags = ['-exec', '-execdir', '-ok', '-okdir'];
        if (!execFlags.includes(argText)) continue;

        // Found an exec flag - analyze the command it executes
        // Find the terminator (; or +)
        let terminatorIndex = -1;
        for (let j = i + 1; j < args.length; j++) {
            const term = extractWordText(args[j]);
            if (
                term === ';' ||
                term === '+' ||
                term === '\\;' ||
                term === '\\+'
            ) {
                terminatorIndex = j;
                break;
            }
        }

        if (terminatorIndex === -1) {
            // Malformed -exec (no terminator)
            return {
                dangerous: true,
                reason: `find ${argText} without terminator`,
            };
        }

        // Extract the command between exec flag and terminator
        const execArgs = args.slice(i + 1, terminatorIndex);

        // Check for redirects (which indicate shell operations)
        const hasRedirect = execArgs.some((a: any) => a?.type === 'Redirect');
        if (hasRedirect) {
            return {
                dangerous: true,
                reason: `find ${argText} with shell redirection`,
            };
        }

        const execCommand = execArgs
            .map(a => extractWordText(a))
            .filter(Boolean);

        if (execCommand.length === 0) {
            return {
                dangerous: true,
                reason: `find ${argText} with empty command`,
            };
        }

        const cmdName = execCommand[0];
        if (!cmdName) {
            return {
                dangerous: true,
                reason: `find ${argText} with undefined command`,
            };
        }

        // Check if {} is the command itself (executing found files)
        if (cmdName === '{}') {
            return {
                dangerous: true,
                reason: `find ${argText} {} (executes found files directly)`,
            };
        }

        // Check for destructive commands
        const destructiveCmds = [
            'rm',
            'shred',
            'chmod',
            'chown',
            'mv',
            'dd',
            'mkfs',
            'truncate',
            'tee',
            'cp',
            'ln',
            'install',
            'rsync',
        ];
        if (destructiveCmds.includes(cmdName)) {
            return {
                dangerous: true,
                reason: `find ${argText} ${cmdName} (destructive)`,
            };
        }

        // Check for dangerous interpreters and meta-executors
        // These can all invoke arbitrary commands or scripts
        const dangerousInterpreters = [
            // Shells
            'sh',
            'bash',
            'zsh',
            'ksh',
            'dash',
            'fish',
            'tcsh',
            'csh',
            // Script interpreters
            'perl',
            'python',
            'python2',
            'python3',
            'ruby',
            'node',
            'nodejs',
            'php',
            'lua',
            // Meta-executors that can run commands
            'env',
            'xargs',
            'parallel',
            'nohup',
            'nice',
            'ionice',
            'timeout',
            'stdbuf',
            'script',
            'expect',
            // Text processors that can execute
            'awk',
            'gawk',
            'mawk',
            'nawk',
            'sed',
            'ed',
            // Editors that can run shell commands
            'vim',
            'nvim',
            'emacs',
        ];

        // Handle both bare names and full paths like /usr/bin/python
        const isDangerousInterpreter = dangerousInterpreters.some(
            interp => cmdName === interp || cmdName.endsWith(`/${interp}`),
        );

        if (isDangerousInterpreter) {
            return {
                dangerous: true,
                reason: `find ${argText} ${cmdName} (can execute commands)`,
            };
        }

        // Check for shell metacharacters in command
        const fullExecCmd = execCommand.join(' ');
        if (/[|&;$`<>]/.test(fullExecCmd)) {
            return {
                dangerous: true,
                reason: `find ${argText} with shell metacharacters`,
            };
        }
    }

    return {dangerous: false};
}

/**
 * Check for suspicious find flags that warrant YELLOW classification
 */
function hasFindSuspiciousFlags(args: any[]): {
    suspicious: boolean;
    reason?: string;
} {
    for (const arg of args) {
        const argText = extractWordText(arg);
        if (!argText) continue;

        // File output flags
        if (
            ['-fprint', '-fprint0', '-fprintf', '-fls'].some(flag =>
                argText.startsWith(flag),
            )
        ) {
            return {
                suspicious: true,
                reason: `find ${argText} (file output)`,
            };
        }

        // Symlink following
        if (['-L', '-follow', '-H'].includes(argText)) {
            return {
                suspicious: true,
                reason: `find ${argText} (symlink following)`,
            };
        }

        // SUID/SGID permission searches
        if (argText === '-perm') {
            // Check the next argument for dangerous permission patterns
            const nextIdx = args.indexOf(arg) + 1;
            if (nextIdx < args.length) {
                const permValue = extractWordText(args[nextIdx]);
                if (permValue) {
                    // Numeric SUID/SGID patterns (e.g., -4000, /6000)
                    const hasNumericSuid = /[-\/]?[2467]000/.test(permValue);
                    // Symbolic SUID/SGID patterns (e.g., -u+s, /g+s, +s)
                    const hasSymbolicSuid = /[ug]?\+s/.test(permValue);

                    if (hasNumericSuid || hasSymbolicSuid) {
                        return {
                            suspicious: true,
                            reason: `find -perm ${permValue} (SUID/SGID search)`,
                        };
                    }
                }
            }
        }

        // Inode-based searches (can bypass path restrictions)
        if (argText === '-inum') {
            return {
                suspicious: true,
                reason: 'find -inum (inode-based access bypasses path checks)',
            };
        }

        // Read-only exec (still suspicious, requires approval)
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(argText)) {
            // If we reach here, hasFindDangerousExecution already passed (not RED)
            // but any -exec usage should still be YELLOW
            return {
                suspicious: true,
                reason: `find ${argText} (command execution)`,
            };
        }
    }

    return {suspicious: false};
}

// 3. PATH ANALYSIS HELPER
function analyzePathRisk(inputPath: string | undefined): SafetyStatus {
    const candidate = inputPath?.trim();
    if (!candidate) return SafetyStatus.GREEN;

    // RED: Home directory and sensitive paths
    // Check for various home directory representations
    const homePatterns = [
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

    const isHomeRelated = homePatterns.some(pattern =>
        pattern.test(candidate),
    );

    if (isHomeRelated) {
        // Extract the path after home prefix for further analysis
        const sliced = candidate
            .replace(/^~/, '')
            .replace(/^\$\{?HOME\}?/, '')
            .replace(/^\$\{?USER\}?/, '')
            .replace(/^\$\{?LOGNAME\}?/, '')
            .replace(/^\/home\/[^/]+/, '')
            .replace(/^\/Users\/[^/]+/, '')
            .replace(/^\/root/, '');

        // Plain home directory access without any suffix is RED
        if (sliced === '' || sliced === '/') {
            loggingService.security('Path risk: home directory access', {
                path: candidate,
            });
            return SafetyStatus.RED;
        }

        // Check for sensitive dotfiles and directories
        const sensitivePaths = [
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

        if (
            /^\/\.\w+/.test(sliced) ||
            sensitivePaths.some(sensitive => sliced.includes(sensitive))
        ) {
            loggingService.security('Path risk: home dotfile or config', {
                path: candidate,
            });
            return SafetyStatus.RED;
        }
    }

    // RED: Absolute System Paths
    if (path.isAbsolute(candidate)) {
        const SYSTEM_PATHS = [
            '/etc',
            '/dev',
            '/proc',
            '/var',
            '/usr',
            '/boot',
            '/bin',
        ];
        if (SYSTEM_PATHS.some(sys => candidate.startsWith(sys))) {
            loggingService.security('Path risk: absolute system path', {
                path: candidate,
            });
            return SafetyStatus.RED;
        }
        // Home dotfiles when absolute
        if (
            /^\/(home|Users)\/[^/]+\/\.\w+/.test(candidate) ||
            candidate.includes('/.ssh') ||
            candidate.includes('/.gitconfig')
        ) {
            loggingService.security('Path risk: absolute home dotfile', {
                path: candidate,
            });
            return SafetyStatus.RED;
        }
        // Other absolute paths are suspicious -> audit
        loggingService.security('Path risk: absolute non-system path', {
            path: candidate,
        });
        return SafetyStatus.YELLOW;
    }

    // RED: Directory Traversal
    if (candidate.includes('..')) {
        loggingService.security('Path risk: directory traversal detected', {
            path: candidate,
        });
        return SafetyStatus.RED;
    }

    // Hidden files -> YELLOW
    const filename = path.basename(candidate);
    if (filename.startsWith('.')) {
        loggingService.security('Path risk: hidden file', {path: candidate});
        return SafetyStatus.YELLOW;
    }

    // Sensitive extensions
    const SENSITIVE_EXTENSIONS = ['.env', '.pem', '.key', '.json'];
    if (SENSITIVE_EXTENSIONS.some(ext => filename.endsWith(ext))) {
        loggingService.security('Path risk: sensitive extension', {
            path: candidate,
        });
        return SafetyStatus.YELLOW;
    }

    return SafetyStatus.GREEN;
}

/**
 * Classify command into a SafetyStatus (GREEN/YELLOW/RED)
 */
export function classifyCommand(commandString: string): SafetyStatus {
    try {
        const reasons: string[] = [];
        const truncatedCommand = commandString.substring(0, 200);
        loggingService.security('Classifying command safety', {
            command: truncatedCommand,
        });
        const ast = parse(commandString, {mode: 'bash'});
        let worstStatus: SafetyStatus = SafetyStatus.GREEN;

        function upgradeStatus(s: SafetyStatus, reason?: string) {
            if (worstStatus === SafetyStatus.RED) return;
            if (s === SafetyStatus.RED) worstStatus = SafetyStatus.RED;
            else if (
                s === SafetyStatus.YELLOW &&
                worstStatus === SafetyStatus.GREEN
            )
                worstStatus = SafetyStatus.YELLOW;
            if (reason) reasons.push(`${s}: ${reason}`);
        }

        function traverse(node: any): void {
            if (!node) return;

            if (Array.isArray(node)) return node.forEach(traverse);

            if (node.type === 'Command') {
                const name =
                    node.name?.text ||
                    (node.name &&
                        node.name.parts &&
                        node.name.parts.map((p: any) => p.text).join(''));
                if (typeof name === 'string') {
                    if (BLOCKED_COMMANDS.has(name)) {
                        upgradeStatus(
                            SafetyStatus.RED,
                            `blocked command: ${name}`,
                        );
                        return;
                    }
                    if (!ALLOWED_COMMANDS.has(name)) {
                        upgradeStatus(
                            SafetyStatus.YELLOW,
                            `unknown or unlisted command: ${name}`,
                        );
                    }
                }

                const cmdName = typeof name === 'string' ? name : undefined;

                // Special handling for find command
                if (cmdName === 'find' && node.suffix) {
                    // Check for dangerous find operations first (RED)
                    const dangerResult = hasFindDangerousExecution(node.suffix);
                    if (dangerResult.dangerous) {
                        upgradeStatus(
                            SafetyStatus.RED,
                            dangerResult.reason || 'find with dangerous flags',
                        );
                    }

                    // Check for suspicious find flags (YELLOW)
                    if (!dangerResult.dangerous) {
                        const suspiciousResult =
                            hasFindSuspiciousFlags(node.suffix);
                        if (suspiciousResult.suspicious) {
                            upgradeStatus(
                                SafetyStatus.YELLOW,
                                suspiciousResult.reason ||
                                    'find with suspicious flags',
                            );
                        }
                    }

                    // Check path arguments for find
                    if (!dangerResult.dangerous) {
                        // Track if previous arg was a pattern flag like -name, -regex
                        let previousArgWasPatternFlag = false;

                        for (const arg of node.suffix) {
                            if (arg?.type === 'Redirect') continue;
                            const argText = extractWordText(arg);
                            if (!argText) continue;

                            // Track pattern flags
                            if (
                                [
                                    '-name',
                                    '-iname',
                                    '-path',
                                    '-ipath',
                                    '-regex',
                                    '-iregex',
                                ].includes(argText)
                            ) {
                                previousArgWasPatternFlag = true;
                                continue;
                            }

                            // Skip flags
                            if (argText.startsWith('-')) {
                                previousArgWasPatternFlag = false;
                                continue;
                            }

                            // Skip pattern arguments (the values after -name, -regex, etc.)
                            if (previousArgWasPatternFlag) {
                                previousArgWasPatternFlag = false;
                                continue;
                            }

                            // Skip glob patterns (contain wildcards)
                            if (/[*?[\]]/.test(argText)) continue;

                            // Skip safe relative paths (. and ./)
                            if (argText === '.' || argText === './') continue;

                            // Skip patterns with backslashes (regex patterns)
                            if (argText.includes('\\')) continue;

                            // Root traversal detection (DoS + information disclosure)
                            if (argText === '/' || argText === '//') {
                                upgradeStatus(
                                    SafetyStatus.YELLOW,
                                    'find / (root traversal - resource intensive)',
                                );
                                continue;
                            }

                            // For find, analyzing paths is more lenient:
                            // - System paths like /etc are YELLOW (not RED)
                            // - Home directories and dotfiles are still RED
                            const pathStatus = analyzePathRisk(argText);
                            if (pathStatus === SafetyStatus.RED) {
                                // Keep RED for home directories, dotfiles, and traversal
                                // Downgrade system paths to YELLOW
                                const homeRelatedPatterns = [
                                    /^~/, // Tilde
                                    /^\$/, // Variables like $HOME, $USER
                                    /^\/home\//, // Linux home
                                    /^\/Users\//, // macOS home
                                    /^\/root/, // Root's home
                                    /\/\.ssh/, // SSH keys
                                    /\/\.env/, // Environment files
                                    /\/\.git/, // Git config
                                    /\/\.aws/, // AWS credentials
                                    /\/\.kube/, // Kubernetes config
                                    /\/\.gnupg/, // GPG keys
                                    /\.\./, // Directory traversal
                                ];

                                const isHomeRelated = homeRelatedPatterns.some(
                                    pattern => pattern.test(argText),
                                );

                                if (isHomeRelated) {
                                    upgradeStatus(
                                        SafetyStatus.RED,
                                        `find dangerous path: ${argText}`,
                                    );
                                } else {
                                    // System paths like /etc get downgraded to YELLOW
                                    upgradeStatus(
                                        SafetyStatus.YELLOW,
                                        `find system path: ${argText}`,
                                    );
                                }
                            } else if (pathStatus === SafetyStatus.YELLOW) {
                                upgradeStatus(
                                    pathStatus,
                                    `find path argument ${argText}`,
                                );
                            }
                        }
                    }

                    // Done with find-specific handling
                    // Don't process suffix generically
                    return;
                }

                if (node.suffix) {
                    let hasOutputRedirect = false;
                    let hasInPlaceEdit = false;

                    // First pass: detect dangerous sed patterns
                    for (const arg of node.suffix) {
                        if (arg?.type === 'Redirect') {
                            // Check if it's an output redirect (>, >>)
                            const op = arg.op?.text || arg.op;
                            if (op === '>' || op === '>>') {
                                hasOutputRedirect = true;
                            }
                        }

                        const argText = extractWordText(arg);
                        if (argText && argText.startsWith('-')) {
                            if (cmdName === 'sed' && argText.startsWith('-i')) {
                                hasInPlaceEdit = true;
                            }
                        }
                    }

                    // Second pass: classify arguments
                    for (const arg of node.suffix) {
                        // Redirects: analyze path risk. For `sed`, only mark output redirects as YELLOW
                        if (arg?.type === 'Redirect') {
                            const fileText = extractWordText(arg.file ?? arg);
                            const op = arg.op?.text || arg.op;

                            if (
                                cmdName === 'sed' &&
                                (op === '>' || op === '>>')
                            ) {
                                upgradeStatus(
                                    SafetyStatus.YELLOW,
                                    `sed with output redirection to ${
                                        fileText ?? '<unknown>'
                                    }`,
                                );
                            }

                            const pathStatus = analyzePathRisk(fileText);
                            upgradeStatus(
                                pathStatus,
                                `redirect to ${fileText ?? '<unknown>'}`,
                            );
                            continue;
                        }

                        const argText = extractWordText(arg);
                        // Flags are normally ignored, but for `sed` the -i flag is dangerous
                        // because it performs in-place edits. Detect -i and variants (e.g. -i, -i.bak, -i'')
                        if (argText && argText.startsWith('-')) {
                            if (cmdName === 'sed' && argText.startsWith('-i')) {
                                upgradeStatus(
                                    SafetyStatus.RED,
                                    `sed in-place edit detected: ${argText}`,
                                );
                                continue;
                            }
                            continue; // other flags ignored
                        }

                        const pathStatus = analyzePathRisk(argText);
                        // For `sed`, file arguments are only risky if combined with dangerous operations
                        if (cmdName === 'sed' && argText) {
                            // If there's an in-place edit or output redirect, path risk matters
                            // Otherwise, reading files with sed is safe (GREEN)
                            if (hasInPlaceEdit || hasOutputRedirect) {
                                if (pathStatus === SafetyStatus.RED)
                                    upgradeStatus(
                                        pathStatus,
                                        `sed file argument ${argText}`,
                                    );
                                else
                                    upgradeStatus(
                                        SafetyStatus.YELLOW,
                                        `sed file argument ${argText}`,
                                    );
                            } else {
                                // Read-only sed: only escalate if path itself is risky
                                if (pathStatus !== SafetyStatus.GREEN) {
                                    upgradeStatus(
                                        pathStatus,
                                        `sed file argument ${argText}`,
                                    );
                                }
                                // Otherwise GREEN - read-only sed is safe
                            }
                            continue;
                        }

                        // Unknown/opaque args fall back to YELLOW
                        if (!argText)
                            upgradeStatus(
                                SafetyStatus.YELLOW,
                                'opaque or unparseable argument',
                            );
                        else upgradeStatus(pathStatus, `argument ${argText}`);
                    }
                }
            }

            // recurse common shapes
            if (node.type === 'LogicalExpression') {
                traverse(node.left);
                traverse(node.right);
                return;
            }
            if (node.type === 'Pipeline') {
                (node.commands || []).forEach(traverse);
                return;
            }
            if (node.type === 'Subshell') {
                traverse(node.list);
                return;
            }
            if (node.type === 'CommandSubstitution') {
                (node.commands || []).forEach(traverse);
                return;
            }
            if (node.type === 'Script' || node.type === 'Program') {
                (node.commands || []).forEach(traverse);
                return;
            }

            for (const k of Object.keys(node)) {
                const v = node[k];
                if (v && typeof v === 'object') traverse(v);
            }
        }

        if (ast && ast.commands) {
            (ast.commands as any[]).forEach(traverse);
        }

        loggingService.security('Command classification result', {
            command: truncatedCommand,
            status: worstStatus,
            reasons,
        });

        return worstStatus;
    } catch (e) {
        // Fail-safe: unparsable -> audit
        loggingService.warn('Failed to parse command, classifying as YELLOW', {
            command: commandString.substring(0, 200),
            error: e instanceof Error ? e.message : String(e),
        });
        return SafetyStatus.YELLOW;
    }
}

/**
 * Validate command safety using an AST parser.
 * Returns true when a command requires user approval.
 * Throws for invalid/empty inputs OR hard-blocked RED classifications.
 */
export function validateCommandSafety(command: string): boolean {
    if (
        !command ||
        typeof command !== 'string' ||
        command.trim().length === 0
    ) {
        throw new Error('Command cannot be empty');
    }
    loggingService.security('Validating command safety', {
        command: command.substring(0, 200),
    });
    const status = classifyCommand(command);

    if (status === SafetyStatus.RED) {
        loggingService.security('Command validation failed: RED (forbidden)', {
            command: command.substring(0, 200),
        });
        throw new Error('Command classified as RED (forbidden)');
    }

    loggingService.security('Validation result', {
        command: command.substring(0, 200),
        status,
    });
    return status === SafetyStatus.YELLOW;
}
