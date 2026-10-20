# Independent post-trial review

Reviewer: `codex/gpt-6.1-sol`, fresh read-only agent
`run_code_bridge_95:agent:1`, 2026-10-20. Verdict: **accept evidence-supported
study conclusion; reject promotion**. No files edited or providers launched.

The reviewer inspected protocol, amendment, runner, inventory, auditor,
conditions, all 24 script bodies and final answers, paged extraction, and selected
original NDJSON/read audits. It independently derived script errors 2→0,
calls 12→12, exact answers 8/12→10/12 and latency ratio 1.13083. It found only
two workflow wins, no error improvement in the DeepSeek stratum, and the two
candidate exact-answer regressions described in results.md. All candidate
scripts used allSettled without replay. No observed forbidden script effects.

## Findings triage

- **Narrow:** two candidate answer regressions and failed efficacy gates — reject
  the candidate, preserve production behavior. Do not tune or rerun observations.
- **Accept:** hash evidence was executed by the parent, not rerun by the read-only
  reviewer; clearly distinguish inspection from execution in the result report.
- **Accept:** fixed comparator matches provider instead of full model identity
  and assumes unique roster construction. The frozen protocol has exactly one
  model per provider; all 24 distinct expected trials were inspected. Do not
  generalize this runner without revisiting coverage, but do not change it now.
- **Accept:** regular-file inventory does not detect empty directories/metadata;
  the exposed graph cannot write them, and no observed script attempted writes.
- **Accept:** related cases, single samples and contained tool authority limit
  generalization. No production safety or population efficacy claim is made.

No routed implementation findings remain. The adequate alternative is
non-adoption and scoped reporting, not added runtime mechanisms.
