#!/usr/bin/env python3
"""Build a read-only join of failed ``run_code`` finishes to canonical events.

This evidence helper lives beside the report rather than in the production
``scripts/`` tree.  It reads rotated application logs and canonical
conversation JSONL and writes only JSON to stdout.
"""

from __future__ import annotations

import glob
import json
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone

LO = "2026-09-06 07:43:49"
HI = "2026-09-07 07:43:49"
APP_GLOB = os.path.expanduser("~/.local/state/term2-nodejs/logs/term2-2026-09-0[67].log*")
CONV_GLOB = os.path.expanduser("~/.local/share/term2-nodejs/conversations/*.jsonl")
DIRECT_TYPES = {"tool_started", "tool_result", "assistant_journal_item", "command_message"}


def _records(pattern):
    for path in glob.glob(pattern):
        try:
            with open(path, encoding="utf-8") as fh:
                for line_no, line in enumerate(fh, 1):
                    try:
                        yield path, line_no, json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except OSError:
            continue


def _app_key(record):
    app = record.get("_app", "")
    try:
        path, line = app.rsplit(":", 1)
        return (record.get("timestamp", ""), path, int(line))
    except (ValueError, AttributeError):
        return (record.get("timestamp", ""), "", record.get("messageId", ""))


def app_records(pattern=APP_GLOB):
    by_id = {}
    for path, line_no, record in _records(pattern):
        if record.get("message") != "run_code execution finished":
            continue
        if not (LO <= record.get("timestamp", "") <= HI) or record.get("ok") is not False:
            continue
        identity = record.get("messageId") or (path, line_no)
        by_id.setdefault(identity, {**record, "_app": f"{path}:{line_no}"})
    return sorted(by_id.values(), key=_app_key)


def response_indexes(pattern=APP_GLOB):
    responses = defaultdict(list)
    all_responses = []
    for path, line_no, record in _records(pattern):
        if record.get("eventType") != "provider.response.received":
            continue
        value = {**record, "_app": f"{path}:{line_no}"}
        all_responses.append(value)
        if record.get("correlationId"):
            responses[record["correlationId"]].append(value)
    for values in responses.values():
        values.sort(key=_app_key)
    all_responses.sort(key=_app_key)
    responses["__all__"] = all_responses
    return responses


def execution_indexes(pattern=APP_GLOB):
    """Index application-owned execution starts by call ID."""
    starts = defaultdict(list)
    for path, line_no, record in _records(pattern):
        if record.get("eventType") != "tool_call.execution_started":
            continue
        call_id = record.get("toolCallId") or record.get("callId")
        if call_id:
            starts[call_id].append({**record, "_app": f"{path}:{line_no}"})
    for values in starts.values():
        values.sort(key=_app_key)
    return starts


def _journal_item(event):
    item = event.get("item")
    return item if isinstance(item, dict) else None


def _event_call_id(event):
    event_type = event.get("type")
    if event_type == "assistant_journal_item":
        item = _journal_item(event)
        return item.get("callId") if item and item.get("type") in {"tool_call", "tool_result"} else None
    if event_type == "tool_started":
        return event.get("toolCallId") or event.get("callId")
    if event_type == "tool_result":
        return event.get("callId") or event.get("toolCallId")
    if event_type == "command_message":
        message = event.get("message")
        return message.get("callId") if isinstance(message, dict) else None
    return None


def _is_direct_call_event(event):
    if event.get("type") not in DIRECT_TYPES:
        return False
    if event.get("type") == "assistant_journal_item":
        item = _journal_item(event)
        return bool(item and item.get("type") in {"tool_call", "tool_result"})
    return _event_call_id(event) is not None


def canonical_index(call_ids, pattern=CONV_GLOB):
    """Return every direct lifecycle copy for each requested call ID.

    ``assistant_journal_item.item.callId`` is a real call identity.  We scan
    the complete corpus because one call may have journal, start, settlement,
    and command-message copies.  ``assistant_turn`` is excluded: it embeds
    transcript history and is not a new execution.
    """
    wanted = set(call_ids)
    found = defaultdict(list)
    for path, line_no, record in _records(pattern):
        event = record.get("event", {})
        if _is_direct_call_event(event) and _event_call_id(event) in wanted:
            found[_event_call_id(event)].append({"path": path, "line": line_no, "record": record})
    return found


def _event_item(event):
    if event.get("type") == "assistant_journal_item":
        return _journal_item(event) or {}
    if event.get("type") == "command_message":
        return event.get("message") or {}
    return event


def _event_kind(event):
    if event.get("type") == "assistant_journal_item":
        return (_journal_item(event) or {}).get("type")
    if event.get("type") == "command_message":
        return "tool_result"
    return event.get("type")


def _event_result(event):
    item = _event_item(event)
    return item.get("output", item.get("result", item.get("content", "")))


def _result_success(event):
    if not event:
        return None
    status = _event_item(event).get("status")
    if status == "completed":
        return True
    if status in {"failed", "aborted", "unknown"}:
        return False
    return None


def _bounded_result(value):
    if isinstance(value, str):
        return value[:500]
    try:
        return json.dumps(value, ensure_ascii=False)[:500]
    except TypeError:
        return str(value)[:500]


def _row_order(row):
    record = row["record"]
    return (record.get("ts", ""), record.get("seq", -1), row["path"], row["line"])


def next_observed(canonical):
    """Return the next direct call/result with sequence and success evidence."""
    result_rows = [row for row in canonical if _event_kind(row["record"].get("event", {})) == "tool_result"]
    if not result_rows:
        return None
    anchor = max(result_rows, key=_row_order)
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
        if not _is_direct_call_event(event):
            continue
        kind = _event_kind(event)
        call_id = _event_call_id(event)
        if kind == "tool_call" or (event.get("type") == "tool_started" and next_call is None):
            if next_call is None:
                next_call = (record, event)
            continue
        if next_call and kind == "tool_result" and call_id == _event_call_id(next_call[1]):
            next_result = (record, event)
            break
    if not next_call:
        return None
    record, event = next_call
    result_record, result_event = next_result or (None, None)
    item = _journal_item(event) or {}
    return {
        "path": path,
        "eventSeq": record.get("seq"),
        "timestamp": record.get("ts"),
        "callId": _event_call_id(event),
        "toolName": event.get("toolName") or item.get("toolName"),
        "result": _bounded_result(_event_result(result_event)) if result_event else None,
        "success": _result_success(result_event),
        "resultEventSeq": result_record.get("seq") if result_record else None,
        "resultTimestamp": result_record.get("ts") if result_record else None,
        "settled": result_event is not None,
    }


def _response_identity(response):
    return response.get("messageId") or response.get("requestId") or response.get("_app")


def _execution_adjacent(execution, response, finish):
    if not (response.get("timestamp", "") <= execution.get("timestamp", "") <= finish.get("timestamp", "")):
        return False
    try:
        started_at = datetime.fromisoformat(execution["timestamp"])
        finished_at = datetime.fromisoformat(finish["timestamp"])
        if (finished_at - started_at).total_seconds() > 5:
            return False
    except (KeyError, TypeError, ValueError):
        return False
    if execution.get("correlationId") and finish.get("correlationId") and execution.get("correlationId") != finish.get("correlationId"):
        return False
    return _app_key(response) <= _app_key(execution) <= _app_key(finish)


def nearest_response_detail(finish, responses, executions=None):
    """Join only a unique response/call with an adjacent execution start.

    Parallel calls and same-second candidates are explicitly rejected rather
    than silently selecting the last provider call.
    """
    values = responses.get(finish.get("correlationId"), []) if finish.get("correlationId") else [
        response for response in responses.get("__all__", []) if response.get("timestamp") == finish.get("timestamp")
    ]
    candidates = []
    seen = set()
    for response in values:
        if _app_key(response) > _app_key(finish):
            continue
        identity = _response_identity(response)
        if identity in seen:
            continue
        seen.add(identity)
        for call in response.get("toolCalls") or []:
            if call.get("function", {}).get("name") != "run_code":
                continue
            call_id = call.get("id")
            starts = (executions or {}).get(call_id, [])
            adjacent = [start for start in starts if _execution_adjacent(start, response, finish)]
            if executions is not None and not adjacent:
                continue
            candidates.append((response, call, adjacent))
    if not candidates:
        if executions is not None:
            fallback_calls = []
            for response in reversed(values):
                if _app_key(response) > _app_key(finish):
                    continue
                fallback_calls = [
                    call.get("id") for call in response.get("toolCalls") or []
                    if call.get("function", {}).get("name") == "run_code" and call.get("id")
                ]
                if fallback_calls:
                    break
            return {"status": "no_execution_start", "callIds": fallback_calls}
        return {"status": "no_response"}
    call_ids = {candidate[1].get("id") for candidate in candidates}
    if len(candidates) != 1 or len(call_ids) != 1:
        return {"status": "ambiguous", "callIds": sorted(call_id for call_id in call_ids if call_id)}
    response, call, adjacent = candidates[0]
    return {"status": "matched", "response": response, "call": call, "execution": adjacent}


def nearest_response(finish, responses, executions=None):
    detail = nearest_response_detail(finish, responses, executions)
    return (detail["response"], detail["call"]) if detail["status"] == "matched" else (None, None)


def _failure_body(record):
    for key in ("errorBody", "error", "errorMessage", "result", "output", "body"):
        value = record.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _timestamp_match(failed, canonical_ts):
    if not failed or not canonical_ts:
        return False
    if failed == canonical_ts:
        return True
    try:
        local = datetime.fromisoformat(failed.replace("Z", "+00:00"))
        if local.tzinfo is None:
            local = local.replace(tzinfo=timezone(timedelta(hours=7)))
        utc = datetime.fromisoformat(canonical_ts.replace("Z", "+00:00"))
        return abs((local - utc).total_seconds()) < 1
    except (TypeError, ValueError):
        return False


def _canonical_body_matches(failure, rows):
    expected = _failure_body(failure)
    if not expected:
        return any(
            _event_result(row["record"].get("event", {})) not in (None, "", [])
            for row in _canonical_result_rows(rows)
        )
    expected = expected.strip()
    for row in rows:
        event = row["record"].get("event", {})
        if _event_kind(event) != "tool_result":
            continue
        actual = _event_result(event)
        if isinstance(actual, str) and (actual.strip() == expected or expected in actual or actual.strip() in expected):
            return True
    return False


def _canonical_result_rows(rows):
    return [
        row for row in rows
        if _event_kind(row["record"].get("event", {})) == "tool_result"
    ]


def main():
    failures = app_records()
    responses = response_indexes()
    executions = execution_indexes()
    joins = []
    call_ids = []
    for failure in failures:
        detail = nearest_response_detail(failure, responses, executions)
        response, call = detail.get("response"), detail.get("call")
        call_id = call.get("id") if call else None
        candidate_call_ids = detail.get("callIds", [])
        if call_id:
            candidate_call_ids = [call_id]
        call_ids.extend(candidate_call_ids)
        joins.append({
            "timestamp": failure.get("timestamp"),
            "correlationId": failure.get("correlationId"),
            "messageId": failure.get("messageId"),
            "toolCalls": failure.get("toolCalls"),
            "app": failure.get("_app"),
            "joinStatus": detail.get("status"),
            "candidateCallIds": candidate_call_ids,
            "providerResponse": response and {
                "app": response.get("_app"), "requestId": response.get("requestId"),
                "sessionId": response.get("sessionId"), "provider": response.get("provider"),
                "model": response.get("model"), "timestamp": response.get("timestamp"),
            },
            "call": call,
        })
    canonical = canonical_index(call_ids)
    validation = {"callIds": 0, "failedTimestamp": 0, "errorBody": 0, "errorBodyChecked": 0}
    for join, failure in zip(joins, failures):
        call_id = (join.get("call") or {}).get("id")
        candidate_rows = {
            candidate: canonical.get(candidate, [])
            for candidate in join.get("candidateCallIds", [])
        }
        rows = canonical.get(call_id, []) if call_id else []
        join["canonical"] = rows
        if not rows and candidate_rows:
            join["canonicalCandidates"] = candidate_rows
        join["nextObserved"] = next_observed(rows)
        validation_rows = rows or [row for candidate in candidate_rows.values() for row in candidate]
        result_rows = _canonical_result_rows(validation_rows)
        join["validation"] = {
            "callId": bool(candidate_rows and all(
                _event_call_id(row["record"].get("event", {})) == candidate
                for candidate, candidate_rows_for_call in candidate_rows.items()
                for row in candidate_rows_for_call
            )),
            "failedTimestamp": any(_timestamp_match(failure.get("timestamp"), row["record"].get("ts")) for row in result_rows),
            "errorBody": _canonical_body_matches(failure, validation_rows),
        }
        validation["callIds"] += int(join["validation"]["callId"])
        validation["failedTimestamp"] += int(join["validation"]["failedTimestamp"])
        validation["errorBodyChecked"] += int(bool(result_rows))
        validation["errorBody"] += int(join["validation"]["errorBody"])
    print(json.dumps({"window": [LO, HI], "failedCount": len(failures), "joins": joins, "validation": validation}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
