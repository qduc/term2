# OpenAI Context Compaction

Status: **Step 1 merged to `main` on 2026-08-06 (`dc949022`)**. The opaque provider-item lane is
implemented and tested; resume at [Step 2](#step-2-opaque-items-survive-persistence-and-replay).
The blocking decision (server-side automatic compaction via `context_management`, not the manual
`/v1/responses/compact` endpoint) remains as resolved on 2026-08-05 — see
[Experiment results](#experiment-results-2026-08-05).

> Renamed from "OpenAI Manual Context Compaction". The manual endpoint was the plan of record until
> the second round of experiments; it is now the documented fallback, not the design.

Scope: `source/providers/openai-responses-model.ts`, `source/providers/openai.provider.ts`,
`source/services/agent-runtime/application-run-loop.ts`, `source/services/conversation/`,
`source/services/session/`, `source/services/settings/settings-schema.ts`.
Related: `decouple-from-openai-agents-sdk.md`, `post-refactor-provider-boundary-audit.md`,
`memory_feature.md`.

## Resume here

Phases 1 and 2 of the originating brief ("map the flow", "verify item fidelity") are **already
done** — the findings are recorded below under [Current flow](#current-flow-phase-1-finding) and
[Item fidelity](#item-fidelity-the-actual-blocker-phase-2-finding). Do not re-map them; that was a
full session of reading.

**Step 1 (opaque provider item lane) is DONE** — merged 2026-08-06 as `dc949022` (feature branch
`opaque-lane`, commit `5155e499`). Start at [Step 2](#step-2-opaque-items-survive-persistence-and-replay).
What Step 1 shipped, so a resumer does not re-derive it:

- `StreamedModelTurnInput`/`StreamedModelTurnOutput` (`source/contracts/streamed-model-turn.ts`)
  both gained a `provider_opaque` variant: `{ type: 'provider_opaque', provider, item }`.
- `ProviderInputItem` (`source/contracts/provider-input.ts`) gained a `providerOpaque?: { provider: string }`
  marker field. Nothing in the tree sets it yet — Step 2's replayed opaque item is the first producer.
- `normalizeInputItem` (`source/services/agent-runtime/application-run-loop.ts`, ~line 1183) checks the
  marker before the `unsupportedInput` throw (which stays as the default) and **strips the internal
  marker from the carried wire item**. The throw message is `Unsupported restored input item type: …`.
- `toResponsesApiInput` (`source/providers/openai-responses-model.ts:82`) splices an `openai`
  `provider_opaque` item verbatim and throws on any other provider's item; `toTurnOutput` (:200)
  returns `provider_opaque` for unknown output types instead of throwing at what was :227.
- `codex-turn-converter.ts` (explicit `case 'provider_opaque'` throw) and
  `ai-sdk-streamed-model.ts` `toPromptMessage` (explicit throw; note the error surfaces as a rejected
  async iteration, not a synchronous throw, because `stream()` is an async generator).
- **No persistence yet.** `normalizeRunItem` (`source/services/conversation/run-item-normalizer.ts:205`)
  still silently drops unknown output kinds, and the run loop's `completion.output` handling is
  filter-based (`if (item.type === 'reasoning')`, `if (item.type !== 'tool_call') continue`) — a
  `provider_opaque` output passes through harmlessly and is not persisted. That seam is Step 2.

Gates run and green for Step 1: `pnpm test` (5217 passed; only the pre-existing flaky
`InputBox` timing test, which passes on isolated rerun), `pnpm test:provider-black-box` (152 passed),
typecheck, prettier, eslint. Unit tests live beside each changed file; the load-bearing negative
test is an opaque item routed to a non-OpenAI provider throwing rather than silently serializing.

Five premises worth not re-deriving:

1. **Term2 does not round-trip opaque OpenAI items today, and cannot.** There are two hard
   throw-sites plus a closed union in the middle. This is the real project. Step 1 is not optional
   preparation, it *is* the work.
2. **Compaction items are already typed in the pinned SDK** (`openai@6.37.0` —
   `ResponseCompactionItem`, `ResponseCompactionItemParam`, and `context_management` on
   `ResponseCreateParams`). No wire reverse-engineering needed; exact shapes are quoted below.
3. **Server-side automatic compaction is the design.** One field on the existing request —
   `context_management: [{ type: 'compaction', compact_threshold }]` — and the server compacts
   inline during the turn. It works only on the `gpt-5.4` family (`gpt-5.1`/`gpt-5.2` return
   HTTP 500), which is fine because `gpt-5.3` and earlier are being dropped. This collapses what
   were Steps 3–5 (a separate API call, a failure-rollback lifecycle, and a stable-boundary trigger
   policy) into a request field plus a history-replacement rule.
4. **Compaction quality is model-dependent, and this is why the support floor matters.** On
   `gpt-5.1` a fact that existed only in a tool result was lost by compaction in 4 of 4 runs. On
   `gpt-5.2` and `gpt-5.4` it survived. The `gpt-5.4`-only support floor removes the problem, but
   the capability gate in Step 3 must stay: Term2 also serves custom and OpenAI-compatible
   providers where this parameter is unsupported.
5. **Steps 1 and 2 are not preparation — they are the implementation.** Auto-compaction's saving is
   only durable if Term2 captures the returned `compaction` items into its own history. Measured: a
   client that re-sends full uncompacted history gets **no saving at all** (3910 tokens vs 3870),
   and Term2 re-sends full history whenever chaining breaks. Without the opaque-item lane, this
   feature silently does nothing on exactly the sessions that need it.

## Goal

Let an OpenAI-backed Term2 session keep a long conversation inside its context budget by opting in
to server-side compaction, capturing the returned `compaction` items, and continuing from them
without losing tool state or conversational continuity.

The compaction item *replaces* the provider-facing context. It is never appended to it, never
summarized into a system message, and never read by Term2.

## Verified API surface

Confirmed by reading `node_modules/openai/resources/responses/responses.d.ts` at the pinned
version (`openai@6.37.0`). Re-verify after any SDK bump.

The design uses `context_management` on the ordinary create call:

```ts
// ResponseCreateParams — the whole of the request-side change
context_management?: Array<{ type: 'compaction'; compact_threshold?: number | null }> | null;
```

When it fires, the response's `output` array contains `compaction` items alongside the normal
message/tool items. Those items are the thing Term2 must capture.

The manual endpoint below is **not** used by this plan. It is documented because it is the
fallback if `context_management` regresses, and because its types define the item shapes that the
auto path also returns.

```ts
client.responses.compact(body: ResponseCompactParams): APIPromise<CompactedResponse>

interface ResponseCompactParams {
  model: string | null;                        // required
  input?: string | ResponseInputItem[] | null;
  instructions?: string | null;
  previous_response_id?: string | null;
  prompt_cache_key?: string | null;
  prompt_cache_retention?: 'in_memory' | '24h' | null;
}

interface CompactedResponse {
  id: string;
  created_at: number;
  object: 'response.compaction';
  output: ResponseOutputItem[];   // "all user messages, followed by a single compaction item"
  usage: ResponseUsage;
}

interface ResponseCompactionItem {        // output form
  id: string;
  type: 'compaction';
  encrypted_content: string;
  created_by?: string;
}

interface ResponseCompactionItemParam {   // input form — what we send back
  type: 'compaction';
  encrypted_content: string;
  id?: string | null;
}
```

`ResponseCompactionItem` is a member of `ResponseOutputItem`; `ResponseCompactionItemParam` is a
member of `ResponseInputItem`. So a compaction item is a legal input item — the returned array can
be fed straight back as `input` on the next `responses.create`.

Facts that shape the design:

- **Chaining differs between the two paths.** On the **auto** path the response is an ordinary
  `Response`, so `previous_response_id` keeps working and `ProviderContinuity` needs no reset. On
  the **manual** fallback path the `CompactedResponse` id is *not* chainable — verified,
  `400 previous_response_not_found` — so that path would additionally require a continuity reset.
  This asymmetry is a large part of why the auto path is simpler.
- Whatever produced it, a compaction item folds assistant messages, reasoning, tool calls and tool
  results into an encrypted blob. Anything Term2 derives from *its own* history (rewind targets,
  `/undo`, file-mutation previews) degrades accordingly. See
  [Collateral on history-derived features](#collateral-on-history-derived-features).
- The set of items preserved verbatim alongside the blob varies by model and by path — the manual
  path returned 3 items on `gpt-5.1` and 6 on `gpt-5.4`. Never assume a fixed count, a fixed
  ordering, or that only user roles appear.
- `encrypted_content` is opaque and potentially large (~4k chars observed). It must never reach a
  log, a subagent, the memory librarian, or the approval reviewer's context projection.

## Current flow (Phase 1 finding)

```text
user input
  → ConversationStore.addUserTurn()                    conversation-store.ts:63
  → SessionInputPlanner.build()                        session-input-planner.ts
      chooses delta vs full history from
      ProviderDefinition.capabilities.supportsConversationChaining (registry.ts:48)
      + ProviderContinuity.previousResponseId          provider-continuity.ts:67
  → ApplicationRunLoop
      normalizeApplicationInput()                      application-run-loop.ts:982
      ProviderInputItem[] → StreamedModelTurnInput[]   (closed union, streamed-model-turn.ts:88)
  → OpenAIResponsesModel*.stream()                     openai-responses-model.ts:421
      requestBody() → toResponsesApiInput()            openai-responses-model.ts:133 / :82
  → stream events → normalizeResponseEvent()           openai-responses-model.ts:273
  → completion → toTurnOutput()                        openai-responses-model.ts:200
      usage → normalizeUsage()                         openai-responses-model.ts:167
  → tool loop (approval, execution, results appended)
  → TurnItemAccumulator → run-item-normalizer          conversation/run-item-normalizer.ts
  → ConversationStore.appendOutput() / replaceHistory() conversation-store.ts:134 / :145
  → ProviderContinuity.record(responseId)              provider-continuity.ts:140
  → JSONL event log (assistant_turn, v3 state)         logging/conversation-log-events.ts:206
```

**What Term2 saves and resends:** `ConversationStore` holds `ProviderInputItem[]`
(`contracts/provider-input.ts:9`) — an open, index-signature record, *not* raw OpenAI items. The
wire array is rebuilt from it on every request by `normalizeApplicationInput` →
`toResponsesApiInput`. Durable state is the JSONL event journal replayed by
`conversation-replay.ts`, plus `exportState`/`importState` (`session-manager.ts:122`/`:130`)
validated by `ImportedConversationStateSchema` (`conversation-state-schema.ts:20`), whose
`history: z.array(z.unknown())` with `.passthrough()` is already permissive enough.

UI messages are separate React state fed by conversation events
(`hooks/use-conversation-messages.ts:28`), **not** projected from `ConversationStore`. Replacing
provider history therefore does not erase the visible transcript. This is what makes compaction
tolerable UX-wise.

## Item fidelity: the actual blocker (Phase 2 finding)

Term2 preserves OpenAI's *semantics* but not its *items*. Assistant output is normalized to four
canonical kinds — `tool_call`, `tool_result`, `assistant_text`, `reasoning` — and re-projected back
to wire shape on the next request (`conversation/conversation-turn-items.ts:44`,
`run-item-normalizer.ts`). Reasoning survives only because `encrypted_content` is carried through
`providerData` by hand (`openai-responses-model.ts:100-110`, `:191-198`).

Anything else is rejected, at three places:

| # | Site | Behaviour |
| --- | --- | --- |
| 1 | `normalizeInputItem`, `application-run-loop.ts:1156` | `unsupportedInput(\`item type: ${type}\`)` — **throws** for any type that is not `function_call`, `function_call_result`/`function_call_output`, `reasoning`, or `message` |
| 2 | `StreamedModelTurnInput`, `contracts/streamed-model-turn.ts:88` | closed 6-member union; there is no variant an opaque item could inhabit |
| 3 | `toTurnOutput`, `openai-responses-model.ts:227` | `throw new Error('Unsupported OpenAI Responses output item: …')` for anything but `function_call` / `message` / `reasoning` |

`toResponsesApiInput` has a `return item;` passthrough at `:111`, but it is unreachable for unknown
types because chokepoint 1 throws upstream.

**Verdict:** a `{ type: 'compaction', encrypted_content }` item cannot enter, traverse, or leave the
run loop today. The brief's contingency — "if Term2 converts everything into generic
`{role, content}`, introduce provider-owned conversation state" — is triggered, but the fix is
narrower than a separate provider-owned state store. `ProviderInputItem` is *already* open and
`ConversationStore` is *already* provider-facing; only the two typed chokepoints in between need an
opaque lane. Do not build a parallel OpenAI-owned conversation store. See
[Rejected alternatives](#rejected-alternatives).

## Experiment results (2026-08-05)

Run live against the real API with `openai@6.37.0`. Fixture: an 8-item conversation (~3.5k input
tokens) carrying two planted facts — a **conversational** one stated by the user (project codename
`Marmalade`) and a **tool-derived** one that appeared only inside a `function_call_output` (build id
`88213`). Both are recalled correctly from the uncompacted conversation, which is the control.

Read in two rounds. **Round 1** ran against a support floor that still included `gpt-5.1`, and
rejected auto-compaction because it 500s there. **Round 2** re-ran it after the decision to drop
`gpt-5.3` and earlier, and reversed that conclusion. Round 1 is kept because it is the evidence for
the `gpt-5.4` floor being load-bearing rather than incidental.

### Round 1 — auto-compaction across models

`context_management: [{ type: 'compaction', compact_threshold: 2000 }]`, input over threshold:

| Model | Result |
| --- | --- |
| `gpt-5.1` | **HTTP 500** `server_error` |
| `gpt-5.2` | **HTTP 500** `server_error` |
| `gpt-5.4` | OK — `output: [compaction, message, compaction]` |
| `gpt-5.4-mini` | OK — `output: [compaction, message, compaction]` |
| `gpt-5.1-codex` | 404, model not on this key |

Isolation matrix confirming the 500 is compaction firing and not our request body — same
conversation, `gpt-5.1`:

| Variant | Result |
| --- | --- |
| long input, **no** `context_management` | OK, `input_tokens=3528` |
| long input + `context_management`, threshold 2000 (**over**) | 500 |
| long input + `context_management`, threshold 100000 (**under**) | OK, `input_tokens=3528` |
| short input + `context_management`, threshold 2000 (**under**) | OK |
| over-threshold, with/without tools, with/without `reasoning` | 500 in all combinations |

So the parameter is *accepted* everywhere and *works* only on `gpt-5.4`. It also fails as an opaque
`500 server_error` rather than a clean 400 capability error — there is nothing to feature-detect on
and nothing safe to retry.

**Round 1 verdict (superseded):** not viable, because `gpt-5.1` was the support floor. With the
floor moved to `gpt-5.4` the first disqualifier disappears and the second becomes a reason to gate
on a capability flag rather than a reason to avoid the feature.

### Round 1 — manual `/v1/responses/compact` (now the fallback)

Works on every model tested, including the ones where auto-compaction 500s:

| Model | `output` shape | `encrypted_content` |
| --- | --- | --- |
| `gpt-5.1` | `[message ×3, compaction]` | 1,700 chars |
| `gpt-5.2` | `[message ×3, compaction]` | 4,516 chars |
| `gpt-5.4` | `[message ×6, compaction]` | 2,060 chars |
| `gpt-5.4-mini` | `[message ×6, compaction]` | 1,848 chars |

Answers to the three questions the plan posed:

- **(a) Compaction item present?** Yes. Exactly one, always last, shape
  `{ id, type: 'compaction', encrypted_content }` — matching `ResponseCompactionItem` with
  `created_by` absent. The preserved messages are prior turns reproduced **verbatim**, not
  rewritten. `gpt-5.1`/`gpt-5.2` preserved the 3 user messages; `gpt-5.4` preserved all 6 user *and*
  assistant messages. So the SDK's "all user messages" is a floor, not an exact contract — never
  assume a fixed count or that only user roles appear.
- **(b) Chain continues?** **Not via `previous_response_id`.** Passing `compacted.id` there returns
  `400 previous_response_not_found`. The plan's assumption is now a verified fact: compaction breaks
  the response chain, `ProviderContinuity.reset()` in Step 4 is required, and the next request must
  send `[...compacted.output, newInput]` as full input. That path works, including with Term2's real
  request shape (`instructions` + `tools` + `include: ['reasoning.encrypted_content']`).
- **(c) Token accounting?** `CompactedResponse.usage.input_tokens` reports the **compaction pass**
  (~3.5k, i.e. the pre-compaction size), not the resulting context. Actual saving shows up on the
  *next* request: `3562 → 1884` input tokens on `gpt-5.1` (47% smaller), `3539 → 2217` on `gpt-5.2`
  (37%), `3542 → 2021` on `gpt-5.4` (43%). Step 7's `inputTokensAfter` therefore genuinely cannot be
  filled from the compact call — that caveat stands.

Also confirmed: **repeat compaction works.** Feeding `[...compacted.output, question]` back into
`responses.compact` is accepted, producing a fresh `[message ×N, compaction]`. Test 7 of the matrix
has a green path.

### Round 1 — fact survival across models

Asked to recall both planted facts from compacted context, tools withheld so the model must answer
from memory:

| Model | Conversational fact | Tool-derived fact |
| --- | --- | --- |
| `gpt-5.1` | survived | **lost** — answered `UNKNOWN`, 4 of 4 runs |
| `gpt-5.2` | survived | survived |
| `gpt-5.4` | survived | survived |

The conversational fact survives trivially: it lives in a preserved user message. The tool-derived
fact only ever existed in a `function_call_output`, which is folded into the encrypted blob — and on
`gpt-5.1` it did not come back out. This tracks the `encrypted_content` sizes above: `gpt-5.1`
produced by far the most aggressive summary.

Two consequences, both of which survived into the final design:

1. **Gate compaction on model** (Step 3). Independently necessary anyway, since `context_management`
   500s on the same models whose compaction quality is poor.
2. **A compacted agent re-runs tools.** With tools available, the continuation did not answer at all
   — it emitted a fresh `function_call` to `get_build_info` to re-derive the lost value. For a
   read-only tool that is merely a wasted call. For Term2, whose tools run shell commands and mutate
   files, **compaction can cause a side-effecting tool to execute a second time.** See
   [Risks](#risks).

### Round 2 — auto-compaction on `gpt-5.4`

Same fixture, `context_management: [{ type: 'compaction', compact_threshold: 2000 }]`.

**Output shape.** When compaction fires, `response.output` is `[compaction, message, compaction]` —
a compaction item before the assistant's reply and another after it, sizes ~4.0k and ~4.3k chars of
`encrypted_content`. Normal message and tool items are unaffected and still present.

**Facts survive, including tool-derived ones.** Chained follow-up with tools withheld answered
`Marmalade, 88213` — both the conversational and the tool-derived fact. This is the `gpt-5.1`
failure mode not reproducing on `gpt-5.4`, consistent with Round 1's fact-survival table.

**Server-held state is *not* compacted.** `responses.inputItems.list(r1.id)` returns all 9 original
items verbatim. Compaction applies to the model's working context and is surfaced to the client via
the output items; it does not rewrite what the server stores for that response.

**Where the saving comes from — the finding that makes Steps 1–2 mandatory:**

| Continuation strategy | `input_tokens` | Saving |
| --- | --- | --- |
| chained via `previous_response_id` | 2322 | ~40% |
| client re-sends full uncompacted history | 3910 | **none** |
| client keeps the returned compaction item | 2340 | ~40% |

Term2 falls into the middle row whenever the chain breaks — session resume, provider error,
`ProviderContinuity` invalidation. Capturing the compaction item is what makes the saving durable.

**Retention rule.** All four candidate rules work and all preserve both facts:

| What the client keeps | `input_tokens` |
| --- | --- |
| last compaction item only | 2055 |
| first compaction item only | 2035 |
| the whole returned triple | 2055 |
| original user messages + last compaction item | 2055 |

The triple costs the same as the last item alone, which means **the server treats the last
compaction item as the context and ignores everything before it.** The arithmetic makes this hard to
read any other way: the triple is `first_compaction + message + last_compaction`, and if the leading
items were counted it would cost ~4,000 tokens rather than the 2,055 measured. The same holds for
the fourth row, where one of the re-sent user messages is a ~1,200-token filler dump that visibly
does not appear in the bill.

Two consequences:

1. **The retention rule is the simple one.** Replace local provider history with the last compaction
   item. "Replace, never append" survives intact from the original brief — now a measured property
   rather than a stipulation.
2. **Items kept *before* the compaction item appear to be free.** If that holds, Term2 can retain
   its own user-turn items ahead of the compaction item purely to keep `/undo`, `/rewind` and
   `getLastUserMessage` working, at no wire cost — see
   [Collateral](#collateral-on-history-derived-features). Treat this as a promising hypothesis with
   one supporting measurement, not a settled fact: verify it deliberately in Step 4 across a couple
   of history sizes before designing around it, because a wrong reading here means silently paying
   for the whole transcript on every turn.

**Cost.** Compaction is billed as output/reasoning tokens on the turn where it fires:

| `compact_threshold` | Fired | `input_tokens` | `output_tokens` | of which reasoning |
| --- | --- | --- | --- | --- |
| 2,000 | yes | 3754 | 629 | 624 |
| 1,000,000 | no | 3539 | 5 | 0 |

~600 extra output tokens per fire. Output tokens cost several times what input tokens do, so a
threshold set too low can cost more than it saves by firing on every turn. This is the main
argument for a conservative default in Step 6, and it is a consideration the manual path did not
have in this form.

### Round 3 — `gpt-5.6-luna`, and the free-prefix hypothesis under control (2026-08-06)

Run against the live API on `gpt-5.6-luna`, a model added after Rounds 1–2. Fixture ~1.16k input
tokens (smaller than Rounds 1–2's ~3.5k), same two planted facts. 14 API calls total.

**Compaction is supported.** `context_management` is accepted and fires:

| Variant | Result |
| --- | --- |
| long input, no `context_management` (control) | OK — `input_tokens=1163`, `output: [reasoning, message]` |
| `compact_threshold: 500` | **400 `integer_below_min_value`** — *"Expected a value >= 1000"* |
| `compact_threshold: 1000` (the minimum) | OK, **fired** — `output: [compaction, reasoning, message]`, `input_tokens=1605` |
| `compact_threshold: 1000000` | OK, did not fire — `input_tokens=1163` |

Three findings here are new and none of them appear in the `gpt-5.4` data above:

1. **There is a hard server minimum of `compact_threshold >= 1000`**, enforced as a clean typed 400.
   Step 6's setting needs a validated floor, not merely "positive int".
2. **The failure surface is not uniform.** Rounds 1–2 saw unsupported models fail as opaque
   `500 server_error`. An *invalid parameter value* fails as a typed `400`. These need different
   handling — see Step 3 — and a "500 ⇒ unsupported" check does not see the 400 at all.
3. **Output shape differs again**: one compaction item, positioned **first**, versus `gpt-5.4`'s two
   items bookending the message. "Retain the last compaction item" still resolves correctly (last =
   only). This is the third distinct shape across three models; treat the caveat against assuming a
   fixed count or position as settled.

**Fact survival: both facts, 3 of 3 runs**, tools withheld — including the tool-derived one that
existed only inside a `function_call_output` and that `gpt-5.1` lost. `gpt-5.6-luna` tracks the
`gpt-5.2`/`gpt-5.4` pattern, not `gpt-5.1`'s.

**Free-prefix hypothesis: CONFIRMED, with the control Round 2 lacked.**

Round 2 inferred the prefix was free from flat token counts across prefix sizes. Flat counts alone
cannot distinguish "the server ignores the prefix" from "the prefix never reached the wire" — a
harness bug produces identical numbers. Round 3 added the missing control:

| Call | Body bytes | `input_tokens` |
| --- | --- | --- |
| `[question]` alone — true baseline | 314 | 68 |
| `[large_filler, question]`, **no compaction item** | 8,587 | **1,434** |

The filler bills at **+1,366 tokens** when nothing precedes it, so it is genuinely transmitted and
genuinely large. With a compaction item in front of it:

| Variant | Body bytes | `input_tokens` |
| --- | --- | --- |
| empty prefix | 3,977 | 828 |
| small prefix | 4,081 | 828 |
| large prefix (1,081 words / 1,366 tokens) | **12,250** | 828 |

Request bodies vary by more than 8 KB while `input_tokens` does not move. The prefix reaches the
server and is billed as if absent. Reproduced at a different absolute value (774 in the first run,
828 here) with an independent compaction item; the flatness is what reproduced.

**Consequence for Step 4:** retain `[...userTurnItems, last compaction item]`. `/undo`, `/rewind`
and `getLastUserMessage` keep working at no measured wire cost.

**Trust boundary.** One model, one fixture, one day. The billing behaviour this rests on is a server
property that could change without notice, and no unit test can catch a regression in it — it is
visible only in token accounting. Re-run this control when adding a model or on any unexplained cost
increase.

### Reproducing

Probe scripts are in this session's scratchpad, not the repo — they hit the live API and cost money,
so they are deliberately not committed. Re-create from the tables above if needed: the shape is one
`responses.create` control, one `responses.compact`, then one `responses.create` from
`[...compacted.output, question]` with tools withheld.

## Implementation steps

Each step is independently landable and independently testable. Work each in its own worktree per
`AGENTS.md` (`git worktree add .worktrees/<slug> -b <slug>`).

### Step 1: opaque provider item passthrough

**Status: DONE — merged 2026-08-06 (`dc949022`).** This was the one architecturally significant
change; everything else is contained. Implemented exactly as specced below, with three notes for
the record: the internal `providerOpaque` marker is stripped from the wire item in
`normalizeInputItem` (so `item.item` is clean when it reaches `toResponsesApiInput`); the ai-sdk
rejection surfaces as a rejected async iteration, not a synchronous throw; and the negative
test (an OpenAI opaque item routed to a non-OpenAI provider throws) is the one that pins the
contract. Gates passed: `pnpm test` + `pnpm test:provider-black-box` (152).

> The line numbers in the original spec below have drifted since 2026-08-05; current anchors:
> `normalizeInputItem` is at `application-run-loop.ts:1183`, `toResponsesApiInput` at
> `openai-responses-model.ts:82`, `toTurnOutput` at `openai-responses-model.ts:200`. The
> `unsupportedInput` message is `Unsupported restored input item type: …`.


Add a passthrough variant to the application's input union so provider-native items Term2 does not
model can cross the run loop untouched:

```ts
// contracts/streamed-model-turn.ts
| { readonly type: 'provider_opaque'; readonly provider: string; readonly item: Readonly<Record<string, unknown>> }
```

- `contracts/streamed-model-turn.ts:88` — add the variant to `StreamedModelTurnInput`, and the
  matching variant to `StreamedModelTurnOutput` (needed for Step 3's return path).
- `application-run-loop.ts:1125` `normalizeInputItem` — before the `unsupportedInput` throw at
  `:1156`, recognise items carrying an opaque marker and emit `provider_opaque`. Keep the throw as
  the default: unknown-and-unmarked must still fail loudly. The marker should live on
  `ProviderInputItem` (e.g. a `providerOpaque: { provider: string }` field set only by the adapter
  that produced the item) rather than an allowlist of type strings, so the run loop stays free of
  OpenAI vocabulary.
- `openai-responses-model.ts:82` `toResponsesApiInput` — emit `item.item` verbatim for
  `provider_opaque` when `provider === 'openai'`; **throw** when the provider does not match. A
  Codex or Anthropic opaque item must never be spliced into an OpenAI request.
- `openai-responses-model.ts:200` `toTurnOutput` — instead of throwing at `:227`, return
  `{ type: 'provider_opaque', provider: 'openai', item }`. This is a behaviour change beyond
  compaction: it makes the adapter forward-compatible with any future Responses item type.
- Every other `StreamedModelTurnInput` consumer must reject `provider_opaque` explicitly rather than
  fall through: `codex-turn-converter.ts:17` (already has `assertNever` at `:48` — it will fail to
  compile, which is correct; give it an explicit throw), and `ai-sdk-streamed-model.ts:260`
  `toPromptMessage`.

Tests: unit tests beside each changed file. The load-bearing assertion is the *negative* one —
an OpenAI opaque item routed to a non-OpenAI provider throws rather than silently serializing.

Gate: `pnpm test` and `pnpm test:provider-black-box` (run-loop change — non-negotiable per
`AGENTS.md`).

### Step 2: opaque items survive persistence and replay

> Path drift since 2026-08-05: `conversation-state-schema.ts` lives at
> `source/services/conversation/conversation-state-schema.ts` (not `source/contracts/`), with
> `history: z.array(z.unknown())` at line 22; `conversation-log-writer.ts` lives at
> `source/services/logging/conversation-log-writer.ts`. Persisted item kinds are in
> `source/services/conversation/conversation-persistence-types.ts`; `conversation-turn-items.ts`
> (same dir) is where replayed items are projected back to `ProviderInputItem` — the seam that must
> emit the `providerOpaque` marker from Step 1 so the run loop re-carries opaque items.

- `run-item-normalizer.ts` / `conversation-turn-items.ts:44` — add a fifth persisted item kind that
  stores the provider item verbatim as opaque JSON. Do **not** define a typed schema per OpenAI item
  variant; `ImportedConversationStateSchema` (`conversation-state-schema.ts:20`) is already
  `z.unknown()` + `.passthrough()` and stays that way.
- `conversation-replay.ts` — replay the new item kind back into `ConversationStore` unchanged.
- Check the serialization path for `undefined`-stripping and key-order rewriting. `structuredClone`
  in `conversation-store.ts:462` is fine; the JSONL writer is the thing to verify.
- `logging/conversation-log-writer.ts` — redact `encrypted_content` (and any `provider_opaque`
  payload over a size threshold) to `<redacted N bytes>` in the app log. Values still round-trip in
  the session state; they just never print. Also confirm `provider-traffic` logs do not echo it.

Tests: a round-trip test — write a session containing an opaque item with an unknown field, replay
it, assert byte-identical recovery. Plus a log-redaction assertion.

Gate: `pnpm test`.

### Step 3: enable server-side compaction

Small, and confined to the OpenAI adapter.

- `openai-responses-model.ts:133` `requestBody()` — add `context_management` when the feature is
  enabled and the resolved model supports it:

  ```ts
  ...(compaction ? { context_management: [{ type: 'compaction', compact_threshold: compaction.threshold }] } : {}),
  ```

- Gate it. `context_management` returns an opaque 500 on models that do not support it, so this
  cannot be sent unconditionally. Two gates, both required:
  - a `supportsContextCompaction?: boolean` capability on `ProviderDefinition.capabilities`
    (`registry.ts:48`), true only for `openai`. Codex's `/v1/responses` shim, opencode's, and
    user-configured OpenAI-compatible providers all speak this endpoint shape without necessarily
    implementing this parameter;
  - a model check inside the adapter. `gpt-5.4`-family and later only. Default-deny: an unrecognized
    model does not get the parameter. Leave a comment that this is empirical (see
    [Experiment results](#experiment-results-2026-08-05)) and needs re-measuring when models are
    added.

- Treat a compaction-related 500 as a normal turn failure through the existing retry path. Do not
  add bespoke recovery — but do consider disabling compaction for the remainder of the session after
  one such failure, so a model that unexpectedly rejects the parameter does not fail every turn.

- **Distinguish the two failure classes.** [Round 3](#round-3--gpt-56-luna-and-the-free-prefix-hypothesis-under-control-2026-08-06)
  found the failure surface is not uniform: an *unsupported model* fails as an opaque
  `500 server_error`, while an *invalid parameter value* fails as a typed
  `400 integer_below_min_value`. Only the 500 should disable compaction for the session — a 400 is a
  configuration error that is fixable and will recur identically on every model, so silently
  disabling the feature on it hides a bug the user could correct. A "500 ⇒ unsupported" check does
  not see the 400 at all.

Tests: unit tests asserting the parameter is present for a supported model, absent for an
unsupported one, and absent for a non-`openai` provider.

Gate: `pnpm test`, `pnpm test:provider-black-box`.

### Step 4: capture compaction items into history

This is where the saving is actually realised. Measured: without it, a full-history resend gets no
benefit at all.

- `openai-responses-model.ts:200` `toTurnOutput` — after Step 1 this already returns
  `provider_opaque` for a `compaction` item, so no further adapter change is needed.
- The run loop / turn accumulator must apply the replacement rule when a completed turn's output
  contains compaction items:

  ```text
  if output contains compaction items:
      new provider history = [ ...retained prefix?, last compaction item ]
      (everything else is dropped — the server ignores items before the last compaction item)
  else:
      normal append
  ```

  **The retained prefix is settled: use Term2's user-turn items.** The free-prefix hypothesis was
  verified under control in [Round 3](#round-3--gpt-56-luna-and-the-free-prefix-hypothesis-under-control-2026-08-06)
  — a 1,366-token prefix bills in full with no compaction item in front of it, and bills as zero
  with one, across request bodies differing by 8 KB. So retain `[...userTurnItems, lastCompaction]`
  rather than `[compaction]` alone: `/undo`, `/rewind` and `getLastUserMessage` keep working at no
  measured wire cost.

  This rests on a server billing property, not on anything Term2 controls, and **no unit test can
  catch it regressing** — it is visible only in token accounting. Do not add a test that pretends
  to; instead re-run Round 3's control when adding a model or on any unexplained cost increase.

  This is `ConversationStore.replaceHistory()` (`conversation-store.ts:145`), which already exists
  for the full-history transport case. Reuse it; do not add a second replacement path.
- `ProviderContinuity` needs no reset here — unlike the manual endpoint, the response is a normal
  `Response` with a chainable id, and chaining continues to work (measured: 2322 input tokens on the
  chained follow-up). Leave continuity alone.
- The UI transcript is unaffected: messages are separate React state
  (`hooks/use-conversation-messages.ts:28`), not projected from `ConversationStore`.

Tests: a turn whose output contains `[compaction, message, compaction]` leaves history as exactly
one opaque item; a turn without compaction items appends as before; two consecutive compacting turns
do not accumulate stale compaction items.

Gate: `pnpm test`, `pnpm test:provider-black-box`.

### Step 5: (folded into Steps 3 and 4)

The original plan had a trigger-policy and stable-boundary step here: compact only between turns,
never between a tool call and its result, never mid-stream. **Server-side compaction removes the
need for all of it** — the server decides when to compact, inside its own turn, and returns the
items alongside normal output. There is no client-side moment to choose and no window in which
Term2 could compact at an unsafe point.

What survives from that step is the threshold, which is now a request parameter (Step 3) rather
than a policy engine, and the model gate, which moved into Step 3.

Keep this heading as a tombstone. A reader coming from the original brief will look for this step
and should find out where it went rather than conclude it was forgotten.


### Step 6: configuration

Under `agent.` in `settings-schema.ts`:

| Key | Type | Default |
| --- | --- | --- |
| `agent.contextCompaction.enabled` | boolean | `false` |
| `agent.contextCompaction.compactThreshold` | int `>= 1000` | conservative — see below |

`compactThreshold` has a **hard server-enforced minimum of 1000** — below it the API returns
`400 integer_below_min_value` ([Round 3](#round-3--gpt-56-luna-and-the-free-prefix-hypothesis-under-control-2026-08-06)).
Validate it in the schema so the failure surfaces at settings time rather than as a failed turn.

`compactThreshold` maps straight onto the API's `compact_threshold`. Choose the default with the
cost table from [Round 2](#round-2--auto-compaction-on-gpt-54) in hand: each fire costs ~600 output
tokens, which are billed several times higher than input tokens. A threshold near the model's
context limit fires rarely and saves a lot; a low one can cost more than it saves. Err high.

Do not add a compaction-model setting. The model gate from Step 3 is **not** a user setting either:
it encodes a measured quality property, not a preference, and a user who added `gpt-5.1` to it would
silently lose tool-derived context and then hit 500s. Keep it in code.

Follow the `setting-wiring` skill — a schema entry alone does not surface in `/settings`. Update
`hooks/settings-completion-config.ts` and `utils/settings-command.ts` too. Note both files have
uncommitted changes on `main` right now; coordinate before editing (`AGENTS.md`, "Parallel Work
Isolation").

Gate: `pnpm test`.

### Step 7: lifecycle events

Three provider-neutral events on `ConversationEvent`
(`services/conversation/conversation-events.ts:9`):

```ts
| { type: 'context_compaction_started';   provider: string; sessionId: string; inputTokensBefore?: number }
| { type: 'context_compaction_completed'; provider: string; sessionId: string;
    inputTokensBefore?: number; inputTokensAfter?: number; durationMs: number }
| { type: 'context_compaction_failed';    provider: string; sessionId: string;
    errorCategory: 'request' | 'validation' | 'persistence'; durationMs: number }
```

No payload ever carries `encrypted_content` or compacted item content. UI is optional in this step —
compaction must work with zero UI changes. When added, a single line in the transcript is enough:
`Context compacted: 176k → 31k tokens`.

Note `inputTokensAfter` is only knowable after the *next* real request completes, since the compact
call's own `usage` reports the compaction pass, not the resulting context size. Either emit it
deferred or leave it undefined; do not report the compact call's usage as the new context size.

Gate: `pnpm test`.

### Step 8: black-box scenarios

Per the `provider-testing` skill, in `scripts/provider-black-box/`. The fake HTTP server
(`fake-provider-http-server.ts`) needs a `/v1/responses/compact` route.

The brief's ten dangerous paths, mapped to where each actually belongs:

| # | Scenario | Home |
| --- | --- | --- |
| 1 | long conversation compacts and continues | `provider-session-responses.blackbox.ts` |
| 2 | tool calls before compaction remain understood after | `provider-session-responses.blackbox.ts` |
| 3 | compaction items arriving on a turn that also contains an unresolved tool call are handled | `provider-session-responses.blackbox.ts` — reshaped: the server, not Term2, picks the moment, so the risk is now *handling* the overlap rather than *avoiding* it |
| 4 | a turn that fails after emitting compaction items leaves history usable | unit (Step 4) + `provider-session-resilience.blackbox.ts` |
| 5 | compacted session survives save / restart / resume | `provider-session-resilience.blackbox.ts` — **highest-value test after 8**: this is the path where the saving is measurably lost if Step 4 is wrong |
| 6 | unknown/opaque fields survive serialization | unit (Step 2) |
| 7 | repeated compactions | `provider-session-responses.blackbox.ts` — confirmed to work live |
| 8 | switching to a non-OpenAI provider does not reuse compacted state | `provider-session-stateless.blackbox.ts` — **highest-value test in the set** |
| 9 | changing models is supported explicitly or rejected safely | `provider-session-resilience.blackbox.ts` — must cover switching *to* an unsupported model mid-session with a compaction item already in history |
| 10 | near-limit context compacts before the next request fails | now the server's responsibility; assert only that the threshold reaches the wire (Step 3 unit test) |
| 11 | a compacted session does not re-execute a side-effecting tool | `provider-session-resilience.blackbox.ts` — **new**, from the experiment; see [Risks](#risks) |
| 12 | history holds exactly one compaction item after a compacting turn, not an accumulating pile | unit (Step 4) — **new**; the `[compaction, message, compaction]` shape makes over-retention the easy mistake |

Scenario 8 is the one most likely to catch a real defect: `ProviderContinuity` already invalidates
on provider switch, but an opaque OpenAI compaction item sitting in `ConversationStore` would be
handed to the next provider's converter. Step 1's provider-mismatch throw is what makes this safe;
the black-box test is what proves it.

The behavioural test the brief asks for — plant facts early, compact, ask about them later, with at
least one fact only obtainable from a tool result — belongs in the fixture-driven suite with a
scripted fake provider. It verifies *our* plumbing (the compaction item reached the model), not
OpenAI's summarization quality. Do not write an assertion that depends on model wording.

Gate: `pnpm test` and `pnpm test:provider-black-box`.

## Collateral on history-derived features

Compaction folds assistant messages, reasoning, tool calls and tool results into one encrypted item.
On the auto path, a naive "history becomes `[compaction]`" replacement destroys **everything** Term2
derives from its own transcript — worse than the manual path, where user messages came back in the
compacted output.

This is why the free-prefix hypothesis in
[Round 2](#round-2--auto-compaction-on-gpt-54) matters beyond token cost. Decide in Step 4 between:

- **`[compaction]` alone** — simplest, and `/undo`, `/rewind`, and `getLastUserMessage` all go blind
  across the boundary; or
- **`[...userTurnItems, compaction]`** — keeps those features working, and measured as costing
  nothing extra, but relies on the server continuing to ignore the prefix.

Either way, these degrade across a compaction boundary and should be stated in the UI rather than
papered over:

- `listRewindTargets` / `/rewind` (`conversation-store.ts:293`) — `discardedReplies` and
  `discardedFiles` under-report, because the tool calls they scan are gone.
- `removeAfterLastToolOutput` / `/retry-tool` (`conversation-store.ts:209`) finds no tool output
  before the boundary.
- `getLastUserMessage` and `/undo` keep working only under the second option.
- The approval reviewer's `buildCompactHistoryContext`
  (`approval/shell-auto-approval-evaluator.ts:142`) sees fewer prior tool calls after compaction —
  which per `llm-auto-approve-evaluator-upgrade.md` means it must treat that context as
  *incomplete*, i.e. bias cautious. Verify that existing incomplete-context handling triggers here.

## Boundary with Term2 memory

Compaction and memory are different mechanisms and must not be wired together.

- Compaction keeps **one active conversation** inside its context budget. It is lossy, opaque, and
  scoped to the OpenAI provider.
- Memory (`services/memory/`) preserves **durable information across sessions**. It is readable,
  searchable, and provider-neutral.

Therefore: never send a compaction item to the memory librarian; never treat compacting as a memory
write; never search inside compacted provider state; never assume compaction preserves anything
worth keeping permanently. Decisions that must survive belong in memory through the normal path,
independent of whether compaction ever runs.

## Rejected alternatives

- **Manual `/v1/responses/compact`.** Was the plan of record through Round 1 and is fully specified
  in the git history of this file. Rejected once the support floor moved to `gpt-5.4`: it needs a
  separate API call, its own failure-and-rollback lifecycle, a stable-boundary trigger policy, and a
  `ProviderContinuity` reset because its response id is not chainable — all to reach a saving the
  auto path delivers from one request field. **Keep it as the fallback** if `context_management`
  regresses or if a future support floor drops back below `gpt-5.4`; it works on every model tested,
  which is its one real advantage.
- **Compacting at a Term2-chosen boundary.** The original brief's instinct — compact between turns,
  never between a tool call and its result — is sound for the manual path and unnecessary for the
  auto path, where the server owns the moment. Do not reintroduce a client-side trigger engine
  alongside `context_management`; two things deciding when to compact is worse than either alone.
- **A separate provider-owned conversation store for OpenAI.** The brief offers this as the fix if
  history is generic. It is not warranted: `ProviderInputItem` is already an open record and
  `ConversationStore` is already the provider-facing projection. A parallel store would duplicate
  rewind, undo, persistence and replay, and would leave two things to keep in sync across
  `/clear`, `/undo`, provider switch and session resume. The narrow opaque lane in Step 1 gets the
  same fidelity for a fraction of the surface.
- **Extracting a text summary from the compaction result.** Explicitly wrong. The returned items are
  the new canonical context; `encrypted_content` is not ours to read, and re-injecting a summary as
  a system message would double-count it.
- **Local token counting to drive the trigger.** No reliable tokenizer in this repo. Provider usage
  is authoritative and already plumbed.
- **Compacting immediately after a turn ends** rather than before the next one. Makes the user wait
  after an answer they already have. The brief is right; the pre-turn placement stands.

## Risks

1. **Step 1 widens a contract used by every provider.** The mitigation is that `provider_opaque`
   throws everywhere except the adapter that produced it. Get that assertion into tests first.
2. **`toTurnOutput` no longer throws on unknown items.** That throw is currently a real safety net
   against silently dropping output. Replacing it with a passthrough means an unrecognized item now
   flows into history instead of failing fast. Confirm nothing downstream assumes the four known
   kinds are exhaustive — `run-item-normalizer.ts` and the message projection are the places to
   check.
3. **Silent no-op.** The most likely way this ships broken is not a crash: it is enabling
   `context_management`, paying ~600 output tokens per fire, and capturing nothing — because Step 4
   is wrong or because the chain happens to hold in testing and hides the bug. Full-history resends
   are where it shows. Scenario 5 in the test matrix is the guard; write it early rather than last.

4. **A compacted agent may re-execute a side-effecting tool.** Observed, not theorised: with tools
   available, a post-compaction continuation did not answer from context — it re-issued a
   `function_call` to recover a value it had lost. That was on `gpt-5.1`, where the tool-derived
   fact did not survive; on `gpt-5.4` the fact survived and the model answered directly, so the
   `gpt-5.4` floor substantially reduces this. It does not eliminate it — compaction is lossy by
   construction and a longer conversation than this fixture may lose more. In Term2 the reflex means
   re-running a shell command or re-applying a patch. Mitigations to settle during Step 4:
   - approval flow is the real backstop — a re-issued mutating call still goes through
     `ApprovalFlowCoordinator`, so this degrades to a confusing prompt rather than silent damage,
     *provided* auto-approval does not wave it through on the grounds that a similar command was
     approved earlier in the now-compacted session. Check how
     `shell-auto-approval-evaluator.ts` treats precedent whose originating context no longer exists;
   - `ToolExecutionLedger` (`services/tool-execution-ledger.ts`) survives compaction independently
     of provider history. Consider keeping it as the record of what already ran, so a repeat call
     can at least be detected.
   Scenario 11 in the test matrix exists for this.

5. **`context_management` fails as an opaque 500, not a typed error.** There is nothing to
   feature-detect on, so the model gate in Step 3 is the only protection and it is a hardcoded list.
   A model that silently loses support, or a user-configured OpenAI-compatible endpoint that
   proxies to something else, produces a 500 on every turn. Disabling compaction for the session
   after the first such failure (Step 3) is what keeps that from bricking the session.

6. **Compaction quality is empirical and will drift.** The allowlist encodes measurements taken on
   2026-08-05 against one fixture. Model updates can change it in either direction without notice.
   Re-run the probe when adding a model, and treat a green result as evidence about that fixture,
   not a guarantee.
