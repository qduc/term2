# Provider-faithful reasoning round-trip on the chat-completions lane

Status: **planned, not implemented.** Nobody is on it.

## Resume here

The rule this plan implements: **send back to a provider whatever that provider
sent us**, rather than translating it into one blessed spelling.

That rule is not new to this codebase. It is already the contract on the
Responses lane, named `provider_opaque`, and it is already enforced. What is
missing is its application to the OpenAI-compatible chat-completions lane, which
hand-maps reasoning into `reasoning_content` regardless of what arrived.

Decisions already taken, so they are not re-litigated:

- **The mechanism is the existing `provider_opaque` lane, not a new one.** It is
  defined on three contracts that already agree with each other:
  `StreamedModelTurnOutput` (`contracts/streamed-model-turn.ts:127`),
  `ProviderInputItem.providerOpaque` (`contracts/provider-input.ts:28`), and the
  persisted `ProviderOpaqueItem` (`contracts/conversation-items.ts:42`).
  Persistence already round-trips it, re-marking `providerOpaque: { provider }`
  on replay (`conversation-turn-items.ts:100`).
- **Provider tagging and hard refusal are part of the rule, not an optional
  extra.** The Responses, Codex, and AI SDK adapters each throw when an opaque
  item from another provider reaches them ("opaque items are only valid on the
  provider that produced them"). Any chat-completions implementation matches
  that, or a model switch mid-conversation splices deepseek's fields into an
  OpenRouter request.
- **Scope is assistant-message continuation metadata, not the literal frame.**
  `id`, `created`, `object`, `model`, `usage`, `logprobs`, and `choices[].index`
  are response-only and invalid on a request. "Whatever they sent" means the
  fields that carry turn-to-turn continuity.

Premises that were tested and disproved — do not rebuild the plan on them:

- **"The middleware normalization is defensive; some provider rejects
  `reasoning`."** It is not. `preserveReasoningContentForOpenAICompatibleMessages`
  (`providers/openai-compatible-middleware.ts:8`) arrived in `40ab34ad` and
  `400e1919` as a plain "convert `reasoning` to `reasoning_content`" feature,
  with no recorded provider that refused the other spelling. It encodes the
  assumption, true at the time, that deepseek was the only reasoning provider.
- **"The middleware currently governs this lane's output."** It does not bite
  today, because `OpenAIChatCompletionsModel` never emits `message.reasoning` —
  it always writes `reasoning_content`, so the rewrite is a no-op here. It bites
  the moment the adapter starts echoing the original spelling, and it silently
  reverted a first attempt at this change. Narrowing it is therefore step one,
  not cleanup.
- **"`reasoning_details` is unhandled reasoning we should be reading."** Reading
  it as reasoning text would double every token, because for the models measured
  it repeats `delta.reasoning` verbatim. It round-trips as opaque continuation
  metadata; it is not a second reasoning source.

## Why this is worth doing

Not hypothetical. `ffa9ca2b` fixed the adapter to capture reasoning from
`delta.reasoning`, which is how `mimo-v2.5-pro`, `mimo-v2.5`, and `hy3` stream
it. We now capture that reasoning and send it back as `reasoning_content` — a
field those OpenRouter-style gateways do not use. Their reasoning continuity
across turns is therefore dropped on the floor today, silently, and the fix that
started capturing the reasoning is what exposed it.

## What was measured

`docs/opencode-chat-completions-wire-shapes.md` records a live survey of all 15
opencode models that route to chat completions (11 reachable; 4 fail upstream).
The findings this plan depends on:

- Two families. `reasoning_content`: kimi-k2.x, glm-5.x, deepseek-v4-\*.
  `reasoning` + `reasoning_details`: mimo-v2.5-pro, mimo-v2.5, hy3.
- `reasoning_details` entries observed were uniformly
  `{ type: "reasoning.text", text, format: "unknown", index }` — plain text, no
  signature, no encrypted payload.

That last point bounds today's severity: for these specific models the round-trip
recovers little beyond the text itself. It does **not** bound tomorrow's. A
`reasoning.encrypted` or signature-bearing entry is unrecoverable from
`delta.reasoning`, and the whole point of the rule is to stop guessing which
fields matter.

## Field taxonomy

The taxonomy is the deliverable most likely to be got wrong, so it is fixed
here rather than decided per call site.

| Class | Fields | Treatment |
| --- | --- | --- |
| Modeled | `content`, `tool_calls`, `finish_reason` | Parsed as today. Unchanged. |
| Continuity metadata | the reasoning field as spelled by the provider (`reasoning_content` or `reasoning`), `reasoning_details`, and any future sibling | Captured verbatim, tagged with the provider, replayed verbatim on the assistant message. |
| Response-only | `id`, `object`, `created`, `model`, `usage`, `cost`, `logprobs`, `choices[].index`, `delta.role` | Never replayed. Invalid or meaningless on a request. |

An unrecognized field on `delta` is continuity metadata by default. That is the
rule's whole point: the failure mode we are fixing was an unknown field being
dropped because nobody had enumerated it.

## Design sketch

1. **Capture.** `OpenAIChatCompletionsModel.stream()` accumulates the raw
   continuity-metadata fields exactly as received, keyed by wire name, alongside
   the reasoning text it already accumulates.
2. **Emit.** The completion's reasoning item carries that payload as the opaque
   lane's `provider`-tagged item, rather than today's synthesized
   `{ reasoning_content, openai_compatible_reasoning_content }` metadata.
3. **Persist.** Reuse the existing opaque path. Note that
   `stripReasoningFields` (`conversation-turn-items.ts:130`) deliberately removes
   `reasoning`, `reasoning_content`, and `reasoning_details` from adjacent
   `providerData` to stop the text being emitted twice; the opaque item must
   carry the payload *instead of*, not in addition to, that stripped copy.
4. **Replay.** `openAICompatibleMessages()` splices the payload back onto the
   assistant message verbatim, refusing a payload tagged with a different
   provider, matching `openai-responses-model.ts:113`.
5. **Narrow the middleware.** `preserveReasoningContentForOpenAICompatibleMessages`
   stops rewriting `reasoning` → `reasoning_content` for providers that sent
   `reasoning`. Determine first what still depends on it — the AI SDK OpenRouter
   provider (`ai-sdk-openrouter.provider.ts:56`) passes a `reasoning` field
   through on a different lane, and `mergeAssistantMessages` handles both
   spellings.

## Verification

- Unit coverage per family in `openai-chat-completions-model.test.ts`: a
  `reasoning_content` provider round-trips `reasoning_content`; a `reasoning`
  provider round-trips `reasoning` **and** its `reasoning_details`.
- A cross-provider refusal test: an opaque payload tagged with provider A
  reaching provider B throws, mirroring the Responses-lane tests.
- `provider-contract.test.ts` already has both families wired through the
  registry boundary (`reasoning` and `reasoning-field` scenarios); extend the
  assertions to the replayed wire body rather than adding new scenarios.
- `pnpm test:provider-black-box` is mandatory for this area. Note that
  `provider-session-resilience.blackbox.ts` has a **pre-existing** failure on
  `main` (`openai-http.reasoning preserves response-side reasoning and final
  output`, "no application-owned response traffic was persisted"), confirmed by
  running the suite at HEAD with no changes applied. Do not attribute it to this
  work, and do not treat the suite as green until it is separately resolved.

## Open questions

- **Does narrowing the middleware regress the AI SDK OpenRouter lane?** Unknown;
  that lane produces `message.reasoning` from a different path and may rely on
  the rewrite. Answer before touching the middleware.
- **Should the opaque payload replace or accompany the
  `openai_compatible_reasoning_content` marker?** The marker distinguishes
  native reasoning from generic reasoning that has no chat-completions wire
  form. The opaque payload may subsume it, which would simplify
  `openAICompatibleMessages()`, but that deletion needs its own check against
  the codex converter, which throws on foreign reasoning metadata keys
  (`codex-turn-converter.ts:154`).
- **How far does the rule generalize?** The same argument applies to the
  Anthropic-format and Responses opencode transports, which were not surveyed.
  Out of scope here; worth a follow-up survey before assuming they are clean.
