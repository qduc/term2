// Exhaustiveness below uses `value satisfies never` in default branches: if
// the union grows, the default-branch value is no longer `never` and this
// fails to compile until the new member is classified. Unlike a throwing
// assertNever it is also runtime-safe — the renderer feeds rows whose loose
// MessageLike types could in principle carry an unrecognized string, and an
// unrecognized row must degrade to "committable" (the pre-policy behavior),
// never crash the render loop.
export function classifyStaticCommitBlocker(message) {
    switch (message.sender) {
        case 'bot':
            return message.status === 'streaming' ? 'bot_streaming' : null;
        case 'reasoning':
            // No status yet means the live row exists but has not been finalized —
            // it still blocks.
            return message.status === 'finalized' ? null : 'reasoning_streaming';
        case 'command': {
            const status = message.status;
            switch (status) {
                case 'pending':
                    return 'command_pending';
                case 'running':
                    return 'command_running';
                case 'completed':
                case 'failed':
                case 'aborted':
                case 'unknown':
                    return null;
                default:
                    status;
                    return null;
            }
        }
        case 'subagent': {
            const status = message.status;
            switch (status) {
                case 'running':
                    return 'subagent_activity';
                case 'completed':
                case 'failed':
                case 'cancelled':
                case 'interrupted':
                case 'backgrounded':
                    return null;
                default:
                    status;
                    return null;
            }
        }
        case 'user':
        case 'system':
        case 'command-group':
            return null;
        default:
            message;
            return null;
    }
}
export const isBlockingStaticCommit = (message) => classifyStaticCommitBlocker(message) !== null;
export function turnEndSettlement(reason) {
    switch (reason) {
        case 'bot_streaming':
        case 'reasoning_streaming':
            return 'finalize';
        case 'command_pending':
        case 'command_running':
            return 'abort';
        case 'subagent_activity':
            return 'leave';
        default:
            reason;
            // Unreachable for the known union. If it somehow runs, leaving the row
            // alone can only keep the tail rendering dynamically — it can never
            // freeze live work into <Static> irreversibly.
            return 'leave';
    }
}
//# sourceMappingURL=static-commit-policy.js.map