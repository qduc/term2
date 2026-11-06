# Pure v3 to native conversion

`convertValidatedV3(input, options?)` in `v3-to-native.mjs` consumes the successful
`readV3Conversation` result. Build the actual dependencies with
`node scripts/build.mjs` before importing it. This module performs no
filesystem access, source discovery, publication, CLI invocation, provider call,
or network request. It neither imports the reader nor invokes a runtime.

## Contract

Success is `{ id, entries: [{ at, fact }], fidelity }`, suitable for
`importDirectSession`. Failure is `{ status: 'failed', error: { code } }` with
fixed classifications, never private paths, IDs, contents or raw exceptions.
There is no success `status` field. **Success entries are private conversation
data**, not safe logging metadata. Only `fidelity` is a safe aggregate report:
counts and booleans. Conversion does not mutate the reader result.

A lowercase UUID, optionally prefixed `conv_`, keeps its existing native ID.
Legacy headless IDs of the exact form `non-interactive-<lowercase UUID>` map to a
deterministic UUIDv8 derived from the versioned `term2:v3-headless:v1` namespace
and the complete source ID. They cannot be confused with a bare UUID by simply
stripping the headless prefix. Other historical IDs fail `unsupported-source-id`. Native item, notice and restoration-turn IDs are derived
from it, without clock/randomness. Original canonical ISO envelope timestamps
and `createdAt` are required; noncanonical instants fail `invalid-timestamp`.

`options.fallback` may explicitly supply missing `provider`, `model`, `profileId`
or `workspace`. Existing values win, including invalid values that must fail;
fallback is not an override. When profile ID is absent but appMode is recorded,
the compiled `profileIdFromLegacyMode` selects the profile before fallback is
considered; absent both, only an explicit fallback may supply it. Missing required configuration fails
`missing-configuration`. Workspaces must be absolute local paths. Any recorded
`sshHost` fails `unsupported-remote-identity`, rather than granting local access
for a remote source. No workspace grant or binding is synthesized.

The native profile header uses actual compiled `getProfileMetadata`. Unknown
profiles fail `unsupported-profile`; a conflicting version/digest on the selected
init fails `profile-mismatch`. Unsupported reasoning fails
`unsupported-reasoning`. Explicit `default` is retained as intent and in the
notice, but omitted from native effort fields. Model/provider identifiers are preserved, not guessed
from a catalog. The native `configuration_changed` retains model, reasoning and
temperature; absent reasoning remains default intent, not an invented effort.
The import notice also retains the original JSON-valued appMode/profile/effort/
temperature settings. Header `appVersion: v3-offline-converter/1` identifies this
encoding, **not** a claimed original application version.

## Encoding and fidelity

The authoritative `restoredState.messages` is observed exactly once in visible
source order using regular `transcript_message` facts. Observations have native
user/assistant/system/tool roles: commands are tool observations, subagents and
reasoning are system observations, never fake assistant senders. Native text
includes command/output/status/approval labels and subagent task/tools/final text,
not just hidden metadata. Each observation's `presentation.sourceMessage`
contains only that original message, allowing exact reconstruction of its durable
JSON shape, including sender, humanInputAt, skill, reasoning, usage, approvals and
subagent metadata. Incidental own `undefined` properties added by legacy replay
are omitted, because they cannot originate in persisted JSON. No whole legacy
state, seed or archive is retained. Repeated source IDs and the reserved notice ID
are deterministically remapped only where needed for unique native observation IDs;
generated IDs avoid every original ID and already assigned ID. The original IDs
remain in sourceMessage, including every repetition. `derivedProfileCount` and
`remappedObservationIdentityCount` expose aggregate fidelity information;
`fallbackFieldCount` excludes a profile derived from recorded appMode.

An unambiguous identical direct message event supplies its original envelope
timestamp (`presentation.timestampBasis: source-message-event`). Otherwise `at`
uses the last source envelope timestamp, labelled `import-settlement`, and
`ambiguousMessageTimestamps` increments. This does not pretend settlement time is
the original message time. Source `humanInputAt` survives verbatim in sourceMessage;
snapshot appearances/journal-generated IDs alone are not taken as timing proof.

One explicit `turn_started` with empty input and `display:false` opens a
context-restoration wrapper. Observations correlate to that same wrapper so the
existing same-turn physical payload sharing can operate. Exactly one final
provider context is emitted as hidden `item` facts containing provider-bound
`provider_input` Items, one per actual `normalizeApplicationInput(history)` part.
No portable re-encoding strips signatures, encrypted/opaque items, provider
metadata, raw arguments, reasoning or structured output from that normalized
request. Normalization errors fail `normalization-refused`; native schema/replay
errors fail `native-validation-refused`. The converter also checks actual native
`replay(...).history.map(itemToInput)` against normalization, failing
`native-context-mismatch` rather than accepting recovery facts or changed context.

An explicit interrupted `turn_ended` and a visible import notice explain that the
wrapper is not a historical execution/model request. No historical admissions,
tool starts/finishes, approvals, subagent lifecycles or response completions are
invented. Source `previousResponseId` is deliberately not a native continuation;
the notice explains the continuity break. No history replacement or second copy
of the provider context is emitted. Thus compacted final provider history can
coexist with older visible source messages. Matched journal/snapshot handling,
retry, undo and interrupted settlement remain the reader replay's responsibility;
the converter never reimports assistant snapshots from envelopes.

`fidelity` retains explicit `sourceStartedTurnCount`, accepted-adjunct count,
assistant-snapshot count and user-message count separately.
`sourceNonConsumedUserMessageCount` is a **derived legacy input count**, not an
execution/admission count. `sourceTurnCountAmbiguous` remains true: even a log
with explicit starts can contain older history without admissions. The one
restoration wrapper must not be mistaken for the source historical turn count.
`replayWarningCount` exposes no warning contents; interrupted reader recovery is
preserved as authoritative context/display, not represented as physical effects.

## Accounting and goal

The import notice's presentation durably retains original full `usage` and
`subagentUsage` separately, including fields native Usage cannot represent.
Exactly one native usage observation projects their combined prompt/completion/
cache-read counters. It is explicitly labelled imported combined accounting, not
a root model request. Per-message usage and per-cost usage are **not** added again.

`costRecords` become ordinary `request_cost_recorded` receipts using the same
actual source/native `ModelRequestCost` contract, without repricing. Repeated or
corrected receipts remain in source order; native accounting upserts by physical
requestId rather than billing each receipt again. Their original run ancestry
cannot be reconstructed from these records; the wrapper owns the imported
receipts. A source aggregate already accumulated by replay is not retroactively
corrected here. The original goal is restored by `goal_changed` with
`source: launcher`, describing import ownership, not claiming a historical user
action or self-check.

## Verification boundaries

Use synthetic persisted v3 files through reader, converter, `importDirectSession`,
native `readFactLines`, `replay`, `itemToInput`, public state and `DirectProjection`.
Compare original message durable JSON against observed DTO sourceMessage values,
and actual normalized provider context against native provider input. Check exact
configuration, aggregate usage/costs/goal, refusal shapes, deterministic conversion
and repeated publication bytes. These author controls do not establish live
provider acceptance, workspace authorization or independent acceptance.

Legacy `subagent_tool_started` currently updates activity but does not populate
`restoredState.messages[].tools`; conversion does not resurrect those events as
executions. Tools actually present in a restored subagent message are visible and
retained. The strict reader must admit/validate lifecycle adjuncts for accepted
input references: rejecting `session_turn_started` while admitting
`user_input_accepted` makes lawful accepted-input replay impossible. That reader
boundary is separate from conversion.
