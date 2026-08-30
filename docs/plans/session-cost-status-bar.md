# Session Cost in the Status Bar

Status: **implemented.** `source/services/cost/` (`model-cost.ts`, `pricing.ts`,
`pricing-overlay.ts`, `subscription-providers.ts`) owns the accounting, and `StatusBar`
renders a `SessionCostSummary` slot with `exact`/`partial`/`unavailable` states
(`source/components/layout/StatusBar.tsx:119-122`). The **Resume here** notes below
describe the pre-implementation state and are retained for their design constraints,
not as a description of current behavior.

Scope: provider completion accounting, the application run loop, foreground and
subagent session accounting, conversation persistence/replay, `/usage`, and the Ink
status bar.

Related: `docs/plans/post-refactor-provider-boundary-audit-findings.md`,
`docs/plans/openai-context-compaction.md`.

## Resume here

The repository already has reliable cumulative **token** accounting, but not reliable
monetary accounting:

- `NormalizedUsage` carries input, output, reasoning, cache-read, and cache-creation
  counters.
- `ConversationOrchestrator` adds a completed foreground run to the session usage
  accumulator once. A run may contain several model requests, including approval
  continuations, so its terminal usage is deliberately cumulative.
- subagent usage has a separate accumulator, and both accumulators are reconstructed
  from conversation JSONL on resume.
- `StatusBar` receives `lastUsage`, which is the most recent request's context/footer
  usage, not cumulative session usage.
- the vendored model catalog contains context windows and output limits only. Its
  cross-provider model fallback is safe for context windows but must **not** be reused
  for prices.
- some OpenAI-compatible providers emit a cost-only trailer. Term2 currently strips
  that trailer to keep it from corrupting the SDK usage accumulator.
- `AgentLimits.maxCost` explicitly rejects today because provider-neutral pricing is
  unavailable.

Do not derive the whole session price from the provider/model selected when the UI
renders. A session can change models, subagents can use different models, and a request
can use a non-standard service tier. Attribute cost while the completed model request's
identity and exact request options are still available.

The primary checkout is currently shared and dirty. Implement this feature in
`.worktrees/session-cost-status-bar` on branch `codex/session-cost-status-bar`, run
`pnpm install` in that worktree, and merge only after review and verification. Do not
modify or absorb the unrelated primary-checkout changes.

## Goal

Show the incurred cost of priced model requests in the interactive status bar, across
foreground and subagent work, without presenting partial or estimated data as an exact
provider bill.

The feature must survive session resume and must remain correct when a session changes
provider, model, or service tier.

## Product contract

### Meaning of “session cost”

Session cost is incurred model-request spend since this conversation session was
created. It is not the hypothetical cost of the currently retained transcript.

- Rewind, undo, compaction, and message deletion do not subtract already incurred cost.
- Clearing the conversation or starting a genuinely new session resets it.
- Resuming a session restores cost records written by the version that created them.
- Old log entries without cost records are not repriced using today's catalog. A resumed
  legacy session is partial until a new session is started.
- Tool execution, local shell work, and network charges outside model inference are out
  of scope.

### Truthfulness states

Every session summary has an explicit coverage state:

| State | Meaning | Compact status-bar text |
| --- | --- | --- |
| `exact` | Every counted request supplied a provider-reported USD charge. | `Cost $0.42` |
| `estimated` | Every counted request is priced, but at least one used vendored prices. | `Est $0.42` |
| `partial` | Some incurred requests are priced and some are not. | `Est $0.42+` |
| `unavailable` | No incurred request can be priced. | Omit the cost segment |

`$0.42+` is a lower bound, not a total. `/usage` must explain the state and show priced
versus unpriced request counts. The footer must never silently substitute the current
model's price for an unknown historical request.

All catalog-derived values are estimates even if the arithmetic is exact. Provider
billing can include routing, negotiated discounts, batch/flex tiers, taxes, or failed
requests that terminal usage cannot establish.

### Supported billing dimensions

Pricing arithmetic uses non-overlapping units:

- uncached input tokens;
- cached input/read tokens;
- cache-write/creation tokens, including distinct TTL rates only when the provider
  exposes them distinctly;
- output tokens.

Reasoning tokens are informational when they are already a subset of output tokens; do
not bill them twice. A provider/model/tier whose usage semantics cannot be mapped to
these dimensions is unpriced until a native fixture establishes the mapping.

Use integer USD micros for accumulation and JSON persistence. Convert decimal provider
charges without passing through binary floating-point arithmetic. Round each model
request once, then add integers.

## Ownership and contracts

Add a cohesive `source/services/cost/` module. It owns pricing lookup, arithmetic,
coverage rules, formatting, and accumulation. Providers continue to own wire parsing;
the run loop owns the model-request lifecycle; the conversation layer owns session
persistence; the status bar only renders a supplied summary.

Suggested public shapes (names may change, responsibilities may not):

```ts
type CostSource = 'provider' | 'catalog';
type ServiceTier = 'standard' | 'flex' | 'batch' | 'unknown';

interface ModelRequestCost {
  requestId: string;
  provider: string;
  model: string;
  serviceTier: ServiceTier;
  outcome: 'completed' | 'failed' | 'cancelled';
  usage?: NormalizedUsage;
  usdMicros?: number;
  source?: CostSource;
  pricingVersion?: string;
  unpricedReason?:
    | 'missing_usage'
    | 'unknown_provider'
    | 'unknown_model'
    | 'unknown_tier'
    | 'ambiguous_usage';
}

interface SessionCostSummary {
  knownUsdMicros: number;
  pricedRequests: number;
  unpricedRequests: number;
  state: 'exact' | 'estimated' | 'partial' | 'unavailable';
}
```

Do not add monetary fields to `NormalizedUsage`: usage is a provider-normalization
contract, while cost has identity, price-version, provenance, and completeness rules.
Keeping them separate prevents generic usage merges from dropping or double-counting
money.

`ModelRequestCost` is one record per dispatched request, including a typed unpriced
record when a dispatched request fails or is cancelled without billable evidence. The
application run state holds the records accumulated across tool loops and approval
continuations. Terminal foreground/subagent results carry the complete record list once,
matching the existing run-cumulative usage contract.

Failed or cancelled requests for which the provider supplies neither usage nor a charge
cannot be estimated. Record an unpriced request only when the application can establish
that dispatch occurred; do not invent zero cost. This keeps the summary partial rather
than falsely exact after an ambiguous failure.

## Step 1 — Pin pricing and arithmetic contracts with red tests

Create `source/services/cost/model-cost.ts` and colocated tests before production code.

Tests must establish:

1. standard input/output arithmetic in integer micros;
2. cached input is removed from full prompt input and charged at the cache-read rate;
3. cache creation is charged once and is not also inferred from `total_tokens`;
4. reasoning tokens are not added to output a second time;
5. provider-reported cost wins over a catalog estimate without adding both;
6. missing model, provider, tier, or ambiguous usage yields an unpriced record;
7. mixed exact/estimated/unpriced records produce all four coverage states;
8. decimal parsing and sub-cent formatting are deterministic;
9. duplicate delivery of the same request record cannot double-count. Give every
   record a stable request ID local to the run.

Before enabling a provider in the price catalog, add a fixture proving whether its
reported prompt counter includes cache reads and whether cache creation is separate.
The existing `NormalizedUsage` convention is the starting hypothesis, not evidence for
every provider.

Acceptance: the cost module is pure, deterministic, has no settings/provider imports,
and all unsupported inputs return typed unpriced results rather than throwing or
guessing.

## Step 2 — Add a provider-scoped, versioned price catalog

Extend the existing generated model catalog pipeline rather than creating a second
model-name matcher:

- add optional, typed per-million-token prices and supported service tiers to the input
  and generated model metadata;
- increment the generated catalog schema version;
- retain the source version and generation timestamp as `pricingVersion` provenance;
- add `getModelPricing(provider, model, tier)` with exact and dash-bounded model matching
  inside the named provider only;
- never use `lookupModelAnyProvider` for pricing;
- fail closed for custom providers and unknown tiers;
- do not treat standard pricing as flex/batch pricing;
- keep Codex OAuth/ChatGPT-plan requests unpriced because the status bar already exposes
  plan rate limits and there is no per-request API bill to infer.

Prefer pricing fields from the same pinned pi-ai catalog source already used by
`pnpm catalog:update`. If a provider has no price data there, add a small versioned
Term2 overlay sourced from that provider's official pricing documentation; do not scrape
prices at runtime. Each overlay entry needs a source URL and a checked-at date in its
metadata.

Generator tests must prove tier mapping, cache-rate mapping, omission of incomplete
entries, stable output, and the prohibition on cross-provider price fallback.

Acceptance: changing a UI setting or provider alias cannot retroactively change an
already-created `ModelRequestCost`.

## Step 3 — Produce one cost record at each model-request boundary

Extend the streamed completion contract with an optional provider-reported USD charge.
Keep it separate from `usage`.

In `ApplicationRunLoop`, allocate a stable run-local request ID immediately before
dispatch and settle it exactly once. When a terminal `completion` is accepted:

1. capture the exact `providerId`, `agent.model`, and effective service tier from the
   dispatched request—not from mutable settings;
2. normalize the completion usage once;
3. prefer a validated provider-reported charge when present;
4. otherwise call the provider-scoped pricing module;
5. append the resulting record to run state;
6. preserve records in the continuation handle so approvals do not lose them;
7. expose the cumulative record list on the terminal run result exactly once.

Handle terminal-less/error paths explicitly. Once dispatch begins, an error or
cancellation with no billable evidence contributes an unpriced request marker to the
run's accounting result/logging path. Preserve the existing
`AmbiguousModelOutcomeError` and cancellation semantics; cost accounting is
observational and must never convert a failure into success or trigger a replay.

For the OpenRouter/OpenAI-compatible cost-only trailer, replace “discard” with
“intercept as billing metadata while keeping it out of the SDK usage accumulator.” Add
an adapter test proving that the trailer creates one provider-sourced cost record and
does not become a malformed model chunk. Do not assume every compatible provider uses
the same currency or trailer semantics; accept only the characterized USD form.

This step changes provider/run-loop contracts. Required tests:

- streamed-adapter unit tests for provider cost parsing and invalid trailers;
- `ApplicationRunLoop` tests covering one request, tool-loop multi-request totals,
  approval continuation, cancellation, missing usage, and exact-over-estimate
  precedence;
- a provider black-box fixture carrying usage plus a cost trailer through the shipped
  CLI boundary;
- negative fixtures showing unknown models/tiers remain partial rather than borrowing
  another provider's price.

Acceptance: a run with N dispatched model requests produces N unique accounting
records, including across approval continuation, and retry/cancellation behavior is
otherwise unchanged.

## Step 4 — Accumulate and persist foreground plus subagent cost

Add a `SessionCostAccumulator` beside the existing usage accumulators, but keep their
contracts separate.

Wire it through `App`/`useConversation`/`ConversationOrchestrator`:

- add completed foreground-run records once when the final result is applied;
- add completed foreground records neither on an approval pause nor again on resume;
- add subagent records when `subagent_completed` is applied;
- emit a UI callback with an immutable `SessionCostSummary` after each add/reset so the
  status bar is reactive; do not rely on reading a mutated object during an unrelated
  render;
- reset on the same new-session boundary as both token accumulators.

Persist the request-cost records, not only a formatted total:

- add optional cost records to `assistant_turn` and `subagent_completed` JSONL events;
- keep schemas backward compatible;
- reconstruct the accumulator during replay;
- mark a resumed session partial when older incurred turns have usage but no cost
  records;
- preserve recorded micros and pricing provenance rather than repricing on load;
- ensure log sanitization does not expose credentials or raw provider payloads. Cost
  records contain identity, normalized usage, and billing metadata only.

Pin semantics with conversation persistence/replay tests for mixed models, foreground
plus subagent totals, old logs, rewind/undo, clear/new-session reset, interrupted turns,
and duplicate event replay.

Acceptance: live and resumed summaries match byte-for-byte, and rewind does not reduce
incurred cost.

## Step 5 — Render the session summary

Pass the reactive `SessionCostSummary` through `BottomArea` to `StatusBar`. Keep
`lastUsage` unchanged because it owns the current-context gauge and last-request token
display.

Add a compact cost segment beside the token/context segment using the truthfulness table
above. Formatting rules:

- two decimals at or above one cent;
- enough precision below one cent to avoid rendering a positive cost as `$0.00`;
- locale-independent `.` decimal separator for USD;
- omit `unavailable` rather than showing `$0.00`;
- use the existing slate color for exact/estimated coverage and warning color for
  partial coverage;
- allow Ink layout to wrap rather than truncating model, safety, or cache warnings.

Extend `/usage` to show:

- main, subagent, and total tokens as today;
- known USD amount;
- `exact`, `estimated`, or lower-bound wording;
- priced and unpriced request counts;
- a short explanation when legacy/unpriced activity makes the total partial.

Status-bar component tests must cover all four states, sub-cent formatting, partial
warning color/text, narrow terminal rendering, and coexistence with rate-limit/cache
warnings. Slash-command tests pin the detailed explanation.

Acceptance: after a priced turn completes, the status bar updates without another user
action; after clear it disappears; after resume it displays the persisted summary.

## Step 6 — Verification and rollout

Develop test-first and run focused tests after each step. Before handoff run:

```bash
pnpm exec prettier --write <changed-files>
pnpm exec vitest run source/services/cost/model-cost.test.ts \
  source/providers/model-catalog/catalog.test.ts \
  source/providers/model-catalog/generate-catalog.test.ts \
  source/services/agent-runtime/application-run-loop.test.ts \
  source/services/conversation/conversation-orchestrator.test.ts \
  source/services/conversation/conversation-replay.test.ts \
  source/components/layout/StatusBar.test.tsx \
  source/hooks/use-app-commands.test.ts
pnpm typecheck
pnpm test:provider-black-box
pnpm test
```

Also run the relevant adapter test for every provider whose pricing or native-cost path
is enabled. Record focused red proof before implementation for the black-box
cost/usage scenario when practical.

Manual acceptance in the interactive CLI:

1. priced API-key model: cost appears after the first completed turn and increases after
   a tool-loop turn;
2. model switch: the old amount retains its old model price and the new request uses the
   new model price;
3. subagent: total increases and `/usage` identifies subagent contribution;
4. unknown custom provider: no false dollar total; after mixing with priced work the
   footer uses the partial lower-bound form;
5. Codex OAuth: plan-rate-limit display remains, with no invented API dollar cost;
6. rewind: cost is unchanged;
7. clear/new session: cost resets;
8. restart/resume: cost and completeness state match the pre-exit values.

Because this touches provider, run-loop, persistence, and shared UI contracts, merge only
after the full unit suite, typecheck, and provider black-box suite pass. Report baseline
or shared-checkout failures separately from failures introduced by this branch.

## Non-goals

- Enforcing `AgentLimits.maxCost`. That needs pre-call prediction, reservation, and a
  policy for overruns; observing completed cost does not make it safe to enforce.
- Fetching mutable prices at runtime.
- Claiming correspondence with invoices, subscription quotas, taxes, credits, or
  negotiated enterprise pricing.
- Repricing legacy sessions or historical records after catalog updates.
- Charging tools, shell commands, web searches, or other non-model services.
- Replacing the last-turn token/context display with cumulative session tokens.

## Risks to keep visible

- Provider usage counters do not all share identical cache semantics. Enable pricing
  only behind characterized fixtures.
- Cost-only trailers may be provider-specific and may not be USD. Fail closed.
- A request can incur provider cost without returning terminal usage. Partial state is
  required for honest reporting.
- Cumulative run results cross approval segments; adding both an intermediate and final
  total double-counts.
- Persisting only totals prevents audit, duplicate detection, and future mixed-model
  explanations. Persist request records.
- Catalog prices drift. Version every estimate and never reprice stored records.
