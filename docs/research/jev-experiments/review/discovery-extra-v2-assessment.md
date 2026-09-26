# V5: discovery-extra D2-D6 live-results audit

Run `jev-fit-20260919` · task V5 · worker `review` (`GPT-5.6 Sol`, self-reported) · 2026-09-19.

**Method:** blind relabel before unblinding, then unchanged `review/audit.py` checks over the frozen dataset and raw runner records. No provider calls, fixture edits, or benchmark reruns were made by this review.

**Scope:** these are provider-level **Choice** results on handcrafted synthetic cases. D3-D6 ask for one best candidate. They are not ranking metrics. In particular, D5 uses synthetic repository-flavored passages; it does not test retrieval or ranking over real source files.

## Decisions

| Task | Held-out result | Strongest simple baseline; paired W-L, exact p | Decision |
| --- | --- | --- | --- |
| D2 tool/MCP discovery | **24/24** rubric | authored 10/24; **14-0, p=0.00012** | **Promising pilot** for advisory top-1 tool choice within the supplied catalog |
| D3 memory retrieval | **23/24** scoped | authored 20/24; 3-0, p=0.25 | **Conditional fit**: superiority is not established and the only error is label-sensitive |
| D4 session retrieval | **22/24** scoped | authored 13/24; **9-0, p=0.00391** | **Conditional fit**: strong score, but duplicate-relevant excerpts make top-1 labels material |
| D5 code/search passage choice | **24/24** scoped | authored 14/24; **10-0, p=0.00195** | **Promising pilot** for synthetic top-1 passage choice, not real-code ranking |
| D6 output-section choice | **21/24** scoped | lexical 8/24; **14-1, p=0.00098** | **Conditional fit**: strong baseline improvement, but two errors have duplicate-relevant evidence and one scored fixture leaks rationale prose into evidence |

All held-out records were answered successfully, so correct/attempted equals correct/answered. Wilson 95% intervals are D2 and D5 `[0.8620, 1.0000]`, D3 `[0.7976, 0.9926]`, D4 `[0.7415, 0.9768]`, and D6 `[0.6900, 0.9566]`.

These verdicts apply only to the tested top-1 Choice contracts. They do not establish calibrated confidence, full ranking quality, production retrieval quality, or safe authority to block, kill, approve, or discard work.

## Provenance and integrity

Pinned inputs:

| Artifact | SHA-256 |
| --- | --- |
| `discovery-extra/dataset.json` | `11a6475a001b7cbdf41b6987bb5bdc7c9f9ec5c005630d2f6db12307a2961d83` |
| `discovery-extra/baseline.py` | `324aa7ff00d9db0f7bee7baa35b87b8b6023c007ffb82e7d8647db9969a678b1` |
| `discovery-extra/prompts.json` | `1d10a3203357fb77099418c2515e8c7dca95044df00e08bc3fbc10eeba564b74` |
| `discovery-extra/freeze.json` | `6061d72b7596731ea5854a32c2e719958316e7e19c8921e50c4c78f0be3bab6a` |
| `results/dev.jsonl` | `1fae0ef7f7f2040d6327f2ce3fd00d132ac2fb48c7da564040fc530414eadaa1` |
| `results/holdout.jsonl` | `f7dfb53ab5a056c9916c2a4c791c9ef43cc654c0045c0c7e86ecf40a6d1b0989` |
| `results/stability.jsonl` | `688d42bdccbbe165e3adbdf80ba4aec491d9d212bd4d5784537aaa408dc3fa67` |

- **500/500 records are live successes:** 360 development, 120 holdout, and 20 stability. All resolve to `typesafe/jev-1.13-20260917`, have HTTP 200, and have unique provider IDs.
- Independent scoring found no malformed JSONL, unknown case IDs, duplicate case/variant tuples, wrong dataset digests, or excluded mock/unattributable records.
- The freeze dataset digest matches. No development record starts after the freeze and no holdout record starts before it. The completed stability artifact contains exactly 20 records.
- Root independently verified all 500 raw records against the frozen payload hashes, states, and one-Choice-per-request contract. The raw schema uses `body`, `payload_sha256`, `duration_ms`, `raw_response`, `resolved_model`, `started_at`, `status`, and `choice`; the freeze timestamp is `created_at`.
- Every selected holdout instruction matches the freeze. The audit reports one payload problem, `D6-holdout-13`, because the gold rationale phrase also occurs in a candidate section and its criterion. This is evidence-text leakage/fixture ambiguity, not transmission of the dataset's `rationale` field, but the case cannot be treated as a clean independent semantic test.
- Provider IDs and usage are accepted from the response records; they were not cross-checked with OpenRouter or billing records.

## Blind label review

`labels-discovery-extra-v2.json` (SHA-256 `8aad1329bd6b1fd42bb33993f2914a51b1970c9cc3311f6b8c6c612549776b83`) and `uncertainties-discovery-extra-v2.md` (SHA-256 `e8f422c487c5fad9f4f46b509e3c10d3d3ba065bc689757fcb5d542229d278dd`) were written and hashed from the 25-case blind sample before the dataset, labels, or results were opened. They remain unchanged after unblinding.

Agreement was **22/25**:

| Task | Agreement | Frozen / reviewer disagreement |
| --- | --- | --- |
| D2 | 5/5 | none |
| D3 | 4/5 | `D3-holdout-11`: `none` / `mem_price` |
| D4 | 4/5 | `D4-holdout-23`: `sess_ts_language` / `sess_languages` |
| D5 | 5/5 | none |
| D6 | 4/5 | `D6-holdout-15`: `sec_trim_set` / `sec_preview` |

Jev chose the blind reviewer's alternative in all three disagreements. Headline scores retain the frozen gold. If each blind disagreement were adjudicated to the reviewer's choice, D3 would move 23→24, D4 22→23, and D6 21→22. That sensitivity does not upgrade any decision because D3 still lacks significant superiority and D4/D6 still contain duplicate-relevant candidates.

The blind notes also pre-registered close alternatives in `D3-holdout-17`, `D4-holdout-12`, and `D6-holdout-21`. The first two matched the frozen label. Jev's `D6-holdout-21` error chose the pre-identified relevant alternative `sec_heartbeat`, showing why exact top-1 accuracy overstates the distinction between relevance and gold preference.

## Development prompt selection

- D2: rubric 24/24, scoped 23/24, minimal 19/24. The one-case margin over scoped is weak evidence of prose superiority.
- D3-D6: minimal, rubric, and scoped each scored **24/24**. The freeze selected scoped by the predeclared tie rule. These ties provide **no evidence** that scoped prose is better than the other variants; an audit display that names `minimal` first is only deterministic tie ordering, not the frozen selection.

## Held-out errors and task interpretation

- **D3:** the sole error, `D3-holdout-11`, asks about OpenRouter alpha batch billing. `mem_price` directly states that the listed price does not establish batch billing; frozen `none` instead treats that as missing evidence. The model (confidence 0.52) and blind reviewer both chose `mem_price`. This is adjudication sensitivity, not clear retrieval failure.
- **D4:** `D4-holdout-23` is the blind disagreement between two excerpts that both name `languages/typescript.ts`. `D4-holdout-02` likewise has two excerpts that both give `run-code/scripted-e2e.test.ts`; the frozen preference contains extra suite-boundary detail. D4 demonstrates relevant-excerpt selection, but not reliable discrimination between near-duplicate relevant answers.
- **D6:** `D6-holdout-15` is the blind disagreement between observed truncation evidence and its trim-configuration cause. `D6-holdout-21` has two sections stating that monitor cancellation does not stop the job. `D6-holdout-20` has two sections stating that a scripted call still hit the output budget. Exact top-1 scoring penalizes all three, but only the first has an independently selected alternative label.

There were no provider, schema, or unanswered failures. The errors are semantic/top-1 distinctions, not transport failures.

## Stability and ordering

The preregistered stability set uses one ordinary and one adversarial holdout case per task, each repeated in original order and with criteria reversed:

- repeat: **10/10** correct;
- reversed order: **10/10** correct;
- all 20 HTTP 200 successes; original/reversed order recorded exactly as planned; no payload problems.

This is a useful small probe against simple order following. Two cases per task cannot establish general order invariance or adversarial robustness.

## Fixture and shortcut audit

- Contract checks pass for all 240 cases: 24 development + 24 holdout per task, unique IDs, valid expected/baseline choices, and no duplicate canonical states within or across splits/tasks.
- D2's holdout→development 5-gram overlap is high (median 0.883; template ratio 1.0) because every case repeats the fixed tool catalog and descriptions. It does not imply duplicate requests, but it means D2 mainly tests request-to-fixed-catalog matching.
- D3, D4, and D6 have no overlap pairs at the 0.6 threshold. D5 has one pair (`D5-dev-21` / `D5-holdout-23`, 0.659) and template ratio 0.083.
- Position counts are not dominated by one universal slot. Expected-first counts over 48 cases are D2 5, D3 5, D4 13, D5 11, and D6 12.
- **Post-hoc, not preregistered:** on the 24 held-out cases, a strict shortest-candidate heuristic would match D3 12, D4 2, D5 5, and D6 1 times; a longest-candidate heuristic would match 0, 9, 9, and 14. Neither length extreme explains all tasks, though D3-shortest and D6-longest remain visible fixture tendencies.
- Each D3-D5 case has four supplied candidates plus `none`; each D6 case has three sections plus `none`. Every task/split has three `none` labels. This is bounded candidate selection, not open-corpus retrieval.
- The authored baseline is reproducible from state and criteria alone for 240/240 cases. Its CLI-only reads of the stored `baseline` field are not on the predictor path.
- Eight tag-word leakage heuristics are benign matches to descriptive words or injected distractor text, not answer labels. The separate `D6-holdout-13` rationale-copy flag is material and remains disclosed above.

## Latency and reported usage

Main holdout latency is p50 566 ms, p95 711 ms, max 988 ms, with 0/120 over the production adapter's 10 s deadline. Stability max is 1.35 s, also with none over 10 s. Development also used one Choice per request; its latency is not pooled with the preregistered main holdout latency.

Provider-reported usage is:

| Phase | Input tokens | Output tokens | Reported cost |
| --- | ---: | ---: | ---: |
| development | 308,412 | 28,365 | $0.012953304 |
| holdout | 103,486 | 9,574 | $0.004346412 |
| stability | 17,456 | 1,606 | $0.000733152 |
| **total** | **429,354** | **39,545** | **$0.018032868** |

These are provider-returned fields, not independently billing-verified economics.

## What this does not establish

- No real-code, production-log, long-context, multilingual, or open-corpus retrieval evaluation.
- No listwise ranking, NDCG, recall@k, calibrated confidence threshold, Score/Noul primitive, or end-to-end workflow benefit.
- No authoritative guard or automatic discard policy; all positive decisions support advisory follow-up only.
- Holdout is author-visible and synthetic, with 24 cases per task and only a five-case blind sample per task.
- No external provider attribution or billing verification.
- Original gold labels and fixtures remain unchanged; label disagreements are sensitivity analysis only.
