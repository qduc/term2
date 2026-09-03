---
title: Session retrieval seek/tail product decision brief
status: decision recommended; no product change
---

# Session retrieval seek/tail product decision brief

## Decision

Adopt the **tail anchor** candidate (`from: "end"`) for the narrow problem
measured by the seek/tail cell: a caller knows the target session and the fact
is in its final projected record. Do not merge either candidate as part of
this brief. The tail anchor is the smaller API, has the lowest observed call
cost, and does not make the caller calculate or guess a record position.

This recommendation is scoped to “read the final projected record.” It is not
equivalent to “find the last assistant message” when a transcript ends with a
different projected kind (for example, a tool or subagent record). That
semantic boundary must be settled by the rollout gate below.

## Evidence verification

The recorded runs use one seed and one prompt. The seed is shared by all
three labeled runs, so the call-count comparison is controlled for fixture and
prompt, but it is still a single model run per arm.

| Arm | Fixture / oracle | Retrieval calls | Defect metrics | Observed retrieval cost | Result artifact |
| --- | --- | --- | --- | --- | --- |
| Control, current build `cc1b29d6` | 60 projected records; prior projected text 52,483 chars (the driver’s checked filler-only subtotal is 52,200); final record is the unique 32-hex token; pass | 8 `session_read` + 1 `session_search` = 9 | First read `omitted: 57`; final read `omitted: 0`; 0 invalid or invented cursors; oracle pass | 62.940 s, 10 model requests, $0.010617 | `/home/qduc/.agents/runtime/bench-session-seek-20260902/control.result.json` |
| Numeric index, candidate `f016a26a` | Same seed and prompt; oracle pass | 4 `session_read` = 4 | Initial read still `omitted: 57`; `startIndex: 50` then `startIndex: 57`; no invalid cursor or schema error | 25.884 s, 5 model requests, $0.005671 | `/home/qduc/.agents/runtime/bench-session-seek-20260902/repair-index.result.json` |
| Tail anchor, candidate `687d60f5` | Same seed and prompt; oracle pass | 1 `session_read` = 1 | Initial read used `from: "end"`; `omitted: 0`; no invalid cursor or schema error | 1.487 s, 2 model requests, $0.003091 | `/home/qduc/.agents/runtime/bench-session-seek-20260902/repair-tail.result.json` |

The fixture checks were independently re-read from
`/home/qduc/.local/share/term2-nodejs/conversations/092f67da-8a44-45fc-8a8a-3c795bf66f7f.jsonl`:

- 30 user/assistant pairs produce 60 projected records, with the final
  projected record an assistant record at projected position 59.
- The final assistant text is exactly `0020c2a389c4655acf773d5376fd3120`;
  that token occurs once in the seed file. Earlier projected text totals
  52,483 characters, exceeding the 12,000-character default budget.
- All three cell session files pass the analyzer’s identity checks: the
  conversation filename matches `session_init.id`, a first user message is
  present, and the provider index preview matches that message. The verified
  cell IDs are `2395caf8-4c42-40d7-8b7a-f04fef587f44` (control),
  `72d3bc8c-57b2-4aa8-82eb-881ed850236d` (numeric index), and
  `dd3d7933-b408-47e9-911e-c2db5b92ca02` (tail).

The analyzer replay used
`node scripts/experiments/session-retrieval-log-analysis.mjs` with those
three IDs and reproduced the recorded call sequences, output summaries,
retrieval elapsed times, requests, and costs. The raw result and conversation
files are local user-state evidence, not committed fixtures. The seek-cell
document’s front-matter status still says the repair comparison was not run;
its dated result section and the result files supersede that stale status.

## Candidate comparison

### Call cost

Tail wins on the measured task: one read versus four for numeric index and
eight reads plus one search for control. It also had the lowest observed
retrieval-turn elapsed time, requests, and provider-reported cost. These are
single-cell model measurements, not a claim that local transcript access has
that fixed latency or price in every run. Numeric index is still an
improvement over the control, but its model chose a discovery read and two
index guesses before reaching the token.

### Compatibility risk

Both candidates are additive optional parameters to `session_read`; existing
calls that omit the new parameter retain the forward-start behavior. Both
candidate builds reject combining an initial-position option with a cursor.
The tail candidate uses the narrow literal `from: "end"`, so its invalid-input
surface is small.

Numeric index has more failure modes: non-integer, negative, out-of-range, and
off-by-one values. More importantly, `startIndex` addresses a **projected
record position**, while the returned item’s `index` is the source message
index. Those indexes happen to align in this fixture, but can diverge when
unprojected messages are skipped. That distinction would need unusually clear
tool prose and tests to avoid model and caller confusion. A stale or changing
transcript can also make a previously calculated total/index pair unusable;
the candidate correctly treats an out-of-range index as an error rather than
silently clamping it.

Tail’s principal risk is semantic, not wire compatibility: “end” means the
last record in the projection, not a reverse scan for the last record of a
particular kind. If the target is a last assistant message followed by a tool,
system, or subagent record, one tail read may return the wrong kind. A very
large final record can also require cursor continuation because output remains
bounded. These cases are acceptable only if the API contract says “last
projected record” or the rollout gate adds a supported way to select the last
assistant record.

### API surface and product fit

Tail adds one discoverable operation to an existing tool and maps directly to
the user intent exercised by the cell. Numeric index exposes a general random
access primitive, which could help other workflows, but that breadth is not
needed to justify this decision and increases contract, documentation, and
test burden. Keep numeric seeking as a separately justified proposal if later
usage demonstrates a need for arbitrary interior-record access.

## Risks and non-conclusions

- The evidence is one deterministic fixture and three single model runs; it
  establishes a strong cost ordering for this cell, not universal success or
  cost distributions.
- The fixture deliberately makes the final projected record an assistant
  token. It does not establish behavior for trailing non-assistant records,
  empty projections, a huge final record, skipped records, or concurrent
  transcript mutation.
- The control’s `session_search` found one match after two reads, but the
  successful oracle path still required eight reads. Search is not treated as
  a comparable tail repair because it requires searchable content and does not
  guarantee the final record’s identity.
- Neither `f016a26a` nor `687d60f5` is an ancestor of the current branch.
  Their results are candidate-build evidence only; no product API or default
  has changed.

## Next gate before merge or rollout

Run a separately labeled tail candidate build through the existing unit/tool
schema tests and a repeated controlled cell. The gate should require:

1. **Semantic correctness:** on fixtures where the requested fact is the last
   projected record, the oracle passes and the returned item has the expected
   record index/kind/text. Add at least one fixture with a large final record
   to verify bounded chunking and cursor continuation.
2. **Boundary decision:** explicitly test a transcript whose final projected
   record is not an assistant record. Either document and accept the
   last-projected-record contract, or do not ship this as a “last assistant”
   solution until that selection problem has its own design.
3. **Efficiency:** across at least three fresh seeds with the same prompt,
   the known-tail task completes with one initial `session_read`, no
   `session_search`/`session_list`, no invented or invalid cursor, and no
   schema-boundary error. A continuation test may use the returned cursor when
   the final record is chunked.
4. **Compatibility:** existing forward reads and cursor continuations remain
   green; `from: "end"` is accepted only on an initial read and is rejected
   with a cursor; default limits and output budgets remain bounded.

If the repeated gate fails the one-read criterion or exposes frequent
last-assistant-versus-last-projected mismatches, do not merge the tail
candidate. Revisit the API semantics rather than promoting numeric index as a
fallback without a separate interior-seek use case.
