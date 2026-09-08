# Rollover cache-affinity repair

## Finding

The rollover path correctly rotates the logical session identity, but prompt
cache affinity must not be derived from that rotating value. The production
receipt that motivated this repair showed a Codex successor request with
18,975 input tokens and zero cached tokens, followed by 25,112 input tokens and
18,816 cached tokens. Its prompt_cache_key changed from the old session UUID
to the successor UUID. The existing receipt logger truncated the instruction
preview, and the two full lengths differed by five bytes, so it did not prove
serialized-prefix equality or explain the first miss by itself.

## Repair

SessionIdentity now owns a stable promptCacheKey alongside the mutable logical
session ID. replace() keeps that key by default, while a newly created
independent session gets its own key. The turn workflow passes the stable key
to AgentConfiguration, so Codex HTTP/WebSocket and OpenAI/Grok Responses
requests can retain provider cache affinity without reusing conversation/history
identifiers. Grok sends the stable key as x-grok-conv-id and keeps the current
logical ID in x-grok-session-id; nested provider-history scopes take precedence
so nested runs remain isolated. OpenCode has no separate cache-affinity header,
so its logical session header continues to rotate rather than incorrectly
reusing server-side history.

No previousResponseId, Codex server-history key, provider-history key, or
ordinary chaining reset behavior was changed for this cache repair.

## Verification telemetry

The shared provider-traffic logging boundary now records versioned,
privacy-safe SHA-256 fingerprints and UTF-8 byte lengths for the unsanitized
instructions/system components, system/developer message components in Chat
Completions and Responses input, and complete tool-definition groups. Ordered
component source labels let two requests be compared without logging their
contents. Request-start and response metadata carry the logical session, stable
cache key, provider-history key, request ID, and the existing usage summary can
therefore be correlated across a rollover. The fingerprint proves
serialized-component equality only; it does not prove provider tokenization,
cache admission, server placement, or cached-token accounting.

## Testing and validation

- Focused rollover, AgentConfiguration, Grok-header, and provider-traffic tests:
  **4 files, 131 passed**.
- TypeScript typecheck: **passed**.
- ESLint on all changed TypeScript files: **passed**.
- Prettier check on all changed files: **passed**.
- Provider black-box gate: **20 files, 177 passed, 1 skipped**.
- pnpm test:changed reached 3,381 passing tests but retained five failures in
  unrelated existing areas (four file-tool approval tests and one nested
  approval acceptance test). The directly related conversation-service and
  session-isolation tests pass when run alone.
- Full isolated suite: **625 files passed, 8,451 tests passed, 3 expected
  failures, 3 skipped**; it retained the same five unrelated failures. The
  run took 146.59 seconds and exited non-zero because of those failures.

The motivating provider receipt was observational evidence; no live provider
cache hit-rate claim is made by this patch. The black-box gate validates the
provider lifecycle and request-shape contracts, not provider-side cache
acceptance.
