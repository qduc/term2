import {SafetyStatus} from '../constants.js';
import type {
    CommandHandler,
    CommandHandlerHelpers,
    CommandHandlerResult,
} from './types.js';

/**
 * Handler for find command safety analysis
 */
export const findHandler: CommandHandler = {
    handle(node: any, helpers: CommandHandlerHelpers): CommandHandlerResult {
        const {
            extractWordText,
            analyzePathRisk,
            hasFindDangerousExecution,
            hasFindSuspiciousFlags,
        } = helpers;
        const reasons: string[] = [];
        let status: SafetyStatus = SafetyStatus.GREEN;

        if (!node.suffix) {
            return {status, reasons};
        }

        // Check for dangerous find operations first (RED)
        const dangerResult = hasFindDangerousExecution(node.suffix);
        if (dangerResult.dangerous) {
            return {
                status: SafetyStatus.RED,
                reasons: [dangerResult.reason || 'find with dangerous flags'],
            };
        }

        // Check for suspicious find flags (YELLOW)
        const suspiciousResult = hasFindSuspiciousFlags(node.suffix);
        if (suspiciousResult.suspicious) {
            status = SafetyStatus.YELLOW;
            reasons.push(
                suspiciousResult.reason || 'find with suspicious flags',
            );
        }

        // Check path arguments for find
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
                status = SafetyStatus.YELLOW;
                reasons.push('find / (root traversal - resource intensive)');
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

                const isHomeRelated = homeRelatedPatterns.some(pattern =>
                    pattern.test(argText),
                );

                if (isHomeRelated) {
                    status = SafetyStatus.RED;
                    reasons.push(`find dangerous path: ${argText}`);
                } else {
                    // System paths like /etc get downgraded to YELLOW
                    status = SafetyStatus.YELLOW;
                    reasons.push(`find system path: ${argText}`);
                }
            } else if (pathStatus === SafetyStatus.YELLOW) {
                status = pathStatus;
                reasons.push(`find path argument ${argText}`);
            }
        }

        return {status, reasons};
    },
};
