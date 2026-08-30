# Model/effort step-down — research findings (2026-08-30)

Status: **research complete; step-down design premises materially changed.** This
doc records the online research done after the benchmark rounds in
`docs/plans/model-effort-step-down-benchmark.md`. The doc's validation results
(quality data, tasks, judge scores) all stand; this file records **how the
mechanism design must change** in response to cache-economics evidence that was
not available in the doc.

## What was researched

- OpenAI Responses API: `previous_response_id`, `reasoning.effort` semantics,
  prompt caching behavior, model pricing (Sol/Terra/Luna), WebSocket session
  persistence.
- Anthropic / Claude Code: prompt caching model, model-switch and effort-switch
  cache invalidation, subagent cache isolation.
- Cursor Router, Claude Code routing patterns, Codex CLI effort semantics,
  third-party routers (pi-model-router, SageRoute, LangChain RouterMiddleware).
- Pricing sources: OpenAI pricing page (via 4 corroborating sources), Codex
  issue #35416 (effort-change cache miss, empirically measured), GPT-5.6
  prompting/cost guides.

## Finding 1 — Effort is NOT cache-safe; this kills the "effort-only" variant

**Claim:** switching `reasoning.effort` for the same model invalidates the
prompt cache, just like switching model.

**Sources:**
- Claude Code docs (code.claude.com/docs/en/prompt-caching): "The cache is
  keyed by effort level as well as model... switching with `/effort` means the
  next request reads the entire conversation history with no cache hits."
- Codex issue #35416 (openai/codex): empirical measurement on GPT-5.6 —
  changing effort mid-session causes a **near-100% cache miss**, including
  dropping back to the pre-effort-change baseline. Returning to a previously
  used level restores the hit. Author's hypothesis: effort is "buried
  somewhere at the beginning of the conversation, e.g. system prompt" (model-
  side reasoning instructions are injected into the prefix).
- OpenAI Prompt Caching guide explicitly lists `reasoning.effort` as a cache-
  invalidating parameter under "Cache breaking changes" for GPT-5.6+.
- OpenAI Prompt Caching 201 cookbook: "Changes to reasoning effort" listed as
  a cache-breaking parameter.

**Consequence for the step-down design:** the doc's original "keep model,
drop effort only" framing assumed effort changes are cache-safe. They are
not, on either lane (Anthropic explicitly, OpenAI via the Codex measurement).
**Both variants — effort-demotion and model-swap — pay the same cache cost.**
The choice between them is therefore driven by quality/capability, not cache
economics.

## Finding 2 — GPT-5.6 cache economics changed the cost math fundamentally

**Claim:** on GPT-5.6, cache writes are no longer free: **reads cost 0.1×
input, writes cost 1.25× input, TTL 30 minutes** (implicit breakpoints;
explicit breakpoints also supported).

**Sources:** OpenAI GPT-5.6 launch announcement + Prompt Caching guide,
corroborated by WaveSpeed, CometAPI, and QCode pricing tables.

**Prices per 1M tokens** (short-context, post-July-30 cut):
| model | input | cached read | cache write | output |
|---|---|---|---|---|
| Sol | $5.00 | $0.50 | $6.25 | $30.00 |
| Terra | $2.00 | $0.20 | $2.50 | $12.00 |
| Luna | $0.20 | $0.02 | $0.25 | $1.20 |

**Worked example — cache-miss cost at 100K context** (full-history request
after a mid-turn model swap; conservative — assume no partial-match):

| variant | cache write (on switch) | reads after switch |
|---|---|---|
| effort-only demotion (same model) | $2.50/M × 100K = **$0.25** | Terra cached 0.1× |
| model swap to luna | 1.25× luna input = $0.25/M × 100K = **$0.025** | Luna cached 0.1× ($0.02/M) |

**Surprise:** because Luna is now 10× cheaper than Terra at the input rate,
the **model swap's one-time cache write is cheaper than an effort-only swap's
write**, and subsequent Luna reads are 10× cheaper than Terra reads. The
effort-only variant no longer wins on cache economics — it loses, because it
keeps the expensive model's write cost while forgoing the cheap model's read
savings.

**Counter-consideration:** this comparison is only valid if the swap is not
repeated. Alternate terra/luna alternation on every tool call in the same
turn would pay two cache writes per alternation. The benchmark ran the
demotion once per turn, so the design should demote once per turn and not
flip-flop.

## Finding 3 — Mid-turn chaining is broken across model changes

**Claim:** switching model mid-chain (server-side chained conversation) breaks
or is unreliable; the industry-standard pattern is: chain within a turn on
one model, switch models **between turns**.

**Sources:**
- OpenAI community threads (May 2025): switching model mid-chain via
  `previous_response_id` either 500s (reasoning → non-reasoning) or silently
  drops prior assistant context (o4-mini → gpt-4o-mini). "The expectation is
  to keep the same model within a thread."
- Cursor Router (production, July 2026): routes **per request** but "Real
  routing happens across a conversation"; trained "where routing results in
  cache misses" and "evaluated in production where our reported cost savings
  include the cost of cache misses in routing decisions." No mid-turn model
  swap.
- Claude Code subagent pattern (Anthropic blog + docs): cheap work goes to
  subagents, not to mid-session main-loop model swaps — "If you need to
  switch models, the best way to do it is with subagents"; the parent cache is
  unaffected by a subagent.
- pi-model-router: "Google thinking tool continuation requires the **same
  model** to avoid thought-signature replay errors. The router detects this
  pattern and preserves the exact model/tier for the continuation turn."
- SageRoute: starts every task on the cheap model and escalates on evidence
  (the **inverse** policy: cheap-first, escalate on failure). Noted as an
  alternative policy shape.
- Anthropic "Lessons from building Claude Code": "Don't change models mid-
  session"; every model has its own cache; a single swap re-writes full
  context.

**Consequence:** the doc's "mid-turn demotion" premise is weaker than assumed.
The industry direction is: **chain within a turn on one model, change model
between turns** (or in a subagent with its own cache). The mid-turn swap is
not impossible, but it is off the well-trodden path and carries the risk that
reasoning items (encrypted `rs_` items from a different model's runtime)
cannot cross the model boundary server-side. This needs a **live probe**
before design commitment.

## Finding 4 — Reasoning continuity is model-pinned, which constrains the swap point

**Claim:** reasoning items cannot cross model boundaries safely mid-turn, and
"reasoning continuity" is specifically a tool-continuation concern.

**Sources:**
- OpenAI Reasoning guide: when doing function calling, pass back reasoning
  items returned with the last function call; these are per-model encrypted
  `rs_` items.
- Google thought signatures (Interactions API + pi-model-router's "Google
  lock"): the reasoning artifact is **model-pinned**; a tool continuation
  without the same model fails.
- pi-model-router: same conclusion for OpenAI reasoning models — reasoning
  items travel with the response that produced them and are only guaranteed
  replayable by the same model.

**Consequence:** the design must place the swap point at a boundary that
**does not require replaying the expensive model's reasoning items into the
cheap model**. The cheapest safe option is: first response of the turn
(expensive model) emits its reasoning items; continuation steps on the cheap
model **do not replay them** (they may re-derive, or the reasoning is
irrelevant for pure tool-execution turns). This needs a live probe to confirm
behavior.

## Finding 5 — Subagent-based demotion is the cache-safe pattern

**Claim:** running continuation steps in a subagent with its own cache, model,
and context window is the industry-blessed pattern for mixed-tier work.

**Sub-criteria:**
- Separate cache: subagent builds its own prefix; parent's cache intact.
- Separate model: no mid-chain model swap.
- Own context window: parent context not polluted.
- Judge/escalation: cheap worker + expensive judge is the pattern that
  consistently beats cheap-only.

**Sources:** Anthropic Lessons (Claude Code), Claude Code subagent docs,
backgrind.com worked example (8 Haiku workers + Opus judge = 3.75× cheaper
than all-Opus), OpenRouter subagent server tool (orchestrator + worker in one
session).

**Consequence:** the design should consider **turn-boundary subagent
demotion**: spawn a subagent on luna for the continuation steps (with its own
prefix, containing only what continuation needs), rather than swapping the
main loop's model. This sidesteps Findings 3+4 entirely — no mid-chain model
swap, no reasoning-item replay risk. It changes the "90% of continuation
requests" saving profile: the parent's next turn then continues on the parent
model with its parent cache intact, and the subagent's short prefix makes the
subagent's cache warm cost small.

**Open question:** does the subagent pattern fit term2's subagent infra
(multi-turn subagent sessions, tool access, budget), or is a main-loop model
swap after all the natural fit for term2's existing machinery? Needs a
code-level design pass — the answer determines where the mechanism lands in
`agent-runtime`.

## Finding 6 — Production routers add "escalate on evidence" to "demote blindly"

**Claim:** production routers (Cursor Router, SageRoute, pi-model-router)
do not demote blindly on continuation steps; they add classification and
escalation signals.

**Examples:**
- Cursor Compass: continuous complexity score per request; route to cheap
  unless clearly complex; **cache-miss cost is priced into the routing
  decision itself**.
- pi-model-router: classifier triggered on (a) N tool failures, (b) periodic
  interval, (c) first tool feedback; otherwise reuse last routing decision —
  "phase stickiness".
- SageRoute: cheap-first with escalation on real execution evidence (repeated
  tool failures, stalls, test failures); "The first cheap-to-strong hop is
  the cheapest, most reversible move" — asymmetric hysteresis (escalate fast,
  demote slowly).

**Consequence:** a pure "first response expensive, rest cheap" rule is the
naive end of a spectrum that production routers occupy. A term2 design should
at least consider an **escalation signal**: if a continuation step fails (tool
error, repeated stalls), the next continuation re-promotes to the expensive
model for that step. This is a much smaller, more defensible increment than
the blanket demotion, and it aligns with the doc's "runaway-effort pathology"
finding: high-effort runs that derail are exactly the case where re-promotion
on failure signals would have saved cost *and* quality.

## Finding 7 — Three-tier pricing means the floor tier is a real choice now

**Sol $5/$30, Terra $2/$12, Luna $0.20/$1.20** (short-context, post-cut).
Terra→Luna is a 10× input-price drop and 10× cached-read drop. This is the
largest price gap between adjacent tiers of the GPT-5.6 family so far, and it
post-dates the original hypothesis (the log analysis ran before the cut).

**Consequence:** the mechanism's "demote to cheap" is worth more now than
when the doc was written (Terra→Luna saves 10× input on continuation steps,
not ~1.75× pre-cut). But the floors change too: **luna#medium as security
floor** (our round answered this affirmatively, 9.0 vs terra 8.67) needs to
be re-priced against terra at the new rates. The security floor verdict
(quality) stands; the *cost* math shifts.

## Finding 8 — Codex CLI's own effort model validates tier/effort decoupling

**Sources:** Codex CLI `model_reasoning_effort` (five levels, per-mode
overrides like `plan_mode_reasoning_effort`), per-subagent effort in TOML
config, "orchestrator high / workers low" pattern reducing token spend
50-70%.

**Consequence:** codified effort-per-role is a standard practice; term2's
existing settings (agent.model, agent.reasoningEffort, cheapModel etc.)
already support this shape. The step-down mechanism should extend the
existing tier system (`model-resolver.ts` already has cheap/balanced/smart
tiers) rather than inventing a parallel one.

## Design implications — what the design must now answer

1. **Mid-turn model swap vs turn-boundary demotion vs subagent demotion** —
   three mechanism shapes, three different cache/reasoning-item risk profiles.
   Decision needs the live probe (Finding 3/4) plus a code-level pass over
   `agent-runtime` (Finding 5's open question).
2. **Where does the security floor (`luna#medium`) attach?** The quality
   verdict stands; the mechanism must be able to express "floor at medium
   effort on cheap model for security-tagged work" and detect those paths.
3. **Escalation signals** (Finding 6): failure/stall re-promotion is cheaper
   to ship, easier to defend, and aligns with the doc's runaway-effort
   finding. Possibly ship escalation-only first.
4. **Cache economics are now favorable to the model swap** (Finding 2's
   worked example) — but only if the swap happens once per turn (no
   alternation) and the cheap tier's read savings compound. Re-derive cost
   math from real token volumes (production logs) before committing.
5. **Effort-demotion is NOT the cache-safe fallback it appeared to be**
   (Finding 1). If effort and model swaps cost the same cache penalty, the
   simpler mechanism (model swap at turn boundary) dominates effort-swap at
   mid-turn.

## What was NOT researched (open)

- Live probe of mid-turn model swap on the Codex Responses lane (does it 400?
  drop reasoning items? silently degrade?). **This is the single highest-value
  next experiment** — cheap (one session), decisive for the design.
- How term2's `ProviderContinuity`/`SessionInputPlanner` exactly behave under
  a mid-turn model change (term2-side, not API-side) — related to the
  model-switch chain-drop fix, but needs a code-level pass.
- Step-level router (Cursor-style per-request classification) — out of scope
  for a first increment; noted for future.
- Gemini/Antigravity lane behavior (term2 has an OpenAI-compatible middleware
  that could route to Gemini; untested for this mechanism).

## Source register

- OpenAI: `developers.openai.com/api/docs/guides/reasoning`,
  `.../guides/conversation-state`, `.../guides/prompt-caching`,
  `.../api/docs/models/gpt-5.6-{terra,luna}`, Prompt Caching 201 cookbook,
  GPT-5.6 launch (openai.com/index/gpt-5-6).
- Anthropic: `code.claude.com/docs/en/prompt-caching`,
  `claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything`,
  `code.claude.com/docs/en/model-config`.
- Codex: `github.com/openai/codex/issues/35416` (effort-change cache miss),
  `codex.danielvaughan.com` (Codex CLI effort/routing guides).
- Routers: `cursor.com/blog/router`, `cursor.com/blog/how-cursor-router-works`,
  `github.com/kdejaeger/pi-model-router` (+ fork `ukind/pi-model-router`),
  `github.com/codejunkie99/sageroute`, `github.com/johanity/langchain-router`.
- Industry patterns: backgrind.com (per-subagent models), OpenRouter subagent
  tool docs, Google thought signatures (`ai.google.dev/gemini-api/docs/thought-signatures`),
  "Agentic Routing: The Harness-Native Data Flywheel" (arXiv 2607.11399).
