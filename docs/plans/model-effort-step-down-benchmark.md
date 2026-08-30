# Model/effort step-down for tool-continuation turns — benchmark validation

Status: **paused mid-validation.** Production-log hypothesis is confirmed by real
task runs + blind quality judge on 4 tasks. One real quality exception found
(security-sensitive fix). Not yet implemented in product code.

## Resume here

No worktree yet — nothing has been implemented. All work so far is
benchmark artifacts under `/home/qduc/.agents/runtime/` (outside the repo,
not committed, will not survive a `.agents/runtime` cleanup — copy anything
you need to keep).

Read the whole doc before doing anything else; the "what NOT to redo" section
below exists because two mistakes already cost real spend once each.

## The proposal being validated

Production provider-traffic logs (7 days, ~8,200 requests, analyzed
2026-08-30) showed 90%+ of `gpt-5.6-sol`/`gpt-5.6-terra` requests are pure
tool-continuation steps (input = only `function_call_output`, no new user
turn) — the expensive model is mostly chaining tool calls, not doing the
"first hard turn" of reasoning. Cost is concentrated there: sol+terra were
7.5%+6.7% of requests but 60%+24% of cost on the Codex-tier models.

Proposal: keep the expensive model/high effort for the first model response
in a turn; demote to a cheap model (`luna`) for tool-continuation steps that
follow.

**User's explicit bar for approval** (this is a standing rule now, saved to
assistant memory as `efficiency-proposals-need-real-run-comparison`): no
efficiency proposal ships on log-inference alone. It must be proven with real
model runs on real tasks, comparing baseline vs proposed, before approval.
Log analysis only produces the hypothesis.

## What's been validated (real benchmark runs, not log inference)

Used the `model-benchmark` skill. Candidates held effort/model constant per
run, harness = `term2` non-interactive (`--auto-approve`), so this tests the
real product. `sol`/`terra` are real production tiers; `luna#high` and
`luna#low` approximate the proposed demotion (full-task, not literally
mid-turn — a fair, slightly conservative proxy: if full-task-on-luna matches
quality, mid-turn-only demotion is safe a fortiori).

Deterministic evaluator (typecheck + hidden test) + Opus blind quality judge
(3 samples/task, `pooled-judge.sh` when sol lives in a separate run dir from
terra/luna — see "Directory layout" below):

| Task | sol | terra (baseline) | luna#high | luna#low |
|---|---|---|---|---|
| `c11-d8-approval-grant-kind` | PASS · 10.0 | PASS · 10.0 | PASS · 10.0 | PASS · 10.0 |
| `f-security-002-symlink-traversal` | PASS · 7.33 | PASS · **9.0** | PASS · 8.33 | PASS · **5.67** |
| `f-correctness-002-null-session-context` | not run | PASS · 9.0 | PASS · 8.17 | PASS · 8.67 |
| `r-retry-abort-backoff` (hard — real async-cancellation bug) | FAIL · 6.0 | FAIL · 8.0 | FAIL · 6.33 | FAIL · 7.67 |

Cost per run (this is where the case is strongest): 7×–140× cheaper for
`luna#low` vs `terra`, e.g. task 1: sol $0.50, terra $1.03, luna-high $0.14,
luna-low $0.02.

**Conclusions actually supported by this evidence:**

1. On 3 of 4 tasks, `luna-low` is at/near quality parity with `terra`
   (10.0=10.0, 8.67 vs 9.0, 7.67 vs 8.0) at a fraction of the cost. The
   headline hypothesis holds there.
2. **Real exception: the security task.** `luna-low` scored 5.67 vs `terra`'s
   9.0 despite both passing the same hidden test — a judge-only finding, the
   deterministic evaluator alone would have called this a tie. **Do not ship
   the blanket version.** Any implementation needs a floor above `luna-low`
   for security-sensitive paths — untested whether medium effort or luna#high
   is enough; only low-effort-on-cheap-model was shown to fail here.
3. `sol` (the priciest model) was never the best performer across all 4
   tasks — tied-best once, mid-pack once, worst once (the hard task). Paying
   for it did not reliably buy quality in this sample.
4. `sol` and `luna#high` (both "high effort") were the two worst scores on
   the hard task, and both independently derailed into a runaway
   verification/exploration loop that ate the full 600s benchmark timeout —
   this is an **effort-level** pathology, not a model-tier one, and echoes
   the earlier production finding (`term2-scan`'s production-log pass) about
   run-budget escalations on long tool chains. Separate problem, same root
   symptom class (long, high-effort tool loops after the fix is already
   correct).

## What NOT to redo (two real mistakes, each cost real spend once)

- **Don't run 3+ heavy `term2` benchmark candidates as parallel background
  Bash tasks on this box.** All three `sol` candidates launched via
  `run_in_background: true` simultaneously were killed silently mid-run
  (no error, no exit code — signature of an external kill). Root-caused to
  host memory pressure (this shared dev box was already at 100% swap / 1.5GB
  free RAM before launch — `free -h` to check), not a term2 bug and not a
  Bash-tool concurrency cap (proven with a zero-cost repro: 3 trivial
  parallel `sleep` background tasks survived fine). Run heavy candidates
  **sequentially** — foreground is fine, it just blocks the turn.

- **The candidate spec provider id is `codex`, not `openai-codex`.** The
  skill's own doc example (`codex:openai-codex/gpt-5.6-terra#high=...`) is
  wrong for this repo — `term2 --provider openai-codex` errors with "Unknown
  provider". Confirmed valid providers: `openai, openrouter, codex, grok,
  opencode, Neuralwatt, DeepSeek`. Two `prepare-benchmark.sh` runs were
  wasted (workspaces regenerated, no API cost lost, just time) before this
  was caught — check `run-candidates.sh --benchmark-dir <dir>` (dry run, no
  `--go`) prints the intended command before spending anything.

## Known tooling issue: `run-judge.sh` dimension-score parser

On task 3 (`f-correctness-002-null-session-context`, plain `run-judge.sh`,
not pooled), the judge produced valid, well-reasoned JSON verdicts in all 3
samples but `run-judge.sh`'s aggregator rejected all of them as "invalid
dimension score" — likely a rubric-key mismatch (this judge used
`correctness/scope/compatibility/tests`, the parser apparently expects a
fixed set). The API calls succeeded (real spend, real usage against the
session limit) — only the aggregation failed. Scores were reconciled by hand
from the raw `control/judge-{1,2,3}.txt` files + `control/mapping.json`
(mapping is a single fixed shuffle for the whole run under plain
`run-judge.sh`, unlike `pooled-judge.sh` which reshuffles per sample — worth
knowing before reading a mapping.json literally per-sample).

`pooled-judge.sh` did not hit this on tasks 1, 2, or 4 — consider always
using `pooled-judge.sh` (even for a single source dir) instead of
`run-judge.sh` directly, or fix the parser, before relying on the automated
aggregation again.

## Directory layout (all under `/home/qduc/.agents/runtime/`)

Each task was benchmarked in two passes — cheap tiers first (Stage 2:
`terra`/`luna#high`/`luna#low`), `sol` added later in a **separate** prepared
dir (Stage 3) after the cheap pilot showed promise. `pooled-judge.sh` joins
them for judging; `collect-cost.py` was run separately per dir.

| Task | Stage 2 dir (terra+luna) | Stage 3 dir (sol only) | Pooled judge dir |
|---|---|---|---|
| c11-d8-approval-grant-kind | `bench-c11-d8-approval-grant-kind-20260830-075644` | `bench-c11-d8-approval-grant-kind-20260830-081447` | `pooled-c11-d8` |
| f-security-002-symlink-traversal | `bench-f-security-002-symlink-traversal-20260830-075645` | `bench-f-security-002-symlink-traversal-20260830-081448` | `pooled-security` |
| f-correctness-002-null-session-context | `bench-f-correctness-002-null-session-context-20260830-081434` | (sol not run) | n/a — used plain `run-judge.sh` |
| r-retry-abort-backoff | `bench-r-retry-abort-backoff-20260830-081436` | `bench-r-retry-abort-backoff-20260830-083600` | `pooled-retry-abort` |

Dead/erroneous dirs from the `openai-codex` provider-id mistake (safe to
delete, no useful data): `bench-c11-d8-approval-grant-kind-20260830-075532`,
`bench-f-security-002-symlink-traversal-20260830-075538`.

**Stage 3 dirs needed manual `meta.json` correction** before pooling would
accept them: `prepare-benchmark.sh` declares all 4 candidates in
`meta.json`, but only `baseline-sol` was actually run there (the others are
0-byte diffs). `pooled-judge.sh`'s collect step cross-checks `meta.json`'s
`candidates` list against found `.diff` files and errors on a mismatch —
edit `meta.json`'s `candidates` array down to `["baseline-sol"]` and delete
the empty duplicate-named `.diff` files before pooling. Also run
`run-evaluator.sh` on the Stage 3 dir if you haven't (pooling needs
`evaluator.status` for every declared candidate).

## Cost/usage spent so far

- Benchmark agent runs (term2 CLI, real provider spend): ~$13 total across
  16 candidate runs (some duplicated by the provider-id mistake and one
  ad-hoc foreground retest).
- Opus judge (comes out of the *Claude* subscription limit, not provider
  API spend — this is why the user asked to watch it): session usage went
  23% → 53% (+30 points) across 4 judged tasks, ~7-8 points per task judged.
  Weekly usage barely moved (24% → 26%). Check current usage with
  `claude -p "/usage"` before resuming further judge runs.

## Next steps to actually ship this

1. Decide the security-path floor: is `luna#high` (medium-cost, effort
   stays high) enough to close the 5.67→9.0 gap, or does it need to stay on
   `terra`/`sol` entirely for security-tagged work? Not tested — would need
   one more benchmark round on the security task with that specific
   candidate.
2. Design how "security-sensitive path" is detected at runtime to gate the
   floor (tool/file path heuristic? task classification? explicit tag?) —
   no design work done yet.
3. Design and implement the actual mid-turn step-down mechanism in
   `source/services/agent-runtime/` (turn-boundary detection: "is this
   request's input pure `function_call_output`, i.e. a continuation of the
   same turn?" — the exact signal used in the log analysis to identify
   continuation steps). Nothing implemented yet; everything above is
   validation only.
4. Optional: expand the benchmark sample (more tasks, more judge samples) if
   the current 4-task/3-sample evidence isn't considered sufbe for a
   product change of this size — current spend (~$13 + 30 points of weekly
   Claude session usage) suggests another full round is affordable if
   wanted.
5. Fix or route around the `run-judge.sh` parser issue before relying on
   unattended judge aggregation again.

## Related, separate findings surfaced along the way (not part of this proposal, worth a future look)

- Two independent model perspectives (agy/Antigravity, grok) converged
  unprompted on the same missing capability: real LSP-based code
  intelligence instead of the current ripgrep-only `code_context_search`
  (confirmed: `source/tools/file/code-context.ts` is ripgrep-only, no LSP).
- The runaway high-effort verification/exploration loop pattern (seen twice
  in this benchmark, on `sol` and `luna#high`) is worth a `guard-design`
  pass independent of this proposal — it wastes wall-clock time and can
  leave *worse* (non-compiling) state than doing nothing, regardless of
  which model tier is running.
- Herdr research panes from the earlier brainstorming round
  (`term2-diff`, `term2-backlog`, `term2-scan`, `agy-ideas`, `grok-ideas`)
  may still be open — check `herdr agent list` if picking this up in the
  same Herdr workspace; they're not required to resume this doc.
