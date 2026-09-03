# Budget call: maxToolArgumentCharacters stays 100k; no per-tool segmentation (2026-09-04)

Decision: KEEP `maxToolArgumentCharacters: 100_000` and
`maxCumulativeToolArgumentCharacters: 100_000` as-is
(`generation-guard.ts:46-47`). No code change.

Evidence (all measured, cited):

- Failure is rare and server-state-dependent: 9 runaway drips in ~2,600
  chained Luna calls (0.35%), all killed by the 100k cap or the 60s drip
  guard. No earlier detector separates cleanly (repetition: 331 FPs;
  meta-leak windows: 9 valid-executed-patch FPs; per-tool ceilings overlap —
  `early-degeneration-evidence-2026-09-04.md`).
- Content-shape trigger FALSIFIED by paired repro: Luna and Sol both
  completed clean (5,866 chars, byte-identical) on the ed40e-class
  repetitive-diff history (`luna-repro-result-2026-09-04.md`). The remaining
  suspect is server-side chained state, which no argument cap can address —
  but which also means the cap's job is pure containment, and it works.
- Headroom is adequate but not generous: largest legitimate completed
  argument re-verified today at **53,349 chars** (`apply_patch create_file`,
  artifact 17-22-18.398Z_382f2.json, session 8b49b, n=2,890 completed args).
  100k gives ~1.9x headroom over the max, ~2.3x over p99 (42,575). Raising
  to e.g. 200k buys nothing (no legit arg is near 100k) while doubling the
  containment cost of each rare runaway. Lowering toward 60k would kill
  observed-legitimate work (53k max > 60k is false comfort — margin would be
  1.1x; any single larger-but-valid patch breaks).
- Segmentation per tool Dicke: `apply_patch` (the degenerating tool) is also
  the highest-ceiling legitimate tool (max 53,349 vs next-highest shell
  13,656). Any per-tool ceiling that spares 53k cannot catch a 100k drip
  meaningfully earlier than the global cap; any that catches it kills legit
  M4 work. Distributions overlap — segmentation has no operating point.

Chunked-write dispatch guidance: KEEP as standing advice. Rationale: with
the cap held at 100k, the only way a legitimate >100k write ever succeeds is
split across calls; the guidance is the escape valve that makes keeping the
cap costless for valid work. Dropping it while holding the cap would turn
containment into a capability ceiling. (No chunked-continuation bypass of the
cap is authorized — each call remains individually bounded; cf. exec spec v2
E3 rejection.)

Review trigger (when to revisit): a legitimate completed argument >80k
(1.25x headroom erosion), or a runaway caught BELOW 100k by a new early
signal (cap no longer the binding containment). Re-measure from
provider-traffic; do not adjust on anecdote.
