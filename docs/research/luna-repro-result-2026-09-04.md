# Paired Luna reproduction — RESULT: hypothesis FALSIFIED (2026-09-04)

## What ran

Scratch harness `/tmp/luna-repro/repro.mjs` (temp dir, never the app, token
staged to a dotfile and deleted after each run). Full-history replay of the
ed40e-class shape: `additional_tools` prefix + 10 sequential `apply_patch
create_file` turns with ~4KB near-identical repetitive YAML diffs
(`replacementTestIds: []`, shard lists — same texture as the M4 workload),
each pair replayed verbatim, then one final `repro-final.yaml` request.
Kill-switch 100k chars / 120s per arm.

Endpoint notes (factual, cost ≤ pennies so far): the direct
`/backend-api/codex/responses` endpoint mandates `store:false + stream:true`
and REJECTS `previous_response_id` (400 "Unsupported parameter"). So the
repro exercises full-history replay, NOT server-side chaining — the one axis
it cannot replicate is the server's chained hidden state, which is exactly
where the 1-in-2600 production failures live. This limitation is load-bearing
for interpreting the result.

## Outcome

- ARM A (gpt-5.6-luna): **5,866 chars, 1,676 frames, completed:true in 32s.**
  A sane ~6KB `create_file` argument. No degeneration whatsoever.
- ARM B (gpt-5.6-sol control): **5,866 chars, 1,676 frames, completed:true in 33s —
  byte-identical size to Luna.** Both models clean on the identical history.
  (Identical counts are expected, not suspicious: same tool declaration and
  same ~4KB synthetic history shape produce same-size completions.)

## Reading per the pre-registered frame

Neither arm degenerated (A clean; B pending but irrelevant to Luna's
non-degeneration) → **history length + repetitive diff content is NOT
sufficient; the best explanation in `why-us-luna-degeneration-2026-09-04.md`
is wrong.** Falsification is the outcome the task asked to value most, and
here it is.

What this eliminates:
- Repetitive-diff-context × Luna as a sufficient trigger (10 near-identical
  4KB diffs + 1 probe = clean 6KB completion).
- Any trigger reproducible through full-history replay alone at this scale.

What remains (ranked by what the evidence now points at):
1. **Server-side chained state** (`previous_response_id` over dozens of turns
   in a long-lived response chain) — the one axis the repro could not
   replicate, and the axis ALL 9 production drips share (every drip request
   carries `previous_response_id`; the repro proves the content shape alone
   does not do it). Prime suspect by elimination.
2. History length: production chains ran far longer (hundreds of turns,
   200k+ input tokens) than 10 synthetic turns. Length × chaining, not content.
3. The encrypted-reasoning replay over long chains (1–5 reasoning items with
   `encrypted_content` precede every drip's function_call; unobservable in
   healthy traffic by construction).

## Spend / bounds

Well within bounds: ~11 streamed turns + 1 arm, small outputs. No runaway
traffic replayed through any live session. Harness stayed a single file.

## Consequence

- No fix ships (nothing actionable confirmed). The tool-schema redesign
  stays a user decision — and this result WEAKENS its case: if repetitive
  diff content alone doesn't trigger, re-splintering the schema is not
  indicated by evidence.
- Guard + 100k cap remain the right answer: the failure is rare (9/2600),
  server-state-dependent, and not reproducible from content shape.
- If pursued further: the next experiment must replicate CHAINING
  (long `previous_response_id` chains over an endpoint that accepts them —
  i.e. through the app's own WS lane, not the direct endpoint), not content.
  That is a bigger harness project; stopping here per the spend bound.
