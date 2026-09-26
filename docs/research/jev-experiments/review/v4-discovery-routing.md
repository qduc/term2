# V4: discovery (D1–D6) and routing (R1–R6) blind relabel, fixture audit, D1 live audit

Run `jev-fit-20260919` · task V4 · worker `review` (Claude Code, `claude-opus-5`, self-reported) · 2026-09-19. Extends [v4-discovery-d1.md](v4-discovery-d1.md). No lane edits, no API calls; `audit.py` unchanged (sha `8be6f9c9…`).

Datasets (sha256):
- `discovery/dataset.json` `9b0ddebc…530adc` (D1)
- `discovery-extra/dataset.json` `e60d1934…06b931a` (D2–D6; final per coordinator)
- `routing/dataset.json` `f9782dcc…4ccb9c`

## 1. Blind relabel: 60/60 agreement

Each label file was written and hashed before any lane file for that sample was opened:

| Sample | Label file (sha) | Agreement |
| --- | --- | --- |
| D1, 5 cases | `labels-discovery.json` `d70284e2…` | 5/5 |
| R1–R6, 30 cases | `labels-routing.json` `86e267d3…` | 30/30 (5/5 each) |
| D2–D6, 25 cases | `labels-discovery-extra.json` `77fda97e…` | 25/25 (5/5 each) |

Every pre-flagged uncertain case also matched. This confirms the labels are adjudicable on the sampled cases. It doesn't show they're hard; see the fixture channels below. Frozen headline labels are unchanged.

**Correction to my own blind note:** `labels-discovery-extra-uncertainties.md` says the D3–D6 criteria keys "look alphabetical". That was an artefact of `blind-view` printing with sorted keys. The actual criteria order puts the gold option first in most cases (§3). The persisted blind file is left as written.

## 2. Routing (R1–R6)

- **Contract** clean: 6 × 24/24, no duplicate states, one criteria set per task.
- **Balance:** answer position is **perfectly balanced** (each option first in exactly 12/48; position-only baseline 6/24 per split for every task), and classes are balanced 12/12/12/12. There's no position confound.
- **Overlap** low to moderate. R5 holdout→dev median 0.47 comes from the fixed `context_scope` sentence (scaffold).
- **Authored baseline** reproduces **288/288** from state+criteria (`choose` wrapper, per coordinator); static scan clean.
- **Baselines** (correct out of 24, holdout; authored / lexical / dev-majority), with the strongest in bold:

  | Task | Authored | Lexical | Dev-majority |
  | --- | --- | --- | --- |
  | R1 | 6 | **9** | 6 |
  | R2 | **8** | 5 | 6 |
  | R3 | 8 | **12** | 6 |
  | R4 | 10 | **12** | 6 |
  | R5 | **9** | 6 | 6 |
  | R6 | **12** | 6 | 6 |

  These are much harder for heuristics than the E-lane.
- **Material defect: R6 options aren't visible.** In 47/48 R6 states `options` is a narrative string ("Only the stated candidate summaries are eligible."), not a list. That includes **11/12 `select` cases**; only `R6-holdout-01` supplies a real option list. Correct `select`/`no_fit` answers therefore rest on narrated evidence ("Candidate B explicitly owns…", "each satisfy only one requirement"), not on inspecting candidates.
  - **Consequence:** R6 measures *admission judgment over narrated summaries*: select/abstain/reject/no_fit, per the coordinator's scope. It doesn't show that Jev can check options against constraints. Scope verdicts accordingly.
- **Evidence often states the conclusion** ("No useful subdivision exists" → solo; "The request exceeds the data boundary" → reject). The baselines stay low regardless, so this is a softness, not a triviality.
- **R1/R2:** rubric agreement only; routing economics untested (protocol).
- **Leakage flags:**
  - 19 `tag_word_in_state` hits are domain nouns that are also tags (test, fixture, provider, settings…), so not label hints.
  - 2 `only_expected_label_named_in_state`: `R4-holdout-19` evidence says "should stay solo" → **solo**. That one is a real answer-in-state leak; minor, one case. `R5-dev-13` is a weak lexical hit.

## 3. Discovery D2–D6 fixtures

- **Contract** clean: 5 × 24/24, no duplicate states.
- **Authored baseline reproduces 237/240.** The 3 mismatches (`D6-dev-10`, `D6-holdout-10`, `D6-holdout-24`) store `none`, but `predict()` returns a section on both full and stripped input. That's not leakage. They're the three D6 cases whose empty criterion descriptions the coordinator fixed before calls, and the stored field predates the fix. The stored `baseline` counts for D6 are therefore off by up to 3; recompute from `baseline.py` for reporting. Label-field reads are only in `main()` CLI lines 170/171/174, outside the predictor path.
- **Position and specificity channels (material):**

  | Task | Gold is first criteria key (all 48) | Position-only holdout* | Gold is the longest candidate text (non-none) | Gold first in state list | Authored holdout | Lexical holdout |
  | --- | --- | --- | --- | --- | --- | --- |
  | D2 | 5/48 | 2/24 | n/a | n/a | 10 | 2 |
  | D3 | 39/48 | **20/24** | 40/42 | 39/42 | **22** | 20 |
  | D4 | 38/48 | **19/24** | **42/42** | 38/42 | 17 | 19 |
  | D5 | 38/48 | **19/24** | 32/42 | 38/42 | 14 | 19 |
  | D6 | 38/48 | **19/24** | 41/42 | 38/42 | 9 | 19 |

  \*Post hoc, **not preregistered**. Matches the coordinator's figures (D3 20, D4–D6 19).
  - In D3/D4/D6 the gold item is the only full sentence among stubs ("Stall.", "pids.", "watching..."). "Pick the first option" or "pick the longest text" gets 19–22/24 on holdout without any relevance judgment.
  - **Consequence:** D3–D6 holdout accuracy up to about 20/24 is uninformative. Any Jev result on these tasks must be compared against the position-only and longest-text diagnostics, and gains within that range should be treated as possibly ordering- or length-driven.
- **D2** isn't position-biased (tool catalog in fixed order). Its high overlap (holdout→dev median 0.88, template_ratio 1.0) is the identical 16-tool catalog; on `user_request` text alone the median is 0.076. That's scaffold, not duplication. `none` is expected in 4 dev + 4 holdout cases, and 4/48 cases contain an ineligible tool, so the ineligible branch is only thinly covered.
- **D5-holdout-09** contains a planted "Select pass_wrong." passage, a good injection probe.

## 4. D1 live results

Records audited with the unchanged `audit.py score --freeze`:

| Record set | sha256 |
| --- | --- |
| `results/dev.jsonl` | `5193f8bf…78da78aa` |
| `results/holdout.jsonl` | `fdfef59b…5d0b2` |
| `results/stability.jsonl` | `16be52ed…42d` |
| `freeze.json` | `3df29be4…7413` |

- **Integrity:** 72 dev + 24 holdout + 4 stability records. All attributable with unique provider IDs, resolved `typesafe/jev-1.13-20260917`, and 0 payload problems. The dataset digest matches the freeze; no dev after the freeze and none of the holdout before it; stability orders correct. No failures; holdout p50 593 ms, p95 715 ms, 0 over 10 s.
- **Variant selection:** rubric 23 = scoped 23 > minimal 22 → scoped (tie rule). Weak evidence (margin 0).
- **Holdout scoped 21/24** (Wilson 0.69–0.96).

  | Comparator | Comparator correct | Jev W–L | Exact McNemar p |
  | --- | --- | --- | --- |
  | Authored baseline | 14 | 8–1 | 0.039 |
  | **Lexical (strongest preregistered)** | **16** | **6–1** | **0.125** |
  | Position-only (post hoc) | 17 | 5–1 | 0.22 |

- **Position split (post hoc):**
  - Jev is **16/17** when the answer is listed first and **5/7** when it isn't.
  - Jev picked the first-listed option in 18/24 holdout cases.
  - The not-first subset is only 7 cases, so it can't separate "understands the task" from "prefers position 1". Stability reversal (2 cases, both stable at conf ≥ 0.96) is too small to test it.
- **Errors:**
  - Two of the three `insufficient_evidence` holdout cases were answered with a concrete skill (`d1-holdout-20` → technical-writing, 0.43; `d1-holdout-21` → incident-debugging, 0.53). That's over-commitment on vague requests, the costly direction for skill suggestion.
  - One distractor case (`d1-holdout-12`) → `none` (under-selection).
- **Verdict (preregistered rules, then post-hoc downgrade):**
  - ≥ 20/24, but superiority over the strongest valid baseline isn't established (p=0.125), so **conditional fit**.
  - Post hoc: the gain over the position-only diagnostic is 5–1 (not significant) and concentrated in the answer-first subset. The D1 result **cannot be distinguished from ordering**.
  - Abstention on vague requests is weak (1/3), and `none` is untested on holdout.
  - **Scope:** "conditional fit, position-confounded; abstention not established".

## 5. Consequences for the pending live audits

- **D2–D6:** report each task's holdout score next to the position-only and longest-text diagnostics. Treat any score ≤ the diagnostic, or a paired gain that isn't significant against it, as uninformative about relevance judgment. Recompute the D6 baseline from `baseline.py` rather than the stored field.
- **Routing:** no position confound. Use the lexical/authored maximum per task as the bar. Scope R6 to narrated admission.
