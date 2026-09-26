# V4 blind relabel (routing R1–R6): uncertainties, written before seeing routing labels

Labeler: review worker, claude-opus-5. Input: `blind-routing.json` via `audit.py blind-view`. 30 cases, 5 per task. Confident on 23.

| Case | My label | Plausible alternative | Why unsure |
| --- | --- | --- | --- |
| R1-holdout-21 | fast | balanced | The replacement is derivable from package.json but not literally "supplied" by the user, as `fast` requires. |
| R2-holdout-03 | standard | minimal | Everything is named (editor, schema, text, test), but adding range validation is implementation, not an exact edit. |
| R2-holdout-10 | thorough | standard | Races + UI changes = subsystem interaction; "diagnose" could be read as bounded analysis. |
| R3-holdout-23 | reviewer | explorer | "Review … for duplicates" names an artifact (reviewer), but finding duplicates is also evidence collection. |
| R4-holdout-05 | parallel | solo | The two checks are independent (parallel), but both are small, so coordination cost could favour solo. |
| R5-holdout-16 | unknown | new_topic | "Run the destructive cleanup now" with no scope or authority. `unknown` covers insufficient context; nothing says it's a different objective. |
| R6-holdout-24 | no_fit | abstain | See the R6 defect below: "no supplied role has both attributes" implies no_fit, but no roles are actually supplied in state. |

## Fixture observations (blind view alone)

- **R6 options are never supplied (material).** Every R6 state has `options: "Only the stated candidate summaries are eligible."` but no candidate list. Cases that turn on "the listed formats" (R6-08) or "no supplied role" (R6-24) describe options the decision subject can't see. The evidence sentence asserts the conclusion instead ("each satisfy only one requirement"). So:
  - `select` can never be criterion-supported on this state shape;
  - `no_fit` vs `abstain` depends on trusting a narrated summary.

  Per the coordinator, R6 measures workflow admission (select/abstain/reject/no_fit), not ranking. Even so, admission without visible options is a narrated-verdict task. The sample has no `select` case.
- **Evidence fields often state the answer.** Examples: "The request exceeds the data boundary" (→reject), "No useful subdivision exists" (→solo), "Fixture contents require that evidence" (→serial), "Neither scope nor definition of done is present" (→none). Expect lexical/keyword baselines to be strong.
- **R1/R2 `none` cases dominate the sample** (R1 3/5, R2 2/5, R3 2/5). Labels are subjective routing judgments; per protocol, R1/R2 = rubric agreement only, economics untested.
- **R5-holdout-04** ("Accept the approval request."): the context says exact approval controls are excluded, so `unknown` = "deterministic control handling applies". A good boundary case.
