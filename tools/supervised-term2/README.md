# Supervised Term2 workers

This Linux launcher owns a single local Node worker and its process group. It
addresses the October 6 incident in which supervisor continuations embedded raw
tool transcripts, an unattended main run accumulated context without an enforced
request ceiling, and shell cancellation left previous workers alive.

```sh
node tools/supervised-term2/launch.mjs \
  --prompt /path/to/handoff.txt --lock /path/to/task-worker.lock \
  -- --provider openrouter --model z-ai/glm-5.3-flash
```

Build Term2 first. The launcher defaults to this checkout's `dist/cli.js`.
Credentials remain in the existing environment/settings connection. The launcher
does not read credentials, create a proxy, alter sandbox policy, or grant tool
approvals. `--entry` is for another Node entry point; `--import` preserves an
existing authorized transport adapter. Reserve one lock directory per shared
worktree/task, and use it for **every** replacement worker.

## Handoff and worker ownership

The launcher rejects handoffs above 32,768 UTF-8 bytes before spawning anything.
The bounded file read detects a file that grows during the read. It never clips
source evidence or asks a model to summarize it. Later useful incident handoffs
were 3,030–11,247 bytes, while the failed handoff was 724,487 bytes. The ceiling
allows nearly three times the largest successful later handoff. A handoff should
contain the outcome, authority/constraints, verified facts, completed effects,
changed files/commits, blockers, next action, and paths to evidence. Keep raw
receipts in retrievable artifacts, and say explicitly when a fact is uncertain.
Handoff text is transferred through a private pipe, not OS-visible argv.

Atomic lock-directory creation rejects a second worker before starting it. The
ownership record contains only supervisor/worker identity and process-group IDs.
SIGINT/SIGTERM cancel the owned group; after a five-second grace period the
launcher sends SIGKILL. It releases the lock only after the child exits and the
process group no longer exists. It also cleans up owned descendants after normal
worker exit. A retained lock means shutdown is unproven, not that the task failed.

The child checks the supervisor's Linux start-time identity every 250ms, including
zombie state. If the supervisor disappears or its PID is reused, the child kills
its own dedicated process group. After supervisor SIGKILL, the lock remains.
Inspect `owner.json`, reconcile unfinished/ambiguous external effects, and prove
the recorded group stopped before explicitly removing a stale lock. The launcher
never treats a missing supervisor as permission to start a replacement.

## Effective Term2 profile

The launcher sets `TERM2_SUPERVISED=1`. `buildEnvOverrides` supplies these values
above persisted configuration and defaults, below explicit CLI/live overrides:

| Setting | Supervised profile | Ordinary shipped default |
| --- | --- | --- |
| `agent.contextCompaction.enabled` | `true` | `false` |
| `agent.contextCompaction.mode` | `local` | `auto` |
| `agent.contextCompaction.compactThresholdTokens` | 60,000 | `null` |
| `agent.maxRequestInputTokens` | 80,000 | `null` (disabled) |
| `agent.maxOutputTokens` | 8,192 | 32,000 |

Compaction's unchanged ratio is 0.8. The incident model's catalog context window
is 1,048,575 tokens, so ratio-only compaction would not trigger until about
839,000 tokens. Rollover defaults to optional reminders at 200k/300k/400k, not
containment. These defaults, plus main-run budget escalation `warn`, are too
permissive for this unattended workflow. They remain unchanged globally to avoid
silently introducing paid summarization and summary-quality tradeoffs for every
interactive session. Parallelism, retries and reasoning defaults are unchanged.
The profile's smaller output cap addresses the observed 32,000-token tool-call
batch; it does not rely on providers respecting a serial-tool hint.

The request ceiling is a separate admission control, **not a monetary budget**.
At the actual dispatch boundary, after request preparation and optional
compaction, Term2 checks the greater of its rendered UTF-8-byte/4 estimate and
the last provider-observed input count. It includes instructions/tool definitions
and reconstructed history for chained requests. A replacement after successful
compaction is measured afresh rather than compared with obsolete usage.
An existing delta-history chain without a complete snapshot is refused even if
older usage is available: that count cannot measure subsequent retained growth.

Local compaction preserves recent turns and cannot safely cut a long single-turn
worker; automatic compaction also has a per-run cap. Failure, refusal, or deferred
compaction therefore cannot waive the request ceiling. A trip emits
`request_input_limit` / `reject_before_dispatch`, rejects without a provider
call or fabricated billing marker, retains transcript and completed tools, and
does not retry or switch models to evade the ceiling. Root and transient role
clients read the same live setting on start and continuation. To continue useful
work, compact a safe completed prefix, use an artifact-backed handoff with
reconciled effects, or explicitly raise the ceiling in `/settings`. Large work is
not evidence of failure; no completed action is automatically replayed.

An explicit persisted 300,000ms request deadline is now preserved rather than
guessed to be an old default and rewritten to zero. Existing zero values remain
zero; their lost provenance cannot be reconstructed automatically.

One-shot child workers inherit the selected output default, stream-character,
request-deadline and idle controls when their agent override bypasses the root
factory. Explicit role `maxTokens` retains its existing precedence; it can raise
or lower the output default, so 8,192 is not an unconditional role output cap.
Inherited output defaults use the same catalog model ceiling as the root factory.

## Verification and remaining limits

```sh
node --test tools/supervised-term2/supervisor.test.mjs
pnpm test source/services/agent-runtime/request-input-limit.test.ts
pnpm test:provider-black-box
```

Tests cover the incident-sized handoff, threshold boundaries, unchanged source
artifacts, overlapping launch refusal, verified stop/replacement, stale locks,
supervisor SIGKILL, actual single-turn compaction refusal, failed compaction after
a completed effect, request preparation, transient agents, and built-CLI wire
admission/profile behavior. All fixtures are local; no paid provider is needed.

This is not a zero-recurrence or exact billing guarantee. Token estimates can
undercount, and provider usage is known only after a request; one admitted request
can overshoot. Many useful requests below the ceiling can still spend money, so
retain provider-enforced credential spending caps and independent billing review.
The launcher cannot stop an external remote action, a process that deliberately
escapes the process group, or a blocked kernel operation. Abruptly stopped effects
remain uncertain and require reconciliation. A supervisor can deliberately bypass
this launcher or choose a different lock directory; workflow adoption is required.
The task-local old launcher has been retired, and its replacement invokes this
guarded path. Repository changes alone do not enforce every external supervisor.
