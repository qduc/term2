# Luna tool-FORMAT paired experiment — pre-registration v2 (2026-09-04)

## Production re-derivation (verified, supersedes the 9-count)

Re-derived from `~/.local/state/term2-nodejs/logs/provider-traffic/*/*/*.json`:
17 aborted `gpt-5.6-luna` artifacts (files listed in the experiment notes),
not the 9 recorded in earlier docs (narrower filter — correct the 9 where it
appears). Findings, verified per artifact by concatenating all
`response.function_call_arguments.delta` frames:

- Tool: **17/17 `apply_patch`** (both `create_file` and `update_file` ops) —
  never `create_file`/`search_replace` as separate tools, never shell.
- Shape: every one opens as a well-formed argument head
  (`{"type":"update_file","path":…` / `{"type":"create_file",…`) then
  collapses into an unbounded whitespace run: 16/17 with longest
  whitespace run 40k–99k chars (spaces/tabs/newlines/`\r`); 1/17 (91bd9)
  is the `} } } } }` repeater instead (max ws run 5). Content ends early:
  last non-whitespace offset is 1k–59k into the 100k stream.
- Rate: ed40e ran 100,001 chars over 54,836 frames (~1.8 chars/frame) —
  single-whitespace-token dribbling, not text production.
- Drip requests are chained (`previous_response_id` + single
  `function_call_output`, `reasoning.effort high`, empty instructions) — the
  server-side chained state no replay harness can replicate.

## Hypothesis under test (sharpened, not replaced)

The trigger is the tool FORMAT being off-distribution, not the file content.
`apply_patch` is exactly where whitespace is SEMANTIC: patch bodies carry
space-prefixed context lines and indentation that must match the target.
Luna is trained predominantly on the Codex shape — a single `exec` tool
whose argument is a small JS program calling nested `tools.apply_patch`
(file content rides inside a nested call, observed in `~/.codex/sessions`:
`const patch = "*** Begin Patch…"; text(await tools.apply_patch(patch));`).
Our harness hands Luna `apply_patch` with the patch body as a direct `diff`
JSON string parameter. Emitting whitespace-semantic payload as a raw JSON
string is precisely the off-distribution case — and a whitespace-specific
failure is what that would look like.

This is DISTINCT from the falsified hypothesis in
`luna-repro-result-2026-09-04.md` (repetitive YAML-diff CONTENT × Luna —
probed clean). Content texture is held CONSTANT here; only the tool format
varies.

## Design (v2 — revised per the whitespace finding)

Paired, same model (`gpt-5.6-luna`), same patch content, same history
length:

- ARM A — OUR `apply_patch` schema: patch body as direct `diff` string
  parameter (`{type:'update_file', path, diff}`), whitespace-semantic
  TS update hunks (space-prefixed context, significant indentation).
- ARM B — Codex shape: single `exec` tool whose argument is a JS program
  (`{program: "const patch = …; text(await tools.apply_patch(patch));"}`)
  carrying the IDENTICAL patch inside a nested `*** Update File ***` script.

Both arms: 10-turn full-history replay of same-texture turns, then probes
with an oversized multi-hunk consolidation request in each arm's idiom.
Scratch harness `/tmp/luna-format-repro/format-repro2.mjs` (direct
`/backend-api/codex/responses`, store:false + stream:true, NOT the
production app). PRIMARY metric: whitespace-run onset — max consecutive
whitespace run, offset where content stops / ws-tail begins, ws fraction.
Argument size is downstream of that. Kill-switch 100k chars.

Note: v1 harness (`format-repro.mjs`, create_file YAML) is superseded — its
pilot ran clean on both arms but arm B emitted a 374-char summary instead of
full content, so the probe did not force long whitespace-semantic
generation. Superseded, not deleted.

## Goal ordering (added mid-run per user direction)

REPRODUCIBLE TRIGGER is the primary deliverable; the A/B verdict is
secondary. A "format matters" verdict without a trigger leaves any fix
unverifiable at a 17-in-2600 base rate. The achievable target is a
STATISTICALLY RELIABLE trigger, not literal determinism (sampling makes
that unlikely): an input shape firing whitespace degeneration at a
materially elevated rate vs control, reported as "fires in k of n trials"
with the control arm alongside. No tuning-to-break: if a variation hits,
re-run that EXACT shape to confirm the rate holds before claiming it.
If no elevated rate is found, report trials, observed rate, and ruled-out
shapes. The durable artifact (repo-permanent, not /tmp): exact request
body + model/settings + trial counts/rates + a re-run script with the
whitespace-onset metric computed automatically — the before/after gauge
for any future fix.

## Pre-registered predictions

- If FORMAT matters (A shows large max-ws-run / early content-end while B
  completes with small ws runs on the same content): strongest result of
  the investigation — the tool-schema redesign becomes evidence-backed
  rather than speculative.
- If BOTH arms complete clean with small ws runs: format is NOT sufficient
  at this scale; joins the content hypothesis as falsified-at-this-scale.
  Prime suspect remains server-side chained state (`previous_response_id`
  over long chains, which the direct endpoint rejects — 400 "Unsupported
  parameter" — and no replay harness can replicate).
- If BOTH arms show ws-run onset: content-scale × Luna, independent of
  format.
- If EITHER arm errors (auth, endpoint, timeout): no conclusion; record the
  failure mode.

## Power statement (read before the numbers)

Production base rate ≈ 17 runaways / ~2600 chained requests (≈0.65%). A small-n
clean result CANNOT rule out a rare trigger — n=4/arm detects only a LARGE
effect (e.g. per-trial degeneration probability ≥30%: P(≥1 hit in 4) ≈ 76%).
Any "both clean" verdict means "not a large, deterministic effect at this
scale", NOT "format is exonerated". Conversely, even ONE probe with a
40k+ whitespace run in either arm is informative given the prior paired
repros produced zero.

## Results — v2 full run (2026-09-04)

Harness `/tmp/luna-format-repro/format-repro2.mjs`, 10-turn history per arm,
4 probes/arm, model `gpt-5.6-luna`, full-history replay (direct endpoint
rejects `previous_response_id`). ~246k input chars sent (~9 min). Raw:
`/tmp/luna-format-repro/format2.json`.

| probe | argChars | frames | chars/frame | maxWsRun | contentEnd | wsFrac |
|---|---|---|---|---|---|---|
| A0–A3 | 1588–1749 | 410–444 | 3.9–4.0 | ≤3 | = end | ~0.09 |
| B0–B3 | 1582–2091 | 374–521 | 4.0–4.3 | ≤4 | = end | 0.07–0.09 |

All 8 probes completed clean. Zero probes fired under the (retrospectively
applied) 10k maxWsRun rule — production runaways show 40k–99k, these show
single digits. Chars/frame 3.9–4.3 (text production) vs ed40e's 1.8
(whitespace dribbling). Rate: **A 0/4, B 0/4.**

Ruled out at this scale (with the no-tuning-to-break discipline — each
shape ran as designed, no variation was tuned after seeing output):

- v1 shape (create_file YAML, direct-diff vs nested-program): 1 probe/arm,
  both clean (A 5,866 chars; B 374-char summary dodge — probe fault, not a
  model signal). Superseded by v2.
- v2 shape (whitespace-semantic TS update hunks, oversized consolidation
  probe): 0/4 + 0/4 with maxWsRun ≤4.
- Any trigger reproducible through full-history replay alone at ≤10 turns
  with ≤4 probes/arm. Smallest detectable effect at n=4/arm: per-trial
  fire probability ≥30% (P(≥1 hit) ≈ 76%).

NOT ruled out (and now the prime suspect by elimination): server-side
chained state — every one of the 17 production drips carries
`previous_response_id` over a long-lived chain, and the direct endpoint
rejects that parameter, so this entire experiment family cannot replicate
the axis where all 17 failures live.

## Verdict

1. **Reproducible trigger: NOT FOUND.** No input shape tested fires
   whitespace degeneration at an elevated rate (0/8 probes fired across
   both shapes). There is no durable trigger artifact to enshrine beyond
   the gauge itself.
2. **A/B verdict (secondary): format is NOT sufficient at this scale.**
   Both arms complete clean with indistinguishable ws profiles — joins the
   content hypothesis as falsified-at-this-scale. This does NOT exonerate
   format in the chained lane; it says replay-scale format variation does
   not move the needle.
3. **Durable artifact (the gauge):**
   `scripts/experiments/luna-format-repro/luna-format-repro.mjs` +
   `README.md` — repo-permanent re-run script with the whitespace-onset
   metric computed automatically (`maxWsRun`/`contentEnd`/`wsFrac` per
   probe, `fired` rollup, exit 0/1/2). Any future fix (schema change, cap,
   prompt change) is verifiable by re-running before/after and comparing
   rates — once a firing shape is found; until then the gauge reports its
   own clean baseline.
4. **Consequence:** no fix ships on this evidence. Guard + 100k cap remain
   the right answer. The next experiment must replicate CHAINING (long
   `previous_response_id` chains over an endpoint that accepts them), not
   content or format — a bigger harness project.
