# Approved resumption

The user approved raising the cumulative cap to **$15** and restarting the paired
study with the corrected launcher. Preserve all prior reserves, including the
five failed initial requests. Starting exposure is **$9.606903305**; this is not
confirmed billing. The failed launch remains part of campaign overhead and is
not a completed model task or paired observation.

This resumption uses `.handoff/campaign-v2` and `medium-live-v2-*` run IDs to keep
the failed first attempt distinct. It binds the same physical shared ledger.
Only the approved cap and run IDs change in the protocol; tasks, rubric, native
models, effort, ordering, concurrency, immutable coding-agent runtimes and
sandbox-off/always-approve settings stay fixed. A new protocol hash records the
producer changes. The original blocked attempt is preserved in Git revision
3f461d0dc and its evidence archive.

The gateway constructor accepts up to $15 (default stays $10); the orchestrator
requires `BENCH_LIVE_APPROVED_CAP_USD=15`. Every physical send still reserves its
worst-case cost before upstream contact. Native usage replaces reservations when
available. Unknown usage retains its reservation and stops at the end of that
logical agent turn; client retries within the turn can make multiple attempts.
The existing per-run 60-request ceiling and 20-minute timeout also remain. They
can truncate a medium task and must be reported as limits and failures, not
silently repaired or removed. No fresh ledger or reserve release is allowed.

Use `launch.mjs --live`, never direct execution of the frozen old producer. The
launcher enables Node proxy handling at startup and checks free authenticated
GET models endpoints before executing the campaign. Those checks establish
routing, not model acceptance or billing certainty. Stop on any new unresolved
usage or insufficient headroom. Do not exceed $15 without another instruction.
