import {SafetyStatus} from '../constants.js';
import type {
    CommandHandler,
    CommandHandlerHelpers,
    CommandHandlerResult,
} from './types.js';

/**
 * Handler for sed command safety analysis
 */
export const sedHandler: CommandHandler = {
    handle(node: any, helpers: CommandHandlerHelpers): CommandHandlerResult {
        const {extractWordText, analyzePathRisk} = helpers;
        const reasons: string[] = [];
        let status: SafetyStatus = SafetyStatus.GREEN;

        if (!node.suffix) {
            return {status, reasons};
        }

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
                if (argText.startsWith('-i')) {
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

                if (op === '>' || op === '>>') {
                    status = SafetyStatus.YELLOW;
                    reasons.push(
                        `sed with output redirection to ${
                            fileText ?? '<unknown>'
                        }`,
                    );
                }

                const pathStatus = analyzePathRisk(fileText);
                if (pathStatus !== SafetyStatus.GREEN) {
                    status = pathStatus;
                    reasons.push(`redirect to ${fileText ?? '<unknown>'}`);
                }
                continue;
            }

            const argText = extractWordText(arg);
            // Flags are normally ignored, but for `sed` the -i flag is dangerous
            // because it performs in-place edits. Detect -i and variants (e.g. -i, -i.bak, -i'')
            if (argText && argText.startsWith('-')) {
                if (argText.startsWith('-i')) {
                    return {
                        status: SafetyStatus.RED,
                        reasons: [`sed in-place edit detected: ${argText}`],
                    };
                }
                continue; // other flags ignored
            }

            const pathStatus = analyzePathRisk(argText);
            // For `sed`, file arguments are only risky if combined with dangerous operations
            if (argText) {
                // If there's an in-place edit or output redirect, path risk matters
                // Otherwise, reading files with sed is safe (GREEN)
                if (hasInPlaceEdit || hasOutputRedirect) {
                    if (pathStatus === SafetyStatus.RED) {
                        status = pathStatus;
                        reasons.push(`sed file argument ${argText}`);
                    } else {
                        status = SafetyStatus.YELLOW;
                        reasons.push(`sed file argument ${argText}`);
                    }
                } else {
                    // Read-only sed: only escalate if path itself is risky
                    if (pathStatus !== SafetyStatus.GREEN) {
                        status = pathStatus;
                        reasons.push(`sed file argument ${argText}`);
                    }
                    // Otherwise GREEN - read-only sed is safe
                }
                continue;
            }

            // Unknown/opaque args fall back to YELLOW
            if (!argText) {
                status = SafetyStatus.YELLOW;
                reasons.push('opaque or unparseable argument');
            }
        }

        return {status, reasons};
    },
};
