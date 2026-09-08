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

In a request artifact, compare `sent.requestFingerprint` components between a
full-prefix predecessor request and the first successor request. Chained deltas
may omit prefix and tools; do not compare their empty measurements as if they
represented the reconstructed full prompt. `sent.promptCacheKey` is the
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

## Live Herdr test: 2026-09-08

**Result: the code-level repair works, but the observed caching bug still
reproduces. A stable prompt_cache_key alone did not preserve cache hits in this
run.** Socket reuse remains parked; this test made no transport changes.

Built main `7e0bdc4a` successfully with `pnpm build`, then started a fresh real
interactive Term2 session in Herdr tab `w18:t6`, pane `w18:p6`, using
`codex / gpt-5.6-luna`, high effort, WebSocket transport. No settings were
changed. The model performed two text-only warmup turns, exactly one
`session_rollover`, a text-only successor response, and one text-only successor
follow-up. No file reads or edits were requested of the measured session.
Herdr agent prompt rejected the detected idle Term2 agent with agent_not_ready;
input was submitted to the verified interactive pane and receipt was confirmed
by rendered assistant responses and persisted provider artifacts, not echo.

Marker: `ROLLOVER_CACHE_LIVE_20260908_B`.
Predecessor: `871d0588-4d39-409f-9693-558f348ce0d8`.
Successor: `ec476945-2734-4bbb-b234-c1f07b78ae89`.

| Request (UTC) | Input | Cached | Previous response supplied |
| --- | ---: | ---: | --- |
| Initial warmup, 16:35:56.245 | 17,243 | 0 | no |
| Second warmup, 16:36:32.230 | 17,282 | 16,128 | yes |
| Rollover-trigger turn, 16:37:05.651 | 17,419 | 17,152 | yes |
| First successor, 16:37:08.983 | 17,513 | **0** | no |
| Second successor, 16:37:51.070 | 17,566 | 17,152 | yes |

The actual wire prompt_cache_key stayed equal to the predecessor UUID in all
five requests. The session-id header rotated to the successor UUID. Model,
effort, and account were unchanged. The first successor did not reference the
old response chain; the next request referenced the successor response.

The initial predecessor and first successor full-prefix fingerprints matched:

- Developer component `input[1]`: 61,217 UTF-8 bytes; SHA-256
  `40ec1e9bbb3810afbdee3791f9a72cfa1621a8cdb00ca8bd5db6cd5d9cf078e0`.
- Eight tool definitions: measurement 20,390 bytes; SHA-256
  `42d5232f565c943ed2d6d20cfab049c575a9a49b650aa189d80a605a4e1d4be9`.
- Aggregate prefix measurement SHA-256
  `14bf7c09a81d6b3f2a8398894a9ec83fc7be3bd4d90b1c321ab70395157ce20c`.
- This model uses the Responses-lite shape: empty instructions plus
  additional_tools and a developer message in input. Chained requests omit
  those input components; their smaller fingerprints are not prefix drift.

Artifact root: `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-08/`.
Files, in table order:

- `16-35-10_871d0/16-35-56.245Z_e2e06.json`
- `16-35-10_871d0/16-36-32.230Z_1d33d.json`
- `16-35-10_871d0/16-37-05.651Z_f0853.json`
- `16-37-08_ec476/16-37-08.983Z_191cf.json`
- `16-37-08_ec476/16-37-51.070Z_8b893.json`

This single real rollover rules out a changed measured developer/tool component
or changed body cache key as necessary explanations for this instance. It does
not isolate socket replacement, handshake identity, chain loss, backend
placement, or cache policy: those remain confounded. No socket identifier is
logged by this patch, so socket replacement is inferred from the current
rollover disposal path, not independently measured in these artifacts.
The next turn warming again is consistent with a fresh cache domain but does
not prove one. No cross-model/provider generalization or causal cache-hit
improvement claim is supported by this sample.
