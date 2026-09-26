#!/usr/bin/env python3
"""Independent V1 audit for the Jev Choice pilot (run jev-fit-20260919).

Stdlib only; performs no network calls and never runs fixture strings as
commands. Written by the review worker independently of the lane workers and
of infra/runner.py; it imports nothing from them except, on explicit request,
a lane baseline module for the reproducibility check.

Blindness: `contract`, `overlap`, and `baselines` print only counts, indices,
and case IDs, never expected-label names (unless --show-labels), so the
reviewer can still relabel a blind sample afterwards. `blind-view` refuses
sample files that carry label-bearing fields.

Mock policy: any record with a truthy `mock`, or which lacks the attribution
fields a live runner record carries (request_hash, request_payload and, for
successes, a response object), is excluded from live counts and listed. The
--allow-mock flag exists only so that --selftest can exercise metric code on
declared fixtures; every result produced with it is stamped evidence=MOCK.

Subcommands (all print JSON):
  contract   DATASET...                    schema/leakage/duplication checks
  overlap    DATASET... [--threshold 0.6]  nearest-neighbour 5-gram overlap
  baselines  DATASET [--baseline-script P] independent baselines + authored-baseline reproducibility
  score      DATASET --records JSONL... [--phase holdout] [--freeze F]
  blind-view   --sample S                  print label-free sample for relabeling
  blind-compare DATASET --sample S --reviewer R   agreement with frozen labels
  --selftest                               explicit mock-fixture self-test
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.util
import json
import math
import re
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

PINNED_MODEL = "typesafe/jev-1.13"
PRODUCTION_DEADLINE_MS = 10_000
REQUIRED = ("id", "task", "split", "state", "criteria", "expected", "rationale", "provenance", "tags", "baseline")
SPLITS = ("dev", "holdout")
MIN_PER_SPLIT = 24
LEAKY_STATE_KEYS = {"expected", "answer", "label", "gold", "correct", "correct_answer", "rationale", "baseline", "ground_truth", "solution"}
TRANSPORT_KINDS = {"http", "URLError", "TimeoutError", "timeout", "ConnectionError"}
STOPWORDS = set(
    "the and for are but not you all any can had her was one our out has have this that with from they will would there their what when which who whom why how its into than then them these those been being more most other some such only own same very just also should could about above after again against below between both during each few further here once over under until while does did doing because where your yours".split()
)
Z95 = 1.959963984540054


# ---------------------------------------------------------------- utilities

def canonical(value: Any) -> str:
    """Same canonical form as infra/runner.py so request hashes are comparable."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def digest(value: Any) -> str:
    return sha256_text(canonical(value))


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: str | Path) -> Any:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def load_jsonl(paths: Iterable[str | Path]) -> tuple[list[dict[str, Any]], list[str]]:
    records, problems = [], []
    for path in paths:
        for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                problems.append(f"{path}:{number}: invalid JSON ({error.msg})")
                continue
            if isinstance(value, dict):
                value["_source"] = f"{Path(path).name}:{number}"
                records.append(value)
            else:
                problems.append(f"{path}:{number}: record is not an object")
    return records, problems


def leaves(value: Any, include_keys: bool = False) -> list[str]:
    """Flatten a JSON value to its scalar leaves (optionally with keys)."""
    out: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if include_keys:
                out.append(str(key))
            out.extend(leaves(item, include_keys))
    elif isinstance(value, list):
        for item in value:
            out.extend(leaves(item, include_keys))
    elif value is not None:
        out.append(str(value))
    return out


def all_keys(value: Any, in_list: bool = False, skip_list_items: bool = False) -> list[str]:
    """Object keys, recursively. With skip_list_items, keys of objects that sit
    inside arrays are omitted: e.g. candidates[].label is an identifier, not an
    answer field."""
    out: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if not (skip_list_items and in_list):
                out.append(str(key))
            out.extend(all_keys(item, in_list, skip_list_items))
    elif isinstance(value, list):
        for item in value:
            out.extend(all_keys(item, True, skip_list_items))
    return out


def tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", text.lower()) if len(t) >= 3 and t not in STOPWORDS}


def shingles(text: str, n: int = 5) -> set[str]:
    text = re.sub(r"\s+", " ", text.lower()).strip()
    return {text[i:i + n] for i in range(max(1, len(text) - n + 1))} if text else set()


def jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a or b else 1.0


def wilson(k: int, n: int, z: float = Z95) -> list[float] | None:
    if n == 0:
        return None
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return [round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)]


def mcnemar_exact(wins: int, losses: int) -> float:
    """Two-sided exact McNemar (binomial on discordant pairs, p=0.5)."""
    n = wins + losses
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, k) for k in range(min(wins, losses) + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def percentile(values: list[float], fraction: float) -> float | None:
    """Nearest-rank percentile; stated explicitly so it can be reproduced."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def by_task(dataset: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for case in dataset:
        if isinstance(case, dict):
            grouped[str(case.get("task"))].append(case)
    return dict(sorted(grouped.items()))


def load_datasets(paths: list[str]) -> tuple[list[dict[str, Any]], dict[str, str]]:
    combined: list[dict[str, Any]] = []
    digests: dict[str, str] = {}
    for path in paths:
        data = load_json(path)
        digests[path] = file_sha256(Path(path))
        if not isinstance(data, list):
            raise SystemExit(f"{path}: dataset must be a JSON array")
        combined.extend(data)
    return combined, digests


# ---------------------------------------------------------------- contract

def contract(dataset: list[Any]) -> dict[str, Any]:
    errors: list[str] = []
    ids: Counter[str] = Counter()
    counts: dict[str, Counter[str]] = defaultdict(Counter)
    leakage = defaultdict(list)
    position: dict[str, Counter[str]] = defaultdict(Counter)
    option_counts: dict[str, Counter[int]] = defaultdict(Counter)
    criteria_sets: dict[str, set[str]] = defaultdict(set)
    label_sets: dict[str, set[str]] = defaultdict(set)
    state_seen: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    tag_freq: dict[str, Counter[str]] = defaultdict(Counter)
    task_size: Counter[str] = Counter()
    for case in dataset:
        if isinstance(case, dict) and isinstance(case.get("tags"), list):
            task_size[str(case.get("task"))] += 1
            tag_freq[str(case.get("task"))].update({t for t in case["tags"] if isinstance(t, str)})
    # tags on more than half a task's cases (e.g. "synthetic") carry no label signal
    generic_tags = {task: {t for t, n in freq.items() if n > task_size[task] / 2} for task, freq in tag_freq.items()}
    for index, case in enumerate(dataset):
        where = f"case[{index}]"
        if not isinstance(case, dict):
            errors.append(f"{where}: not an object")
            continue
        missing = [key for key in REQUIRED if key not in case]
        if missing:
            errors.append(f"{where}: missing {missing}")
            continue
        cid, task, split, state, criteria = case["id"], case["task"], case["split"], case["state"], case["criteria"]
        where = f"{cid}" if isinstance(cid, str) else where
        if not isinstance(cid, str) or not cid:
            errors.append(f"{where}: id must be a nonempty string")
        ids[str(cid)] += 1
        if split not in SPLITS:
            errors.append(f"{where}: split must be dev|holdout")
        if not isinstance(state, dict):
            errors.append(f"{where}: state must be an object")
        if not isinstance(criteria, dict) or not criteria or not all(isinstance(k, str) and k and isinstance(v, str) and v.strip() for k, v in criteria.items()):
            errors.append(f"{where}: criteria must map nonempty labels to nonempty descriptions")
            continue
        labels = list(criteria)
        for field in ("expected", "baseline"):
            if case[field] not in criteria:
                errors.append(f"{where}: {field} not an allowed choice")
        if not isinstance(case["rationale"], str) or not case["rationale"].strip():
            errors.append(f"{where}: rationale must be nonempty text")
        # coordinator-approved (V2): provenance may be nonempty text or a nonempty object
        prov = case["provenance"]
        if not ((isinstance(prov, str) and prov.strip()) or (isinstance(prov, dict) and prov)):
            errors.append(f"{where}: provenance must be nonempty text or a nonempty object")
        if not isinstance(case["tags"], list) or not case["tags"] or not all(isinstance(t, str) and t for t in case["tags"]):
            errors.append(f"{where}: tags must be a nonempty string array")
        counts[str(task)][str(split)] += 1
        criteria_sets[str(task)].add(digest(criteria))
        label_sets[str(task)].add(canonical(sorted(labels)))
        option_counts[str(task)][len(labels)] += 1
        if case["expected"] in criteria:
            index_of = labels.index(case["expected"])
            position[str(task)][f"{index_of}/{len(labels)}"] += 1
        if isinstance(state, dict):
            state_seen[digest(state)].append((str(cid), str(task), str(split)))
            keys = {k.lower() for k in all_keys(state, skip_list_items=True)}
            if keys & LEAKY_STATE_KEYS:
                leakage["label_like_state_key"].append(str(cid))
            state_text = " ".join(leaves(state, include_keys=True)).lower()
            state_tokens = tokens(state_text)
            label_tok = {label: tokens(label.replace("_", " ").replace("-", " ")) for label in labels}
            exp = case["expected"]
            if exp in label_tok and label_tok[exp] and label_tok[exp] <= state_tokens and not any(t and t <= state_tokens for l, t in label_tok.items() if l != exp):
                leakage["only_expected_label_named_in_state"].append(str(cid))
            if isinstance(case["rationale"], str) and len(case["rationale"]) >= 20 and case["rationale"].lower() in state_text:
                leakage["rationale_copied_into_state"].append(str(cid))
            if any(isinstance(t, str) and len(t) >= 4 and t not in generic_tags.get(str(task), set()) and re.search(rf"\b{re.escape(t.lower())}\b", state_text) for t in case["tags"] if isinstance(case["tags"], list)):
                leakage["tag_word_in_state"].append(str(cid))
            if isinstance(cid, str) and isinstance(exp, str) and len(exp) >= 3 and exp.lower() in cid.lower():
                leakage["expected_label_in_id"].append(str(cid))
    for cid, n in ids.items():
        if n > 1:
            errors.append(f"duplicate id {cid} x{n}")
    for task, split_counts in sorted(counts.items()):
        for split in SPLITS:
            if split_counts[split] < MIN_PER_SPLIT:
                errors.append(f"{task}: {split} has {split_counts[split]} < {MIN_PER_SPLIT}")
    duplicates = {"cross_split": [], "within_split": [], "cross_task": []}
    for group in state_seen.values():
        if len(group) < 2:
            continue
        ids_in = [g[0] for g in group]
        if len({g[1] for g in group}) > 1:
            duplicates["cross_task"].append(ids_in)
        elif len({g[2] for g in group}) > 1:
            duplicates["cross_split"].append(ids_in)
        else:
            duplicates["within_split"].append(ids_in)
    tasks = {}
    for task in sorted(counts):
        total = sum(position[task].values())
        first = sum(v for k, v in position[task].items() if k.startswith("0/"))
        last = sum(v for k, v in position[task].items() if int(k.split("/")[0]) == int(k.split("/")[1]) - 1)
        expected_first = sum(v / int(k.split("/")[1]) for k, v in position[task].items())
        tasks[task] = {
            "counts": dict(counts[task]),
            "distinct_criteria_sets": len(criteria_sets[task]),
            "distinct_label_sets": len(label_sets[task]),
            "option_count_distribution": dict(sorted(option_counts[task].items())),
            "expected_position": dict(sorted(position[task].items())),
            "expected_first_count": first,
            "expected_last_count": last,
            "first_count_if_position_uniform": round(expected_first, 2),
            "n_with_valid_expected": total,
        }
    return {
        "ok": not errors and not any(duplicates.values()),
        "errors": errors,
        "tasks": tasks,
        "duplicate_states": duplicates,
        "leakage_flags": {k: sorted(v) for k, v in sorted(leakage.items())},
        "note": "Leakage flags are heuristics that name case IDs only; each needs human inspection.",
    }


# ---------------------------------------------------------------- overlap

def overlap(dataset: list[dict[str, Any]], threshold: float = 0.6) -> dict[str, Any]:
    """Char 5-gram Jaccard over state *values* (keys excluded: shared schema
    keys would inflate every pair). Reports holdout->nearest-dev and the
    nearest-other-case within each task (template detection)."""
    out = {}
    for task, cases in by_task(dataset).items():
        sig = {c["id"]: shingles(" ".join(leaves(c.get("state")))) for c in cases if isinstance(c.get("state"), dict)}
        dev = [c["id"] for c in cases if c.get("split") == "dev" and c["id"] in sig]
        hold = [c["id"] for c in cases if c.get("split") == "holdout" and c["id"] in sig]
        cross, flagged = [], []
        for h in hold:
            best = max(((jaccard(sig[h], sig[d]), d) for d in dev), default=(0.0, None))
            cross.append(best[0])
            if best[0] >= threshold:
                flagged.append({"holdout": h, "dev": best[1], "jaccard": round(best[0], 3)})
        ids = list(sig)
        nearest_any = []
        for a in ids:
            nearest_any.append(max((jaccard(sig[a], sig[b]) for b in ids if b != a), default=0.0))
        def summary(values: list[float]) -> dict[str, Any]:
            return {"n": len(values), "min": round(min(values), 3) if values else None, "median": round(percentile(values, 0.5), 3) if values else None, "max": round(max(values), 3) if values else None}
        out[task] = {
            "holdout_to_nearest_dev": summary(cross),
            "holdout_pairs_at_or_above_threshold": sorted(flagged, key=lambda f: -f["jaccard"]),
            "any_case_to_nearest_other": summary(nearest_any),
            "template_ratio": round(sum(v >= threshold for v in nearest_any) / len(nearest_any), 3) if nearest_any else None,
        }
    return {"threshold": threshold, "method": "char 5-gram Jaccard over state leaf values, lowercased, whitespace-collapsed", "tasks": out}


# ---------------------------------------------------------------- baselines

def lexical_choice(state: Any, criteria: dict[str, str]) -> str:
    """Independent token-overlap probe. Reads ONLY state and criteria.
    score(option) = |tokens(label+description) & tokens(state)| / |tokens(label+description)|;
    ties resolve to the earliest criteria key (disclosed position dependence)."""
    state_tokens = tokens(" ".join(leaves(state, include_keys=True)))
    best, best_score = None, -1.0
    for label, description in criteria.items():
        option_tokens = tokens(label.replace("_", " ").replace("-", " ") + " " + description)
        score = len(option_tokens & state_tokens) / len(option_tokens) if option_tokens else 0.0
        if score > best_score:
            best, best_score = label, score
    return str(best)


def dev_majority_labels(dataset: list[dict[str, Any]]) -> dict[str, str]:
    """Per-task majority of DEV expected labels only. Ties -> lexicographically
    smallest label. Holdout labels are never read here."""
    majority = {}
    for task, cases in by_task(dataset).items():
        tally = Counter(c["expected"] for c in cases if c.get("split") == "dev")
        if tally:
            top = max(tally.values())
            majority[task] = min(label for label, n in tally.items() if n == top)
    return majority


def dev_majority_choice(case: dict[str, Any], majority: dict[str, str]) -> str | None:
    label = majority.get(case["task"])
    return label if label in case["criteria"] else None  # None = inapplicable, scored wrong


def stripped_case(case: dict[str, Any], index: int) -> dict[str, Any]:
    """What a legitimate baseline may see: neutral id, task, state, criteria."""
    return {"id": f"audit-{index:05d}", "task": case["task"], "state": json.loads(canonical(case["state"])), "criteria": dict(case["criteria"])}


FORBIDDEN_BASELINE_PATTERNS = {
    "reads_label_field": r"""\[\s*['"](expected|rationale|tags|provenance|baseline)['"]\s*\]|\.get\(\s*['"](expected|rationale|tags|provenance)['"]""",
    "process_or_eval": r"\bsubprocess\b|os\.system|os\.popen|\beval\(|\bexec\(",
    "network": r"\burllib\b|\bsocket\b|\brequests\b|\bhttp\.client\b",
    "nondeterminism": r"\brandom\b|\btime\.time\(|datetime\.now|\buuid\b",
}


LABEL_FIELDS_READ = {"expected", "rationale", "tags", "provenance", "baseline"}


def baseline_static_scan(path: Path, predictor: str | None = None) -> dict[str, Any]:
    """Line-regex scan for process/network/nondeterminism, plus an AST scan for
    label-field reads that attributes each read to its enclosing function and
    says whether that function is reachable from the predictor. A read in CLI
    reporting code (e.g. main() comparing stored vs predicted baseline) is
    listed but is not predictor leakage."""
    source = path.read_text(encoding="utf-8")
    hits: dict[str, Any] = {}
    for number, line in enumerate(source.splitlines(), 1):
        code = line.split("#", 1)[0]
        for name, pattern in FORBIDDEN_BASELINE_PATTERNS.items():
            if name != "reads_label_field" and re.search(pattern, code):
                hits.setdefault(name, []).append(number)
    tree = ast.parse(source)
    funcs = {n.name: n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    calls = {name: {c.func.id for c in ast.walk(node) if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)} for name, node in funcs.items()}
    reachable: set[str] = set()
    frontier = [predictor] if predictor in funcs else []
    while frontier:
        name = frontier.pop()
        if name in reachable:
            continue
        reachable.add(name)
        frontier.extend(c for c in calls.get(name, ()) if c in funcs)
    reads = []
    for name, node in funcs.items():
        for sub in ast.walk(node):
            key = None
            if isinstance(sub, ast.Subscript) and isinstance(sub.slice, ast.Constant) and sub.slice.value in LABEL_FIELDS_READ:
                key = sub.slice.value
            elif isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) and sub.func.attr == "get" and sub.args and isinstance(sub.args[0], ast.Constant) and sub.args[0].value in LABEL_FIELDS_READ:
                key = sub.args[0].value
            if key:
                reads.append({"field": key, "line": sub.lineno, "function": name, "in_predictor_path": name in reachable})
    module_level = [n.lineno for n in tree.body if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom))
                    and any(isinstance(s, ast.Constant) and s.value in LABEL_FIELDS_READ for s in ast.walk(n))]
    if reads:
        hits["label_field_reads"] = sorted(reads, key=lambda r: r["line"])
    if any(r["in_predictor_path"] for r in reads) or module_level:
        hits["reads_label_field"] = sorted({r["line"] for r in reads if r["in_predictor_path"]} | set(module_level))
    return hits


def load_baseline_function(path: Path, name: str | None):
    spec = importlib.util.spec_from_file_location(f"lane_baseline_{sha256_text(str(path))[:8]}", path)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(path.parent))
    try:
        spec.loader.exec_module(module)  # executes lane code; opt-in only
    finally:
        sys.path.pop(0)
    for candidate in ([name] if name else ["choose", "predict_case", "predict"]):
        if candidate and callable(getattr(module, candidate, None)):
            return candidate, getattr(module, candidate)
    raise SystemExit(f"{path}: no baseline function among choose/predict_case/predict (use --baseline-func)")


def baselines(dataset: list[dict[str, Any]], script: str | None = None, func: str | None = None) -> dict[str, Any]:
    majority = dev_majority_labels(dataset)
    result: dict[str, Any] = {"tasks": {}}
    repro: dict[str, Any] = {}
    fn = None
    if script:
        path = Path(script)
        repro["script"] = str(path)
        repro["script_sha256"] = file_sha256(path)
        repro["function"], fn = load_baseline_function(path, func)
        repro["static_scan"] = baseline_static_scan(path, repro["function"])
    for task, cases in by_task(dataset).items():
        row: dict[str, Any] = {}
        for split in SPLITS:
            split_cases = [c for c in cases if c.get("split") == split]
            n = len(split_cases)
            stored = sum(c["baseline"] == c["expected"] for c in split_cases)
            lexical = sum(lexical_choice(c["state"], c["criteria"]) == c["expected"] for c in split_cases)
            maj_pred = [dev_majority_choice(c, majority) for c in split_cases]
            maj = sum(p == c["expected"] for p, c in zip(maj_pred, split_cases))
            row[split] = {
                "n": n,
                "authored_stored_correct": stored,
                "lexical_probe_correct": lexical,
                "dev_majority_correct": maj,
                "dev_majority_inapplicable": sum(p is None for p in maj_pred),
            }
        result["tasks"][task] = row
    if fn is not None:
        mismatches, crashes = [], []
        for index, case in enumerate(dataset):
            try:
                choice = fn(stripped_case(case, index))
            except Exception as error:  # a crash on a stripped case = it needed forbidden fields
                crashes.append({"id": case["id"], "error": type(error).__name__, "message": str(error)[:120]})
                continue
            if choice != case["baseline"]:
                mismatches.append(case["id"])
        repro.update({"n": len(dataset), "matches_stored_field": len(dataset) - len(mismatches) - len(crashes), "mismatch_ids": mismatches, "crashes_on_state_and_criteria_only": crashes,
                      "reproducible_from_state_and_criteria": not mismatches and not crashes and not ({k: v for k, v in repro["static_scan"].items() if k != "label_field_reads"})})
        result["authored_baseline_reproducibility"] = repro
    result["dev_majority_label_names"] = "hidden (use --show-labels)"
    result["_majority"] = majority
    return result


# ---------------------------------------------------------------- scoring

# Runner record schema drifted during authoring (result/request_payload/request_hash/response
# -> status/body/payload_sha256/raw_response + live/dataset_sha256/http_status/provider_id).
# Accessors accept both; the hash rule follows whichever hash field is present.

def rec_status(record: dict[str, Any]) -> Any:
    return record.get("status", record.get("result"))


def rec_payload(record: dict[str, Any]) -> Any:
    return record.get("body", record.get("request_payload"))


def rec_response(record: dict[str, Any]) -> Any:
    return record.get("raw_response", record.get("response"))


def wire_digest(value: Any) -> str:
    """infra/runner.py payload_sha256: insertion-order compact JSON."""
    return sha256_text(json.dumps(value, separators=(",", ":"), ensure_ascii=True))


def rec_hash_ok(record: dict[str, Any]) -> bool | None:
    payload = rec_payload(record)
    if isinstance(record.get("payload_sha256"), str):
        return wire_digest(payload) == record["payload_sha256"]
    if isinstance(record.get("request_hash"), str):
        return digest(payload) == record["request_hash"]
    return None


def is_mock(record: dict[str, Any]) -> str | None:
    if record.get("mock") or str(record.get("evidence", "")).upper() == "MOCK":
        return "declared_mock"
    if "live" in record and record.get("live") is not True:
        return "not_marked_live"
    if not isinstance(rec_payload(record), dict) or rec_hash_ok(record) is None:
        return "missing_request_attribution"
    if rec_status(record) == "success" and not isinstance(rec_response(record), dict):
        return "success_without_response_body"
    if "live" in record and "http_status" not in record:
        return "live_without_http_status"
    return None


def failure_class(record: dict[str, Any]) -> str:
    if rec_status(record) == "success":
        return "success"
    kind = str((record.get("error") or {}).get("kind", ""))
    if record.get("http_status") == 200 or kind in ("ValueError", "JSONDecodeError"):
        return "schema_or_answer"  # runner files these under transport_error; separated here
    if kind in TRANSPORT_KINDS or "timeout" in kind.lower():
        return "transport"
    return "other_error"


def payload_checks(record: dict[str, Any], case: dict[str, Any], frozen_instructions: str | None) -> list[str]:
    problems = []
    payload = rec_payload(record)
    if not isinstance(payload, dict):
        return ["no request payload/body"]
    if set(payload) != {"model", "state", "questions"}:
        problems.append(f"payload keys {sorted(payload)}")
    if payload.get("model") != PINNED_MODEL:
        problems.append("payload model not pinned")
    if rec_hash_ok(record) is not True:
        problems.append("payload hash does not match stored payload")
    if canonical(payload.get("state")) != canonical(case["state"]):
        problems.append("payload state differs from dataset state")
    questions = payload.get("questions")
    if not isinstance(questions, dict) or len(questions) != 1:
        problems.append("expected exactly one question")
    else:
        question = next(iter(questions.values()))
        if not isinstance(question, dict) or set(question) != {"type", "instructions", "criteria"}:
            problems.append("question has unexpected fields")
        else:
            if canonical(question["criteria"]) != canonical(case["criteria"]):
                problems.append("payload criteria differ from dataset criteria")
            elif not isinstance(question["criteria"], dict) or list(question["criteria"]) not in (list(case["criteria"]), list(reversed(list(case["criteria"])))):
                problems.append("criteria order is neither original nor reversed")
            if frozen_instructions is not None and question["instructions"] != frozen_instructions:
                problems.append("instructions differ from frozen selection")
            leak_text = canonical(question.get("instructions", "")) + canonical(payload.get("state"))
            for field in ("rationale",):
                value = case.get(field)
                if isinstance(value, str) and len(value) >= 20 and value in leak_text:
                    problems.append(f"{field} text present in payload")
    return problems


def per_class(pairs: list[tuple[str, str | None]]) -> tuple[dict[str, Any], float | None]:
    """pairs = (expected, predicted-or-None). None counts as wrong."""
    support = Counter(e for e, _ in pairs)
    hits = Counter(e for e, p in pairs if p == e)
    recall = {label: f"{hits[label]}/{support[label]}" for label in sorted(support)}
    balanced = sum(hits[l] / support[l] for l in support) / len(support) if support else None
    return recall, (round(balanced, 4) if balanced is not None else None)


def paired(model_ok: list[bool], other_ok: list[bool]) -> dict[str, Any]:
    wins = sum(m and not o for m, o in zip(model_ok, other_ok))
    losses = sum(o and not m for m, o in zip(model_ok, other_ok))
    return {"other_correct": sum(other_ok), "model_wins": wins, "model_losses": losses, "mcnemar_exact_p": round(mcnemar_exact(wins, losses), 5)}


def score(dataset: list[dict[str, Any]], records: list[dict[str, Any]], phase: str, freeze: dict[str, Any] | None = None,
          dataset_sha: str | None = None, allow_mock: bool = False) -> dict[str, Any]:
    cases = {c["id"]: c for c in dataset}
    majority = dev_majority_labels(dataset)
    excluded, unknown = [], []
    live: list[dict[str, Any]] = []
    for record in records:
        if record.get("phase") != phase:
            continue
        reason = is_mock(record)
        if reason and not allow_mock:
            excluded.append({"source": record.get("_source"), "reason": reason})
            continue
        if record.get("case_id") not in cases:
            unknown.append(record.get("_source"))
            continue
        live.append(record)
    keys = Counter((r.get("case_id"), r.get("variant")) for r in live)
    duplicate_keys = sorted(f"{c}|{v}" for (c, v), n in keys.items() if n > 1)
    first = {}
    for record in live:  # append-only: first record per tuple is authoritative
        first.setdefault((record["case_id"], record.get("variant")), record)
    frozen_by_task = (freeze or {}).get("selected_instructions", {}) if phase == "holdout" else {}
    out: dict[str, Any] = {
        "evidence": "MOCK" if allow_mock else "live-eligible records only",
        "phase": phase,
        "records_in_phase_used": len(first),
        "excluded_unattributable_or_mock": excluded,
        "unknown_case_ids": unknown,
        "duplicate_case_variant_tuples": duplicate_keys,
        "freeze_checks": {},
        "tasks": {},
    }
    if freeze is not None:
        out["freeze_checks"]["dataset_sha_matches_freeze"] = (dataset_sha == freeze.get("dataset_sha256")) if dataset_sha else "dataset sha not supplied"
        stamps = [r.get("started_at", r.get("timestamp")) for r in live if isinstance(r.get("started_at", r.get("timestamp")), str)]
        if stamps and isinstance(freeze.get("created_at"), str):
            if phase == "holdout":
                out["freeze_checks"]["records_before_freeze"] = sum(s < freeze["created_at"] for s in stamps)
            elif phase == "dev":
                out["freeze_checks"]["records_after_freeze"] = sum(s > freeze["created_at"] for s in stamps)
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for (cid, variant), record in first.items():
        grouped[(cases[cid]["task"], str(variant))].append(record)
    for (task, variant), recs in sorted(grouped.items()):
        split = "dev" if phase == "dev" else "holdout"
        universe = [c for c in dataset if c["task"] == task and c.get("split") == split]
        by_case = {r["case_id"]: r for r in recs}
        rows = []
        for case in universe:
            record = by_case.get(case["id"])
            klass = failure_class(record) if record else "not_attempted"
            choice = record.get("choice") if record and klass == "success" and record.get("choice") in case["criteria"] else None
            rows.append((case, record, klass, choice))
        attempted = [r for r in rows if r[1] is not None]
        answered = [r for r in attempted if r[3] is not None]
        correct = sum(r[3] == r[0]["expected"] for r in attempted)
        confusion: dict[str, Counter[str]] = defaultdict(Counter)
        for case, _, klass, choice in attempted:
            confusion[case["expected"]][choice if choice is not None else f"<{klass}>"] += 1
        recall, balanced = per_class([(r[0]["expected"], r[3]) for r in attempted])
        model_ok = [r[3] == r[0]["expected"] for r in attempted]
        comparisons = {
            "authored_stored_baseline": paired(model_ok, [r[0]["baseline"] == r[0]["expected"] for r in attempted]),
            "lexical_probe": paired(model_ok, [lexical_choice(r[0]["state"], r[0]["criteria"]) == r[0]["expected"] for r in attempted]),
            "dev_majority": paired(model_ok, [dev_majority_choice(r[0], majority) == r[0]["expected"] for r in attempted]),
        }
        durations = [float(r[1]["duration_ms"]) for r in attempted if isinstance(r[1].get("duration_ms"), (int, float))]
        payload_problems = {}
        for case, record, _, _ in attempted:
            problems = payload_checks(record, case, frozen_by_task.get(task))
            if problems:
                payload_problems[case["id"]] = problems
        response_models = Counter(str(r[1].get("resolved_model") or rec_response(r[1]).get("model")) for r in attempted
                                  if r[1].get("resolved_model") or (isinstance(rec_response(r[1]), dict) and rec_response(r[1]).get("model")))
        provider_ids = [r[1].get("provider_id") or (rec_response(r[1]) or {}).get("id") for r in attempted if isinstance(rec_response(r[1]), dict) or r[1].get("provider_id")]
        provider_ids = [i for i in provider_ids if i]
        orders = Counter()
        for case, record, _, _ in attempted:
            q = (rec_payload(record) or {}).get("questions") or {}
            crit = next(iter(q.values()), {}).get("criteria") if q else None
            if isinstance(crit, dict):
                orders["original" if list(crit) == list(case["criteria"]) else "reversed" if list(crit) == list(reversed(list(case["criteria"]))) else "other"] += 1
        digest_mismatch = sum(1 for r in attempted if dataset_sha and "dataset_sha256" in r[1] and r[1]["dataset_sha256"] != dataset_sha)
        confidences = [r[1].get("confidence") for r in answered if isinstance(r[1].get("confidence"), (int, float))]
        out["tasks"][f"{task}|{variant}"] = {
            "universe": len(universe),
            "attempted": len(attempted),
            "answered": len(answered),
            "not_attempted": len(universe) - len(attempted),
            "failure_classes": dict(Counter(r[2] for r in attempted if r[2] != "success")),
            "correct": correct,
            "correct_over_attempted": f"{correct}/{len(attempted)}",
            "wilson95_attempted": wilson(correct, len(attempted)),
            "correct_over_answered": f"{correct}/{len(answered)}",
            "wilson95_answered": wilson(correct, len(answered)),
            "class_support_and_recall": recall,
            "balanced_accuracy_attempted": balanced,
            "confusion_expected_to_predicted": {k: dict(v) for k, v in sorted(confusion.items())},
            "paired_vs_baselines": comparisons,
            "latency_ms": {"n": len(durations), "p50": percentile(durations, 0.5), "p95": percentile(durations, 0.95), "max": max(durations) if durations else None,
                           "over_production_10s": sum(d > PRODUCTION_DEADLINE_MS for d in durations),
                           "distinct_values": len(set(durations)), "note": "batched dev requests are not comparable to single-question holdout latency"},
            "response_model_field": dict(response_models) or "absent in all responses (unknown, not assumed pinned)",
            "confidence_n": len(confidences),
            "provider_ids": {"present": len(provider_ids), "unique": len(set(provider_ids))},
            "criteria_order": dict(orders),
            "records_with_other_dataset_sha256": digest_mismatch,
            "http_status": dict(Counter(str(r[1].get("http_status")) for r in attempted if "http_status" in r[1])),
            "payload_problems": payload_problems,
        }
    if phase == "dev":
        out["variant_selection"] = variant_margins(out["tasks"], grouped, cases)
    return out


def variant_margins(task_rows: dict[str, Any], grouped, cases) -> dict[str, Any]:
    margins = {}
    tasks = sorted({key.split("|")[0] for key in task_rows})
    for task in tasks:
        variants = {key.split("|")[1]: row["correct"] for key, row in task_rows.items() if key.startswith(task + "|")}
        ranked = sorted(variants.items(), key=lambda kv: -kv[1])
        entry: dict[str, Any] = {"correct_by_variant": variants}
        if len(ranked) >= 2:
            (top, top_n), (second, second_n) = ranked[0], ranked[1]
            ok = lambda v: {r["case_id"]: r.get("choice") == cases[r["case_id"]]["expected"] and rec_status(r) == "success" for r in grouped[(task, v)]}
            a, b = ok(top), ok(second)
            shared = sorted(set(a) & set(b))
            entry.update({"top": top, "runner_up": second, "margin_cases": top_n - second_n,
                          "discordant": paired([a[i] for i in shared], [b[i] for i in shared]),
                          "weak_evidence": top_n - second_n <= 2})
        margins[task] = entry
    return margins


# ---------------------------------------------------------------- blind relabel

LABEL_FIELDS = {"expected", "baseline", "rationale", "tags", "provenance"}


def blind_view(sample: Any) -> list[dict[str, Any]]:
    items = sample if isinstance(sample, list) else sample.get("cases", [])
    leaking = [str(item.get("id")) for item in items if isinstance(item, dict) and LABEL_FIELDS & set(item)]
    if leaking:
        raise SystemExit(f"refusing: sample carries label-bearing fields for {leaking[:5]}... (blindness would be broken)")
    return [{"id": i["id"], "task": i.get("task"), "state": i["state"], "criteria": i["criteria"]} for i in items]


def blind_compare(dataset: list[dict[str, Any]], sample: Any, reviewer: dict[str, str]) -> dict[str, Any]:
    cases = {c["id"]: c for c in dataset}
    ids = [i["id"] for i in blind_view(sample)]
    rows, per_task = [], defaultdict(lambda: [0, 0])
    for cid in ids:
        case = cases.get(cid)
        if case is None:
            rows.append({"id": cid, "problem": "not in dataset"})
            continue
        mine = reviewer.get(cid)
        agree = mine == case["expected"]
        per_task[case["task"]][0] += agree
        per_task[case["task"]][1] += mine is not None
        if not agree:
            rows.append({"id": cid, "task": case["task"], "frozen": case["expected"], "reviewer": mine, "valid_choice": mine in case["criteria"]})
    return {"agreement_by_task": {t: f"{a}/{n}" for t, (a, n) in sorted(per_task.items())},
            "disagreements": rows,
            "policy": "headline scores keep frozen labels; disagreements are reported as adjudication sensitivity, never rewritten"}


# ---------------------------------------------------------------- selftest

def _mock_dataset() -> list[dict[str, Any]]:
    """Explicit MOCK fixtures (provenance says so). Two tasks x 24/24."""
    data = []
    animals = ["otter", "heron", "badger", "falcon", "lynx", "moose", "viper", "bison"]
    for task in ("T1", "T2"):
        for split in SPLITS:
            for i in range(24):
                pick = "alpha" if i % 3 else "beta"
                if split == "holdout" and i < 20:
                    pick = "beta"  # holdout majority differs from dev majority on purpose
                data.append({
                    "id": f"mock-{task}-{split}-{i:02d}", "task": task, "split": split,
                    "state": {"note": f"{split} {task} case {i} mentions {pick} evidence about {animals[i % 8]} number {i * 7 + (0 if split == 'dev' else 1000)}"},
                    "criteria": {"alpha": "alpha evidence present", "beta": "beta evidence present"},
                    "expected": pick, "rationale": "mock fixture rationale text long enough", "provenance": "MOCK audit selftest fixture",
                    "tags": ["mock"], "baseline": "alpha",
                })
    return data


def selftest() -> int:
    checks = 0
    def check(condition: bool, message: str) -> None:
        nonlocal checks
        if not condition:
            raise AssertionError(message)
        checks += 1

    # statistics against hand-computed values
    check(wilson(20, 24) == [0.6415, 0.9332], f"wilson 20/24 {wilson(20, 24)}")
    check(wilson(0, 0) is None, "wilson n=0")
    check(abs(mcnemar_exact(6, 0) - 0.03125) < 1e-12, "mcnemar 6-0")
    check(abs(mcnemar_exact(8, 1) - 0.0390625) < 1e-12, "mcnemar 8-1")
    check(mcnemar_exact(3, 3) == 1.0 and mcnemar_exact(0, 0) == 1.0, "mcnemar ties")
    check(percentile([1, 2, 3, 4], 0.5) == 2 and percentile([5], 0.95) == 5, "nearest-rank percentile")

    data = _mock_dataset()
    report = contract(data)
    check(report["ok"], f"clean mock contract: {report['errors'][:3]}")
    prov = json.loads(json.dumps(data)); prov[0]["provenance"] = {"kind": "synthetic"}; prov[1]["provenance"] = {}
    prov_errors = contract(prov)["errors"]
    check(len(prov_errors) == 1 and prov[1]["id"] in prov_errors[0], f"provenance object allowed, empty object rejected: {prov_errors}")
    check(report["tasks"]["T1"]["counts"] == {"dev": 24, "holdout": 24}, "counts")
    check(report["tasks"]["T1"]["distinct_criteria_sets"] == 1, "criteria set count")
    check(sum(report["tasks"]["T1"]["expected_position"].values()) == 48, "position tally")
    check(set(report["leakage_flags"]) >= {"only_expected_label_named_in_state"}, "state naming only expected label is flagged")
    check("alpha" not in json.dumps(report["tasks"]) and "beta" not in json.dumps(report["tasks"]), "contract output stays label-blind")

    broken = json.loads(json.dumps(data))
    broken[1]["id"] = broken[0]["id"]
    broken[2]["expected"] = "gamma"
    del broken[3]["rationale"]
    broken[30]["state"] = dict(broken[0]["state"])  # T1 holdout copies a dev state
    broken[5]["state"]["expected"] = "alpha"
    bad = contract(broken)
    joined = " ".join(bad["errors"])
    check("duplicate id" in joined and "expected not an allowed choice" in joined and "missing ['rationale']" in joined, f"contract errors: {bad['errors']}")
    check(bad["duplicate_states"]["cross_split"], "cross-split state duplicate detected")
    check(broken[5]["id"] in bad["leakage_flags"].get("label_like_state_key", []), "label-like state key flagged")
    listed = json.loads(json.dumps(data))
    listed[6]["state"]["candidates"] = [{"label": "A", "text": "identifier, not an answer"}]
    check(listed[6]["id"] not in contract(listed)["leakage_flags"].get("label_like_state_key", []), "candidate[].label identifier not flagged")
    check("tag_word_in_state" not in report["leakage_flags"], "generic tag carried by every case is ignored")
    check(any("holdout has 23" in e for e in contract(data[:-1])["errors"]), "24-per-split minimum enforced")

    near = overlap(data, 0.6)
    check(near["tasks"]["T1"]["template_ratio"] > 0.5, "templated mock cases detected as templates")

    # baselines: lexical reads only state+criteria; dev majority never uses holdout
    check(lexical_choice({"x": "beta evidence here"}, {"alpha": "alpha evidence", "beta": "beta evidence"}) == "beta", "lexical picks overlapping option")
    check(lexical_choice({"x": "nothing"}, {"alpha": "a1", "beta": "b1"}) == "alpha", "lexical tie -> first key")
    majority = dev_majority_labels(data)
    check(majority["T1"] == "alpha", "dev majority is alpha although holdout majority is beta")
    tampered = [dict(c, expected="beta") if c["split"] == "holdout" else c for c in data]
    check(dev_majority_labels(tampered) == majority, "changing holdout labels cannot move dev majority")

    with tempfile.TemporaryDirectory() as tmp:
        honest = Path(tmp, "honest.py")
        honest.write_text("def choose(case):\n    return 'alpha'\n\ndef main(cases):\n    return [c for c in cases if choose(c) != c['baseline']]\n", encoding="utf-8")
        cheat = Path(tmp, "cheat.py")
        cheat.write_text("def choose(case):\n    return case['expected']\n", encoding="utf-8")
        ok = baselines(data, str(honest))["authored_baseline_reproducibility"]
        check(ok["reproducible_from_state_and_criteria"], f"honest baseline reproducible: {ok}")
        check(ok["static_scan"]["label_field_reads"][0]["function"] == "main" and not ok["static_scan"]["label_field_reads"][0]["in_predictor_path"], "CLI-only label read is listed but not predictor leakage")
        helper = Path(tmp, "helper.py")
        helper.write_text("def _peek(case):\n    return case.get('expected')\n\ndef choose(case):\n    return _peek(case) or 'alpha'\n", encoding="utf-8")
        check("reads_label_field" in baseline_static_scan(helper, "choose"), "label read in a helper reachable from predictor is flagged")
        bad_b = baselines(data, str(cheat))["authored_baseline_reproducibility"]
        check(not bad_b["reproducible_from_state_and_criteria"] and bad_b["crashes_on_state_and_criteria_only"] and "reads_label_field" in bad_b["static_scan"], "label-reading baseline rejected")

    # scoring: declared-mock records must never enter live counts
    def record(case: dict[str, Any], choice: str | None, *, result: str = "success", kind: str | None = None, ms: float = 400.0, mock: bool = True) -> dict[str, Any]:
        payload = {"model": PINNED_MODEL, "state": case["state"], "questions": {"case": {"type": "choice", "instructions": "frozen", "criteria": case["criteria"]}}}
        r = {"mock": mock, "phase": "holdout", "task": case["task"], "case_id": case["id"], "variant": "scoped", "timestamp": "2026-09-19T03:00:00Z",
             "request_hash": digest(payload), "request_payload": payload, "result": result, "duration_ms": ms}
        if result == "success":
            r.update({"choice": choice, "confidence": 0.9, "response": {"answers": {"case": {"choice": choice, "confidence": 0.9}}}})
        else:
            r["error"] = {"kind": kind}
        r["_source"] = f"fixture:{case['id']}"
        return r
    holdout = [c for c in data if c["task"] == "T1" and c["split"] == "holdout"]
    records = [record(c, c["expected"]) for c in holdout[:20]]
    records += [record(holdout[20], "alpha" if holdout[20]["expected"] == "beta" else "beta")]
    records += [record(holdout[21], None, result="transport_error", kind="http")]
    records += [record(holdout[22], None, result="transport_error", kind="ValueError", ms=12_000)]
    records += [record(holdout[0], "alpha")]  # duplicate tuple: first record stays authoritative
    live_view = score(data, records, "holdout")
    check(live_view["records_in_phase_used"] == 0 and len(live_view["excluded_unattributable_or_mock"]) == len(records), "mocks excluded from live counts")
    check(live_view["tasks"] == {}, "no live metrics from mocks")
    mocked = score(data, records, "holdout", freeze={"selected_instructions": {"T1": "frozen"}}, allow_mock=True)
    row = mocked["tasks"]["T1|scoped"]
    check(mocked["evidence"] == "MOCK", "allow-mock output is stamped MOCK")
    check(row["attempted"] == 23 and row["answered"] == 21 and row["correct"] == 20 and row["not_attempted"] == 1, f"counts {row['attempted']} {row['answered']} {row['correct']}")
    check(row["correct_over_attempted"] == "20/23" and row["wilson95_attempted"] == wilson(20, 23), "failures count as wrong over attempted")
    check(row["failure_classes"] == {"transport": 1, "schema_or_answer": 1}, f"failure split {row['failure_classes']}")
    check(row["latency_ms"]["over_production_10s"] == 1, "10s production deadline count")
    check(mocked["duplicate_case_variant_tuples"] == [f"{holdout[0]['id']}|scoped"], "duplicate tuple reported")
    check(row["payload_problems"] == {}, f"clean payloads: {row['payload_problems']}")
    tampered_record = record(holdout[23], "alpha")
    tampered_record["request_payload"]["state"] = {"note": "changed"}
    t_row = score(data, [tampered_record], "holdout", allow_mock=True)["tasks"]["T1|scoped"]
    check(any("hash" in p for p in t_row["payload_problems"][holdout[23]["id"]]), "hash/payload mismatch caught")
    def current(case: dict[str, Any], choice: str, reverse: bool = False, live: Any = True) -> dict[str, Any]:
        crit = dict(reversed(list(case["criteria"].items()))) if reverse else dict(case["criteria"])
        body = {"model": PINNED_MODEL, "state": case["state"], "questions": {"case": {"type": "choice", "instructions": "frozen", "criteria": crit}}}
        return {"live": live, "phase": "holdout", "task": case["task"], "case_id": case["id"], "variant": "scoped", "started_at": "2026-09-19T03:00:00Z",
                "dataset_sha256": "fixture-sha", "body": body, "payload_sha256": wire_digest(body), "http_status": 200, "status": "success", "choice": choice,
                "confidence": 0.7, "raw_response": {"id": f"gen-{case['id']}", "model": PINNED_MODEL, "answers": {"case": {"choice": choice, "confidence": 0.7}}},
                "provider_id": f"gen-{case['id']}", "resolved_model": PINNED_MODEL, "duration_ms": 300.0 + len(case["id"]), "_source": "fixture"}
    fresh = [current(holdout[0], holdout[0]["expected"]), current(holdout[1], holdout[1]["expected"], reverse=True)]
    check(score(data, [dict(r, live=False) for r in fresh], "holdout")["records_in_phase_used"] == 0, "live=false records excluded")
    new_row = score(data, fresh, "holdout", dataset_sha="fixture-sha", allow_mock=True)["tasks"]["T1|scoped"]
    check(new_row["payload_problems"] == {} and new_row["criteria_order"] == {"original": 1, "reversed": 1}, f"current schema + reversed order: {new_row['payload_problems']} {new_row['criteria_order']}")
    check(new_row["provider_ids"] == {"present": 2, "unique": 2} and new_row["response_model_field"] == {PINNED_MODEL: 2}, "provider id / resolved model tallied")
    check(score(data, fresh, "holdout", dataset_sha="other", allow_mock=True)["tasks"]["T1|scoped"]["records_with_other_dataset_sha256"] == 2, "per-record dataset digest mismatch counted")
    bad_answer = dict(fresh[0], status="transport_error", error={"kind": "ValueError"}); bad_answer.pop("choice")
    check(score(data, [bad_answer], "holdout", allow_mock=True)["tasks"]["T1|scoped"]["failure_classes"] == {"schema_or_answer": 1}, "HTTP 200 + invalid answer is not a transport failure")
    unattributed = [{k: v for k, v in r.items() if k not in ("request_hash", "mock")} for r in records[:2]]
    check(score(data, unattributed, "holdout")["records_in_phase_used"] == 0, "unattributable records excluded even if not flagged mock")

    # blind workflow
    try:
        blind_view([{"id": "x", "state": {}, "criteria": {}, "expected": "a"}])
        raise AssertionError("label-bearing sample accepted")
    except SystemExit:
        checks += 1
    sample = [{"id": c["id"], "task": c["task"], "state": c["state"], "criteria": c["criteria"]} for c in holdout[:5]]
    compared = blind_compare(data, sample, {c["id"]: c["expected"] for c in holdout[:4]} | {holdout[4]["id"]: "alpha"})
    check(compared["agreement_by_task"]["T1"] == "4/5" and len(compared["disagreements"]) == 1, f"blind compare {compared}")

    print(json.dumps({"selftest": "passed", "checks": checks, "evidence": "MOCK fixtures only; not provider evidence"}))
    return 0


# ---------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--selftest", action="store_true", help="run mock-fixture self-test and exit")
    sub = parser.add_subparsers(dest="command")
    p = sub.add_parser("contract"); p.add_argument("datasets", nargs="+")
    p = sub.add_parser("overlap"); p.add_argument("datasets", nargs="+"); p.add_argument("--threshold", type=float, default=0.6)
    p = sub.add_parser("baselines"); p.add_argument("dataset"); p.add_argument("--baseline-script"); p.add_argument("--baseline-func"); p.add_argument("--show-labels", action="store_true")
    p = sub.add_parser("score"); p.add_argument("dataset"); p.add_argument("--records", nargs="+", required=True); p.add_argument("--phase", default="holdout"); p.add_argument("--freeze"); p.add_argument("--allow-mock", action="store_true")
    p = sub.add_parser("blind-view"); p.add_argument("--sample", required=True)
    p = sub.add_parser("blind-compare"); p.add_argument("dataset"); p.add_argument("--sample", required=True); p.add_argument("--reviewer", required=True)
    args = parser.parse_args(argv)
    if args.selftest:
        return selftest()
    if args.command in ("contract", "overlap"):
        data, digests = load_datasets(args.datasets)
        result = contract(data) if args.command == "contract" else overlap(data, args.threshold)
        result["dataset_sha256"] = digests
    elif args.command == "baselines":
        data, digests = load_datasets([args.dataset])
        result = baselines(data, args.baseline_script, args.baseline_func)
        majority = result.pop("_majority")
        if args.show_labels:
            result["dev_majority_label_names"] = majority
        result["dataset_sha256"] = digests
    elif args.command == "score":
        data, digests = load_datasets([args.dataset])
        records, problems = load_jsonl(args.records)
        freeze = load_json(args.freeze) if args.freeze else None
        result = score(data, records, args.phase, freeze, digests[args.dataset], args.allow_mock)
        result.update({"jsonl_problems": problems, "dataset_sha256": digests, "records_sha256": {r: file_sha256(Path(r)) for r in args.records}})
    elif args.command == "blind-view":
        result = blind_view(load_json(args.sample))
    elif args.command == "blind-compare":
        data, _ = load_datasets([args.dataset])
        result = blind_compare(data, load_json(args.sample), load_json(args.reviewer))
    else:
        parser.print_help()
        return 2
    print(json.dumps(result, indent=2, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
