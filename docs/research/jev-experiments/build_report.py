#!/usr/bin/env python3
"""Integrate frozen live results and reviewed judgments; no provider calls."""
import collections
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LANES = ("discovery", "discovery-extra", "routing", "evidence")


def read(path):
    return json.loads(path.read_text())


def records(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def percentile(values, q):
    values = sorted(values)
    return values[max(0, math.ceil(len(values) * q) - 1)]


def main():
    annotations = read(ROOT / "synthesis.json")
    aggregate = read(ROOT / "aggregate/summary.json")
    assert not aggregate["errors"], aggregate["errors"]
    all_records, held_records, rows = [], [], {}
    for lane in LANES:
        base = ROOT / lane
        data = read(base / "dataset.json")
        frozen = read(base / "freeze.json")
        for filename, key in (("dataset.json", "dataset_sha256"), ("prompts.json", "prompts_sha256")):
            assert hashlib.sha256((base / filename).read_bytes()).hexdigest() == frozen[key]
        assert aggregate["lanes"][lane]["complete"]
        phases = {phase: records(base / "results" / f"{phase}.jsonl") for phase in ("dev", "holdout", "stability")}
        all_records += sum(phases.values(), [])
        held_records += phases["holdout"]
        index = {c["id"]: c for c in data}
        for task, variant in frozen["selected_variants"].items():
            scores = aggregate["lanes"][lane]["holdout_selected_vs_baseline"]["tasks"][f"{task}|{variant}"]
            comparators = scores["paired_vs_baselines"]
            best_n = max(v["other_correct"] for v in comparators.values())
            # For tied baseline accuracy report every paired comparison, never pick the favourable p.
            best = {k: v for k, v in comparators.items() if v["other_correct"] == best_n}
            dev = {v: sum(r.get("choice") == index[r["case_id"]]["expected"] and r.get("status") == "success" for r in phases["dev"] if r["task"] == task and r["variant"] == v) for v in ("minimal", "rubric", "scoped")}
            assert sum(r["task"] == task for r in phases["dev"]) == 72
            assert scores["attempted"] == 24
            assert "Pending" not in annotations[task]["verdict"]
            rows[task] = {"lane": lane, "variant": variant, "dev_correct_out_of_24": dev, "holdout": scores, "strongest_baselines": best, **annotations[task]}
    assert set(rows) == set(annotations) and len(rows) == 20
    challenge = records(ROOT / "challenge/results/challenge.jsonl")
    all_records += challenge
    counts = collections.Counter(r["phase"] for r in all_records)
    failures = [r for r in all_records if r["status"] != "success"]
    usage = [r["raw_response"]["usage"] for r in all_records if isinstance(r.get("raw_response"), dict) and isinstance(r["raw_response"].get("usage"), dict)]
    cost = sum(u.get("cost", 0) for u in usage)
    timings = [r["duration_ms"] for r in held_records]
    resolved = collections.Counter(r.get("resolved_model") for r in all_records if r["status"] == "success")
    report = {"run_id": "jev-fit-20260919", "tasks": rows, "records_by_phase": dict(counts), "total_records": len(all_records), "failure_count": len(failures), "usage_records": len(usage), "provider_reported_cost_excluding_smoke_and_workers": cost, "resolved_models": dict(resolved), "holdout_latency_ms": {"n": len(timings), "p50": percentile(timings, .5), "p95": percentile(timings, .95), "max": max(timings), "over_10000": sum(t > 10000 for t in timings)}}
    (ROOT / "integrated-results.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# Jev in term2: live task-fit experiments",
        "",
        "Completed research pilot, 2026-09-19. No production behavior or settings were changed. The strongest evidence supports bounded advisory classification, including tool and code-passage selection, specialist selection, delegation advice, incoming-message intent and failure triage. Retrieval results need the task-specific qualifications below. Automatic approval, stopping, completion certification and output suppression are not supported by this experiment.",
        "",
        "Read the [exact tested prompts](prompt-catalog.md), [complete request examples and all variants](prompt-catalog.json), [machine-readable results](integrated-results.json), and [source-based opportunity inventory](../jev-decision-model-opportunities.md).",
        "",
        "## What was tested",
        "",
        f"20 task families, each with 24 development and 24 author-visible holdout cases: 960 main synthetic fixtures. Three prompt variants per task produced {counts['dev']} development requests; frozen selections produced {counts['holdout']} holdout requests. There were {counts['stability']} separate repeat/order requests and an 80-case challenge probe. Total: **{len(all_records)} live requests, {len(all_records)-len(failures)} successful responses**, excluding the one successful smoke request. Failures count as wrong; no retries replaced them.",
        "",
        "Subject: `typesafe/jev-1.13`, requested through term2's existing OpenRouter decision endpoint; successful responses resolved to `typesafe/jev-1.13-20260917`. The user's zai preference was applied to the GLM authoring worker. GLM, Codex, Claude and Grok authored or reviewed experiments; this is not a comparative benchmark of those workers as decision models. Grok used its default harness model without an override.",
        "",
        "Only **Choice top-1** was measured. Memory/session/code selection here does not establish full ranking, candidate-generation recall, or end-to-end retrieval quality. R1/R2 measure rubric agreement, not actual routed task quality or savings. R6 was narrowed to workflow-admission classification; generic programmable decisions remain unestablished.",
        "",
        "## Results by task",
        "",
        "All scores are out of 24. Development columns are minimal/rubric/scoped. Baseline is the strongest of the independently reproduced authored heuristic, independent lexical probe and dev-majority predictor. Exact two-sided paired McNemar p-values are exploratory and unadjusted across 20 tasks; they are screening evidence, not confirmatory population claims. If strongest baselines tie, all their p-values are shown. Full win/loss counts, class recall and Wilson intervals are retained in the audit JSON files.",
        "",
        "| Task | Dev m/r/s | Selected | Holdout | Best baseline | Paired p | Fit in this pilot |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for task in annotations:
        r = rows[task]
        dev = "/".join(str(n) for n in r["dev_correct_out_of_24"].values())
        best = r["strongest_baselines"]
        ps = ", ".join(f"{v:.5g}" for v in sorted({b['mcnemar_exact_p'] for b in best.values()}))
        lines.append(f"| {task} {r['name']} | {dev} | {r['variant']} | {r['holdout']['correct_over_attempted']} | {next(iter(best.values()))['other_correct']}/24 | {ps} | {r['verdict']} |")
    lines += ["", "The preregistered promising-pilot threshold was at least 20/24 plus paired improvement over the strongest baseline, without a material label dispute or required-invariant failure. Conditional means narrower use or no demonstrated superiority. Inconclusive includes unresolved fixture/label defects. The [preregistration](interpretation-preregistered.md) remains unchanged; coordinator qualifications appear explicitly in each task's interpretation.", "", "As an exploratory multiplicity sensitivity check, a Bonferroni cutoff of 0.05/20 retains the paired improvements for promising tasks D2, D5, R1, R3, R4 and R5; E1 and E2 do not pass that stricter screen. This does not replace the preregistered pilot rules. A perfect 24/24 still has a Wilson 95% lower bound of about 86%. These small synthetic samples cannot establish production reliability.", "", "## Prompting and state contracts", "", "Use the exact instructions together with their criteria and state shape in the catalog. Prompt prose alone is not the experiment. A development winner separated by zero, one or two cases is weak evidence of superiority; ties used scoped > rubric > minimal. Losing variants were not run on holdout, so the holdout cannot establish which variant is best.", ""]
    for task in annotations:
        r = rows[task]
        lines += [f"### {task}: {r['name']}", "", f"**{r['verdict']}.** {r['condition']}", "", r["prompt_guidance"], "", f"Tested instructions: [{task}, {r['variant']}](prompt-catalog.md#{task.lower()}-{r['variant']}); frozen criteria and states: [{r['lane']}/dataset.json]({r['lane']}/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.", ""]
    lines += [
        "## Reliability, latency and cost",
        "",
        f"Main holdout requests: p50 **{percentile(timings,.5):.0f} ms**, p95 **{percentile(timings,.95):.0f} ms**, maximum {max(timings):.0f} ms; {sum(t>10000 for t in timings)}/{len(timings)} exceeded the production adapter's ten-second deadline. These are provider-request timings, not end-to-end agent latency. The experimental runner allowed 60 seconds, so its behavior differs from the production adapter.",
        "",
        f"Provider-returned `usage.cost` sums to **${cost:.8f}** over {len(usage)} responses across development, holdout, stability and challenge. This excludes worker-harness spending and the smoke request ($0.000014574), and is not billing-verified. The two original development failures were HTTP 502 for E1 minimal after roughly 41–43 seconds; prompt comparisons on that task are partly confounded by transport failure. All variants used one question per request; generic audit notes about batched development latency do not describe this run.",
        "",
        "Stability trials are separate from headline accuracy and preserve failures. Ordinary and adversarial cases were selected in file order. Missing adversarial cases for E2/E6/R3/R4/R5 were omitted under recorded pre-call amendments, rather than using the original first-two-case fallback. Reversal changed criteria order only, not candidate order inside state. This sparse probe cannot establish order invariance or isolate stochastic variation from order effects. Across 35 sampled cases, repeat answers agreed with the original holdout in 33/35 and reversed-order answers in 32/35. Evidence: 12/14 and 12/14; routing: 9/9 and 8/9; D1: 2/2 and 2/2; D2–D6: 10/10 and 10/10. See each lane's stability-plan.json and aggregate results.",
        "",
        "The independent 80-case challenge scored **79/80** with its own scoped prompt. E8 confused a label-noise case with model disagreement after an injected annotator claim. This is a separate four-case-per-task probe, not transfer of the main selected prompts and not pooled with their holdouts. Grok later authored D2–D6, so challenge authorship is not independent of that lane; the challenge was already frozen and was not reused as its cases.",
        "",
        "## Evidence quality and deviations",
        "",
        "- Inputs and selected prompts were hashed and frozen before holdout calls; raw logs retain request bodies, body hashes, response IDs, resolved model, usage and timing. Labels, rationales, split names and baseline answers were excluded from model inputs. Independent scoring recomputes outcomes from those logs.",
        "- Holdouts were visible to the authors who wrote the prompts. Independent reviewers labelled five sampled holdout cases per task before viewing lane labels/results. This reduces obvious label errors; it does not create sealed or human-adjudicated ground truth. Label disagreements and uncertainties remain visible, with original scores preserved. The fresh D2–D6 blind sample agrees with gold in 22/25 (5/5, 4/5, 4/5, 5/5, 4/5 respectively); in all three disagreements the reviewer chose the same alternative as Jev.",
        "- D1 retains material answer-position bias. D3–D6 initially had short distractors and answer-first ordering; that version was rejected before provider calls. Final revisions and the [fresh blind audit](review/discovery-extra-v2-assessment.md) are documented with the retained dataset-v1-rejected.json. D6-holdout-13 has a rationale-substring audit flag in a competing section: no rationale field was sent, and the overlap does not identify the gold option. Post-hoc first-option/longest-text diagnostics are in aggregate/shortcuts.json and are not preregistered baselines.",
        "- E3/E4 and R2 have material label or state-contract problems. E5's preservation prefixes and E7's labelled change surfaces give simple heuristics most or all of the answer. High scores there do not establish added model value. R6 retained narrated options in 47/48 fixtures.",
        "- The challenge is too small for the main audit's 24/24 contract; those contract warnings are intentional and remain visible. It is reported separately.",
        "- No calibrated confidence threshold, long-context sweep, multilingual evaluation, provider-independent comparison, Score/Noul trial, production replay, or routed-task cost/quality result was established. These remain unmeasured possibilities, not successful uses.",
        "",
        "## Practical next steps",
        "",
        "1. Pilot failure triage and role/delegation/intent suggestions in shadow or advisory mode, preserving typed error handling, exact controls and user authority.",
        "2. Validate discovery on real candidate pools with balanced positions, substantial competing content, no-match cases and labelled relevance; measure whether suggestions actually reduce wrong loads or search work.",
        "3. Fix explicit requirements/evidence contracts before more completion or progress prompting. Compare compaction and test suggestions against the already-strong deterministic heuristics.",
        "4. For model/effort routing, run fixed-versus-routed complete tasks and count quality, retries, wall time, cache effects and total cost. Classification agreement cannot answer those questions.",
        "5. Evaluate Score, Noul, multi-question batching and genuinely agent-authored bounded decisions separately. Retain policy in each domain owner rather than granting one generic classifier authority.",
        "",
        "## Reproduction and artifact map",
        "",
        "Offline only; these commands do not invoke a provider:",
        "",
        "```sh",
        "python3 docs/research/jev-experiments/infra/runner.py selftest",
        "python3 docs/research/jev-experiments/review/audit.py --selftest",
        "python3 docs/research/jev-experiments/infra/aggregate.py",
        "python3 docs/research/jev-experiments/infra/shortcut_audit.py",
        "python3 docs/research/jev-experiments/build_prompt_catalog.py",
        "python3 docs/research/jev-experiments/build_report.py",
        "```",
        "",
        "- [Protocol and ownership](../jev-experiment-protocol.md), [worker lifecycle](coordination.json), and [predeclared interpretation](interpretation-preregistered.md). Dedicated Herdr workspace: w1J, Jev experiments; pre-existing panes were untouched.",
        "- Main inputs, selected prompts and raw logs: discovery/, discovery-extra/, routing/, evidence/. Each has dataset.json, prompts.json, freeze.json and results/*.jsonl.",
        "- [Evidence audit](review/evidence-live-assessment.md), [routing/skill audit](review/v4-live-assessment.md), [revised-discovery audit](review/discovery-extra-v2-assessment.md) and [final synthesis review](review/final-synthesis-review.md), and machine-readable aggregate/ audit outputs.",
        "- [Independent scorer documentation](review/audit-README.md). Mock selftests validate the experiment machinery, not model capability. No product source changed, so repository source-test gates were not triggered.",
        "",
    ]
    (ROOT / "README.md").write_text("\n".join(lines))
    print(f"Integrated {len(rows)} tasks and {len(all_records)} live request records")


if __name__ == "__main__":
    main()
