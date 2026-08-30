# P1 saved-session audit viability/value experiment

## Question and decision

Can the existing saved-session audit classify a small, current sample of real
saved conversations without disclosing their contents, and does the result
produce a useful distinction between work waiting on a person and work that was
interrupted?

**P1 result: technically viable, but not sufficient evidence to land a
user-facing audit surface yet.** All 20 sampled files produced a verdict from
cleanly decoded evidence in a bounded time. The sample did contain interrupted
work, but contained no `awaiting_approval` verdicts, so it cannot demonstrate
the live prevalence or user value of that distinction.

## Privacy boundary

The experiment was read-only. The runner enumerates, stats, and reads the
saved-log directory; it makes no network/provider calls and does not invoke the
persistence facade that can perform legacy migration. It parses JSONL in memory
because that is required to audit it, but never renders or writes raw events.

Its only stdout is the aggregate JSON shown below. It does **not** print or put
in this report prompts, assistant text, commands, credentials, tool arguments,
error text, filenames, session IDs, paths derived from a session, or timestamps
from an individual session. All count fields are aggregate across the sample.

## Method and reproducibility

The experiment runner has a fixed target directory and selects the 20 primary
`*.jsonl` files with the newest modification times at execution. It merges a
present delta sidecar using the same sequence-order rule as persistence, but is
otherwise deliberately independent of persistence initialization to preserve
the read-only guarantee.

Run from this worktree:

```sh
pnpm exec tsx scripts/experiments/session-audit-p1.ts
```

The following is the complete aggregate output from the executed sample. The
directory is live, so a later invocation can choose different files or observe
new events.

```json
{
  "sampledFiles": 20,
  "classified": 20,
  "unclassifiable": 0,
  "failures": {
    "directoryRead": 0,
    "candidateStat": 0,
    "primaryRead": 0,
    "sidecarRead": 0,
    "sidecarsFound": 3
  },
  "decodeQuality": { "filesWithSkippedLines": 0, "skippedLines": 0, "totalEnvelopes": 11136 },
  "outcomes": {
    "empty": 0,
    "settled": 17,
    "awaiting_approval": 0,
    "interrupted_mid_tool": 2,
    "interrupted_mid_turn": 1
  },
  "aggregates": {
    "userTurns": 80,
    "assistantTurns": 82,
    "toolCalls": {
      "started": 1236,
      "completed": 31,
      "failed": 0,
      "aborted": 0,
      "unknown": 0,
      "unfinished": 21
    },
    "unfinishedSubagents": 1,
    "unfinishedBackgroundShells": 1,
    "errorEvents": 4,
    "truncatedEvents": 0
  },
  "elapsedMs": 204.376
}
```

`elapsedMs` measures selection, file reads, decoding, sidecar merging, and
auditing within the runner. It excludes package-manager/TypeScript-launch
startup. The command completed successfully; its harness wall time was 3.234
seconds including `prettier` run in the same shell command and `pnpm` startup.

### Outcome evidence

The live sample reports the two operational categories separately:

- Awaiting human approval: **0**.
- Interrupted work: **3** (`interrupted_mid_tool`: 2;
  `interrupted_mid_turn`: 1).

So the audit output does distinguish an unanswered approval from interruption;
the observed aggregate makes the distinction visible rather than collapsing it
into a generic stale-session count. However, the zero approval count means P1
does not validate that category against a naturally occurring recent example.
The existing focused test suite does cover the semantic priority of an unanswered
approval over a dangling tool call.

## Landing criteria

A user-facing audit surface should be considered only if all of the following
are true:

| Criterion | P1 evidence | Status |
| --- | --- | --- |
| A bounded recent sample is fully classifiable. | 20/20 classified; 0 unclassifiable. | Pass |
| Evidence is readable and decodable without silent loss. | 0 directory/stat/primary/sidecar read failures; 0 skipped lines; 0 truncation markers. | Pass for this sample |
| The result keeps `awaiting_approval` separate from interrupted outcomes. | Separate counts were emitted (0 versus 3); focused behavior tests pass. | Mechanism passes; live positive approval evidence absent |
| A representative sample demonstrates a reason to expose the distinction. | Interrupted work appeared, but approval did not. No user-action/ground-truth evidence was collected. | **Not yet proven** |
| The surface can be redacted by construction. | This runner is aggregate-only, but the existing per-session formatter includes identifiers and other details. | **Not yet proven for product UI** |
| Regression/type validation is green. | 15 focused tests and project typecheck passed. | Pass |

Therefore P1 is a success as a read-only classification viability experiment and
a failure as a complete value/landing experiment. Do not treat this result as
approval to implement a user-facing CLI or UI.

## Verification

Commands run and results:

```sh
pnpm exec prettier --write scripts/experiments/session-audit-p1.ts
# pass

pnpm exec tsx scripts/experiments/session-audit-p1.ts
# pass; aggregate output recorded above

NODE_ENV=test pnpm test source/services/conversation/session-audit.test.ts source/services/conversation/session-audit.persistence.test.ts
# pass: 2 test files, 15 tests

pnpm typecheck
# pass: tsc --noEmit
```

The root TypeScript configuration includes `source/**/*`, so `pnpm typecheck`
validates the existing audit production code but does not include the
experiment-only `scripts/` runner. The runner was executed successfully through
`tsx`; no production behavior was changed.

### Experiment bookkeeping

The experiment artifacts are tracked, not uncommitted or untracked:
`EXPERIMENT-P1.md` and `scripts/experiments/session-audit-p1.ts` were added in
commit `eff6f2bc` (`test(conversation): add session audit experiment runner,
findings, and edge case tests`). The production audit service is separately
tracked in `b9e061e2` (`feat(conversation): report how a saved session ended,
without resuming it`).

## Unresolved risks and next evidence needed

1. The live sample has no approval-stalled session. Establish the category's
   value with a consented/controlled real saved log or a broader privacy-reviewed
   aggregate sample; do not reveal session contents to do so.
2. There is no independent ground truth for the three interrupted verdicts.
   A writer lifecycle marker, or a controlled recovery comparison, is needed
   before claiming diagnostic accuracy beyond the existing unit tests.
3. The directory is live. A writer can append between stat, read, and sidecar
   read, so this is a point-in-time best-effort sample rather than an atomic
   snapshot.
4. The high aggregate gap between observed `tool_started` (1,236) and direct
   `tool_result` completions (31) needs product-semantics review before a UI
   presents these counters as an execution-success metric. An assistant turn
   can settle the audit's in-flight bookkeeping without producing a direct
   tool-result count.
5. `formatSessionAudit` is unsuitable as a privacy-safe UI payload: it can
   render session identifiers, tool details, command text, and error text. A
   future surface needs an explicitly redacted view model, not that formatter.
6. This sample is one local data directory and one recency window. It says
   nothing about older formats, permission failures, corrupted logs, or a
   broader user population.
