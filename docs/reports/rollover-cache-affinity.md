# Rollover cache-affinity repair

## Finding

The rollover path correctly rotates the logical session identity, but prompt
cache affinity must not be derived from that rotating value. The production
receipt that motivated this repair showed a Codex successor request with
18,975 input tokens and zero cached tokens, followed by 25,112 input tokens and
18,816 cached tokens. Its prompt_cache_key changed from the old session UUID
to the successor UUID. The existing receipt logger truncated the instruction
preview, and the two full lengths differed by five characters, so it did not prove
serialized-prefix equality or explain the first miss by itself.

## Repair

SessionIdentity now owns a stable promptCacheKey alongside the mutable logical
session ID. replace() keeps that key by default, while a newly created
independent session gets its own key. The turn workflow passes the stable key
to AgentConfiguration, so Codex HTTP/WebSocket and OpenAI/Grok Responses
requests can retain provider cache affinity without reusing conversation/history
identifiers. Grok sends the stable key as x-grok-conv-id and keeps the current
logical ID in x-grok-session-id; nested provider-history scopes take precedence
so nested runs retain distinct header scopes. Term2 currently implements no
separate OpenCode cache-affinity header. Its x-opencode-session behavior is
unchanged: the captured wrapper override may remain stable, while reconstruction
under a successor session derives a new value. The backend meaning of this
header is not independently established here; retaining it deliberately across
rollover is deferred rather than risking reuse of server-side conversation state.

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
- Initial worker changed/full gates failed in five approval cases under the
  inherited nested TMPDIR. Full-suite test duration was 146.59 seconds.
- Parent full isolated gate with `TMPDIR=/tmp pnpm test`: **628 files passed,
  8,456 tests passed, 3 expected failures, 3 skipped**, exit 0. Test duration
  **236.41 seconds**, total shell elapsed **239.073 seconds**. The five failures
  disappear with the existing local TMPDIR workaround; no production fix for
  those tests was made.
- Parent related gate covering all nine changed production files: **203 files
  passed, 3,386 tests passed, 3 expected failures, 2 skipped**, exit 0. Test
  duration **159.21 seconds**, total shell elapsed **170.484 seconds**.
- Parent independently reran the 131 focused tests and typecheck successfully.
- A final test-only follow-up checks that instruction changes beyond the old
  preview and tool-schema changes alter their respective hashes, while changing
  routing keys alone does not. Its focused and `TMPDIR=/tmp pnpm test:changed`
  runs both passed **54 tests**; typecheck passed again. Full-suite counts above
  precede this one additional test; no production code changed after that gate.

The motivating provider receipt was observational evidence; no live provider
cache hit-rate claim is made by this patch. The black-box gate validates the
provider lifecycle and request-shape contracts, not provider-side cache
acceptance.

## Reading future evidence

In a request artifact, compare `sent.requestFingerprint` components between the
last predecessor and first successor requests. `sent.promptCacheKey` is the
root context affinity, not necessarily the actual nested or provider-specific
wire key: inspect `sent.body.prompt_cache_key` and the recorded routing headers
alongside `sent.providerHistoryKey`. Join the same artifact's received usage
using its request ID. Compare the model/account route as well. Prefix parts
contain system/developer components, not the full user transcript or a
provider-tokenized prefix; equal hashes are not proof of cache eligibility.

A stable key plus changed instruction/tool hashes points toward reconstruction
as a remaining cause. Stable components and routing with zero cached tokens
leave backend placement, retention, admission, and unmeasured request details
open. No controlled live comparison has yet isolated these variables. The key
is runtime-owned and retained across live rollover, not persisted as a durable
resume identity across process restart.

## Prevention

The defect was possible because logical session identity also served as cache
affinity. Existing configuration tests asserted that mapping and did not cover
rollover. A separate runtime-owned field and a real session rollover test now
protect their different lifetimes; fingerprint tests protect the observability
needed to challenge the cache-routing hypothesis rather than cement it as fact.
