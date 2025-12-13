import parse from 'bash-parser';
import {loggingService} from '../../services/logging-service.js';
import {
    SafetyStatus,
    ALLOWED_COMMANDS,
    BLOCKED_COMMANDS,
    SAFE_GIT_COMMANDS,
    DANGEROUS_GIT_COMMANDS,
} from './constants.js';
import {extractWordText} from './utils.js';
import {hasFindDangerousExecution, hasFindSuspiciousFlags} from './find-helpers.js';
import {analyzePathRisk} from './path-analysis.js';

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

                // Special handling for git command
                if (cmdName === 'git') {
                    // Extract the git subcommand (first non-flag argument)
                    let gitSubcommand: string | undefined;
                    if (node.suffix) {
                        for (const arg of node.suffix) {
                            const argText = extractWordText(arg);
                            if (argText && !argText.startsWith('-')) {
                                gitSubcommand = argText;
                                break;
                            }
                        }
                    }

                    if (!gitSubcommand) {
                        // No subcommand found (e.g., just "git" or "git --version")
                        upgradeStatus(
                            SafetyStatus.YELLOW,
                            'git without subcommand',
                        );
                        return;
                    }

                    // Check if it's a known dangerous command
                    if (DANGEROUS_GIT_COMMANDS.has(gitSubcommand)) {
                        upgradeStatus(
                            SafetyStatus.YELLOW,
                            `git ${gitSubcommand} (write operation)`,
                        );
                        return;
                    }

                    // Check if it's a known safe command
                    if (SAFE_GIT_COMMANDS.has(gitSubcommand)) {
                        // Check for dangerous flags that might make it unsafe
                        const hasDangerousFlags = node.suffix.some((arg: any) => {
                            const argText = extractWordText(arg);
                            if (!argText) return false;

                            // Flags that might modify repository state
                            return (
                                argText.startsWith('--force') ||
                                argText.startsWith('-f') ||
                                argText.startsWith('--hard') ||
                                argText.startsWith('--delete') ||
                                argText.startsWith('-d') ||
                                argText.startsWith('-D')
                            );
                        });

                        if (hasDangerousFlags) {
                            upgradeStatus(
                                SafetyStatus.YELLOW,
                                `git ${gitSubcommand} with potentially dangerous flags`,
                            );
                        }
                        // Otherwise stays GREEN - safe read-only git command
                        return;
                    }

                    // Unknown git subcommand
                    upgradeStatus(
                        SafetyStatus.YELLOW,
                        `git ${gitSubcommand} (unknown subcommand)`,
                    );
                    return;
                }

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

// Re-export types and constants for convenience
export {SafetyStatus} from './constants.js';