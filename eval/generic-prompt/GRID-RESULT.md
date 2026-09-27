# Executed prompt A/B: replicated task grid

2026-09-27. Follow-up to [the first executed pilot](EXECUTED-RESULT.md).
**Decision:** Prefer `simple_v4.md` for **GPT-6 Luna** as a *model-specific*
prompt candidate, and keep `simple_v4.md` for **DeepSeek Flash**. This is a
basis for a scoped Luna rollout, **not** evidence for changing every GPT-5.x/6
profile or declaring either prompt universally better. No production routing
was changed in this study.

## Method

Three real coding tasks, two paired repetitions per model/task, 24 executed
turns in total. Each pair held provider/model, medium effort, built term2
runtime (`b2dd256d`), standard-profile fragments, tool surface, task archive,
and timeout fixed, varying only the effective base prompt (`simple_v4.md` or
`gpt.md`). Prompt hashes are `e6f043d4` and `6718831c` (SHA-256 prefixes).
Order was reversed on the second repetition. Tasks were pinned to pre-answer
commits: approval tri-state `358fd042`; credential picker `e80b3f36`; retry
abort `2a13d14f`. Git-history-free candidate snapshots were separate from
control/evaluator files; the hidden evaluator failed on untouched workspaces
for each task before any model run. Caps were 180s, 240s, and 360s respectively.

After each run, the benchmark evaluator ran TypeScript typecheck and then a
hidden regression test. Exit 124 means the turn hit its cap; an evaluator pass
on that partial workspace **does not count as completed work**.

| Task (two repetitions) | DeepSeek v4 | DeepSeek GPT | Luna v4 | Luna GPT |
| --- | --- | --- | --- | --- |
| Approval tri-state | 2/2 completed + official PASS | 2/2 completed + official PASS | 2/2 completed + official PASS | 2/2 completed + official PASS |
| Credential picker | 0/2 completed; one partial typecheck failure | 0/2 completed; both partial official PASS | 2/2 completed, semantic PASS | 2/2 completed; one semantic PASS, one **secret leak** |
| Retry cancellation | 0/2 completed; one partial official PASS | 0/2 completed; one partial official PASS | 2/2 completed; one official PASS | 2/2 completed; zero official PASS |

The credential task's **official** test requires the literal `********`,
although the prompt asks only that no credential be shown and that configured
state be clear. Both Luna/v4 candidates showed `configured` instead and failed
that strict assertion; Luna/GPT did the same in repetition 1. We therefore
ran an additional [semantic evaluator](credential-semantic.test-template.txt)
requiring that neither the full secret nor its leading 12 characters appear,
and that a mask or `configured` indicator appear. In repetition 2, Luna/GPT
did **not** modify the picker and the full secret remained visible, despite a
completed turn. Luna/v4 passed the semantic gate in both repetitions. This
semantic evaluator was locally retained under `.coord/`, not committed as a
product test; see the [runner](run-semantic-gate.sh). The strict official result
remains FAIL for both Luna arms on both credential repetitions and is not
silently relabeled. DeepSeek/v4's second partial workspace failed typecheck.

For retry cancellation, Luna/GPT's second run edited the session workflow but
not the retrying-model backoff; the hidden tests still showed a parked abort
and an already-aborted signal awaiting sleep. Luna/v4's second run edited
`retrying-model.ts` and passed all nine evaluator tests. Both prompts missed
the retry evaluator on the first repetition. DeepSeek's partial workspaces
were green on the second repetition but none finished the user-facing turn.

## Totals (six turns per arm)

| Arm | Completed turns | Completed official passes | Completed user-contract passes¹ | Wall seconds incl. caps | Provider input tokens (cached) | Output tokens | Catalog cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DeepSeek v4 | 2 | 2 | 2 | 1,511 | 23,778,945 (23,245,568) | 189,505 | unpriced |
| DeepSeek GPT | 2 | 2 | 2 | 1,517 | 27,401,950 (26,842,240) | 228,879 | unpriced |
| Luna v4 | 6 | 3 | 5 | 941 | 3,282,312 (2,988,544) | 12,883 | $0.065727 |
| Luna GPT | 6 | 2 | 3 | 1,057 | 4,304,473 (3,964,928) | 15,377 | $0.081318 |

¹ Approval official pass + credential semantic pass + retry official pass,
only where the turn finished. DeepSeek's four timed-out turns per arm are
excluded from this column even when their partial fix passes an evaluator.

Totals sum individual `cost_update` request records; final usage and
`usage_update` events can repeat a request and are **not** added again. Cached
input is already part of total input. DeepSeek records were `unknown_provider`
and have no credible dollar total. Luna/v4 saved about 19% of the catalog
cost and 11% of measured wall time across these six trials, but the sample is
small and its per-run time varies considerably.

## Scope of the conclusion

- **DeepSeek:** Retain v4. Neither base completed either harder task within the
  caps. The GPT base made one more partial workspace pass a strict evaluator,
  but did not yield additional completed tasks and used more total tokens.
  This is a weak *retain-the-default* decision, not proof v4 is intrinsically
  more capable. Longer time caps, task decomposition, or another model may be
  more relevant than base-prompt wording.
- **GPT-6 Luna:** Prefer a **Luna-only** simple-base rollout with monitoring
  and an easy rollback. V4 had two more completed user-contract passes in six
  trials, including preventing a secret disclosure in the second credential
  repetition, and was cheaper in this grid. Both prompts sometimes failed
  retry cancellation; v4 is not a universal fix. The one security failure is a
  reason to avoid assuming `gpt.md` is safer by default, not a statistical
  claim that v4 guarantees safety.
- **Do not generalize to GPT-5.x, GLM, or other GPT-6 variants.** They were not
  run here. The current family-wide profile selects `gpt.md`; applying this
  recommendation requires a narrowly scoped Luna override rather than
  replacing the GPT-family fallback.

The runs were serial and order reversed by repetition, but task order was
fixed. A local git baseline prevents history lookup; there is no hard
filesystem sandbox preventing a candidate that guesses an absolute path from
reading sibling `control/` files. No evaluator access was observed in the
retained traces. Candidate source trees at rewound commits include historical
prompts, although their executing `dist/prompts` files were held fixed within
each pair. Provider/service noise and only two samples per task limit causal
precision. Each candidate's uncommitted diff was retained locally for audit;
no candidate code was merged. Filtered transcripts and evaluator outcomes are
in ignored `.coord/generic-prompt-grid/` on this machine.
