/** Model-facing lifecycle contract for session-owned background shell jobs. */
export function getBackgroundShellAddendum(): string {
  return `### Background shell jobs

Use \`shell\` with \`background: true\` only for work that can continue after you return control. A successful launch returns \`{ jobId, status: "running" }\`.

- A \`status: "running"\` handle means the job launched successfully. Do NOT call \`get_shell_job\` as a polling loop and do not run \`sleep\` merely to wait.
- End the current turn and wait for the automatic completion notification. It arrives when the job settles and includes its terminal status and bounded output, so continue from that notification.
- Use \`get_shell_job\` only when a later user instruction requires an early status check for a specific job. Use \`cancel_shell_job\` only when the user asks to stop that job or the task requires cancellation.`;
}
