#!/usr/bin/env python3
"""Build a read-only join of failed run_code finishes to canonical events.

The application logs are rotated and may overlap; messageId is the app-record
identity. Canonical conversation records are searched by the nested run_code
call id, and only tool_started/tool_result are counted as the call lifecycle.
This intentionally writes only to stdout so the caller can redirect to /tmp.
"""

from __future__ import annotations

import glob
import json
import os
from collections import defaultdict

LO = "2026-09-06 07:43:49"
HI = "2026-09-07 07:43:49"
APP_GLOB = os.path.expanduser("~/.local/state/term2-nodejs/logs/term2-2026-09-0[67].log*")
CONV_GLOB = os.path.expanduser("~/.local/share/term2-nodejs/conversations/*.jsonl")


def app_records():
    by_id = {}
    for path in glob.glob(APP_GLOB):
        with open(path, encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, 1):
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("message") != "run_code execution finished":
                    continue
                ts = record.get("timestamp", "")
                if not (LO <= ts <= HI) or record.get("ok") is not False:
                    continue
                identity = record.get("messageId") or (path, line_no)
                by_id.setdefault(identity, {**record, "_app": f"{path}:{line_no}"})
    return sorted(by_id.values(), key=lambda r: (r.get("timestamp", ""), r.get("messageId", "")))


def response_indexes():
    responses = defaultdict(list)
    all_responses = []
    for path in glob.glob(APP_GLOB):
        with open(path, encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, 1):
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("eventType") != "provider.response.received":
                    continue
                correlation = record.get("correlationId")
                all_responses.append({**record, "_app": f"{path}:{line_no}"})
                if correlation:
                    responses[correlation].append({**record, "_app": f"{path}:{line_no}"})
    for values in responses.values():
        values.sort(key=lambda r: (r.get("timestamp", ""), r.get("messageId", "")))
    all_responses.sort(key=lambda r: (r.get("timestamp", ""), r.get("messageId", "")))
    responses["__all__"] = all_responses
    return responses


def canonical_index(call_ids):
    found = defaultdict(list)
    remaining = set(call_ids)
    for path in glob.glob(CONV_GLOB):
        if not remaining:
            break
        with open(path, encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, 1):
                hits = [call_id for call_id in remaining if call_id in line]
                if not hits:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                event = record.get("event", {})
                call_id = event.get("toolCallId") or event.get("callId") or event.get("message", {}).get("callId")
                if call_id not in hits:
                    continue
                if event.get("type") in {"tool_started", "tool_result", "assistant_journal_item", "assistant_turn", "command_message"}:
                    found[call_id].append({"path": path, "line": line_no, "record": record})
                # A conversation file contains all copies; keep scanning it for
                # the result and remove only after finding a direct result.
                if event.get("type") == "tool_result" or (event.get("type") == "command_message" and event.get("message", {}).get("callId") == call_id):
                    remaining.discard(call_id)
    return found


def next_observed(canonical):
    """Return the next canonical tool call/result after this run_code result."""
    if not canonical:
        return None
    result_rows = [row for row in canonical if row["record"].get("event", {}).get("type") in {"tool_result", "command_message"}]
    if not result_rows:
        return None
    anchor = max(result_rows, key=lambda row: row["line"])
    path = anchor["path"]
    try:
        with open(path, encoding="utf-8") as fh:
            rows = list(fh)
    except OSError:
        return None
    next_call = None
    next_result = None
    for raw in rows[anchor["line"]:anchor["line"] + 600]:
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            continue
        event = record.get("event", {})
        if event.get("type") == "tool_started" and next_call is None:
            next_call = event
        if next_call is not None and event.get("type") == "tool_result" and event.get("callId") == next_call.get("toolCallId"):
            next_result = event
            break
        if next_call is not None and event.get("type") == "command_message" and event.get("message", {}).get("callId") == next_call.get("toolCallId"):
            next_result = event.get("message", {})
            break
    if next_call is None:
        return None
    outcome = (next_result or {}).get("output", "")
    return {
        "path": path,
        "callId": next_call.get("toolCallId"),
        "toolName": next_call.get("toolName"),
        "outcome": outcome[:500],
        "settled": next_result is not None,
    }


def nearest_response(finish, responses):
    values = responses.get(finish.get("correlationId"), [])
    if not finish.get("correlationId"):
        # Some DeepSeek app records intentionally have no correlationId. In
        # that case use the provider response in the same wall-clock second;
        # the millisecond messageId still orders response -> execution.
        values = [r for r in responses["__all__"] if r.get("timestamp") == finish.get("timestamp")]
    # messageId contains the millisecond epoch and provides ordering within a
    # wall-clock second where the app timestamp is intentionally second-level.
    finish_key = finish.get("messageId", "")
    prior = [r for r in values if r.get("messageId", "") <= finish_key]
    # App timestamps have seconds, so several response records can tie. The
    # last response carrying a run_code call is the most specific predecessor.
    for response in reversed(prior):
        calls = response.get("toolCalls") or []
        run_calls = [call for call in calls if call.get("function", {}).get("name") == "run_code"]
        if run_calls:
            call = run_calls[-1]
            return response, call
    return None, None


def main():
    failures = app_records()
    responses = response_indexes()
    joins = []
    call_ids = []
    for failure in failures:
        response, call = nearest_response(failure, responses)
        call_id = call.get("id") if call else None
        if call_id:
            call_ids.append(call_id)
        joins.append({
            "timestamp": failure.get("timestamp"),
            "correlationId": failure.get("correlationId"),
            "messageId": failure.get("messageId"),
            "toolCalls": failure.get("toolCalls"),
            "app": failure.get("_app"),
            "providerResponse": response and {
                "app": response.get("_app"), "requestId": response.get("requestId"),
                "sessionId": response.get("sessionId"), "provider": response.get("provider"),
                "model": response.get("model"), "timestamp": response.get("timestamp"),
            },
            "call": call,
        })
    canonical = canonical_index(call_ids)
    for join in joins:
        call_id = (join.get("call") or {}).get("id")
        join["canonical"] = canonical.get(call_id, [])
        join["nextObserved"] = next_observed(join["canonical"])
    print(json.dumps({"window": [LO, HI], "failedCount": len(failures), "joins": joins}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
