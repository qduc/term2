# Librarian retrieval benchmark rubric

Score each criterion 0 or 1 from the returned brief. The criterion must be
stated correctly and traced to a memory ID; unsupported guesses do not count.

1. Uses `GET {GROK_BASE_URL}/billing?format=credits` with bearer auth.
2. Warns not to strip `/v1`, not to add an invented client header, and not to
   use `/billing` without `format=credits`.
3. States the `config` nesting, `currentPeriod.end` / `billingPeriodEnd`
   fallback, protobuf `{val}` possibility, and weekly period type.
4. Carries `periodEndMs` and `productUsage` in the public shape.
5. Defines `Credits N%` plus optional deterministic `MM/DD` reset rendering.
6. Missing data renders nothing and never zero; transient failures retain the
   last good reading.
7. Keeps the Grok slot distinct from `lastCodexRateLimit`.
8. Uses process-wide ownership, a shared five-minute cooldown, and busy-to-idle
   refresh with no idle timer.
9. Handles 401/403 as permanently disabled, 429 via retry-after with the local
   cooldown floor, and `/usage` as a forced refresh.
10. Explicitly identifies `grok-credit-polling-prototype` as superseded and
    cites the governing replacement memory IDs.

Secondary metrics: wall time, model calls, total/cached/output tokens, proxy
cost, memory-tool calls inside the librarian, irrelevant-detail count, and
whether the parent actually invoked the librarian.

