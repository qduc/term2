# Fresh-built live verification (2026-09-07)

## Status

R1-R4 executed; no production fixes made. Evidence and limitations below.

Original user request: build current code, launch NEW interactive term2 as a test
subject, hunt bugs autonomously. Do not implement fixes merely from this
request. Priority order: live rollover workers, worker compaction history-key
ownership, deleted cwd including session-index worker, removal of a root owned
by a live process, then other bounded pokes. Report exact repro, expected and
observed; no survival claim from UI liveness alone.

Only owned Herdr target: workspace w18, newly created tab **w18:t4**, root pane
**w18:p4**, terminal term_65ade74c62e8814b. NEVER touch w18:p1/p2/p3 or w1/wS.
Use pane run/send-text/send-keys/read; agent prompt does not work here. One pane
per tab. No focus changes. Child interactive prompts must be verified from
responses/canonical events, not terminal echo.

Main baseline/build: 1103a9d0e85814b2a1d6dd6a426ba4aa695ef222. Parent ran pnpm
build successfully immediately before launch. Pre-existing untracked user file
docs/plans/run-code-nested-approval-preflight.md untouched.
Disposable owned worktree/branch: .worktrees/live-verify-subject /
live-verify-subject. Initial child launch through pane run:
`cd /home/qduc/term2/.worktrees/live-verify-subject && node /home/qduc/term2/dist/cli.js -p codex -m gpt-5.6-luna -r high`
No positional prompt; actual interactive TUI confirmed. Root was retained
through R2, then removed only in the R4 protocol below. Main checkout and
other agents were never removal targets.

R1 child predecessor session
ebafaa01-4fdc-423e-a7c5-4957cdbf80aa; successor/current
6a19b1ea-5dfd-4e2b-bc8a-ceeb5718334e. Canonical JSONL in
~/.local/share/term2-nodejs/conversations/. All times below UTC.

## R1: live rollover with two workers and shell control — PASS, bounded

Delivered marker LIVEVERIFY-R1-20260907 by pane send-text + Enter. Canonical
predecessor user_message seq2 proves delivery. Prompt prohibited edits/settings/
worktree removal/herdr and required immediate rollover while workers active.

- Worker A snug-clover-500 (r1_worker_a) launched seq4 at 06:10:17.891;
  foreground sleep90/150000ms started seq8 at 06:10:22.542.
- Worker B numinous-loft-625 (r1_worker_b) launched seq10 at 06:10:26.390;
  foreground sleep90/150000ms started seq19 at 06:10:33.252.
- Control shell 857fc0d0-3ee3-4c38-94e1-9724d266056e started seq14 at
  06:10:31.767, background sleep90/150000ms.
- Rollover requested seq20/21 at 06:10:39.075; successor seq2 records completed
  rollover 0e57e50d-ca5b-4660-907c-d13d7c3def30 at 06:10:39.112, 37ms settlement.
- Successor seq57 at 06:11:57.023: original A completed R1-WORKER-A-DONE, one
  shell call, no files changed.
- Successor seq128 at 06:12:01.770: original shell completed, exit0, 90006ms.
- Successor seq200 at 06:12:07.420: original B completed R1-WORKER-B-DONE, one
  shell call, no files changed.

Parent independently parsed canonical successor direct lifecycle records: one
completion per original handle. Child rendered final report with3notifications.
No replacements or cancellations. This verifies one live rollover under this
workload, not arbitrary shutdown/crash/config-change survival.

## R2 preparation notes (historical)

Needed child-only compaction settings; shared user settings MUST NOT be changed.
Settings schema agent.contextCompaction enabled/mode(auto/native/local),
compactThreshold ratio0..1, compactThresholdTokens nullable integer>=1000.
settings-env.ts does NOT offer compaction env overrides. Locate project/
isolated settings path mechanism before configuring; can restart the same
owned pane if required, after retaining R1 evidence.
Source agent-factory.ts around416 builds native threshold; agent-client.ts
around206/354 reads compaction settings for run loop. Want REAL worker-owned
provider compact request and subsequent worker/root anchor evidence. No fake
provider can close this live target. Use bounded context fixture/threshold
only inside test subject, retain request IDs/worker headers.

## R2: worker native compaction — chain isolation PASS; header discrepancy

Restarted the owned pane with child-only `XDG_STATE_HOME` pointing to
`.worktrees/live-verify-subject/.live-verify-state`; native compaction threshold
20000 tokens. Shared settings untouched. Session
019321c3-dab3-4dcb-a94e-159b0fd1a4c7. First attempt windy-radish-978 was
protocol-invalid: worker lacks run_code; parent prompt unnecessarily forbade
direct read_file. No reads or compaction from that attempt. A correction typed
during approval did not become a canonical user message. Initial wait also
matched prompt echo, not completion; neither counted as evidence.

Corrected R2B delivered canonical seq148 at 06:19:26.628Z. Worker
cobalt-tortoise-967 (r2b_context) launched seq151 at 06:19:33.819Z. Five real
read_file calls (seq155/175/176/177/178) read settings-schema, settings-service,
and agent.ts, including truncated-file continuation. Completed seq179 at
06:20:21.330Z with R2B-WORKER-DONE, three file facts, no edits. Root final
R2B-ROOT-RECEIVED seq191 at 06:20:24.271Z.

Wire evidence under isolated state logs/provider-traffic/2026-09-07/06-15-49_01932/:
- Trigger 06-19-47.752Z_4e89d.json, request
  4e89dbfe-3c4c-4777-9f79-f18451f8dfcd, compaction_trigger, HTTP200,
  27710 input tokens. Returned artifact
  cmp_02f8b935fd4b9513016a9e57861b1887d0adbaa2ef133e1cd3.
- Worker reuse 06-20-07.301Z_14b6f.json, request
  14b6f1a8-eef8-409e-aefc-fa969d4a4e50, exact same artifact, no
  previous_response_id, worker-qualified session-id ending
  :subagent:cobalt-tortoise-967. Subsequent worker requests chain normally.
- Root control 06-20-21.344Z_b82c3.json retains previous_response_id
  resp_07d2c1c71d6e6a7d016a9e57788ef887d08f59ec6a5c61e75e from its pre-compaction
  wait response; no worker compaction artifact in root input.

Confirmed discrepancy: the compaction trigger request session-id/thread-id and
x-codex-turn-metadata session_id/thread_id use the ROOT UUID, without worker
suffix. Ordinary worker requests before/after use the worker-qualified UUID.
This does not establish root history corruption: actual chain invalidation
and artifact reuse remained worker-owned in this run. Investigate header
identity separately; no production fix authorized by this test request.

## R3: deleted cwd — confirmed worker-bootstrap failures

Launched NEW interactive process from empty owned subdirectory
`.worktrees/live-verify-subject/.live-verify-deleted-cwd`, then parent removed
that empty directory with rmdir after TUI startup. Absolute built entry point
and target read file remained present. Canonical session
94c05956-1791-4f1c-99e2-ea94eb8e985d: prompt seq2 06:23:42.708Z; run_code
failed seq7 06:23:54.359Z with success:false and:

```text
Script sandbox failed: ENOENT: process.cwd failed with error no such file or directory, the current working directory was likely removed without changing the working directory, uv_cwd
[no tool calls]
```

Expected resilience: a request using absolute extant paths should not fail
solely because the process launch directory disappeared; at minimum the
recovery boundary should identify how to recover. Observed: sandbox bootstrap
failed before tools.describe, session_list, or absolute read_file could execute.
The model nevertheless rendered a settled failure report seq154 06:24:09.457Z.
Do not count this as exercising session_list or as total UI/process death.

Independent real BUILT session-index-worker probe (not a provider mock):
`node .worktrees/live-verify-subject/live-verify-index-probe.mjs` imported
dist/services/conversation/session-index/session-index-worker-client.js,
created a client with disposable absolute database/source paths, ran probe(),
closed it, then chdir into an owned empty directory, rmdir that directory,
and constructed/probed a new client. Baseline result {ok:true}, 577ms. Deleted
cwd result ENOENT/uv_cwd, 22ms; stack begins process.cwd at
node:internal/main/worker_thread:130:19 and MessagePort at line147. Entire
probe settled exit0 in664ms (the script catches/reports failure; exit0 is NOT
a pass verdict). This independently establishes the session-index worker
bootstrap defect; the full session-browser fallback path remains untested.

## R4: removal of root owned by live process — confirmed tool loss

Preserved every untracked test artifact outside the disposable worktree.
Launched NEW interactive process from live-verify-subject root, with settings
and logs under the outside evidence directory. Verified TUI startup and clean
worktree (moved one late R3 shutdown audit artifact too). Parent
`git worktree remove .worktrees/live-verify-subject` succeeded, exit0, 74ms,
while process remained live. This was external Git removal, not the
application worktree-removal tool: no claim about that tool admission gate.

Canonical session f5cae36d-3e39-478f-ab45-00991515af11: post-removal prompt
seq2 06:27:25.817Z; run_code failure seq20 06:27:31.142Z; final report seq91
06:27:36.459Z. Exactly the same uv_cwd startup error and [no tool calls] as
R3, despite absolute target file in the intact main checkout. Model received
prompt and rendered failure. This reproduces the same failure class under
whole-root removal, not a separately proven new defect.

## Evidence retention and interpretation

R2-R4 settings/traffic moved intact to
`.worktrees/live-verify-evidence/.live-verify-state/`. R2 relative traffic
filenames above now resolve there. R3 late shutdown audit is in
`.worktrees/live-verify-evidence/r3-late-shutdown-state/`. Independent probe
script and its disposable database fixture are retained beside those paths.
Canonical conversations remain in ~/.local/share/term2-nodejs/conversations/.
No raw credentials or opaque reasoning copied into this report.

Defect-class follow-up (not implemented): both observed worker bootstrap paths
depend on a valid ambient process cwd, even for operations with absolute
inputs. A future regression should use real Node worker bootstrap after cwd
delete, not mock Worker or merely mock process.cwd in the caller. A recovery
policy must distinguish the process cwd from the logical workspace root; do
not silently redirect relative writes to main/home. Origin and complete
sibling coverage have not been established by this bounded live study.
The class remains unfixed.

Final bounded poke: in R4 session a separate prompt-only request seq92 at
06:28:46.558Z completed seq103 at 06:28:48.929Z with exact
CONTAINMENT-SECOND-TURN-OK. Confirms a new model turn still works after the
bootstrap failure; does not establish tool recovery. Stopped the owned child
with Ctrl+C after settlement. Pane retained, no focus/layout changes.

No production source changes, fixes, or full-suite claims. Fresh build passed
in predecessor session; this report records live checks and a standalone
built-worker probe, not a green regression suite.
