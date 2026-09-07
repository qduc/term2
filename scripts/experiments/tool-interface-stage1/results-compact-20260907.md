# Stage1 compact matrix results — 2026-09-07

Factual evidence only. Compact combined treatment (catalog-wide input signatures; purpose/returns on `tools.describe`; honest schema fallback; N1 KEEP lookup telemetry) vs baseline. The **run is valid**. This document does **not** declare the stage accepted, recommend merge, claim isolated-catalog causality, claim a production break-even, or treat compact-vs-full as a paired comparison. Parent owns the final judgment.

## Pins

| item | value |
| --- | --- |
| Baseline `source/` | `76e51d2497a2009f6011c15b694e201a08e9de79` (`sourceMatchesPin.matches: true`) |
| Bench HEAD at preflight | `812b952ffe95876687d05d4eff1ffb274ab7960c` |
| Compact candidate | `2890f0b9a78fa3af611d32472c6f400123485c92` (clean) |
| Treatment | compact-input-signatures combined treatment vs names-only nonessentials |
| Models | luna `codex/gpt-5.6-luna#medium`; glm `zai/glm-5.3-flash#medium`; deepseek `DeepSeek/deepseek-v4-flash#medium` |
| Matrix | 2 treated + 2 untreated × 3 models × 2 arms × 3 trials = **72 cells / 36 pairs** |
| Surface | non-interactive CLI lower bound (session tools absent) |

Historical full candidate `80f74884` and `results-20260907.md` remain preserved and **unaccepted**. Compact-vs-full numbers below are **indicative, not paired**.

## Invocation and terminal status

Reconstructed from `preflight/preflight.json` (`generatedAt` 2026-09-07T15:43:21.143Z, `estimated.cells` 72, `paid: true`, blockers `[]`) and parent terminal receipt `/tmp/tool-interface-compact-matrix-terminal.md`.

| clock | value |
| --- | --- |
| Terminal process | **exit 0** |
| Combined terminal wall | **1,086,431 ms = 18 m 6.431 s** (builds + driver preflight + 72 cells; **not** cell-only) |
| Sum of per-cell `wallTimeMs` | **1,077,062 ms** (mean 14,959 ms) |
| Remainder | 9,369 ms (rebuild/preflight/driver overhead, not model time) |

Do not infer elapsed from `generatedAt`. Elapsed and pass/fail are separate: the process succeeded; every cell also scored `correct`. `runInvalid: false`. No correctness regressions.

## Evidence paths (preserved; not rewritten)

- Run tree: `.bench-runs/compact-matrix72-20260907-2244/`
- Driver report: `report.json` (`generatedAt` 2026-09-07T16:01:18.717Z)
- Parent rescore: `report.rescored.json` (`generatedAt` 2026-09-07T16:01:26.474Z, `rescoredFrom` the driver report)
- Preflight: `preflight/preflight.json`
- 72 `cells/*/result.json` plus harvested `stdout.txt` and `logs/provider-traffic`

Original artifacts were not modified for this document. Aggregates below were reproduced by parsing those JSON files.

## Header parity (every cell)

Live raw headers (`source: provider-traffic-raw`) match construction snapshots and are constant per (model, arm):

| model | n cells / arm | baseline | compact | delta |
| --- | ---: | --- | --- | ---: |
| luna | 12 | 18 names / 1454 B | 18 names / 2291 B | +837 B |
| glm | 12 | 21 names / 2651 B | 21 names / 3488 B | +837 B |
| deepseek | 12 | 21 names / 2651 B | 21 names / 3488 B | +837 B |

36/36 pairs: name-set match, static-prose SHA match (`de585058…e62da`), `pairValid: true`. Interactive catalog (session tools) is not measured.

## Paired correctness

72/72 cells `outcome.kind === "correct"` and oracle-correct. 36/36 valid scored pairs. 0 infrastructure. 0 fairness invalid. `rejectEfficiencyClaims: false`. Identity 72/72 via `cost_update` (provider/model as pinned). Raw sidecar `body.reasoning.effort === "medium"` on **72/72** cells.

| model | treated pairs B/C | untreated pairs B/C |
| --- | --- | --- |
| luna | 6/6 and 6/6 | 6/6 and 6/6 |
| glm | 6/6 and 6/6 | 6/6 and 6/6 |
| deepseek | 6/6 and 6/6 | 6/6 and 6/6 |

Per task (9 cells/arm): all 9/9 correct on both arms for `contained-edit-port`, `retrieve-config-token`, `memory-billing-contact`, `skill-invoice-contact`.

Correctness is saturated. It does not show a treatment win; it also does not show a regression.

## Invalid params and run_code

| | baseline | compact | total |
| --- | ---: | ---: | ---: |
| `run_code` calls | 65 | 49 | 114 |
| invalid params | **10** | **3** | 13 |
| unknown tool | 1 | 0 | 1 |
| describe lookups | 0 | 0 | **0** |
| result-handling failures | 11 | 3 | 14 |
| recoveries | 11 | 3 | 14 |

All 13 invalid-param counts are on **memory-billing-contact**. Compact 3 remaining: luna trials 0 and 1, deepseek trial 0. Failures recovered in-cell (14/14). The one unknown-tool count is untreated control `deepseek__contained-edit-port__trial2` **baseline** (not a compact-arm event).

`tools.describe` **0/72**. Honest-fallback marker never observed. Those combined-treatment legs are unmeasured in this run.

### Remaining compact memory errors (read-only)

All three remaining compact invalids are the same concrete failure: `tools.memory_get({ …, scope: "project" })` → `(root): Unrecognized key: "scope"`. The compact signature taught at failure time is `tools.memory_get({ id: string, cursor?: string, maxChars?: number })` — `scope` is **not** in the input contract. The model added a key the schema rejects. This is not a missing-required-field repair; it is an extra-key hallucination after a correct compact signature.

| cell | first nested call | error |
| --- | --- | --- |
| `luna__memory-billing-contact__trial0` candidate | `memory_get({scope:"project", id:"northwind-billing"})` | unrecognized `scope` |
| `luna__memory-billing-contact__trial1` candidate | same | unrecognized `scope` |
| `deepseek__memory-billing-contact__trial0` candidate | `memory_get({ id, scope: "project" })` | unrecognized `scope` |

Baseline memory invalids in this run mixed extra keys (`scope`, `title`, `name`) and missing `id`. Compact did not eliminate extra-`scope` on luna (2/3 trials) or one deepseek trial. glm compact memory: 1→0.

## Prompt tokens (per-request sums)

250 provider requests. Per-turn prompt sums equal `promptTokensSum` on all 72 cells.

| arm | prompt tokens | cache-read tokens | requests | cell wall ms |
| --- | ---: | ---: | ---: | ---: |
| baseline | 1,289,416 | 895,680 | 130 | 549,848 |
| compact | 1,207,719 | 839,296 | 120 | 527,214 |
| **total** | **2,497,135** | **1,734,976** | **250** | **1,077,062** |

Compact **−81,697** prompt tokens vs baseline (−10 requests, −22,634 ms cell wall). That total is **not** a guaranteed per-model gain.

**Per-model total prompt deltas** (all four tasks, 24 cells/model):

| model | baseline prompt | compact prompt | Δ prompt | Δ % | baseline wall ms | compact wall ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| luna | 391,732 | 409,286 | +17,554 | **+4.5%** | 204,305 | 215,037 |
| glm | 384,110 | 362,940 | −21,170 | **−5.5%** | 223,808 | 198,791 |
| deepseek | 513,574 | 435,493 | −78,081 | **−15.2%** | 121,735 | 113,386 |

Mixed: luna net worse, glm and deepseek net better on total prompt tokens. Cache-read tokens are **within-arm only**. Do not compare cache across arms. Do not treat the pooled −81,697 as an all-model win.

Indicative (not paired) vs historical full `80f74884` totals: that run was luna **+18.4%**, glm **+10.1%**, deepseek **−3.2%**. Compact is cheaper on this snapshot, but cells are from a different date/run and must not be scored as a pair.

## Cost (catalog micros)

All 72 cells have `costKnown: true`. Sum **136,554 µUSD ≈ $0.137**.

| model | baseline µUSD | compact µUSD | sum |
| --- | ---: | ---: | ---: |
| luna | 36,596 | 39,645 | 76,241 |
| glm | 15,014 | 12,352 | 27,366 |
| deepseek | 17,256 | 15,691 | 32,947 |

Catalog µUSD is an **estimate from recorded usage and catalog rates**, not verified provider billing.

## Equal-turn pairs (confounded; not a header tax)

16/36 pairs have identical turn counts. Δ prompt/request in that sample is small (min 100, median ~188, mean ~189, max 262) relative to residual script/result/history variation. **Omitted as a causal header-tax estimate.** Same-turn pairs can still differ in nested scripts and conversation content.

## Treated-tool path vs essential bypass

G3 reporting: a treated-stratum cell counts as treated-path only if a treated nested tool ran.

| task (stratum) | treated-path cells | essential-bypass-only | no nested tools |
| --- | ---: | ---: | ---: |
| memory-billing-contact (treated) | 18/18 | 0 | 0 |
| skill-invoice-contact (treated) | 10/18 | **8** | 0 |
| contained-edit-port (control) | 0 | 18 | 0 |
| retrieve-config-token (control) | 0 | 17 | 1 |

**Split treated by task — do not pool the treated stratum.**

Memory (18/18 treated-path). Invalid params **10→3** (luna 3→2, glm 1→0, deepseek 6→1). Turns 32→22. Prompt:

| model | baseline | compact | Δ |
| --- | ---: | ---: | ---: |
| luna | 88,623 | 79,661 | −10.1% |
| glm | 77,083 | 58,725 | −23.8% |
| deepseek | 155,799 | 82,540 | −47.0% |

Skill (10/18 treated-path, **8 essential bypass** via nested `read_file` only — no `activate_skill`):

| cell | arm |
| --- | --- |
| `glm__skill-invoice-contact__trial0` | baseline |
| `glm__skill-invoice-contact__trial0` | candidate |
| `glm__skill-invoice-contact__trial1` | baseline |
| `glm__skill-invoice-contact__trial2` | baseline |
| `deepseek__skill-invoice-contact__trial0` | baseline |
| `deepseek__skill-invoice-contact__trial1` | baseline |
| `deepseek__skill-invoice-contact__trial1` | candidate |
| `deepseek__skill-invoice-contact__trial2` | baseline |

Luna skill: 6/6 `activate_skill`. Exclude the eight bypass cells from treated-stratum headlines. Skill prompt is mixed (luna +1.9%, glm −23.4%, deepseek +2.3%) and noisy.

Control nested tools were essential filesystem tools. One control cell (`luna__retrieve-config-token__trial2` candidate) completed correctly with **zero** `run_code` / nested-tool calls.

## Limitations

1. Non-interactive coverage: no session tools. Header bytes are a lower bound on interactive production.
2. Preflight `baselineDirty: true` (untracked `.bench-runs/`). `sourceMatchesPin.matches: true`. Candidate clean.
3. `reasoningEffort` is not on `cost_update`; verified from raw sidecar bodies.
4. Combined-treatment describe telemetry and honest-fallback produced **zero events**.
5. Compact-vs-full is a cross-run indication only.
6. Task-set error rate is not production prevalence. No break-even claim.
7. Combined terminal wall includes both CLI rebuilds; do not substitute cell-sum wall for that figure.

## Arithmetic checks performed

- 72 cells in 36 pairs; 12 pairs/model; 18 pairs/stratum.
- Header (count, bytes) unique per (model, arm) as tabled; 36/36 name + static match.
- Prompt 391,732+409,286+384,110+362,940+513,574+435,493 = 2,497,135.
- Cost 36,596+39,645+15,014+12,352+17,256+15,691 = 136,554 µUSD.
- Invalid 10+3 = 13, all on memory-billing-contact.
- Combined terminal wall 1,086,431 ms vs cell-sum 1,077,062 ms (documented remainder).

## Conclusion (evidence, not a merge decision)

The compact 72-cell run is **valid**. Correctness is at ceiling on both arms. Memory argument errors dropped 10→3 but did not reach zero; the three compact leftovers are extra `scope` on `memory_get` despite a signature that omits `scope`. Prompt effect is **mixed by model** (luna +4.5%, glm −5.5%, deepseek −15.2%). Skill remains a noisy stratum (8/18 `read_file` bypass). Parent decides whether that is enough to accept, iterate, or stop.
