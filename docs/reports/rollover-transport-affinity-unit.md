# Codex rollover transport-affinity unit

## Implementation

- Added a typed conversation-reset seam to \`StreamedModelTurn\` and delegated it through \`RetryingModel\`.
- \`AgentClient.rolloverRootContext()\` now retains the owned streamed model and resets only the predecessor's logical Codex history. It keeps the shared compaction-state object intact, so a retained model never points at stale session state.
- Codex WebSocket acquisition now has an explicit stable affinity key and returns a connection ID plus an actual reused/new flag. Root rollover uses \`codex.promptCacheKey\` for the physical handshake/pool key while keeping the current logical/provider-history identity in frame metadata. Nested scopes still fall back to their isolated logical header identity.
- Provider traffic records the bounded connection ID, affinity key, logical history key, and actual reuse result on request settlement. No credentials or prompt contents are added.

## Lifecycle review repair

The bounded review traced the observed rollover miss to a lease-settlement race,
not to an intentional socket retirement. The Codex transport received the
terminal frame but did not release its pool slot until the transport generator
was resumed for its `finally` block. Rollover can be committed after the
application observes that terminal frame and before that resume, so the
successor saw the retained socket as still in flight and opened a new one.
Terminal frames now release the socket before they are yielded. Ambiguous
abort/error paths still release with `keepAlive: false`; the repair does not
claim reuse when the request outcome is unknown.

The root cache reset is also scoped defensively. It visits owned entries only,
finds reset capability through the `RetryingModel` wrapper, refuses an unkeyed
reset, and evicts a cached provider model that exposes no reset seam rather
than silently carrying unknown logical state into the successor. Borrowed
transient entries and their nested siblings are not reset. Existing disposal is
preserved for evicted owned models.

Regression coverage now includes terminal-frame-before-yield pool reuse,
root-successor full-input/no-predecessor followed by successor chaining,
nested-scope chain preservation, unsupported wrapped providers, borrowed
models, and the absent logical-key case.

## Validation

- Baseline before edits: focused existing suite, 3 files / **145 passed**; elapsed **4.276s**.
- Red proof: the new cross-rollover pool test failed before implementation with \`TypeError: pool.acquireWithMetadata is not a function\`.
- Focused final: 4 files / **201 passed**; elapsed **12.439s**.
- Typecheck: **passed**; elapsed included in the final focused run command.
- Related production graph: 202 files / **3,507 passed**, 2 expected failures, 2 skipped; elapsed **79.115s**.
- Codex fake network E2E: 1 file / **15 passed**; elapsed **2.190s**.
- Provider black-box gate: 20 files / **177 passed**, 1 skipped; elapsed **64.611s**.
- Full isolated suite (\`TMPDIR=/tmp pnpm test\`, 900,000ms allowance): 628 files / **8,459 passed**, 3 expected failures, 3 skipped; elapsed **197.571s**.
- Changed-test gate: 202 files / **3,507 passed**, 2 expected failures, 2 skipped; elapsed **135.635s**.
- ESLint: 0 errors and 1 pre-existing \`require-yield\` warning at \`source/providers/codex-responses-model.test.ts:3016\`.
- Prettier check: **passed**.

## Unresolved / scope boundary

Post-review validation: focused transport/lifecycle tests **130 passed** across
5 files; typecheck **passed**; provider black-box **177 passed / 1 skipped**;
`TMPDIR=/tmp pnpm test` **8,464 passed / 3 expected failures / 3 skipped**;
ESLint reported 0 errors and the pre-existing `require-yield` warning in the
Codex model test; Prettier passed. The related and changed selectors each
retained the repository's unrelated environment-sensitive failures in the
file-safety and nested-approval tests (5 failed in each selector run), while
the isolated full suite remained green apart from its documented expected
failures.

No live provider probe was run. These tests prove the actual in-process pool lease/reuse seam, logical-history reset, and recorded reuse metadata; they do not prove provider-side cache admission or cached-token accounting. OpenCode and live proof remain with the parent as requested.
