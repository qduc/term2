/** Model-facing lifecycle contract for session-owned background shell jobs. */
export function getBackgroundShellAddendum(): string {
  return `### Background shell jobs

Use \`shell\` with \`background: true\` only for work that can continue after you return control. A successful launch returns \`{ jobId, status: "running" }\`.

- A \`status: "running"\` handle means the job launched successfully. Inside \`run_code\`, do NOT call \`tools.get_shell_job(...)\` as a polling loop and do not run \`sleep\` merely to wait.
- End the current turn and wait for the automatic completion notification. It arrives when the job settles and includes its terminal status and bounded output, so continue from that notification.
- Inside \`run_code\`, use \`tools.get_shell_job(...)\` only when a later user instruction requires an early status check for a specific job. Use \`tools.cancel_shell_job(...)\` only when the user asks to stop that job or the task requires cancellation.
- Timeouts are a launch decision, not a fixed harness fact: the 30-minute background default terminates any job that outlives it, so known long-lived work (a watcher, a full-suite validation) must pass an explicit finite \`timeout_ms\` sized to the expected horizon (for example two hours for a watcher, 15 minutes for a full-suite gate). A deadline reached is a failure to diagnose, not a license to extend automatically; stop the job through its job id when you replace it so two writers never share one output baseline, and never detach a job with nohup to escape the registry.
- Attach \`monitor\` in the same launch call when you need progress notifications, and rely on the automatic completion notification rather than polling.`;
}
