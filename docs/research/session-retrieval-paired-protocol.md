---
title: Session retrieval controlled paired-run protocol
status: completed 2026-08-31
---

# Session retrieval controlled paired-run protocol

## Fixed variables and attribution

All six continuation cells ran serially through real interactive `term2` panes
in Herdr with `codex/gpt-5.6-luna`, medium effort, standard mode, and YOLO tool
approval. A rollover cell was always run before its ordinary-resume cell so the
source transcript was still at the same boundary. The ordinary cell used
`term2 -p codex -m gpt-5.6-luna -r medium --resume <source-id>`; the rollover
cell started a fresh interactive root and received a bounded brief plus the
source session ID.

`scripts/experiments/session-retrieval-paired-runs.json` is the exact-ID
manifest. Rebuild the local evidence packet with:

```bash
node scripts/experiments/session-retrieval-paired-analysis.mjs \
  > /tmp/session-retrieval-paired-results.json
```

The analyzer finds the continuation boundary by the exact prompt recorded in
the manifest, so an ordinary-resume cell excludes the source turn's requests,
tokens, time, and cost. It verifies each result ID by conversation filename,
`session_init.id`, first persisted user message, and provider-index
`firstUserMessagePreview`. Raw JSONL and provider traffic remain local user
state and are not committed.

## Pair 1 — diagnosis-rich coding

The model-benchmark preparer archived `r-retry-abort-backoff` at
`12709ca6~1` into byte-identical `ordinary-resume` and `rollover` source trees
under:

```text
/home/qduc/.agents/runtime/bench-r-retry-abort-backoff-20260831-092559
```

Source session `9cc61896-a75e-4af9-b1bb-c4f6c432a75c` received the benchmark
bug report plus this phase boundary:

```text
Phase 1 only for a controlled continuation study. Diagnose the task below, but
do not modify any files, run formatters, or implement the fix. Inspect the
relevant production code and existing tests. Identify the root cause, the
smallest correct implementation seam, and the regression tests that would prove
the behavior. Confirm the workspace is still unchanged, then stop.
```

The fresh rollover received the source ID, the implementation instruction, and
a 1,147-character handoff containing the diagnosed seam: abort-aware backoff in
`RetryingModel`, an abort-shaped rejection, no second provider attempt, and a
focused pending-sleep regression test. The ordinary resume received:

```text
Continue the interrupted task from the diagnosis already in this session.
Implement the smallest correct fix, add focused regression tests, run the
focused validation, and report the changed files and results. Do not
re-diagnose from scratch unless the source facts conflict with the code. Do not
commit.
```

The hidden evaluator was `r-retry-abort-backoff`'s nine-test evaluator plus its
typecheck gate. The two source trees were identical before continuation. They
use different project paths to preserve independent mutable coding outputs;
therefore the rollover cell's project-scoped `SessionBrowser` could not read
the source transcript. This is an intentional limitation of this pair: it
measures whether a diagnosis-rich handoff makes retrieval unnecessary, not
whether fallback transcript reads work.

## Pair 2 — interrupted research

Both cells and the source used `/tmp/session-retrieval-paired-research`, and
both continuation cells were read-only. Durable JSON artifacts contained five
10/10 retrieval scores per arm, candidate/incumbent broad-synthesis invocation
counts of 4/5 and 0/5, mean wall times of 6.4 s and 7.0 s, mean wire-token
counts of 31,966 and 31,315, and the same failed coding-oracle assertion. The
source prompt kept two decisive facts transcript-only:

```text
Promote the candidate routing affordance only if (1) retrieval-oracle quality
does not regress, (2) desired broad synthesis appears in at least 3 of 5
candidate runs, and (3) the paired coding oracle is no worse. The prompt rewrite
remains rejected because this experiment isolates routing, not prompt prose.
```

The rollover brief named source session
`b9ba496e-e3ba-4c43-b026-dbb50196e55f`, pointed to the durable artifacts, and
said the acceptance rule and scope distinction remained in the transcript. The
ordinary-resume prompt supplied the same final-report checklist without those
two facts. The deterministic oracle required the correct promoted/rejected
items, both arms' metrics, and an explicit evaluation of all three conditions.

## Pair 3 — sparse operational continuation

Both cells and source used `/tmp/session-retrieval-paired-ops`, and both
continuations were read-only. The source inspected a two-file canary-state
fixture and was told that a later bare `continue` must produce exactly five
fields. The rollover's complete first message was:

```text
continue

Previous session ID: `8b8d3860-7d3c-4104-8d11-ab206bbb2426`.

This is a sparse operational continuation. Recover only the minimum prior state
needed to carry out the pending response. Do not modify files or perform
external actions.
```

The ordinary-resume prompt was only `continue`. The deterministic oracle
required the exact service (`provider-black-box-canary`), green run
(`33297703254`), candidate commit (`350036e0`), next-action wording, and
confirmation code (`PTY-IDLE-CEILING-CLOSED`).
