#!/usr/bin/env python3
"""Read retained Term2 artifacts and emit small, reproducible lifecycle evidence.

This is deliberately a stdlib-only script.  It never emits sent text, previews,
tool arguments, headers, or response content; those fields are only inspected
for bounded structural markers needed for classification.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


BUCKETS = ((0, 8_000, "<8k"), (8_000, 32_000, "8-32k"),
           (32_000, 64_000, "32-64k"), (64_000, 128_000, "64-128k"),
           (128_000, math.inf, "128k+"))


def scalar(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def nested(obj: Any, *path: str) -> Any:
    for key in path:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(key)
    return obj


def walk(obj: Any) -> Iterable[dict[str, Any]]:
    if isinstance(obj, dict):
        yield obj
        for value in obj.values():
            yield from walk(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from walk(value)


def has_type(obj: Any, value: str) -> bool:
    return any(item.get("type") == value for item in walk(obj))


def date_range(start: dt.date, end: dt.date) -> list[dt.date]:
    return [start + dt.timedelta(days=i) for i in range((end - start).days + 1)]


def usage_from_received(received: dict[str, Any] | None) -> dict[str, Any]:
    summary = received.get("summary") if isinstance(received, dict) else None
    payload = summary.get("payload") if isinstance(summary, dict) else None
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(usage, dict):
        return {"present": False, "input": None, "cached": None, "cache_field": None,
                "output": None, "cost": None, "cost_field": None}
    input_tokens = scalar(usage.get("input_tokens"))
    if input_tokens is None:
        input_tokens = scalar(usage.get("prompt_tokens"))
    output_tokens = scalar(usage.get("output_tokens"))
    if output_tokens is None:
        output_tokens = scalar(usage.get("completion_tokens"))
    details = usage.get("input_tokens_details") or usage.get("prompt_tokens_details") or {}
    cached = scalar(details.get("cached_tokens")) if isinstance(details, dict) else None
    cache_field = "cached_tokens" if cached is not None else None
    # OpenRouter chat-completions records sometimes expose these scalar aliases.
    if cached is None and scalar(usage.get("prompt_cache_hit_tokens")) is not None:
        cached = scalar(usage.get("prompt_cache_hit_tokens"))
        cache_field = "prompt_cache_hit_tokens"
    cost = scalar(usage.get("cost"))
    cost_field = "cost" if cost is not None else None
    if cost is None:
        cost = scalar(usage.get("cost_in_usd_ticks"))
        cost_field = "cost_in_usd_ticks" if cost is not None else None
    return {"present": True, "input": input_tokens, "cached": cached,
            "cache_field": cache_field, "output": output_tokens, "cost": cost,
            "cost_field": cost_field}


def classify_exchange(sent: dict[str, Any], received: dict[str, Any] | None) -> str:
    """Classify from structure, not prompt text."""
    body = sent.get("body") if isinstance(sent, dict) else None
    if has_type(body, "compaction"):
        return "native_compaction_reset"
    # A provider-specific summarizer is represented structurally in some old
    # recordings.  Do not call an ordinary prompt containing "summarize" one.
    if isinstance(body, dict) and (body.get("compaction") is not None or
                                   body.get("summarizer") is True or
                                   body.get("operation") == "compact"):
        return "summarizer_request"
    summary = received.get("summary") if isinstance(received, dict) else None
    if not isinstance(summary, dict) or not isinstance(summary.get("payload"), dict):
        return "incomplete_or_error"
    status = summary.get("status")
    if not isinstance(status, int) or not 200 <= status < 300:
        return "incomplete_or_error"
    return "ordinary"


def bucket(input_tokens: int | float | None) -> str | None:
    if input_tokens is None:
        return None
    for low, high, name in BUCKETS:
        if low <= input_tokens < high:
            return name
    return None


def iso_date(value: str | None) -> str | None:
    if not value:
        return None
    return value[:10] if len(value) >= 10 and value[4] == "-" else None


def add_usage_stat(stats: dict[str, Any], usage: dict[str, Any]) -> None:
    stats["requests"] += 1
    if usage["input"] is not None:
        stats["input_tokens"] += usage["input"]
    if usage["output"] is not None:
        stats["output_tokens"] += usage["output"]
    if usage["cached"] is not None:
        stats["cached_tokens"] += usage["cached"]
        stats["cache_observed_input_tokens"] += usage["input"] or 0
        stats["cache_observed_requests"] += 1
    if usage["cost"] is not None:
        stats["recorded_cost_sum"] += usage["cost"]
        stats["recorded_cost_requests"] += 1
        field = usage.get("cost_field") or "unknown"
        stats["recorded_cost_by_field"].setdefault(field, {"requests": 0, "sum": 0})
        stats["recorded_cost_by_field"][field]["requests"] += 1
        stats["recorded_cost_by_field"][field]["sum"] += usage["cost"]


def new_stat() -> dict[str, Any]:
    return {"requests": 0, "input_tokens": 0, "cached_tokens": 0,
            "cache_observed_input_tokens": 0,
            "output_tokens": 0, "cache_observed_requests": 0,
            "recorded_cost_sum": 0, "recorded_cost_requests": 0,
            "recorded_cost_by_field": {}}


def finalize_stat(stats: dict[str, Any]) -> dict[str, Any]:
    result = dict(stats)
    # cost and cost_in_usd_ticks are different recorded units; retain their
    # field-specific sums and never publish a mixed-unit total.
    result.pop("recorded_cost_sum", None)
    result["cache_ratio_weighted"] = (stats["cached_tokens"] / stats["cache_observed_input_tokens"]
                                      if stats["cache_observed_input_tokens"] else None)
    return result


def iter_traffic(root: Path, dates: list[dt.date]) -> Iterable[tuple[str, Path]]:
    for day in dates:
        folder = root / day.isoformat()
        if folder.is_dir():
            for path in sorted(folder.rglob("*.json")):
                yield day.isoformat(), path


def analyze_traffic(root: Path, dates: list[dt.date]) -> dict[str, Any]:
    by_date: dict[str, Any] = {day.isoformat(): {"files": 0, "parse_errors": 0,
        "duplicate_request_ids": 0, "missing_sent": 0, "missing_received": 0,
        "usage_present": 0, "usage_missing": 0, "cache_field_present": 0,
        "cache_field_missing": 0, "cost_present": 0, "complete": 0} for day in dates}
    by_provider_model: dict[str, dict[str, Any]] = defaultdict(new_stat)
    by_date_provider_model: dict[str, dict[str, Any]] = defaultdict(new_stat)
    coverage_by_date_provider_model: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "files": 0, "complete": 0, "usage_missing": 0,
        "cache_field_missing": 0, "cost_present": 0, "incomplete_or_error": 0})
    by_bucket: dict[str, dict[str, Any]] = defaultdict(new_stat)
    by_session: dict[str, dict[str, Any]] = defaultdict(lambda: {"requests": 0,
        "first": None, "last": None, "models": [], "usage_input_tokens": 0,
        "top_request_ids": []})
    requests: list[dict[str, Any]] = []
    seen: set[str] = set()
    classes = Counter()
    shapes = Counter()
    for day, path in iter_traffic(root, dates):
        coverage = by_date[day]
        coverage["files"] += 1
        try:
            with path.open(encoding="utf-8") as stream:
                record = json.load(stream)
        except (OSError, ValueError):
            coverage["parse_errors"] += 1
            continue
        sent = record.get("sent") if isinstance(record, dict) else None
        received = record.get("received") if isinstance(record, dict) else None
        request_id = sent.get("requestId") if isinstance(sent, dict) else None
        request_session = sent.get("sessionId") if isinstance(sent, dict) else None
        key = (f"{request_id}|{request_session}" if request_id else f"path:{path}")
        if key in seen:
            coverage["duplicate_request_ids"] += 1
            continue
        seen.add(key)
        if not isinstance(sent, dict):
            coverage["missing_sent"] += 1
            continue
        if not isinstance(received, dict):
            coverage["missing_received"] += 1
        summary = received.get("summary") if isinstance(received, dict) else None
        status = summary.get("status") if isinstance(summary, dict) else None
        if isinstance(status, int) and 200 <= status < 300 and isinstance(summary.get("payload"), dict):
            coverage["complete"] += 1
        usage = usage_from_received(received)
        coverage["usage_present" if usage["present"] else "usage_missing"] += 1
        coverage["cache_field_present" if usage["cached"] is not None else "cache_field_missing"] += 1
        if usage["cost"] is not None:
            coverage["cost_present"] += 1
        provider = str(sent.get("provider") or "unknown")
        model = str(sent.get("model") or "unknown")
        label = f"{provider}/{model}"
        kind = classify_exchange(sent, received)
        dimension = coverage_by_date_provider_model[f"{day}/{label}"]
        dimension["files"] += 1
        dimension["complete"] += int(kind != "incomplete_or_error")
        dimension["incomplete_or_error"] += int(kind == "incomplete_or_error")
        dimension["usage_missing"] += int(not usage["present"])
        dimension["cache_field_missing"] += int(usage["cached"] is None)
        dimension["cost_present"] += int(usage["cost"] is not None)
        classes[kind] += 1
        if isinstance(summary, dict):
            shapes[str(summary.get("wireShape") or summary.get("transport") or "unknown")] += 1
        if kind == "ordinary":
            add_usage_stat(by_provider_model[label], usage)
            add_usage_stat(by_date_provider_model[f"{day}/{label}"], usage)
            if bucket(usage["input"]):
                add_usage_stat(by_bucket[bucket(usage["input"])], usage)
        session = str(sent.get("sessionId") or "unknown")
        stamp = sent.get("timestamp")
        s = by_session[session]
        s["requests"] += 1
        s["usage_input_tokens"] += usage["input"] or 0
        s.setdefault("daily_requests", Counter())[day] += 1
        s["first"] = min(x for x in (s["first"], stamp) if x) if stamp else s["first"]
        s["last"] = max(x for x in (s["last"], stamp) if x) if stamp else s["last"]
        if model not in s["models"] and len(s["models"]) < 8:
            s["models"].append(model)
        if len(s["top_request_ids"]) < 3 and request_id:
            s["top_request_ids"].append(request_id)
        requests.append({"request_id": request_id, "session_id": session, "timestamp": stamp,
                         "provider": provider, "model": model, "kind": kind,
                         "status": status, "input": usage["input"], "cached": usage["cached"],
                         "output": usage["output"], "cost": usage["cost"], "path": str(path),
                         "compaction_ids": [item["id"] for item in walk(sent.get("body"))
                                            if item.get("type") == "compaction" and item.get("id")][:4]})
    # Gap and model-switch flags are observational sequencing warnings, not causes.
    gaps = 0
    switches = 0
    session_reqs: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in requests:
        session_reqs[item["session_id"]].append(item)
    for items in session_reqs.values():
        items.sort(key=lambda x: x["timestamp"] or "")
        for previous, current in zip(items, items[1:]):
            if previous["model"] != current["model"]:
                switches += 1
            try:
                a = dt.datetime.fromisoformat(previous["timestamp"].replace("Z", "+00:00"))
                b = dt.datetime.fromisoformat(current["timestamp"].replace("Z", "+00:00"))
                if (b - a).total_seconds() > 6 * 3600:
                    gaps += 1
            except (AttributeError, ValueError):
                pass
    for session in by_session.values():
        session["daily_requests"] = dict(sorted(session.get("daily_requests", {}).items()))
    return {"coverage_by_date": by_date, "provider_model": {k: finalize_stat(v) for k, v in sorted(by_provider_model.items())},
            "provider_model_by_date": {k: finalize_stat(v) for k, v in sorted(by_date_provider_model.items())},
            "coverage_by_date_provider_model": dict(sorted(coverage_by_date_provider_model.items())),
            "input_buckets": {k: finalize_stat(v) for k, v in by_bucket.items()},
            "sessions": dict(sorted(by_session.items(), key=lambda x: (-x[1]["requests"], x[0]))),
            "request_count": len(requests), "classification": dict(classes), "wire_shapes": dict(shapes),
            "gap_edges_over_6h": gaps, "model_switch_edges": switches,
            "requests": requests, "session_requests": {k: v for k, v in session_reqs.items()}}


def app_events(log_root: Path, dates: list[dt.date]) -> dict[str, Any]:
    counts = Counter()
    records = []
    for day in dates:
        for path in sorted(log_root.glob(f"term2-{day.isoformat()}.log*")):
            try:
                with path.open(encoding="utf-8", errors="replace") as stream:
                    for line in stream:
                        try:
                            item = json.loads(line)
                        except ValueError:
                            continue
                        message = item.get("message", "")
                        if item.get("eventType") != "log.message" or not isinstance(message, str):
                            continue
                        if message == "Local context compaction dropped provider-opaque items with their cold turns":
                            counts["local_compaction_drop"] += 1
                            records.append({"kind": "local_compaction_drop", "timestamp": item.get("timestamp"),
                                            "session_id": item.get("sessionId"), "correlation_id": item.get("correlationId"),
                                            "dropped_opaque_items": item.get("droppedOpaqueItems")})
                        elif message == "Codex compact endpoint failed; continuing with uncompacted history":
                            counts["native_compaction_failed"] += 1
                            records.append({"kind": "native_compaction_failed", "timestamp": item.get("timestamp"),
                                            "correlation_id": item.get("correlationId"), "model": item.get("model")})
            except OSError:
                continue
    return {"counts": dict(counts), "records": records}


def conversations(root: Path, dates: list[dt.date], traffic: dict[str, Any]) -> dict[str, Any]:
    rollovers = []
    native_local = Counter()
    for path in sorted(root.glob("*.jsonl")):
        try:
            with path.open(encoding="utf-8", errors="replace") as stream:
                for line in stream:
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    event = row.get("event") or {}
                    stamp = row.get("ts")
                    if iso_date(stamp) not in {d.isoformat() for d in dates}:
                        continue
                    if event.get("type") == "session_rollover":
                        if event.get("phase") in ("requested", "completed"):
                            r = {k: event.get(k) for k in ("phase", "rolloverId", "sourceSessionId", "successorSessionId", "reason", "providerInputTokens", "settlementLatencyMs")}
                            r["event_ts"] = stamp
                            r["conversation_file"] = path.name
                            rollovers.append(r)
                    if event.get("type") in ("context_compaction", "local_compaction", "compaction"):
                        native_local[event.get("type")] += 1
        except OSError:
            continue
    wire_by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for req in traffic["requests"]:
        wire_by_session[req["session_id"]].append(req)
    links = []
    for rollover in rollovers:
        if rollover["phase"] != "completed" or not rollover.get("sourceSessionId") or not rollover.get("successorSessionId"):
            rollover["successor_verified"] = False
            continue
        successor_file = root / f"{rollover['successorSessionId']}.jsonl"
        verified = False
        if successor_file.is_file():
            try:
                with successor_file.open(encoding="utf-8", errors="replace") as stream:
                    for line in stream:
                        row = json.loads(line)
                        event = row.get("event") or {}
                        if event.get("type") == "session_init" and event.get("rolloverFrom") == rollover["sourceSessionId"]:
                            verified = True
                            break
            except (OSError, ValueError):
                pass
        rollover["successor_verified"] = verified
        successor_requests = sorted(wire_by_session.get(rollover["successorSessionId"], []), key=lambda x: x["timestamp"] or "")
        rollover["successor_wire_requests"] = len(successor_requests)
        rollover["first_successor_request"] = ({"request_id": successor_requests[0]["request_id"], "input": successor_requests[0]["input"], "cached": successor_requests[0]["cached"], "model": successor_requests[0]["model"]} if successor_requests else None)
        rollover["subsequent_successor_requests"] = max(0, len(successor_requests) - 1)
        predecessor_requests = sorted(wire_by_session.get(rollover["sourceSessionId"], []), key=lambda x: x["timestamp"] or "")
        rollover["predecessor_wire_requests"] = len(predecessor_requests)
        before = predecessor_requests[-1] if predecessor_requests else None
        after = successor_requests[0] if successor_requests else None
        rollover["before_after"] = {
            "before_last": ({"request_id": before["request_id"], "timestamp": before["timestamp"], "input": before["input"], "cached": before["cached"], "model": before["model"]} if before else None),
            "after_first": ({"request_id": after["request_id"], "timestamp": after["timestamp"], "input": after["input"], "cached": after["cached"], "model": after["model"]} if after else None),
            "model_switch": bool(before and after and before["model"] != after["model"]),
        }
        if before and after:
            try:
                a = dt.datetime.fromisoformat(before["timestamp"].replace("Z", "+00:00"))
                b = dt.datetime.fromisoformat(after["timestamp"].replace("Z", "+00:00"))
                rollover["before_after"]["gap_seconds"] = (b - a).total_seconds()
            except (AttributeError, ValueError):
                rollover["before_after"]["gap_seconds"] = None
        if verified:
            links.append(rollover)
    return {"event_counts": dict(native_local), "rollovers": rollovers,
            "completed_verified_links": len(links), "verified_links": links}


def enrich(traffic: dict[str, Any]) -> None:
    for stat in list(traffic["provider_model"].values()) + list(traffic["input_buckets"].values()):
        stat["cache_ratio_per_request_mean"] = None
    for label, stat in traffic["provider_model"].items():
        values = [r["cached"] / r["input"] for r in traffic["requests"]
                  if r["kind"] == "ordinary" and f"{r['provider']}/{r['model']}" == label
                  and r["cached"] is not None and r["input"]]
        stat["cache_ratio_per_request_mean"] = sum(values) / len(values) if values else None
    for label, stat in traffic["input_buckets"].items():
        values = [r["cached"] / r["input"] for r in traffic["requests"]
                  if r["kind"] == "ordinary" and bucket(r["input"]) == label
                  and r["cached"] is not None and r["input"]]
        stat["cache_ratio_per_request_mean"] = sum(values) / len(values) if values else None


def relative_cost(traffic: dict[str, Any]) -> dict[str, Any]:
    all_input = sum(r["input"] or 0 for r in traffic["requests"] if r["kind"] == "ordinary")
    observed_input = sum(r["input"] or 0 for r in traffic["requests"] if r["kind"] == "ordinary" and r["cached"] is not None)
    cached = sum(r["cached"] or 0 for r in traffic["requests"] if r["kind"] == "ordinary" and r["cached"] is not None)
    observed = sum(1 for r in traffic["requests"] if r["kind"] == "ordinary" and r["cached"] is not None)
    fraction = cached / observed_input if observed_input else None
    return {"ordinary_input_tokens_all": all_input, "ordinary_input_tokens_cache_observed": observed_input,
            "cache_missing_input_tokens": all_input - observed_input, "cache_observed_requests": observed,
            "cached_fraction_observed": fraction,
            "counterfactual_relative_input_cost_by_cached_price_ratio": {
                str(r): (1 - fraction + fraction * r if fraction is not None else None)
                for r in (0, 0.1, 0.25, 0.5, 1)},
            "formula": "relative input cost = uncached_fraction + cached_fraction * (cached_price / uncached_price); counterfactual only"}


def analyze(args: argparse.Namespace) -> dict[str, Any]:
    start = dt.date.fromisoformat(args.start)
    end = dt.date.fromisoformat(args.end)
    dates = date_range(start, end)
    traffic = analyze_traffic(Path(args.traffic_root).expanduser(), dates)
    enrich(traffic)
    app = app_events(Path(args.app_root).expanduser(), dates)
    conv = conversations(Path(args.conversation_root).expanduser(), dates, traffic)
    native_resets = [r for r in traffic["requests"] if r["kind"] == "native_compaction_reset"]
    for reset in native_resets:
        same_session = sorted(traffic["session_requests"].get(reset["session_id"], []), key=lambda x: x["timestamp"] or "")
        later = [r for r in same_session
                 if (r["timestamp"] or "") > (reset["timestamp"] or "")]
        reset["later_same_session_wire_requests"] = len(later)
        prior = [r for r in same_session if (r["timestamp"] or "") < (reset["timestamp"] or "")]
        previous = prior[-1] if prior else None
        reset["previous_same_session_request"] = ({"request_id": previous["request_id"],
            "timestamp": previous["timestamp"], "input": previous["input"],
            "cached": previous["cached"], "model": previous["model"]} if previous else None)
        peak = max((r for r in prior if r["input"] is not None), key=lambda r: r["input"], default=None)
        reset["peak_previous_request"] = ({"request_id": peak["request_id"],
            "timestamp": peak["timestamp"], "input": peak["input"],
            "cached": peak["cached"], "model": peak["model"]} if peak else None)
        reset["input_reduction_from_peak"] = (peak["input"] - reset["input"]
                                                if peak and reset["input"] is not None else None)
        reset["prior_high_input_requests"] = [{"request_id": r["request_id"],
            "timestamp": r["timestamp"], "input": r["input"], "cached": r["cached"],
            "output": r["output"], "model": r["model"]}
            for r in sorted((r for r in prior if r["input"] is not None),
                            key=lambda r: r["input"], reverse=True)[:4]]
        reset.pop("path", None)
        reset["input_reduction_from_previous"] = (previous["input"] - reset["input"]
                                                    if previous and previous["input"] is not None and reset["input"] is not None else None)
    home = Path.home()
    def portable(path: str) -> str:
        expanded = Path(path).expanduser()
        try:
            return "~" + str(expanded.relative_to(home))
        except ValueError:
            return str(expanded)
    return {"schema": 1, "window": {"start": args.start, "end": args.end, "timezone": "UTC for wire/conversations; app wall time retained as date-labelled"},
            "sources": {"traffic_root": portable(args.traffic_root), "app_log_root": portable(args.app_root), "conversation_root": portable(args.conversation_root)},
            "traffic": {k: v for k, v in traffic.items() if k not in ("requests", "session_requests")},
            "relative_cost": relative_cost(traffic), "app_events": app, "conversations": conv,
            "native_reset_links": native_resets[:100],
            "limitations": ["Provider traffic is sanitized and records scalar usage, not prompt bodies.", "A missing cache field is not treated as zero; all coverage fields are explicit.", "App log timestamps are local wall time; no session is inferred from correlationId alone."]}


def render_report(data: dict[str, Any]) -> str:
    t = data["traffic"]
    cov = t["coverage_by_date"]
    lines = ["# Context-lifecycle economics (retained local evidence)", "", f"Window: **{data['window']['start']} through {data['window']['end']}** (inclusive).", "", "## Method and boundaries", "", "The standalone `analyze.py` reads provider-traffic JSON one file at a time, app JSONL rotations, and persisted conversation JSONL. Requests are deduplicated by the `(sent.requestId, sent.sessionId)` identity; index files are not counted. No prompts, previews, tool arguments, headers, response text, or ciphertext are emitted. Wire timestamps are UTC; app timestamps are local wall-clock labels. These are observations, not causal savings or policy thresholds.", "", "## Coverage", "", "| date | files | complete | usage | cache field | recorded cost | parse errors | duplicate request IDs |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for day, c in cov.items():
        lines.append(f"| {day} | {c['files']} | {c['complete']} | {c['usage_present']} / {c['usage_missing']} missing | {c['cache_field_present']} / {c['cache_field_missing']} missing | {c['cost_present']} | {c['parse_errors']} | {c['duplicate_request_ids']} |")
    lines += ["", f"Deduplicated traffic requests: **{t['request_count']}**. Wire shapes: `{json.dumps(t['wire_shapes'], sort_keys=True)}`. Structural traffic classification: `{json.dumps(t['classification'], sort_keys=True)}` (the `summarizer_request` count is therefore explicit, including zero). App compaction-trigger records are reported separately below; their text is not used as a traffic request classification.", "", "Coverage by provider/model/date (all deduplicated files; `usage_missing` and `cache_field_missing` are fields, not zeroes):", "", "| date/provider/model | files | complete | incomplete/error | usage missing | cache missing | cost present |", "|---|---:|---:|---:|---:|---:|---:|"]
    for label, c in t["coverage_by_date_provider_model"].items():
        lines.append(f"| `{label}` | {c['files']} | {c['complete']} | {c['incomplete_or_error']} | {c['usage_missing']} | {c['cache_field_missing']} | {c['cost_present']} |")
    lines += ["", "## Token and cache economics", "", "Only scalar provider-recorded usage is used. `cached_tokens: 0` is observed zero; absent cache fields remain missing. Cost sums stay separated by the provider's recorded field (`cost` versus `cost_in_usd_ticks`); neither is converted or priced here. Weighted ratios use the input-token denominator from requests where a cache field was present.", "", "| provider/model | ordinary requests | input | cache-observed input | cached | output | weighted cache ratio | mean per-request ratio | recorded cost fields (count/sum by field) |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for label, s in t["provider_model"].items():
        costs = ", ".join(f"{field}:{value['requests']}/{value['sum']}" for field, value in s.get("recorded_cost_by_field", {}).items()) or "—"
        lines.append(f"| `{label}` | {s['requests']} | {s['input_tokens']} | {s['cache_observed_input_tokens']} | {s['cached_tokens']} | {s['output_tokens']} | {fmt(s['cache_ratio_weighted'])} | {fmt(s['cache_ratio_per_request_mean'])} | {costs} |")
    lines += ["", "Input-size buckets (ordinary requests):", "", "| bucket | requests | input | cache-observed input | cached | weighted ratio | mean per-request ratio |", "|---|---:|---:|---:|---:|---:|---:|"]
    for label in ("<8k", "8-32k", "32-64k", "64-128k", "128k+"):
        s = t["input_buckets"].get(label)
        if s: lines.append(f"| {label} | {s['requests']} | {s['input_tokens']} | {s['cache_observed_input_tokens']} | {s['cached_tokens']} | {fmt(s['cache_ratio_weighted'])} | {fmt(s['cache_ratio_per_request_mean'])} |")
    rc = data["relative_cost"]
    lines += ["", "### Relative input-price sensitivity", "", f"Ordinary input totals: **{rc['ordinary_input_tokens_all']}** tokens; cache-observed denominator: **{rc['ordinary_input_tokens_cache_observed']}** across {rc['cache_observed_requests']} requests; cache-field-missing input: **{rc['cache_missing_input_tokens']}**. Ratios below use only the cache-observed denominator, never treating missing cache as zero. The counterfactual relative cost at cached/uncached price ratios is `{json.dumps(rc['counterfactual_relative_input_cost_by_cached_price_ratio'])}`. Formula: `{rc['formula']}`. This is not a provider bill, does not establish that compaction caused savings, and does not assume cached tokens are free: at ratio 0.1 they still contribute 10% of uncached unit price; at ratio 1 there is no input-cost difference. Any positive reduction requires cached unit price < uncached unit price; there is no break-even monetary price in this corpus without a complete provider price schedule.", "", "## Session growth and boundary flags", "", f"Sessions with traffic: **{len(t['sessions'])}**. Edges with >6-hour gap: **{t['gap_edges_over_6h']}**; model-switch edges: **{t['model_switch_edges']}**. These flags mark confounding boundaries rather than imputing continuity. Top sessions by request count:", ""]
    for sid, s in list(t["sessions"].items())[:15]:
        daily = ", ".join(f"{day}:{count}" for day, count in s.get("daily_requests", {}).items())
        lines.append(f"- `{sid}`: {s['requests']} requests ({daily}), input {s['usage_input_tokens']} tokens, models `{', '.join(s['models'])}`, first `{s['first']}`, last `{s['last']}`, request IDs `{', '.join(s['top_request_ids'])}`")
    app = data["app_events"]
    conv = data["conversations"]
    lines += ["", "## Compaction and rollover evidence", "", f"App structured messages: `{json.dumps(app['counts'], sort_keys=True)}`. Persisted structured compaction event types: `{json.dumps(conv['event_counts'], sort_keys=True)}`. A failed native compact endpoint is not a reset. Native wire reset items: **{len(data['native_reset_links'])}**; each is linked to later same-session wire requests only when the request envelope contained a structural `type: compaction` item. Verified completed rollover predecessor→successor links: **{conv['completed_verified_links']}**.", "", "Native reset artifact/request IDs and downstream reuse:"]
    for reset in data["native_reset_links"]:
        previous = reset.get("previous_same_session_request")
        peak = reset.get("peak_previous_request")
        prior = (f"previous request `{previous['request_id']}` input={previous['input']} cached={previous['cached']}" if previous else "no previous request")
        peak_text = (f"peak prior `{peak['request_id']}` input={peak['input']} cached={peak['cached']}" if peak else "no peak prior")
        high = ", ".join(f"`{item['request_id']}`={item['input']}" for item in reset.get("prior_high_input_requests", [])) or "—"
        lines.append(f"- session `{reset['session_id']}`, request `{reset['request_id']}`, compaction item `{', '.join(reset.get('compaction_ids', [])) or '—'}`, model `{reset['model']}`, timestamp `{reset['timestamp']}`, {prior}; {peak_text}; prior high-input requests {high}; reset input={reset['input']} cached={reset['cached']} (reduction from peak={reset.get('input_reduction_from_peak')}), later same-session wire requests: {reset.get('later_same_session_wire_requests', 0)}")
    lines += ["", "| rollover phase | event time | predecessor | successor | successor session_init verified | predecessor/ successor wire requests | first/subsequent usage | before→after flags |", "|---|---|---|---|---|---:|---|---|"]
    for r in conv["rollovers"]:
        first = r.get("first_successor_request")
        usage = (f"{first['input']}/{first['cached']} ({first['model']}) + {r.get('subsequent_successor_requests', 0)} subsequent" if first else "no wire request")
        before_after = r.get("before_after", {})
        before = before_after.get("before_last")
        after = before_after.get("after_first")
        flags = f"gap={before_after.get('gap_seconds', '—')}s, model_switch={before_after.get('model_switch', False)}"
        lines.append(f"| {r.get('phase')} | {r.get('event_ts')} | `{r.get('sourceSessionId')}` | `{r.get('successorSessionId')}` | {r.get('successor_verified')} | {r.get('predecessor_wire_requests', 0)} / {r.get('successor_wire_requests', 0)} | {usage} | {flags}; before `{before.get('request_id') if before else '—'}` → after `{after.get('request_id') if after else '—'}` |")
    lines += ["", "## Limitations", "", "The date-labelled app-log selection uses local wall-clock dates, while persisted and provider records use UTC. Rotations and retained corpus availability are reported by the table, not assumed. Sanitized traffic cannot recover prompt semantics, server billing rules, or omitted usage; recorded `cost` values are summed only when scalar fields exist and are never extrapolated. Same-session reuse after a reset is transport evidence, not proof of semantic summary fidelity. Rollover requests without IDs or successor `session_init.rolloverFrom` remain unresolved. Gap/model-switch flags, workload mix, provider routing, and concurrent sessions confound any before/after interpretation.", "", "Reproduce with:", "", "```sh", "python3 docs/research/context-lifecycle-economics/analyze.py --start 2026-08-31 --end 2026-09-05 --output docs/research/context-lifecycle-economics/evidence.json --report docs/research/context-lifecycle-economics.md", "```"]
    return "\n".join(lines) + "\n"


def fmt(value: Any) -> str:
    return "—" if value is None else f"{value:.4f}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2026-08-31")
    parser.add_argument("--end", default="2026-09-05")
    parser.add_argument("--traffic-root", default="~/.local/state/term2-nodejs/logs/provider-traffic")
    parser.add_argument("--app-root", default="~/.local/state/term2-nodejs/logs")
    parser.add_argument("--conversation-root", default="~/.local/share/term2-nodejs/conversations")
    parser.add_argument("--output", required=True)
    parser.add_argument("--report")
    args = parser.parse_args()
    data = analyze(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as stream:
        json.dump(data, stream, indent=2, sort_keys=True)
        stream.write("\n")
    if args.report:
        Path(args.report).write_text(render_report(data), encoding="utf-8")


if __name__ == "__main__":
    main()
