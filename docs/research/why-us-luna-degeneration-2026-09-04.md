# WHY US? — Codex A/B + request-shape audit (2026-09-04)

## 1. Codex A/B result: CLEAN — but the control is weaker than it looks

Searched all 257 Codex rollout sessions under `~/.codex/sessions` (read-only):

- 123 luna-dominant sessions, 5394 `custom_tool_call` records, 119 classic
  `function_call` records. **Zero runaway tool arguments.** Largest Codex-side
  tool input anywhere: 41,089 chars (`exec`); largest luna-session input:
  41,089. Our harness: 9 drips killed at 100k chars + 3 sibling 1006s.
- Markers (`malformed`, `truncated`, `runaway`, `too_large`) hit only skill-doc
  prose and prompt text, never error records. No aborted-stream record type
  exists in the rollout schema at all.

CAVEAT (do not overclaim): Codex NEVER asks Luna to write files. Its only
file-writing path is `exec` (shell with heredocs); there is no `apply_patch`
/ `create_file` tool in any of the 257 sessions — top tools are `exec`
(12,600), `wait`, `spawn_agent`. So the control covers "Luna emitting tool
arguments under Codex" (12.6k exec calls, max 41k, zero runaways) but NOT
"Luna emitting 50k+ file-creation diffs" — the exact shape that degenerates
for us. Absence there is real evidence against a harness-agnostic model
property (12.6k clean calls is a substantial sample), but the file-diff
trigger class is untested by the control.

Stronger statement available: Codex constrains the trigger to *file-content
arguments specifically*, not tool arguments in general.

## 2. Input-context reconstruction (kept from prior pass)

For each drip the chained request carries only `[function_call_output]` +
`previous_response_id` — full history is server-side, so "what the model saw"
is not directly observable. Traceable facts:

- All 9 drip heads are coherent `apply_patch` JSON (`create_file` ×5,
  `update_file` ×4) for M4 YAML artifact paths — never mid-JSON continuation.
  The truncated-continuation hypothesis is DEAD: no drip begins mid-argument.
- Preceding tool results are mundane and span the full range (32B–15kB):
  file reads, shell outputs, prior patch confirmations, one `ls` error
  (`No such file`), two schema-error self-corrections. Matched healthy
  `apply_patch` calls (233 in the 2k–60k band) follow IDENTICAL predecessor
  classes. No predecessor feature separates drips from healthy.
- 2/9 drips follow a schema-error → self-correction (824e1, cb340: the model
  emitted a malformed `apply_patch`, got `Tool input did not match schema`,
  then degenerated writing the correction). But the same error→correction
  shape completes fine elsewhere, and 7/9 have no error predecessor at all.
  Correlation 2/9, not a trigger.
- Drip creator calls are ordinary: one drip's `call_id` traces to a 67-char
  `read_file` in the same log; the fatal chained call answers a normal result.
  Nothing about the local request/response pair is anomalous — the anomaly is
  entirely in what the server then generates from its chained history.
- **The one feature shared by all 9 and rare in healthy traffic:** every drip
  stream opens `response.output_item.added` events of type `reasoning` with
  `encrypted_content` (~1292 chars each, 1–5 items) BEFORE the `function_call`
  item; healthy completed luna payloads in this log show tool calls with NO
  reasoning-added frame counterpart (healthy chained n≈2600 carry reasoning
  server-side too, but it never surfaces as stream events — the 9 drips are
  the ONLY artifacts in the 3023-file set with raw `events` retained, because
  only aborted streams keep them; completed streams persist only the merged
  `payload`). Honest weight: the reasoning-frame presence correlates 9/9 vs
  0/completed-observable, but the observability is asymmetric by construction
  (aborted→events, completed→payload), so this may be a recording artifact,
  not a model signal. Do NOT claim it as the trigger without a completed
  stream's raw frames to compare against.

## 3. Request-shape audit (secondary)

- **Output cap: we send NONE — and neither can Codex.** `buildResponsesCreateRequest`
  sets `max_output_tokens` only when `request.maxTokens` is defined; the run
  loop never sets it on this path, and `normalizeCodexRequestData` DELETES it
  with comment "Codex responses endpoint rejects temperature and
  max_output_tokens; always omit them" (`source/providers/codex-responses-model.ts:679-685`,
  asserted by tests at `:752, :829-850`). All 2665 luna sent bodies: zero carry
  an output cap. This is endpoint-mandated, not our choice — Codex hits the same
  endpoint and must omit it too. NOT a differentiator. A cap would bound damage
  only; correctly held out of scope.
- **Tool schemas ARE structurally inviting:** `apply_patch` takes an unbounded
  `diff: z.string()` ("Unified diff content", no max) and `create_file` takes
  whole-file `diff` strings; healthy legit args reach 53k. Codex has no such
  tool — file writes go through `exec` heredocs, where the shell grammar bounds
  what the model emits per command. Our schema invites single-argument file
  contents; Codex's grammar splinters the same work across commands. Plausible
  contributor, not provable from logs.
- **Chained shape:** identical in drip vs healthy (single `function_call_output`
  + `previous_response_id`, `reasoning: {effort high, summary auto, context all_turns}`,
  `parallel_tool_calls: false`, tools via `additional_tools` prefix only on fresh
  turns). The 1-in-2600 failure rate on identical shapes says the request shape
  does not determine the outcome — the difference is inside the server's
  chained state, invisible to us.
- **Sampling:** we send no temperature/top_p (endpoint rejects temperature);
  Codex likewise cannot set it here. No differentiator.

## 4. Best explanation + test

Best single difference: **Codex never gives Luna an unbounded file-content
parameter; we do.** Every drip is a large `diff` string for a YAML artifact;
Codex's largest luna tool input is 41k shell text and its file edits ride
inside exec commands. The mechanism (model-side) is consistent with
degeneration inside long repetitive YAML-diff generation — our M4 workload
fed Luna hundreds of near-identical `+replacementTestIds: []` / shard-list
patches in sequence, the classic repetitive-context degeneration setup — and
Codex never presents that context shape.

Test that would convert this to fact: reproduce with a cheap model — replay
the ed40e-class shape (chained `previous_response_id` over a history of ~10
near-identical large YAML `create_file` diffs, then request one more) against
`gpt-5.6-luna` itself on a scratch task, and against a non-Luna Codex model on
the identical history. If Luna degenerates and the other does not, trigger is
repetitive-diff-context × Luna; if neither, the history-length or chaining
state matters more than content. Costs one paired run; needs a scratch
Codex-API harness (NOT the production app — do not replay 100k-arg traffic
through the live session).

## 5. Standing-authorization verdict: NO CHANGE SHIPS

No safe improvement found: the cap is endpoint-forbidden, the schema IS the
product (bounding `diff` breaks legit 53k patches), sampling params are
endpoint-rejected. "Our requests look normal for this endpoint; the asymmetry
is the file-diff workload Codex never presents" is the useful answer. Guard
stays as the right answer.
