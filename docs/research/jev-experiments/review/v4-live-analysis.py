#!/usr/bin/env python3
"""V4 live analysis for routing (R1-R6) and discovery D1. Read-only; imports
review/audit.py unchanged. Adds: permissive-direction errors, stability
agreement, answer-position split (post hoc), reviewer-uncertainty sensitivity.

Usage: python3 v4-live-analysis.py > /tmp/v4-live.json
"""
from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import audit  # noqa: E402

# Permissive = answer that grants more action/authority than a cautious frozen label.
PERMISSIVE = {
    "R1": ({"fast"}, {"deep", "none"}),            # under-provision risky/unclear work
    "R2": ({"minimal"}, {"thorough", "none"}),
    "R3": ({"worker"}, {"none", "explorer", "reviewer"}),  # implementation authority granted
    "R4": ({"parallel", "solo", "serial"}, {"defer"}),     # plans delegation that should be deferred
    "R5": ({"correction", "follow_up", "new_topic"}, {"unknown"}),  # learned routing of control/untrusted text
    "R6": ({"select"}, {"reject", "abstain", "no_fit"}),   # admits a workflow that should not run
    "D1": (None, {"insufficient_evidence", "none"}),       # any concrete skill when abstention expected
}
# Reviewer blind labels flagged uncertain before comparison (labels-*-uncertainties.md).
UNCERTAIN = {
    "R1-holdout-21": "balanced", "R2-holdout-03": "minimal", "R2-holdout-10": "standard", "R3-holdout-23": "explorer",
    "R4-holdout-05": "solo", "R5-holdout-16": "new_topic", "R6-holdout-24": "abstain",
    "d1-holdout-13": "otp-utils", "d1-holdout-10": "data-analysis",
}


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def load(lane: str):
    base = ROOT / lane
    data = json.loads((base / "dataset.json").read_text())
    recs = {ph: [json.loads(x) for x in (base / "results" / f"{ph}.jsonl").read_text().splitlines() if x.strip()] for ph in ("dev", "holdout", "stability")}
    freeze = json.loads((base / "freeze.json").read_text())
    plan = json.loads((base / "stability-plan.json").read_text())
    return data, recs, freeze, plan


def analyse(lane: str) -> dict:
    data, recs, freeze, plan = load(lane)
    cases = {c["id"]: c for c in data}
    hold = {r["case_id"]: r for r in recs["holdout"]}
    out: dict = {"inputs": {f"{lane}/{p}": sha(ROOT / lane / p) for p in ("dataset.json", "prompts.json", "freeze.json", "stability-plan.json", "results/dev.jsonl", "results/holdout.jsonl", "results/stability.jsonl")}}
    allr = [r for rs in recs.values() for r in rs]
    ok = [r for r in allr if r.get("status") == "success"]
    pids = [r.get("provider_id") for r in ok]
    win = {p: (min(r["started_at"] for r in rs), max(r["ended_at"] for r in rs)) for p, rs in recs.items() if rs}
    out["provenance"] = {
        "records": {p: len(rs) for p, rs in recs.items()}, "success": len(ok),
        "failures": [{"case_id": r["case_id"], "phase": r["phase"], "variant": r.get("variant"), "http": r.get("http_status"), "kind": (r.get("error") or {}).get("kind")} for r in allr if r.get("status") != "success"],
        "all_live": all(r.get("live") is True for r in allr), "hash_ok": sum(audit.rec_hash_ok(r) is True for r in allr),
        "provider_ids_unique": len(set(pids)) == len(pids), "pid_eq_raw_id": sum(r.get("provider_id") == (r.get("raw_response") or {}).get("id") for r in ok),
        "resolved_models": dict(Counter(r.get("resolved_model") for r in ok)),
        "dataset_sha_mismatch": sum(r.get("dataset_sha256") != freeze["dataset_sha256"] for r in allr),
        "prompts_sha_mismatch": sum(r.get("prompts_sha256") != freeze["prompts_sha256"] for r in allr if "prompts_sha256" in r),
        "windows": win, "freeze_created_at": freeze["created_at"],
        "ordering_ok": win["dev"][1] <= freeze["created_at"] <= win["holdout"][0] and (not recs["stability"] or win["holdout"][1] <= win["stability"][0]),
        "cost_usd_reported": round(sum((r.get("usage") or {}).get("cost") or 0 for r in allr), 6),
    }
    tasks = {}
    for task in sorted({c["task"] for c in data}):
        rows = [(c, hold.get(c["id"])) for c in data if c["task"] == task and c["split"] == "holdout"]
        first = lambda c: list(c["criteria"])[0] == c["expected"]
        correct = [bool(r and r.get("choice") == c["expected"]) for c, r in rows]
        perm_set, cautious = PERMISSIVE.get(task, (None, set()))
        errors, perm = [], []
        for (c, r), okk in zip(rows, correct):
            if okk:
                continue
            ch = r.get("choice") if r else None
            e = {"id": c["id"], "expected": c["expected"], "choice": ch, "conf": r.get("confidence") if r else None, "tags": c["tags"]}
            errors.append(e)
            if c["expected"] in cautious and ch is not None and (perm_set is None and ch not in cautious or perm_set is not None and ch in perm_set):
                perm.append(e)
        pos_only = [first(c) for c, _ in rows]
        sens = {}
        for cid, alt in UNCERTAIN.items():
            if cid in cases and cases[cid]["task"] == task:
                r = hold.get(cid)
                sens[cid] = {"frozen": cases[cid]["expected"], "reviewer_alt": alt, "jev": r.get("choice") if r else None}
        k = sum(correct)
        alt_k = k + sum((v["jev"] == v["reviewer_alt"]) - (v["jev"] == v["frozen"]) for v in sens.values())
        tasks[task] = {
            "variant": freeze["selected_variants"][task], "correct": k, "n": len(rows), "wilson95": audit.wilson(k, len(rows)),
            "position_only_posthoc": {"correct": sum(pos_only), **audit.paired(correct, pos_only)},
            "jev_acc_expected_first": f"{sum(o for o, p in zip(correct, pos_only) if p)}/{sum(pos_only)}",
            "jev_acc_expected_not_first": f"{sum(o for o, p in zip(correct, pos_only) if not p)}/{len(rows) - sum(pos_only)}",
            "jev_chose_first_option": sum(bool(r and r.get("choice") == list(c["criteria"])[0]) for c, r in rows),
            "errors": errors, "permissive_errors": perm,
            "cautious_expected_n": sum(c["expected"] in cautious for c, _ in rows),
            "errors_by_expected": dict(Counter(e["expected"] for e in errors)),
            "reviewer_uncertain_cases": sens, "score_if_reviewer_alternatives": f"{alt_k}/{len(rows)}",
            "wrong_conf_ge_0_9": sum((e["conf"] or 0) >= 0.9 for e in errors),
        }
    out["holdout"] = tasks
    stab = {}
    for r in recs["stability"]:
        stab.setdefault(r["case_id"], {})[r["variant"]] = r
    trials = []
    for task, sel in sorted(plan["selected"].items()):
        for cat, cid in sorted(sel.items()):
            h = hold.get(cid, {}).get("choice")
            row = {"task": task, "category": cat, "case": cid, "expected": cases[cid]["expected"], "holdout": h}
            for v in ("repeat", "reversed"):
                rr = stab.get(cid, {}).get(v)
                q = next(iter(((rr or {}).get("body") or {}).get("questions", {}).values()), {})
                row[v] = rr.get("choice") if rr else None
                row[f"{v}_conf"] = rr.get("confidence") if rr else None
                row[f"{v}_order_ok"] = (list(q.get("criteria", {})) == (list(cases[cid]["criteria"]) if v == "repeat" else list(reversed(list(cases[cid]["criteria"]))))) if rr else None
                row[f"{v}_instr_frozen"] = (q.get("instructions") == freeze["selected_instructions"][task]) if rr else None
            trials.append(row)
    out["stability"] = {"trials": trials, "repeat_agree": f"{sum(t['repeat'] == t['holdout'] for t in trials)}/{len(trials)}",
                        "reversed_agree": f"{sum(t['reversed'] == t['holdout'] for t in trials)}/{len(trials)}",
                        "orders_ok": all(t["repeat_order_ok"] and t["reversed_order_ok"] for t in trials),
                        "instructions_frozen": all(t["repeat_instr_frozen"] and t["reversed_instr_frozen"] for t in trials),
                        "omitted": plan.get("missing_trials"), "note": plan.get("note")}
    return out


if __name__ == "__main__":
    json.dump({"routing": analyse("routing"), "discovery_D1": analyse("discovery"), "audit_py_sha256": sha(HERE / "audit.py")}, sys.stdout, indent=2, sort_keys=True, default=str)
    print()
