# User-authorized $30 cumulative cap

The user instructed: **new budget: $30**. This supersedes the $15 cap and retains
all prior usage and conservative reservations. There is no new ledger, reserve
release, task change, model change, grader change or additional comparison arm.

Apply the change after the active first v3 Term2 run naturally settles. A clear
controllerPauseSentinel in the next, unstarted Pi run makes the old coordinator
stop at that boundary. Preserve the checkpoint as a controller record; it is not
an agent-start receipt. Never interrupt a pending inference to reconfigure it.

Preserve the old cap15 protocol and all producer bytes. The new protocol must
match the previous one except `capUsd` and hashes of run.mjs/budget-gateway.mjs.
Record both protocol hashes, the exact retained completed-result hashes and the
unchanged ledger hash at transition. The first v3 observation remains in the
cohort: an administrative limit increase after it finishes does not change its
prompt, work, grading or measured cost/time. Resume skips that existing result;
it must not be selectively rerun.

The gateway accepts a maximum $30 configuration (default remains $10); the
orchestrator requires explicit `BENCH_LIVE_APPROVED_CAP_USD=30`. Per-send worst-case
reservations, exclusive writer, native usage settlement, unknown-usage retention,
200-request per-run allowance and 20-minute task timeout remain. Stop before any
send exceeding $30; no further increase is authorized. All five OpenAI pairs
remain scheduled before Anthropic, with runner ordering unchanged.
