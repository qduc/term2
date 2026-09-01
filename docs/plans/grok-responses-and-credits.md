# Grok on the Responses API & Credit Usage Tracking

## Status
- **Grok Responses API**: Merged 2026-08-20 (`b065bbc9`, `40c4546a`).
- **Grok Credit Usage in Status Bar**: Merged 2026-08-21.

---

## Grok on the Responses API

### Motivation & Wire Constraints
Grok runs on the Responses API so encrypted reasoning round-trips, which Chat Completions could never do (it only returned a summary). 

Verified live against the proxy:
- Streaming SSE, function calling, usage, `prompt_cache_key`, and `include: ['reasoning.encrypted_content']` all work.
- **Chaining does NOT work**: `previous_response_id` 404s under Zero Data Retention (ZDR) and `store: true` comes back downgraded.
- Consequently, Grok's capabilities declare no chaining and no server-side compaction, but do support a prompt cache key.
- `TERM2_GROK_API=chat` falls back to the legacy Chat Completions lane.

### Architectural Invariants
Three things stopped keying on provider names, and must not go back:
1. **The opaque lane tag**: Was previously hard-coded `openai` because both Responses providers happened to be OpenAI. Grok is a second vendor on the same wire shape and its ciphertext is not interchangeable, so it gets its own lane (`grok`); the adapter takes the lane as a parameter.
2. **Prompt cache key placement**: Placement is a capability, not a provider id. Placing it by provider id put Grok on a placement no Responses adapter reads (causing live wire `prompt_cache_key: null`).
3. **Run loop encrypted reasoning**: The run loop previously kept terminal encrypted reasoning only for `codex` and `openai` namespaces, silently dropping Grok's. It now matches the namespaced *shape*, ensuring no Responses lane is lossy.

`x-grok-conv-id` is the documented xAI header for prompt-cache server affinity; the undocumented `x-grok-session-id` is still sent alongside it until something upstream is confirmed not to key on it.

---

## Grok Credit Usage in Status Bar

### Background & Endpoint
Grok's meter does *not* come from the inference lane: its Responses stream carries no quota frame the way Codex pushes `codex.rate_limits`, and the proxy returns no rate-limit response headers.

It is a separate REST call recovered from the `grok` CLI binary:
`GET {GROK_BASE_URL}/billing?format=credits` (Bearer token alone), returning `creditUsagePercent` plus a weekly `currentPeriod` and a per-product split. (Omitting `?format=credits` returns monthly billing totals instead.)

### Display & Lifecycle Cadence
- It represents a **percentage of a weekly period consumed**, not a requests-remaining allowance. Therefore, it cannot render in Codex's used/reset window format and has its own slot formatter in `StatusBar`.
- `lastCodexRateLimit` was deliberately not renamed into a shared field: the two shapes have nothing in common beyond the slot they occupy.
- **Cadence & Cooldown**: Cadence is owned by `source/services/grok/grok-credit-usage-service.ts`. It refreshes on the busy → idle edge of a turn, never on a timer, so an idle terminal makes no requests. 
- The 5-minute cooldown is long because the value is an integer percentage over a *week*, so high freshness is unnecessary while the undocumented endpoint should be treated gently.
- The service is process-wide: the cooldown only holds if callers share one clock (preventing subagent fan-outs from making simultaneous duplicate fetches).
- On HTTP 401, it stops permanently rather than retrying a dead token. `/usage` forces a refresh past the cooldown.
