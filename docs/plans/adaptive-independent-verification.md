# Adaptive independent verification

The completion boundary now treats a root durable goal's recorded `goal_check achieved` as a proposal.
The host gate authorizes completion, requests a repair, or returns control with the goal still active.
This path is enabled by default. The explicit immediate-live recommendation in the proposal takes
precedence over its earlier phased-rollout sequence; model quality thresholds have not been established.

## Initial eligibility and policy

The first integration covers root durable goals in local Git repositories. Ordinary responses without
an active goal, blocked/deferred self-checks, and transient subagents keep their existing lifecycle.
Remote, non-Git, oversized, unsupported, and unverifiable workspace snapshots cannot authorize an achieved
proposal. Each one names its cause to the user and writes a `completion_verification.operational_alert`
carrying the reason, the workspace path and the task id; such a workspace has no attested revision, so it
leaves no persisted verification row. Independent verification currently supports repository inspection rather than arbitrary test
execution. Tasks needing runtime evidence return INCONCLUSIVE when that evidence cannot be obtained.

`adaptive-verification-v1` requires independent verification for executable/configuration and unknown
changes. Only regular, non-executable `.md`, `.txt`, and `.rst` changes qualify for model-selected skip;
both HEAD and current file modes are inspected. Sensitive documentation paths remain mandatory.
A deterministic 5% sample of proposed skips is independently verified before completion; logs retain the
original recommendation separately from the action. This audit is bounded by the same task budgets.

`agent.decisionModel` selects the existing OpenRouter Decisions adapter (Jev or another compatible model).
It remains optional. Unavailability, invalid output, invalid confidence, unknown policy, timeout, or
unsupported metadata falls back to independent verification or blocking. Model confidence is not proof.
The gate receives a bounded original goal, criteria, host-observed change metadata, and the worker claim.

The only initial deterministic checker applies when the exact acceptance criterion is
`git diff --check` and the changes are eligible documentation. Every other quick-check recommendation
is upgraded to independent verification. A failed quick check requests repair, never completion. The check
covers exactly the change set the revision attests to: tracked changes against HEAD, staged and unstaged
alike, plus every untracked file. A staged whitespace error is inside the attested revision, so the check
must see it.

## Isolation and evidence

Each verifier gets a new application run loop and a new provider transport, literal verifier instructions,
the original goal/criteria, repository path, revision, and attempt ID. It receives no worker transcript,
reasoning, explanation, confidence, memory instructions, or prior verifier conclusion. Its only tool
offers bounded file reads, file listing, diff inspection, and a whitespace probe. It has no editor,
arbitrary shell, delegation, approval, or task-state tools. Invalid tool use invalidates the result.

Git operations disable fsmonitor and external diff/textconv/pager execution. A clean/process
filter that a tracked path selects causes diff/snapshot verification to block: Git can otherwise execute
those filters even with `--no-ext-diff --no-textconv`. A configured filter that no path selects stays
inert, so ambient configuration such as a system-wide Git LFS install blocks only once a repository
binds a path to it. The initial policy prefers an explicit unsupported-workspace outcome over running
repository-selected code.

A valid report includes outcome, evidence, checked items, limitations, verifier version, attempt ID,
revision, and reported cost when available. At least one successful independent probe is required;
a failed read followed by an asserted PASS is invalid. The adapter includes successful probe receipts
in the checked items. A PASS remains a scoped assessment, not a guarantee of exhaustive correctness.

The revision hashes HEAD, the tracked working diff, and untracked file contents. HEAD alone is not enough.
Missing/stale artifacts and changes before settlement block completion. Snapshot input is bounded to
512 changed files and 2 MiB of diff/untracked contents. Git commands have 10-second deadlines.
Ignored files and external runtime state are not attested; do not treat this adapter as runtime proof.

## Budgets and durable control

Task records live in `completion-verification.sqlite` under `env-paths('term2').data`, with private file
permissions, WAL, full synchronous persistence, and compare-and-swap transitions. Records include a
recovery epoch, generation, task contract, revision, operation/task deadlines, gate/verifier invocation
counts, and consumed repairs. Terminal states reject normal updates. A new recovery epoch prevents old
callbacks from matching a task recreated by an administrator.

Defaults: three repairs, four gate attempts, four verification invocations, a 30-minute completion/repair
window, a 10-second gate deadline, and a 120-second verification deadline. A verifier also has at most
12 model rounds, 24 probes, and 4096 output tokens per round. These are containment settings, not measured
quality/latency thresholds. No separate monetary ceiling is claimed. Reported helper charges are logged;
they are not currently added to the foreground cost footer.

`agent.verificationMaxRepairs` configures new tasks (0–10). Persisted tasks retain all original budgets;
the tighter gate/verification count can exhaust before a larger repair setting. Programmatic harness
adapters can supply all budgets through `VerificationBudgets`.

FAIL consumes a repair atomically before returning the continuation. A repair must change the repository
revision. Repeated identical failure evidence, no progress, deadline, or budget exhaustion blocks.
The same run's autonomous repair is stopped at the persisted task deadline, including a nonresponsive
model. Cancellation is propagated; late results cannot settle the task. A tool ignoring cancellation may
still need the existing execution host's process containment, but cannot authorize task completion.

New user instructions, including admitted steering, supersede the harness repair continuation's timer.
They can ask another question or defer the goal. They do not refund counters or authorize an expired or
terminal task's completion. On restart, a persisted uncertain in-flight verification is blocked rather
than automatically redispatched; consumed repairs and task deadlines remain authoritative.

`completion_verification_blocked` is a distinct terminal cause. The UI receives a visible notice and
the goal stays active; non-interactive execution exits 2 and emits no `completed` record.

## Operations, rollback, and recovery

`agent.completionVerification=false` restores the existing goal self-check completion path at the next
completion boundary. It does not erase verification records or grant user authorization. Re-enable it
after addressing failures. Both settings appear under Safety in `/settings` with schema descriptions.

Look for `completion_verification.transition` and `completion_verification.operational_alert` in logs.
Transitions include task/revision/attempt identifiers, gate policy and recommendation, overrides, result,
counters, timestamps, durations, and available cost. Prior reports carry their own attempt/revision IDs
and `reportCurrent` distinguishes them from the current attempt. Logs omit raw worker and verifier
evidence; the private database retains bounded reports for inspection. Logging failure generates an
operational alert where possible and never substitutes for verification or persistence.

After building, an operator can inspect or recover one exact task using its logged task ID:

```sh
node dist/completion-verification-admin.js inspect TASK_ID
node dist/completion-verification-admin.js recover TASK_ID OPERATOR "Reason for a new verification epoch"
```

Recovery refuses a live, unexpired pending operation. Stop the old process and wait for its persisted
operation deadline if it crashed without settlement. Recovery records operator, reason, timestamp, and
the previous record atomically in `completion_verification_recovery`, then removes the current row.
The next completion proposal starts a new epoch; stale callbacks cannot change it. This entry point is
not registered as an agent tool. Database corruption/unavailability requires operator repair or backup
restoration; it never falls back to successful completion. Keep the original database for investigation.

## Evidence and remaining evaluation

`source/services/completion-verification/completion-verification.integration.test.ts` exercises real Git
repositories and SQLite persistence, restart/reopen, concurrent duplicate/stale callbacks, terminal-state
protection, recovery epochs, malformed results, timeouts, cancellation, failed-only probe evidence,
actual deterministic checks, audit sampling, repairs, scope-preserving steering, Git executable hooks and
filters, and the root AgentClient's fresh verifier transport and successful goal closure.

Repository-required typecheck, lint, static guards, provider black-box checks, and independent verification
are recorded in the task ledger with their actual results. These deterministic fixtures establish control
behavior; they do not measure Jev's false-skip rate or the verifier model's accuracy.
Real-task baseline comparisons, rare-defect calibration, escaped-defect rates, latency/cost distributions,
and adoption thresholds remain unmeasured. Use audited recommendations and inspectable independent labels
to collect that evidence during live use. Parallel preparation and artifact reuse are deferred.
