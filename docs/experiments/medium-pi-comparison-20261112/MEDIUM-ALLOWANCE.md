# Medium-task allowance amendment, before the primary cohort

The v2 pilot exposed an inherited small-task harness limit: Pi's first OpenAI
run attempted a 61st request after its last paid response requested two tools.
The gateway rejected it with HTTP 402 at the 60-request quota. Pi recorded a
terminal assistant error but exited zero. This is a confirmed artificial cutoff,
not evidence that the model had naturally finished. The same artifact also fails
the frozen functional/complexity checks; no feedback is supplied to either agent.

Pause v2 after its active Anthropic Pi run naturally settles, before the next
agent starts. An explicit controllerPauseSentinel/agentWasNotStarted checkpoint
in the next run's started.json triggers the existing fail-closed guard. It is
not a receipt of an actual agent execution. Preserve the checkpoint and all pilot
artifacts. Do not kill a pending paid request or release any reservation.

All v2 pilots, including the normally completed Term2 run, are exploratory and
excluded from the primary paired cohort. Their costs, failures and time remain
reported separately as campaign overhead. Excluding the entire pilot rather
than selecting outcomes avoids mixing protocols or preferentially rerunning
failed outputs. The earlier transport-only v1 attempt remains overhead too.

The primary cohort uses v3 IDs and a **200-request per-run allowance**, with the
same hard **$15 cumulative cap**, **20-minute timeout**, five repetitions per
runner/provider, alternating order, task, source, rubric, models, effort,
immutable agent runtimes, sandbox OFF and always-approve settings. There is no
change to the coding prompt or grading source in response to pilot output.
The internal request allowance and run IDs change. The primary plan also groups
providers: complete all five OpenAI pairs first, then Anthropic pairs, with the
same alternating runner order inside each provider. Pilot native costs show
Anthropic materially more expensive on this task; grouping ensures the approved
budget can yield one full five-pair comparison rather than leave every provider
undersampled. This ordering decision is frozen before v3 and does not select
runs based on their outcomes. This remains a bounded
study; any 200-request or time cutoff is a failed/truncated attempt and must be
reported. No additional budget authorization is needed within the approved $15.

Read-only reporting additionally detects Pi's last assistant message ending in
`stopReason: error`, since an exit code of zero is insufficient. Keep the original
stored frozen `qualityPass` field and report accepted completion separately:
frozen artifact acceptance plus no terminal CLI failure. This implements the
already stated requirement to count truncation as failure, without changing any
functional test or rerunning an agent with grader feedback. The captured v2
zero-exit 402 is the real-boundary regression evidence for this reporting check.
