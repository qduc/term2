**Verdict: ACCEPT.** I found nothing at the must-fix bar. The two properties exercise real ledger and projector entry points, the oracles catch faults, and production code is untouched.

**Tested revision:** HEAD `28a207274c2c237ab74b0692825e13ed0fc0fe4c`, tree `80b201ca…`, base `6a25ecc7`, Node v24.19.0. The checker reports `dirty: true`, but that's only the untracked `checks/ledger/` evidence folder; `git diff HEAD` is empty. Production file hashes match the "original" hashes in `mutation-checks.json`:
- `tool-execution-ledger.ts` `426f07f4…`
- `conversation-state-projector.ts` `01fa7aed…`
- `ledger.mjs` `7e0cea83…`

## What I ran
| Command | Exit | Result |
|---|---|---|
| `pnpm -s verify:generated --target history --seed 777001` | 0 | settlement, reconciliation and pair-projection: 1,000 cases each, all green |
| `pnpm -s verify:generated --seed 31337 --runs 5000` | 0 | all 5 properties green; ledger properties took 0.54s and 1.85s |
| Settlement mutation replay (`--seed=424242 --path '45:4:3:3:4:4:6:6:6:7:8:8:8:8'`) on restored source | 0 | 1,146 cases |
| Replacement-boundary mutation replay (`--path '0:1:0:1:1:1'`) on restored source | 0 | 57 cases |
| `--runs 0`, and `--path` without `--seed` | 2, 2 | invalid input is rejected properly |
| prettier on the 4 changed files | 0 | formatted |
| eslint | 0 | `scripts/` is in its ignore list, so this checked nothing |

The retained mutation diffs are the right size: `if (entry.dispatchedAt)` → `if (false)`, and the boundary check → `if (false)`. Each recorded a red run, a red replay, and a green restored replay (exits 1, 1, 0).

## My own challenges
I ran bounded Node probes that swapped `ToolExecutionLedger` methods in memory, with no file changes, at seed 4242 and 1,000 runs. **All 11 mutants went red**, mostly within 2–19 cases:
- **Settlement scope:** ignoring the call ID on interruption or rejection → "settled incorrectly".
- **Dispatch evidence:** losing dispatch marks → "dispatch evidence changed".
- **Import:** turn counter set from the entry count → "reused a logical turn identity"; dropping entries on import → "import changed saved entries".
- **Completed outcomes:** a completed output being blanked → "observed output changed".
- **User anchor under retry drift:** ignoring the user-turn stamp → "pair precedes its user turn". The retry-drift check does real work.
- **Pair preservation:** a missing synthetic result → "settled call lost"; duplicated pair items → "lost or duplicated"; a reversed pair → "result precedes call"; altered arguments → "call payload changed".

After restoring the methods, both properties went back to green.

On oracle independence: the settlement oracle is a separate per-call state model. In reconciliation, the expected output for aborted/unknown results is read back from the ledger itself, so it only proves the payload is preserved, not that it's correct. Settlement covers correctness separately, so that's fine. There's no network, model or provider dependency at runtime; the only imports are fast-check and `source/`.

## Limits and nits (none blocking)
1. **Thin `unknown` coverage.** Only about 22 of 1,000 settlement cases actually reach dispatched→`unknown`, and about 22% of interrupts hit nothing. The retained mutant and my `dispatchLost` mutant still went red quickly. If anyone cares, weighting the actions toward call, dispatch and interrupt would help.
2. **The main reconciliation checks run on only ~25% of cases.** The boundary setting picks one of four values evenly, so ~75% of cases take the boundary early-return. That path only asserts that nothing changed, which matches production but means post-boundary ledger entries are untested. Interleaved boundaries are excluded too.
3. **No user message after the latest ledger entry is ever generated**, so the "crossed into a later user turn" check never sees the "latest turn goes at the end" rule against a newer user message. This matches the plan's exclusion of exact insertion indexes. The real import and replay call sites (`conversation-record.ts:330`, `conversation-replay.ts:1429`) appear to avoid that shape, but I didn't verify it end-to-end.
4. **The import turn check asserts exactly `max+1`.** That's stricter than the "no collision" contract, so a harmless change to the rewind policy would turn it red. The assertion message ("reused a logical turn identity") is also loose, since rewinding past tool-less turns legitimately reuses those IDs.
5. **Rejection is only generated as a scoped rejection of never-dispatched calls.** The docs scope it the same way, and the mutant still caught ignored scope.

I didn't run full tiers (typecheck, build, full lint); the parent owns those. The claimed four-seed ×10k evidence is only retained in `seeds.json`, and I didn't re-run it. My own fresh seeds at 1k and 5k plus the replays cover the same ground. No probes or artifacts were written to the repo. Clean slice.