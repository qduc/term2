# Luna apply_patch runaways: grammar-constraint hypothesis (COMPLETE — FALSIFIED)

## Status
Complete. Hypothesis falsified on three independent legs (grammar identity,
termination analysis, healthy-call control). No fix ships.

## 1. Probe claim — VERIFIED in code
`source/lib/agent-factory.ts:235-252`: when `shouldUseNativePatchTool`, the
`apply_patch` tool is replaced with a NATIVE FREEFORM declaration:
`modelTool: { type: 'custom', format: { type: 'grammar', syntax: 'lark',
definition: UPSTREAM_APPLY_PATCH_GRAMMAR } }`, description exactly
"The `apply_patch` tool can be used to edit files. This is a FREEFORM tool,
so do not wrap the patch in JSON." Policy: `source/providers/codex.provider.ts:461`
`nativePatchModelPrefixes: ['gpt-5']` → `gpt-5.6-luna` matches → native tool
active on the Codex WS lane. Canonical-envelope description work does NOT
reach Luna (consistent with the probe).

## 2. Grammar provenance — UPSTREAM's, not ours
`source/tools/file/upstream-apply-patch.ts:17-34` vs
`/tmp/codex-src/codex-rs/core/assets/tools/apply_patch.lark`: BYTE-IDENTICAL
except trailing newline (diff: only `11a12 > (blank)` + missing final newline).
Upstream test `apply_patch_spec_tests.rs` asserts the same description string
and grammar. So "if grammars differ the difference is the finding" resolves
to: THEY DO NOT DIFFER. Codex ships this exact grammar and does not
degenerate → grammar content alone cannot be the cause.

## 3. Grammar termination analysis (preliminary)
```
start: begin_patch hunk+ end_patch
add_line: "+" /(.*)/ LF        change_line: ("+"|"-"|" ") /(.*)/ LF
change: (change_context | change_line)+ eof_line?
```
- Termination IS reachable at every line boundary: after any complete
  `add_line`/`change_line`, `hunk+` is satisfied → `end_patch` legal.
- No production forces more content: `change?` optional, `eof_line?` optional.
- Whitespace mechanism EXISTS in one shape: `change_line` with `" "` prefix
  + `/ (.*)/` matches trailing-whitespace context lines, so runs of
  `" \n"`-shaped lines are grammar-legal. But observed tails contain NO
  newlines at all (envelope ed40e: 0 `\n` in 100k chars; tails are
  spaces/tabs/`\r`), i.e. an UNTERMINATED line — the grammar cannot complete
  any production without LF, so constrained decoding would have to emit LF
  eventually, not pure spaces forever. Weak fit.
- `filename: /(.+)/` needs ≥1 char — irrelevant mid-hunk.

## 4. Artifact cross-check (10 large aborted-with-events envelopes, all luna)
All `OpenAIResponsesWSModel`, `previous_response_id` chained, `function_call`
deltas (NOT `custom_tool_call_input.delta`):
- ed40e (17-23): 100000 chars / 54836 frames / 1.82 cpf; head
  `{"type":"create_file","path":"docs/test-audit/artifacts/approval-m3.yaml",...}`;
  last non-ws at 59406 (59%); tail pure `[ \t\r]`.
- a4cd2 (18-18): last non-ws at 6%; pre-collapse text is multilingual garbage
  + `to=functions.apply_patch (commentary)` leak, then `"   ` + spaces.
- 79944/63f45: collapse at 15%/19.5%; tails ` \t` / `   \n\n` mixes.
- 5491a (19-19): update_file on real source file, collapse at 24.5%.
Positional consistency: NOT one structural position (6–59% across envelopes);
common shape is mid-`diff`-string whitespace death inside a JSON envelope,
not a grammar-production boundary.

## 5. Wire declaration vs wire output (code path now traced end-to-end)
`toModelTools` (`application-run-loop.ts:1982-1996`) DOES forward
`modelTool.type:'custom'` as `{type:'custom', format}` — and the Lite
normalization (`codex-responses-model.ts:747-771`) moves `tools` into the
chain-head `additional_tools` item (session had 48 chain-heads, 2617 chained
requests). So the grammar IS declared to the server at chain start.
BUT the traffic log sanitizes tool definitions to bare name strings
(`provider-traffic.ts:122-133`), so the declaration is confirmed only via
the code path, not the wire. And the server answers with plain
`function_call` + `function_call_arguments.delta` JSON (`{"type":...}`),
never `custom_tool_call`/`custom_tool_call_input.delta`. Whether the
server runs constrained decoding against the Lark grammar for these calls
is therefore UNOBSERVED — the output item type is the server's choice.
REQUIRED NEXT: one HEALTHY luna apply_patch completion's item type; if
healthy calls are also `function_call`+JSON, the grammar is inert on this
lane and the hypothesis is dead.

## 6. Healthy-call control — grammar is INERT on this lane
454 healthy luna `apply_patch` completions sampled in session 8b49b: ALL are
`type: 'function'` with JSON args (`{"type":"create_file",...}`),
including 44KB valid patches. Zero `custom_tool_call` items anywhere on the
lane. The server answers every call — healthy and runaway alike — as plain
JSON function calls. Server-side Lark constrained decoding cannot be forcing
the whitespace: the constrained channel (custom-tool patch text) is never
used.

## 7. Verdict
HYPOTHESIS FALSIFIED on three independent legs: (1) grammars byte-identical
with upstream Codex, which does not degenerate; (2) termination reachable at
every line boundary, and observed tails are unterminated non-newline runs no
production can extend; (3) collapse positions spread 6–59% with JSON payloads
on a lane where the grammar channel is never exercised (454/454 healthy
calls are plain function calls). The runaways are model-side degeneration
inside long `previous_response_id` chains: coherent JSON head → mid-string
collapse into whitespace (sometimes via multilingual garbage +
`to=functions.apply_patch` commentary leak), ~1–2.7 chars/frame, no terminal
item. Consistent with the repro result (content shape alone clean; chaining
the unreplicated axis). No grammar fix indicated. Artifact gap for future
wire-level questions: `sanitizeToolDefinitions` reduces declarations to name
strings and aborted envelopes keep counters only — raw capture needed, not
the traffic log.
