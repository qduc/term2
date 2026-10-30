export const DOCKER_HOST_CONTROL_APPROVE_ANSWERS = new Set([
    'docker-allow-once',
    'docker-allow-session',
    'docker-allow-project',
]);
export function isDockerHostControlApproveAnswer(answer) {
    return (typeof answer === 'string' && DOCKER_HOST_CONTROL_APPROVE_ANSWERS.has(answer));
}
export const READ_FILE_SESSION_APPROVE_ANSWER = 'allow-folder-session';
/**
 * Read-only tools whose approval prompt offers "allow this folder for this
 * session". The grant is session-scoped and shared, so approving a folder from
 * one of these prompts also covers the others.
 */
const FOLDER_SESSION_READ_TOOLS = new Set(['read_file', 'grep', 'glob']);
export function supportsFolderSessionRead(toolName) {
    return typeof toolName === 'string' && FOLDER_SESSION_READ_TOOLS.has(toolName);
}
export function isReadFileSessionApproveAnswer(answer) {
    return answer === READ_FILE_SESSION_APPROVE_ANSWER;
}
/** Answer strings for the denied-read approval variant (see prepareContinuation). */
export const DENIED_READ_APPROVE_ANSWERS = new Set([
    'allow-once',
    'allow-remember',
    'unsandboxed-once',
]);
export function isDeniedReadApproveAnswer(answer) {
    return typeof answer === 'string' && DENIED_READ_APPROVE_ANSWERS.has(answer);
}
/**
 * The tool name a check-in carries on the approval transport.
 *
 * It names no real tool. It exists because the descriptor requires a tool name
 * and because logs and snapshots already record this string; branch on
 * `checkIn` instead, never on this value.
 */
export const CHECK_IN_TOOL_NAME = 'max_turns_exceeded';
//# sourceMappingURL=conversation.js.map