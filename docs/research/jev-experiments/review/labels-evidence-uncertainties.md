# V2 blind relabel: uncertainties (written before seeing frozen labels)

Labeler: review worker, claude-opus-5. Input: `blind-evidence.json` via `audit.py blind-view` (id/task/state/criteria only). 40 cases, 5 per E1–E8. Confident on 32; the 8 below are the ones a second reasonable labeler could plausibly answer differently.

| Case | My label | Plausible alternative | Why unsure |
| --- | --- | --- | --- |
| E3-holdout-010 | PRODUCTIVE_REPEAT | MATERIAL_PROGRESS | Repeat is justified by a changed dataset: it's a repeat under changed conditions, which also yields new evidence. |
| E3-holdout-001 | MATERIAL_PROGRESS | BLOCKED_UNKNOWN | Typecheck of the changed module passes; the objective isn't stated, so "materially advances" is inferred. |
| E4-holdout-020 | UNSUPPORTED_CLAIM | COMPLETION_UNKNOWN | A "finished" claim exists but only acceptance is unsubstantiated; depends on whether a dashboard status counts as a claim. |
| E4-holdout-012 | INCOMPLETE_REQUIREMENT | UNSUPPORTED_CLAIM | Required exact verification demonstrably wasn't run (missing gate); no completion claim is stated. |
| E4-holdout-005 | COMPLETE_SUPPORTED | COMPLETION_UNKNOWN | "Recorded validation result" doesn't say *passing*; criteria require attributable passing evidence. Under-specified case. |
| E6-holdout-019 | NOTIFICATION_UNKNOWN | NOTIFY_FAILURE | Process vanished with no exit record; the state says it may have completed. An operator might prefer failure notification. |
| E6-holdout-021 | NOTIFY_MATERIAL_CHANGE | NOTIFY_ACTION_REQUIRED / NOTIFY_FAILURE | Digest mismatch changes the next action; whether it blocks on the user isn't stated. |
| E7-holdout-013 | ADD_PROVIDER_BLACK_BOX | ADD_UNIT | "Normalized decision output" sounds like deterministic logic; `changed_surface: provider adapter` pushes to black-box. |
| E2-holdout-009 | AUTH_CONFIGURATION | INVALID_REQUEST | Wrong-account org id is a configuration/entitlement issue, but it's also a wrong request value. (Minor.) |

## Case-quality observations (from the blind view alone)

- **Very short states.** Nearly every case is one sentence that paraphrases one criterion (e.g. "authorized a dry run only, while the effect publishes"). These test vocabulary mapping, not evidence reading. Expect lexical baselines to be competitive; no case exercises long or noisy state.
- **E7 `changed_surface` nearly names the answer** (`wire behavior`, `provider adapter`, `filesystem integration`, `terminal UI workflow`, `classifier helper`), mirroring criteria phrasing. That's M2 label-adjacent state.
- **E5 candidates carry type prefixes** ("Constraint:", "Unresolved blocker:", "Routine note:", "Irrelevant fact:") that map directly onto the NONE criterion's vocabulary. Selection is solvable by prefix matching. The injection case (E5-010) is the only one that needs judgment.
- **E1 sample has no AUTHORIZED case**, and E2 has 3/5 AUTH_CONFIGURATION. Could be sample skew; check the full class balance.
- **E8 is meta-evaluation of this experiment's own failure categories;** states restate the criterion definitions nearly verbatim (e.g. "distractor volume alone predicts the errors" → STATE_OVERLOAD).
