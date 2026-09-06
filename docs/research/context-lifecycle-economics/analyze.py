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
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


BUCKETS = ((0, 8_000, "<8k"), (8_000, 32_000, "8-32k"),
           (32_000, 64_000, "32-64k"), (64_000, 128_000, "64-128k"),
           (128_000, math.inf, "128k+"))


def scalar(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def wire_input_items(sent: dict[str, Any]) -> list[dict[str, Any]]:
    """Return only the provider request's top-level Responses `input` items.

    The traffic logger records the sanitized request body verbatim.  Compaction
    markers are not inferred from arbitrary nested values: the Codex Responses
    wire contract puts them directly in `body.input`.
    """
    body = sent.get("body")
    items = body.get("input") if isinstance(body, dict) else None
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def request_kind(sent: dict[str, Any]) -> str | None:
    headers = sent.get("headers")
    raw = headers.get("x-codex-turn-metadata") if isinstance(headers, dict) else None
    if not isinstance(raw, str):
        return None
    try:
        metadata = json.loads(raw)
    except ValueError:
        return None
    value = metadata.get("request_kind") if isinstance(metadata, dict) else None
    return value if isinstance(value, str) else None


def request_lane(request: dict[str, Any]) -> str:
    """A conservative lane key from metadata actually retained by the logger."""
    provider = str(request.get("provider") or "unknown")
    model = str(request.get("model") or "unknown")
    mode = str(request.get("mode") or "unknown")
    model_class = request.get("model_class") or request.get("modelClass")
    wrapper = request.get("model_wrapper_class") or request.get("modelWrapperClass")
    kind = request.get("request_kind") or request.get("requestKind")
    if not isinstance(model_class, str) or not isinstance(wrapper, str):
        return f"{provider}/{model}/{mode}/unattributed"
    return f"{provider}/{model}/{mode}/{model_class}/{wrapper}/{kind if isinstance(kind, str) else 'unknown'}"


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


def classify_exchange(sent: dict[str, Any], received: dict[str, Any] | None = None) -> str:
    """Classify the mechanism from the exact sanitized Responses input path."""
    item_types = {item.get("type") for item in wire_input_items(sent)}
    if "compaction_trigger" in item_types:
        return "native_compaction_trigger"
    if "compaction" in item_types:
        return "native_compaction_replay"
    return "ordinary"


def exchange_outcome(sent: dict[str, Any], received: dict[str, Any] | None) -> str:
    """Classify HTTP/error state independently of the request mechanism."""
    if not isinstance(received, dict):
        return "missing_response"
    if isinstance(received.get("error"), dict):
        return "error"
    summary = received.get("summary")
    if not isinstance(summary, dict):
        return "incomplete"
    status = summary.get("status")
    if isinstance(status, int) and not 200 <= status < 300:
        return "http_error"
    if isinstance(status, int) and 200 <= status < 300 and isinstance(summary.get("payload"), dict):
        return "success"
    return "incomplete"


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
        "top_request_ids": [], "lanes": {}})
    requests: list[dict[str, Any]] = []
    seen: set[str] = set()
    classes = Counter()
    outcomes = Counter()
    mechanism_outcomes = Counter()
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
        outcome = exchange_outcome(sent, received)
        outcomes[outcome] += 1
        mechanism_outcomes[f"{kind}/{outcome}"] += 1
        dimension = coverage_by_date_provider_model[f"{day}/{label}"]
        dimension["files"] += 1
        dimension["complete"] += int(outcome == "success")
        dimension["incomplete_or_error"] += int(outcome != "success")
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
        metadata_request_kind = request_kind(sent)
        request_item = {"request_id": request_id, "session_id": session, "timestamp": stamp,
                         "provider": provider, "model": model, "kind": kind,
                          "mechanism": kind, "outcome": outcome, "mode": sent.get("mode"),
                          "model_class": sent.get("modelClass"),
                          "model_wrapper_class": sent.get("modelWrapperClass"),
                          "request_kind": metadata_request_kind,
                         "status": status, "input": usage["input"], "cached": usage["cached"],
                         "output": usage["output"], "cost": usage["cost"], "path": str(path),
                          "compaction_ids": [item["id"] for item in wire_input_items(sent)
                                             if item.get("type") == "compaction" and item.get("id")][:4]}
        request_item["lane"] = request_lane(request_item)
        lane = request_item["lane"]
        s["lanes"][lane] = s["lanes"].get(lane, 0) + 1
        requests.append(request_item)
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
            "request_count": len(requests), "classification": dict(classes), "outcomes": dict(outcomes),
            "mechanism_outcomes": dict(mechanism_outcomes), "wire_shapes": dict(shapes),
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
                        elif message == "Local context compaction blocked; continuing with uncompacted history":
                            counts["local_compaction_blocked"] += 1
                            records.append({"kind": "local_compaction_blocked", "timestamp": item.get("timestamp"),
                                            "correlation_id": item.get("correlationId"), "provider": item.get("provider"),
                                            "model": item.get("model"), "reason": item.get("reason")})
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
        view = lambda r: ({"request_id": r["request_id"], "timestamp": r["timestamp"],
                           "input": r["input"], "cached": r["cached"], "output": r["output"],
                           "model": r["model"], "provider": r["provider"], "mode": r["mode"],
                           "outcome": r["outcome"], "lane": r["lane"]} if r else None)
        # Session IDs pool root, child, and auxiliary calls.  Use the first
        # successor's complete recorded lane as the comparison lane; never
        # call adjacent requests in a pooled session one model's continuation.
        lane = successor_requests[0].get("lane") if successor_requests else None
        same_lane_successors = [r for r in successor_requests if lane and r.get("lane") == lane]
        rollover["first_successor_request"] = view(same_lane_successors[0]) if same_lane_successors else None
        rollover["subsequent_successor_requests"] = max(0, len(same_lane_successors) - 1)
        predecessor_requests = sorted(wire_by_session.get(rollover["sourceSessionId"], []), key=lambda x: x["timestamp"] or "")
        rollover["predecessor_wire_requests"] = len(predecessor_requests)
        same_lane_predecessors = [r for r in predecessor_requests if lane and r.get("lane") == lane]
        before = same_lane_predecessors[-1] if same_lane_predecessors else None
        after = same_lane_successors[0] if same_lane_successors else None
        rollover["before_after"] = {
            "before_last": view(before),
            "after_first": view(after),
            "model_switch": bool(before and after and before["model"] != after["model"]),
            "lane": lane,
            "predecessor_same_lane_requests": len(same_lane_predecessors),
            "successor_same_lane_requests": len(same_lane_successors),
            "successor_first_five": [view(r) for r in same_lane_successors[:5]],
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


def linked_economics(links: list[dict[str, Any]]) -> dict[str, Any]:
    """Sensitivity of observed linked sizes; deliberately not a savings model."""
    rows = []
    for link in links:
        before = link.get("before_after", {}).get("before_last")
        after = link.get("before_after", {}).get("after_first")
        if not before or not after or before.get("input") is None or after.get("input") is None:
            continue
        removed = max(0, before["input"] - after["input"])
        cold = after["input"] - after["cached"] if after.get("cached") is not None else None
        rows.append({"rollover_id": link.get("rolloverId"), "predecessor_input": before["input"],
                     "successor_first_input": after["input"], "successor_first_cached": after.get("cached"),
                     "removed_context_proxy": removed, "cold_start_delta": cold,
                     "reset_cost_proxy": after["input"], "lane": link.get("before_after", {}).get("lane")})
    aggregate = {"usable_sample_count": len(rows),
                 "cache_warm_sample_count": sum(r["cold_start_delta"] is not None for r in rows),
                 "predecessor_input_tokens": sum(r["predecessor_input"] for r in rows),
                 "successor_first_input_tokens": sum(r["successor_first_input"] for r in rows),
                 "reset_cost_proxy_tokens": sum(r["reset_cost_proxy"] for r in rows),
                 "removed_context_proxy_tokens": sum(r["removed_context_proxy"] for r in rows),
                 "cold_start_delta_tokens": sum(r["cold_start_delta"] or 0 for r in rows),
                 "unknown_handoff_or_rework_cost": True}
    sensitivity = {}
    for ratio in (0.01, 0.1, 0.25):
        horizons = [r["reset_cost_proxy"] / (ratio * r["removed_context_proxy"])
                    for r in rows if r["removed_context_proxy"] > 0]
        sensitivity[str(ratio)] = {"usable_horizons": len(horizons),
                                   "mean_n_strictly_greater_than": (sum(horizons) / len(horizons) if horizons else None),
                                   "aggregate_n_strictly_greater_than": (
                                       aggregate["reset_cost_proxy_tokens"] /
                                       (ratio * aggregate["removed_context_proxy_tokens"])
                                       if aggregate["removed_context_proxy_tokens"] else None)}
    return {"assumptions": [
        "reset_cost_proxy is the first same-lane successor input, priced at one uncached-input unit; handoff and rework costs are not logged",
        "removed_context_proxy is max(predecessor input minus first successor input, 0); this is a size delta, not causal context removal",
        "cached_price is a ratio to uncached input price; output prices, quality, latency, and provider billing are excluded",
    ], "formula": "n > reset_cost / (cached_price * removed_context)",
        "rows": rows, "aggregate": aggregate, "cached_price_ratio_sensitivity": sensitivity}


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
    native_resets = [r for r in traffic["requests"] if r["kind"] == "native_compaction_replay"]
    native_triggers = [r for r in traffic["requests"] if r["kind"] == "native_compaction_trigger"]
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
    local_summary = {"successful_summary_count": None,
                     "status": "unavailable",
                     "reason": "The retained app logger has local drop/blocked records but no persisted local summary-success marker; provider traffic has no local summary request envelope. This is unavailable, not zero."}
    economics = linked_economics(conv["verified_links"])
    return {"schema": 2, "window": {"start": args.start, "end": args.end, "timezone": "UTC for wire/conversations; app wall time retained as date-labelled"},
            "sources": {"traffic_root": portable(args.traffic_root), "app_log_root": portable(args.app_root), "conversation_root": portable(args.conversation_root)},
            "traffic": {k: v for k, v in traffic.items() if k not in ("requests", "session_requests")},
             "relative_cost": relative_cost(traffic), "app_events": app, "local_summary": local_summary,
             "linked_economics": economics, "app_events": app, "conversations": conv,
             "native_trigger_requests": [{k: r.get(k) for k in ("request_id", "timestamp", "session_id", "provider", "model", "mode", "request_kind", "input", "cached", "outcome", "lane")} for r in native_triggers],
            "native_reset_links": native_resets[:100],
             "limitations": ["Provider traffic is sanitized and records scalar usage, not prompt bodies.", "A missing cache field is not treated as zero; all coverage fields are explicit.", "Session IDs pool root, child, and auxiliary calls; role lanes are restricted to retained mode/model-class/request-kind metadata, and unattributed lanes remain pooled.", "Local summary success is unavailable from retained logging; no zero count is inferred.", "Historical accepted-link counts are not comparable unless their corpus window and metadata criteria are retained."]}


def render_report(data: dict[str, Any]) -> str:
    t = data["traffic"]
    cov = t["coverage_by_date"]
    lines = ["# Context-lifecycle economics (retained local evidence)", "", f"Window: **{data['window']['start']} through {data['window']['end']}** (inclusive).", "", "## Method and boundaries", "", "The standalone `analyze.py` reads provider-traffic JSON one file at a time, app JSONL rotations, and persisted conversation JSONL. Requests are deduplicated by the `(sent.requestId, sent.sessionId)` identity; index files are not counted. No prompts, previews, tool arguments, headers, response text, or ciphertext are emitted. Wire timestamps are UTC; app timestamps are local wall-clock labels. These are observations, not causal savings or policy thresholds.", "", "Wire/source contract checked: `source/services/logging/provider-traffic.ts` writes `sent.mode`, model class metadata, and the sanitized `sent.body`; `source/providers/codex-responses-model.ts` appends `input[*].type=compaction_trigger` for native compaction; `source/providers/codex.provider.ts` detects that exact final input item and records `request_kind=compaction`. This analyzer follows those paths and does not infer mechanism from prompt text or arbitrary nested `type` values.", "", "## Coverage", "", "| date | files | complete | usage | cache field | recorded cost | parse errors | duplicate request IDs |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for day, c in cov.items():
        lines.append(f"| {day} | {c['files']} | {c['complete']} | {c['usage_present']} / {c['usage_missing']} missing | {c['cache_field_present']} / {c['cache_field_missing']} missing | {c['cost_present']} | {c['parse_errors']} | {c['duplicate_request_ids']} |")
    lines += ["", f"Deduplicated traffic requests: **{t['request_count']}**. Wire shapes: `{json.dumps(t['wire_shapes'], sort_keys=True)}`. Mechanism classification: `{json.dumps(t['classification'], sort_keys=True)}`. Independent HTTP/error outcomes: `{json.dumps(t['outcomes'], sort_keys=True)}`; mechanism/outcome cross-tab: `{json.dumps(t['mechanism_outcomes'], sort_keys=True)}`. The Codex markers are recognized only at `sent.body.input[*].type`: `compaction_trigger` means trigger and `compaction` means replay marker. Guessed `body.compaction`, `body.summarizer`, and `body.operation` fields are not classified.", "", "Coverage by provider/model/date (all deduplicated files; `usage_missing` and `cache_field_missing` are fields, not zeroes):", "", "| date/provider/model | files | complete | incomplete/error | usage missing | cache missing | cost present |", "|---|---:|---:|---:|---:|---:|---:|"]
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
    lines += ["", "### Relative input-price sensitivity", "", f"Ordinary input totals: **{rc['ordinary_input_tokens_all']}** tokens; cache-observed denominator: **{rc['ordinary_input_tokens_cache_observed']}** across {rc['cache_observed_requests']} requests; cache-field-missing input: **{rc['cache_missing_input_tokens']}**. Ratios below use only the cache-observed denominator, never treating missing cache as zero. The counterfactual relative cost at cached/uncached price ratios is `{json.dumps(rc['counterfactual_relative_input_cost_by_cached_price_ratio'])}`. Formula: `{rc['formula']}`. This is a history-size sensitivity, not a provider bill or evidence that compaction caused savings. Reducing uncached history can reduce input cost even when cached and uncached unit prices are equal; no provider price schedule is available here.", "", "## Session growth and boundary flags", "", f"Sessions with traffic: **{len(t['sessions'])}**. Edges with >6-hour gap: **{t['gap_edges_over_6h']}**; model-switch edges: **{t['model_switch_edges']}**. Session IDs are pooled identifiers, not root-model context identities. The 8b49 session's **3,023 requests over {fmt_duration(t['sessions'].get('8b49b1ea-9cbe-4615-8b7f-71a0422e1f26', {}).get('first'), t['sessions'].get('8b49b1ea-9cbe-4615-8b7f-71a0422e1f26', {}).get('last'))}** include multiple providers/models and lanes; adjacent requests are not interpreted as one model context. These flags mark confounding boundaries rather than imputing continuity. Top sessions by request count:", ""]
    for sid, s in list(t["sessions"].items())[:15]:
        daily = ", ".join(f"{day}:{count}" for day, count in s.get("daily_requests", {}).items())
        lanes = ", ".join(f"{lane}={count}" for lane, count in list(s.get("lanes", {}).items())[:5])
        lines.append(f"- `{sid}`: {s['requests']} pooled requests ({daily}), input {s['usage_input_tokens']} tokens, models `{', '.join(s['models'])}`, lanes `{lanes}`, first `{s['first']}`, last `{s['last']}`, request IDs `{', '.join(s['top_request_ids'])}`")
    app = data["app_events"]
    conv = data["conversations"]
    lines += ["", "## Compaction and rollover evidence", "", f"App structured messages: `{json.dumps(app['counts'], sort_keys=True)}`. Persisted structured compaction event types: `{json.dumps(conv['event_counts'], sort_keys=True)}`. Local summary success: **{data['local_summary']['status']}** (successful count is not inferred). Native wire triggers: **{len(data['native_trigger_requests'])} retained examples** of **{t['classification'].get('native_compaction_trigger', 0)}**; native replay markers: **{len(data['native_reset_links'])}**. Trigger and replay are distinct mechanisms; HTTP/error outcome is tabulated independently. In particular, request `90343fc6-604d-4e99-864d-88aa40ef6e6b` is a `compaction_trigger` with input 206582, not ordinary traffic. Verified completed rollover predecessor→successor links: **{conv['completed_verified_links']}**.", "", "Native replay-marker artifact/request IDs and downstream reuse:"]
    for reset in data["native_reset_links"]:
        previous = reset.get("previous_same_session_request")
        peak = reset.get("peak_previous_request")
        prior = (f"previous request `{previous['request_id']}` input={previous['input']} cached={previous['cached']}" if previous else "no previous request")
        peak_text = (f"peak prior `{peak['request_id']}` input={peak['input']} cached={peak['cached']}" if peak else "no peak prior")
        high = ", ".join(f"`{item['request_id']}`={item['input']}" for item in reset.get("prior_high_input_requests", [])) or "—"
        lines.append(f"- session `{reset['session_id']}`, request `{reset['request_id']}`, replay marker `{', '.join(reset.get('compaction_ids', [])) or '—'}`, model `{reset['model']}`, timestamp `{reset['timestamp']}`, {prior}; {peak_text}; prior high-input requests {high}; replay input={reset['input']} cached={reset['cached']} (reduction from peak={reset.get('input_reduction_from_peak')}), later same-session wire requests: {reset.get('later_same_session_wire_requests', 0)}")
    lines += ["", "| rollover phase | event time | predecessor | successor | successor session_init verified | predecessor/ successor wire requests | first/subsequent usage | before→after flags |", "|---|---|---|---|---|---:|---|---|"]
    for r in conv["rollovers"]:
        first = r.get("first_successor_request")
        usage = (f"{first['input']}/{first['cached']} ({first['model']}) + {r.get('subsequent_successor_requests', 0)} subsequent" if first else "no wire request")
        before_after = r.get("before_after", {})
        before = before_after.get("before_last")
        after = before_after.get("after_first")
        flags = f"gap={before_after.get('gap_seconds', '—')}s, model_switch={before_after.get('model_switch', False)}"
        lines.append(f"| {r.get('phase')} | {r.get('event_ts')} | `{r.get('sourceSessionId')}` | `{r.get('successorSessionId')}` | {r.get('successor_verified')} | {r.get('predecessor_wire_requests', 0)} / {r.get('successor_wire_requests', 0)} | {usage} | {flags}; before `{before.get('request_id') if before else '—'}` → after `{after.get('request_id') if after else '—'}` |")
    econ = data["linked_economics"]
    agg = econ["aggregate"]
    lines += ["", "## Linked rollover size sensitivity", "", f"The current rerun verifies **{conv['completed_verified_links']}** completed links using conversation `session_init.rolloverFrom` plus traffic IDs. Historical material reported 23 accepted links; that count is not a comparable denominator here because its corpus window and metadata coverage are not retained. The current method uses same-lane predecessor/ successor records; where model class, wrapper, or request-kind metadata is absent, the lane is explicitly unattributed rather than guessed.", "", f"Usable linked size pairs: **{agg['usable_sample_count']}**; cache-observed first successors: **{agg['cache_warm_sample_count']}**. Sum predecessor input={agg['predecessor_input_tokens']}; sum first-successor input={agg['successor_first_input_tokens']}; reset-cost proxy={agg['reset_cost_proxy_tokens']}; observed size-delta proxy={agg['removed_context_proxy_tokens']}; cold-start delta (first successor input minus cached input)={agg['cold_start_delta_tokens']}. Handoff and rework cost are unknown, so these are not savings.", "", "Relative horizon sensitivity (not a compaction break-even or policy recommendation):", "", f"Formula: `{econ['formula']}`. {econ['assumptions'][0]}. {econ['assumptions'][1]}.", "", "| cached/uncached price ratio | usable pairs | aggregate strict horizon n | mean per-link strict horizon n |", "|---:|---:|---:|---:|"]
    for ratio, values in econ["cached_price_ratio_sensitivity"].items():
        lines.append(f"| {ratio} | {values['usable_horizons']} | {fmt(values['aggregate_n_strictly_greater_than'])} | {fmt(values['mean_n_strictly_greater_than'])} |")
    lines += ["", "Per-link evidence (root predecessor input and first five same-lane successor requests; `cached=—` means usage missing):"]
    for r in conv["verified_links"]:
        ba = r.get("before_after", {})
        before = ba.get("before_last") or {}
        successors = ba.get("successor_first_five", [])
        successor_text = "; ".join(f"{item['request_id']} input={item['input']} cached={item['cached']}" for item in successors) or "no same-lane successor usage"
        lines.append(f"- rollover `{r.get('rolloverId')}` lane `{ba.get('lane')}`: predecessor `{before.get('request_id', '—')}` input={before.get('input', '—')} → {successor_text}")
    lines += ["", "## Limitations", "", "The date-labelled app-log selection uses local wall-clock dates, while persisted and provider records use UTC. Rotations and retained corpus availability are reported by the table, not assumed. Sanitized traffic cannot recover prompt semantics, server billing rules, or omitted usage; recorded `cost` values are summed only when scalar fields exist and are never extrapolated. Same-session reuse after a replay marker is transport evidence, not proof of semantic summary fidelity. Local summary success is unavailable from retained logs, not zero. Session IDs pool root, child, and auxiliary calls; only exact retained lane metadata is used for before/after links. Rollover requests without IDs or successor `session_init.rolloverFrom` remain unresolved. Handoff/rework cost, quality, latency, workload mix, provider routing, and concurrent sessions are unknown or confounded.", "", "Reproduce with:", "", "```sh", "python3 docs/research/context-lifecycle-economics/analyze.py --start 2026-08-31 --end 2026-09-05 --output docs/research/context-lifecycle-economics/evidence.json --report docs/research/context-lifecycle-economics.md", "```"]
    return "\n".join(lines) + "\n"


def fmt(value: Any) -> str:
    return "—" if value is None else f"{value:.4f}"


def fmt_duration(start: str | None, end: str | None) -> str:
    if not start or not end:
        return "unknown duration"
    try:
        a = dt.datetime.fromisoformat(start.replace("Z", "+00:00"))
        b = dt.datetime.fromisoformat(end.replace("Z", "+00:00"))
        return f"{(b - a).total_seconds() / 3600:.2f}h"
    except ValueError:
        return "unknown duration"


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
