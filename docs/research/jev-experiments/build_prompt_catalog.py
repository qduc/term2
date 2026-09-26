#!/usr/bin/env python3
"""Export frozen, actually tested Choice prompts; never contacts a provider."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LANES = ("discovery", "discovery-extra", "routing", "evidence")


def main():
    catalog = {}
    synthesis = json.loads((ROOT / "synthesis.json").read_text())
    for lane in LANES:
        base = ROOT / lane
        freeze_path = base / "freeze.json"
        if not freeze_path.exists():
            raise ValueError(f"Unfinished lane: {lane}")
        freeze = json.loads(freeze_path.read_text())
        data_bytes = (base / "dataset.json").read_bytes()
        prompt_bytes = (base / "prompts.json").read_bytes()
        assert hashlib.sha256(data_bytes).hexdigest() == freeze["dataset_sha256"]
        assert hashlib.sha256(prompt_bytes).hexdigest() == freeze["prompts_sha256"]
        cases = json.loads(data_bytes)
        prompts = json.loads(prompt_bytes)
        holdout = [json.loads(line) for line in (base / "results/holdout.jsonl").read_text().splitlines() if line.strip()]
        for task, variant in freeze["selected_variants"].items():
            assert task not in catalog
            selected_cases = [c for c in cases if c["task"] == task]
            example = next(c for c in selected_cases if c["split"] == "dev")
            expected = {c["id"]: c["expected"] for c in selected_cases}
            task_results = [r for r in holdout if r["task"] == task]
            assert len(task_results) == 24
            failures = [{"case_id": r["case_id"], "expected": expected[r["case_id"]], "selected": r.get("choice"), "status": r["status"]} for r in task_results if r["status"] != "success" or r.get("choice") != expected[r["case_id"]]]
            catalog[task] = {
                "lane": lane,
                "variant": variant,
                "model_requested": freeze["model"],
                "dataset_sha256": freeze["dataset_sha256"],
                "prompts_sha256": freeze["prompts_sha256"],
                "instructions": freeze["selected_instructions"][task],
                "state_fields_observed": sorted({k for c in selected_cases for k in c["state"]}),
                "example_request": {
                    "model": freeze["model"],
                    "state": example["state"],
                    "questions": {"case": {
                        "type": "choice",
                        "instructions": freeze["selected_instructions"][task],
                        "criteria": example["criteria"],
                    }},
                },
                "all_variants": prompts[task],
                "observed_holdout_failures": failures,
                "correct_out_of_24": 24 - len(failures),
                "interpretation": synthesis[task],
                "note": "Example uses a development case. Criteria may vary per case; retain candidate IDs and descriptions. Selection is a pilot result, not a proven optimum.",
            }
    expected = {f"D{i}" for i in range(1, 7)} | {f"R{i}" for i in range(1, 7)} | {f"E{i}" for i in range(1, 9)}
    assert set(catalog) == expected
    output = {
        "run_id": "jev-fit-20260919",
        "scope": "Frozen selected prompts and representative wire bodies from the live Choice pilot. No API credentials, expected answers, rationales, or split metadata enter example requests. Separate failure annotations are audit metadata, never model input.",
        "tasks": catalog,
    }
    (ROOT / "prompt-catalog.json").write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")
    lines = ["# Tested Jev prompt catalog", "", "Exact development-selected instructions used for the main holdouts. These are candidates for the tested state contracts, not universal best prompts. Full representative request bodies, criteria, state fields, all losing variants, observed holdout failures, task-specific limitations, and frozen digests are in [prompt-catalog.json](prompt-catalog.json). Interpret alongside the experiment report and its task-specific limitations.", ""]
    for task, item in catalog.items():
        lines.extend([f"## {task}: {item['variant']}", "", item["instructions"], "", "Observed state fields: " + ", ".join(f"`{k}`" for k in item["state_fields_observed"]) + ".", "", f"Complete case-dependent criteria: [{item['lane']}/dataset.json]({item['lane']}/dataset.json).", ""])
    (ROOT / "prompt-catalog.md").write_text("\n".join(lines))
    print(f"Exported {len(catalog)} frozen task prompts")


if __name__ == "__main__":
    main()
