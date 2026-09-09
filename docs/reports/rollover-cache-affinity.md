# Rollover cache-affinity repair

Latest live result (2026-09-09): two successive rollovers per provider on
built `19ecb61b` did **not** establish a repeatable fix. The first successor
hit cache on both Codex and OpenCode; the second Codex successor reported
zero cached tokens, and OpenCode omitted the cached-token field. See the
repeat measurement below.

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

## Live Herdr repeat: 2026-09-09, built `19ecb61b`

Real interactive Term2 panes `w18:p7` (Codex/gpt-5.6-luna, high) and
`w18:p8` (opencode/deepseek-v4-flash, high) each performed two text warmup
turns, a real session_rollover, a successor response, a follow-up, and a
second real session_rollover. Anchored assistant markers C1_AFTER/C2_AFTER
and O1_AFTER/O2_AFTER confirmed completion, rather than terminal echo.
No settings changed. The code adds stable Codex handshake affinity and
transport-retention support; this build still opened a new socket at each
measured rollover. OpenCode routing behavior was unchanged.

Artifact root: `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-09/`.
Cached counts are provider-reported; absent is not converted to zero.

| Provider/request | Artifact | Input | Cached |
| --- | --- | ---: | ---: |
| Codex initial | `00-25-08_f1f25/00-25-24.769Z_a2187.json` | 17356 | 0 |
| Codex warm | `00-25-08_f1f25/00-25-50.454Z_52bce.json` | 17401 | 17152 |
| Codex rollover 1 trigger | `00-25-08_f1f25/00-26-11.834Z_c47a3.json` | 17494 | 17152 |
| Codex successor 1 first | `00-26-15_ca57a/00-26-15.664Z_5931f.json` | 17621 | **17152** |
| Codex successor 1 follow-up | `00-26-15_ca57a/00-28-37.061Z_1adbb.json` | 17672 | 17152 |
| Codex rollover 2 trigger | `00-26-15_ca57a/00-28-52.127Z_bb88a.json` | 17734 | 17152 |
| Codex successor 2 first | `00-28-54_5f53d/00-28-54.777Z_4b1ce.json` | 17582 | **0** |
| Codex successor 2 follow-up | `00-28-54_5f53d/00-29-43.307Z_e0b72.json` | 17627 | 17152 |
| OpenCode initial | `00-25-18_4dce0/00-25-32.688Z_f4cf9.json` | 18200 | absent |
| OpenCode warm | `00-25-18_4dce0/00-25-50.482Z_cfe39.json` | 18243 | 18176 |
| OpenCode rollover 1 trigger | `00-25-18_4dce0/00-26-11.848Z_dabf7.json` | 18360 | 18176 |
| OpenCode successor 1 first | `00-26-22_9dff3/00-26-22.282Z_34bdc.json` | 18477 | **17920** |
| OpenCode successor 1 follow-up | `00-26-22_9dff3/00-28-37.094Z_3b592.json` | 18503 | 18432 |
| OpenCode rollover 2 trigger | `00-26-22_9dff3/00-28-52.148Z_603bc.json` | 18606 | 18432 |
| OpenCode successor 2 first | `00-28-54_93ef6/00-28-54.592Z_0edc6.json` | 18361 | **absent** |
| OpenCode successor 2 follow-up | `00-28-54_93ef6/00-33-32.195Z_79881.json` | 18700 | 18432 |

Codex logical sessions rotated from `f1f25ddb-2703-4814-ab4e-abcdc34f57f3`
to `ca57afdc-f6bf-433a-8187-3e2f78cdeb79`, then
`5f53d483-dce5-4745-88dd-36ba04610d35`. Wire prompt_cache_key and
session-id stayed equal to the initial UUID. Each first successor omitted
previous_response_id; follow-ups used only the successor response. Connection
IDs were respectively `ebc96ae3-4f5c-4746-bfa5-d49f8ea6bf2b`,
`c0cd460c-76af-4ff2-b88e-c0746d16fc5f`, and
`f1bdd7d8-5a47-45ba-8445-a925f3463147`, with reused=false on the first
request of each logical session. Full-prefix SHA-256 stayed
`1b28b1d17f9e0f53f4cedf5b2b2dd5e1c2abd14d144f4053a68cfaa10c5a0aac`;
developer input[1] was 61685 bytes, hash
`2f4a0c18853fad70879eb19fd0ab769f941f7f2a59228d22b19f2bafda6eeacc`.
The eight-tool hash stayed
`42d5232f565c943ed2d6d20cfab049c575a9a49b650aa189d80a605a4e1d4be9`.
Chained delta fingerprints are excluded from this equality comparison.

OpenCode logical sessions rotated from `4dce0398-652b-4345-9a18-7b9df5634e6c`
to `9dff3005-342a-42e0-83b3-9241f4b6097c`, then
`93ef65ce-725d-490a-b8ff-64d56a9e8713`. x-opencode-session rotated from
`ses_000000000000aCcqMcqcu80QcW` to `ses_000000000000O8SmKieiyi6eEq`
to `ses_000000000000K620mi84gK0Uc4`. Full-prefix hash stayed
`a331dce47cfd989e1543b29c957dd05d81401286beb906215ca27691a2260dee`;
system component was 56822 bytes, hash
`d2cbe3b7b4dc1b20c9408515419cef5babdb03f732954fd81bd86588b1bacdfe`.
Eight-tool hash stayed
`0fea323a95ff44861c1de9065950240e1763ff5fa247c18e4e5068ea17eedd46`.

These samples prove cache reuse is possible on a first successor for both
selected providers, but not repeatable success of this repair. Stable Codex
body and handshake affinity did not suffice in the second sample. OpenCode
supplied no hit count for its second sample; its changed header is an observed
variable, not a demonstrated cause. No guarantee about backend admission or
cache retention follows from unchanged measured prefix components.
