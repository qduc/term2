export const SUBAGENT_ROLES = ['explorer', 'worker', 'mentor', 'librarian', 'reviewer'];
/**
 * True only when a result represents a settled run. An interrupted result is
 * terminal only when it carries a termination cause; an approval interruption
 * is a live pause and must not enter completion or retrieval lanes.
 */
export function isTerminalSubagentResult(result) {
    return (result.status === 'completed' ||
        result.status === 'failed' ||
        result.status === 'cancelled' ||
        (result.status === 'interrupted' && result.terminalCause !== undefined));
}
//# sourceMappingURL=types.js.map