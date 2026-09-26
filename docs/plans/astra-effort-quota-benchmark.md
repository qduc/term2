# Does `gpt-6-astra` at high effort use less quota than at low effort?

Status: **2 pairs done, 2026-09-21. Task-dependent: `high` cost ~1.3× more on a contained bug, ~0.8× (cheaper) on a cross-cutting tracing task where `low` took 30% more steps. On that task `low` also wrote the better fix (judge 9.67 vs 7.67), so high was cheaper but not better.**
The multi-phase design below is the full version, kept for if the pair is
inconclusive. What actually ran is under "Two-run execution".

## Two-run execution (what actually ran)

- **Task:** `r-ws-session-lifetime` (rewound, two-part real bug). Past runs
  split pass/fail, so it discriminates. Hidden evaluator proven red on the
  untouched baseline (2/8 fail). `f-security-002-symlink-traversal` was
  rejected: its evaluator is **already green at HEAD** (the fix has landed), so
  it would have measured nothing. Any `base_commit`-less task needs the same
  red check before reuse.
- **Order:** `high` first, `low` second, so any shared-prefix cache warmth
  favors `low`. A `high` win can't be put down to caching.
- **Timeout:** 1800s for both. Truncation undercounts consumption.
- **Quota meter:** `read-codex-quota.py` (App Server, read-only) snapshots
  before/after each run. Findings: plan `prolite` exposes **only a weekly
  window** (10080 min), and `usedPercent` is a **whole number**, in App Server
  and in the streamed `codex.rate_limits` alike. One run likely moves it ≤1
  step, so the meter is a sanity check. **Token logs are the primary evidence.**
  term2's Codex OAuth and `~/.codex/auth.json` were confirmed to be the same
  ChatGPT account.
- **Prior evidence against the mechanism (free, from 2026-08-30 luna runs):**
  in term2, luna low took far *fewer* steps than luna high on all 4 tasks
  (20 vs 73, 11 vs 65, 10 vs 59, 29 vs 144 model calls). The "low flails and
  takes more steps" story ran backwards there.
- Artifacts: `~/.agents/runtime/bench-r-ws-session-lifetime-20260921-202328/`
  (outside the repo, not durable).

### Result

Traffic logs confirm 30 requests at `gpt-6-astra`/`high` and 29 at
`gpt-6-astra`/`low`, one session each, no other traffic in the window.

| | high | low | high / low |
|---|---|---|---|
| Hidden evaluator | PASS 8/8 | PASS 8/8 | same |
| Model calls | 30 | 29 | 1.03× |
| Uncached input | 88,548 | 70,906 | 1.25× |
| Cached input | 1,743,488 | 1,292,032 | 1.35× |
| Output (incl. reasoning) | 8,287 | 5,774 | 1.44× |
| Reasoning | 1,490 | 622 | 2.4× |
| Wall clock | 643s | 531s | 1.21× |
| List-price proxy (astra rates) | ~$3.04 | ~$2.29 | 1.33× |
| Weekly meter | 10→11% | 11→12% | indistinguishable |

Reading it:

- Same outcome, same step count. The claim's only plausible mechanism (low
  takes more steps) **didn't show up**: 29 vs 30 calls.
- High costs more everywhere, and mostly not through reasoning tokens.
  Reasoning was small in both runs. The bulk of the gap is **cached input**
  (+450k tokens): high reads more context per step, so every resend is bigger.
- The meter moved one whole point per run and can't separate them. Whatever
  weighting quota uses, high is ≥ low on every token component, so no weighting
  flips the result.
- Consistent with the 2026-08-30 luna evidence (low used fewer steps there too).

Limits: n=1 per arm, one task. That rules out "high is clearly cheaper" on
this kind of task. It doesn't rule out a task where low genuinely flails
(fails, loops, retries), which is the one scenario the claim could still be
true in. If you want to chase that, the next pair would be a task low is
likely to *fail*, e.g. `r-retry-abort-backoff`.

### Pair 2: `r-grok-responses-lane` (harder, cross-provider tracing)

Chosen as the claim's best case: tracing requests/continuations across two
providers that share a wire shape. Evaluator red at baseline (2/3 fail), but
**not solution-agnostic**: it requires the vendor as a third positional argument
to `normalizeResponseEvent` and the literal id `'grok'`. So pass/fail is
advisory, and a blind judge (Opus, 3 samples, real merged fix included as a
hidden calibration candidate) settles quality. Same protocol: high first, 1800s cap.
Traffic: 34 requests `high`, 44 `low`, all `gpt-6-astra`; peak input <100k, so no compaction.

| | high | low | low / high |
|---|---|---|---|
| Hidden evaluator | PASS 3/3 | 2/3 (distinct `grok-responses` tag; the evaluator's `'grok'` is the flawed choice, see judge) | — |
| Model calls | 34 | 44 | 1.29× |
| Uncached input | 90,341 | 98,155 | 1.09× |
| Cached input | 1,990,400 | 2,802,560 | 1.41× |
| Output (incl. reasoning) | 11,219 | 10,463 | 0.93× |
| Reasoning | 2,845 | 1,702 | 0.60× |
| Wall clock | 758s | 802s | 1.06× |
| List-price proxy | ~$3.45 | ~$4.31 | **1.25×** |
| Weekly meter | 12→13% | 13→15% | low moved 2 points, high 1 |

Here the claim's mechanism **did** show up: low took 10 more steps, and the
resent context (cached input) outweighed high's extra reasoning and output.

Blind judge (Opus, 3 samples, labels reshuffled each time): **low 9.67 ± 0.58,
high 7.67 ± 0.58, merged human fix 4.33 ± 0.58.**

- Low won *because of* the `grok-responses` tag the evaluator failed it on. At
  the baseline, chat-completions opaque items are tagged `provider:
  this.providerId`, which is `'grok'` for Grok (verified in
  `openai-chat-completions-model.ts` at `67d25a6d~1`). So `'grok'` collides
  with legacy Grok chat items. The evaluator encodes the collision, and low's
  distinct tag isolates the lanes. **The hidden evaluator is wrong on this
  point.** Treat it as advisory, or rewrite that assertion before reusing the task.
- High had the strongest tests, but it used the colliding tag and turned off
  lifecycle tracking for Grok, which nobody asked for.
- The human fix scored low for bundled scope (prompt-cache placement, registry
  capability, env fallback) and for leaving the legacy `openai-compatible` tag
  accepted on the Grok lane. The judge is a scope-strict rubric, not a verdict
  on shipping.

Net for pair 2: high was ~20% cheaper, but low produced the better fix.

### Combined reading (n=1 per arm per task)

The answer depends on the task. On a contained bug both efforts took the same
number of steps, and high cost ~1.3× more. On a cross-cutting tracing task low
took ~30% more steps, and high cost ~0.8× as much. The deciding variable is
whether low effort adds steps, because in an agent loop resent context dominates
cost (cached input was ~95% of tokens in every run) while reasoning tokens were
small. The claim is neither a myth nor a rule: plausibly true on hard,
exploratory tasks, false on easy ones. Two pairs can't give a threshold.

## The claim and why it isn't obviously wrong

Claim heard secondhand: running `gpt-6-astra` on high reasoning effort consumes
*less* ChatGPT-subscription quota than on low effort.

Per request, high effort has to cost more, because reasoning tokens bill as output.
The claim can only hold **per task**, and there's one mechanism that could make it true:

- An agent loop resends the whole transcript on every step. Total input grows
  roughly quadratically with step count.
- If low effort takes more steps (wrong first guesses, re-reading files, redoing
  failed edits, retrying tests), the extra resent context could outweigh the
  reasoning tokens that high effort spends.
- Cached input is cheap in dollars (`cacheReadPricePerMTok: 1` vs `10` uncached
  for astra in `catalog.generated.ts`), but **we don't know how the subscription
  quota weights cached tokens**. If quota counts cached input near full price,
  the step-count effect gets much bigger.

So the benchmark needs to answer two questions, and the second one matters on its own:

1. Per task, does high effort use less quota than low effort?
2. What does the quota meter actually weight: output, uncached input, cached input, or requests?

## What we measure

| Metric | Source | Role |
|---|---|---|
| **Quota consumed** | Codex App Server `account/rateLimits/read` → `usedPercent` delta (see `docs/research/codex-usage-reset-credits.md`) | **Primary.** The thing the claim is actually about |
| Tokens: uncached in / cached in / output / reasoning | term2 provider-traffic logs via `collect-cost.py` (model-benchmark skill) | Explains *why* the quota moved |
| Requests, tool calls, wall time | provider-traffic + run log | Tests the step-count mechanism directly |
| Solved? | hidden evaluator (typecheck + test) | Quality gate. A cheap failure is not a win |
| Quality score | blind judge (only if pass rates tie) | Tiebreak |

Headline number: **quota per solved task**, alongside raw quota per attempt.

The dollar figure from `collect-cost.py` is a proxy, not the answer. The whole
point of this benchmark is that dollar-weighted tokens and quota might disagree.

### Why the quota meter is awkward

- `usedPercent` is a coarse percentage of a 5-hour (and weekly) window. One run
  will probably move it by less than one step, so **measure batches, not single
  runs**: read the meter, run *k* same-effort cells back to back, read it again.
- It's account-wide. Anything else on the same ChatGPT account (codex CLI, other
  term2 sessions, the desktop app, herdr workers) pollutes the delta. The runs
  need a quiet window with **nothing else on that account**.
- A window reset in the middle of a batch invalidates that batch. Read
  `resetsAt` first, and skip any batch that could cross it.
- term2 streams quota windows (`codex.rate_limits` → `codex_rate_limits` in
  `codex-responses-model.ts`) but doesn't persist them to provider-traffic logs.
  So we read the meter out of band through App Server. Before trusting that,
  **check that term2's Codex OAuth and the App Server login are the same ChatGPT
  account**, since term2 owns its own OAuth.

## Design

**Harness:** term2 non-interactive (`--auto-approve`), because that's the real
product. Only the effort varies: same model, prompt, tasks, and timeout.

**Efforts:** `low` and `high`, with `medium` as a middle point in phase 2. Use
whatever levels the model actually accepts for astra; check this in the dry run.

**Tasks:** reuse the model-benchmark curated set, so there's an evaluator and no
leakage. Mix easy tasks with hard ones on purpose, because the claim predicts the
gap depends on difficulty (low effort flails more on hard tasks):

- easy: `c11-d8-approval-grant-kind`
- medium: `f-correctness-002-null-session-context`, `r-ws-session-lifetime`
- hard: `f-security-002-symlink-traversal`, `r-retry-abort-backoff`

**Replicates:** agent runs are noisy (step count varies a lot run to run), so use
≥3 per cell. One run per cell would just measure luck.

**Ordering:** interleave efforts ABBA across batches (low, high, high, low…) so
cache warmth, time-of-day load, and drift don't line up with one arm. Every run
starts from a fresh workspace and a fresh session, with no shared
`previous_response_id` chain.

**Timeout:** the same generous cap for both arms (e.g. 900s). A timeout counts
as a failure, and **its consumption still counts**. Runaway loops at low effort
are exactly the cost the claim is about, so dropping them would bias toward low.

**Prereqs** (from `model-benchmark/references/cost-capture.md`):
`logging.debugLogging = true` before the first run, and term2 cells run
**serially** (token attribution is a time window over a shared log directory).

## Phases

### Phase 0: tooling, no model spend
- Small script: start `codex app-server`, initialize, `account/read`, then
  `account/rateLimits/read` with `excludeResetCreditDetails: true`. Print
  `usedPercent`, `windowDurationMins`, `resetsAt` for each window. Read-only;
  never call the consume method.
- Check the account match (see above) and the meter's resolution (integer %? decimals?).
- `prepare-benchmark.sh` with candidates `term2:openai-codex/gpt-6-astra#low`
  and `#high`, then dry-run `run-candidates.sh` to confirm the effort flag
  actually shows up in the invocation.

### Phase 1: pilot (~12 astra runs)
2 tasks (one easy, one hard) × {low, high} × 3 reps. Meter read around each
same-effort batch of 3.

Outputs: per-run token breakdown, per-batch quota delta, and the run-to-run
spread. Use the spread to size phase 2. If one 3-run batch doesn't move the meter
visibly, batch size has to go up.

**Stop here if** the pilot already shows high using ≥1.5× the quota of low on
both tasks with no overlap. The claim is dead, and we just report it.

### Phase 2: full grid (~45 astra runs)
5 tasks × {low, medium, high} × 3 reps, ABBA-ordered batches.

### Phase 3: what does quota weight?
Regress per-batch quota delta on the batch's token components (uncached in,
cached in, output incl. reasoning, request count). With ~15+ batches this gives a
rough weighting. That answers question 2 and tells us whether the dollar proxy in
`collect-cost.py` can stand in for quota in future benchmarks.

## Decision rule (set before seeing data)

- **Claim supported:** median quota per task is lower for `high` than `low` on
  ≥4 of 5 tasks, *and* the step-count mechanism shows up (low has more requests
  and more cached input on those tasks). If the mechanism isn't there, a quota
  win is more likely noise or metering weirdness than a real effect.
- **Claim supported only on hard tasks:** report it that way. That's a useful
  routing result (effort by task difficulty), not a blanket rule.
- **Claim rejected:** high ≥ low on ≥4 of 5 tasks.
- Everything in between gets reported as inconclusive, with the spread. No
  squinting.

Always report quota per *solved* task next to raw quota. High effort could lose
on raw quota and still win once failures count.

## Budget and approval

~57 astra runs total if every phase runs; phase 1 alone is ~12. Astra is the
priciest tier in the catalog, and this will burn a visible share of a 5-hour
window, possibly more than one. Per the model-benchmark skill, **no run starts
without an explicit "go"**, and each phase gets its own go.

## Known confounds to report, not hide

- Provider-side load and routing vary over the day, and effort semantics may
  change server-side between runs. ABBA ordering and a short collection window help.
- Prompt-cache hit rate depends on timing between requests; slow steps can let
  the cache expire. Log per-request cached-token share.
- Mid-run compaction or rollover changes token accounting. Flag any run where it fired.
- Five tasks from one repo is a narrow sample. The result is about term2-style
  coding tasks in the term2 harness, not astra in general.
