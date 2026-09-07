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
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone

LO = "2026-09-06 07:43:49"
HI = "2026-09-07 07:43:49"
APP_GLOB = os.path.expanduser("~/.local/state/term2-nodejs/logs/term2-2026-09-0[67].log*")
CONV_GLOB = os.path.expanduser("~/.local/share/term2-nodejs/conversations/*.jsonl")
DIRECT_TYPES = {"tool_started", "tool_result", "assistant_journal_item", "command_message"}
MESSAGE_EPOCH = re.compile(r"^msg-(\d+)-")
# This is a deliberately labelled candidate-window heuristic. It is not an
# execution timeout and must never be reported as an absent execution start.
BOUNDED_CANDIDATE_SECONDS = 5


def _records(pattern, skipped=None):
    for path in glob.glob(pattern):
        try:
            with open(path, encoding="utf-8") as fh:
                for line_no, line in enumerate(fh, 1):
                    try:
                        yield path, line_no, json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except OSError as error:
            if skipped is not None:
                skipped.append({"path": path, "error": str(error)})


def _timestamp_epoch(value):
    """Convert a log timestamp to an ordering value without inventing one."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone(timedelta(hours=7)))
    return parsed.timestamp()


def _message_epoch(value):
    if not isinstance(value, str):
        return None
    match = MESSAGE_EPOCH.match(value)
    return int(match.group(1)) / 1000 if match else None


def _app_key(record):
    """Order by the message's own epoch, with only a stable tie-breaker.

    Rotation names are not chronological (``.10`` sorts before ``.9``), so
    they must never be the primary ordering signal.  Records without a
    message epoch use their timestamp; path/line only makes equal or unknown
    records deterministic and does not claim they happened in that order.
    """
    app = record.get("_app", "")
    try:
        path, line = app.rsplit(":", 1)
        fallback = (path, int(line))
    except (ValueError, AttributeError):
        fallback = ("", 0)
    epoch = _message_epoch(record.get("messageId"))
    if epoch is None:
        epoch = _timestamp_epoch(record.get("timestamp"))
    # All tuple members have fixed types so malformed records remain sortable.
    return (epoch is None, epoch if epoch is not None else 0, fallback, str(record.get("messageId", "")))


def _app_source(record):
    app = record.get("_app", "")
    try:
        path, line = app.rsplit(":", 1)
        return path, int(line)
    except (ValueError, AttributeError):
        return None


def _app_precedes(left, right):
    """Compare records only where their timestamps/source establish order."""
    left_ts = _timestamp_epoch(left.get("timestamp"))
    right_ts = _timestamp_epoch(right.get("timestamp"))
    if left_ts is None or right_ts is None:
        return False
    if left_ts != right_ts:
        return left_ts < right_ts
    left_source = _app_source(left)
    right_source = _app_source(right)
    if left_source and right_source and left_source[0] == right_source[0]:
        return left_source[1] <= right_source[1]
    left_epoch = _message_epoch(left.get("messageId"))
    right_epoch = _message_epoch(right.get("messageId"))
    if left_epoch is not None and right_epoch is not None:
        return left_epoch <= right_epoch
    left_id = left.get("messageId")
    right_id = right.get("messageId")
    if left_id is not None and right_id is not None:
        return str(left_id) <= str(right_id)
    # Same-second records from different files without two message epochs have
    # no trustworthy chronology; do not manufacture one from rotation names.
    return left is right


def app_records(pattern=APP_GLOB, skipped=None):
    by_id = {}
    for path, line_no, record in _records(pattern, skipped):
        if record.get("message") != "run_code execution finished":
            continue
        if not (LO <= record.get("timestamp", "") <= HI) or record.get("ok") is not False:
            continue
        identity = record.get("messageId") or (path, line_no)
        by_id.setdefault(identity, {**record, "_app": f"{path}:{line_no}"})
    return sorted(by_id.values(), key=_app_key)


def response_indexes(pattern=APP_GLOB, skipped=None):
    responses = defaultdict(list)
    all_responses = []
    for path, line_no, record in _records(pattern, skipped):
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


def execution_indexes(pattern=APP_GLOB, skipped=None):
    """Index application-owned execution starts by call ID."""
    starts = defaultdict(list)
    for path, line_no, record in _records(pattern, skipped):
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


def canonical_index(call_ids, pattern=CONV_GLOB, skipped=None):
    """Return every direct lifecycle copy for each requested call ID.

    ``assistant_journal_item.item.callId`` is a real call identity.  We scan
    the complete corpus because one call may have journal, start, settlement,
    and command-message copies.  ``assistant_turn`` is excluded: it embeds
    transcript history and is not a new execution.
    """
    wanted = set(call_ids)
    found = defaultdict(list)
    for path, line_no, record in _records(pattern, skipped):
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
    item = _event_item(event)
    for key in ("success", "ok"):
        value = item.get(key)
        if isinstance(value, bool):
            return value
    status = item.get("status")
    if status in {"failed", "aborted", "unknown"}:
        return False
    # A completed status is delivery/settlement state, not a semantic success
    # signal: command_message may carry the actual `success:false` settlement
    # for the same call.
    if status == "completed":
        return None
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


def next_observed(canonical, skipped=None):
    """Return the next direct call/result with sequence and success evidence."""
    result_rows = [row for row in canonical if _event_kind(row["record"].get("event", {})) == "tool_result"]
    if not result_rows:
        return None
    anchor = max(result_rows, key=_row_order)
    path = anchor["path"]
    try:
        with open(path, encoding="utf-8") as fh:
            rows = list(fh)
    except OSError as error:
        if skipped is not None:
            skipped.append({"path": path, "error": str(error)})
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
    if execution.get("correlationId") and finish.get("correlationId") and execution.get("correlationId") != finish.get("correlationId"):
        return False
    return _app_precedes(response, execution) and _app_precedes(execution, finish)


def _bounded_candidate(execution, response, finish):
    """Apply the historical candidate window without calling it a timeout."""
    if not _execution_adjacent(execution, response, finish):
        return False
    try:
        started_at = datetime.fromisoformat(execution["timestamp"])
        finished_at = datetime.fromisoformat(finish["timestamp"])
    except (KeyError, TypeError, ValueError):
        return False
    return (finished_at - started_at).total_seconds() <= BOUNDED_CANDIDATE_SECONDS


def nearest_response_detail(finish, responses, executions=None):
    """Join only a unique response/call with an adjacent execution start.

    Parallel calls and same-second candidates are explicitly rejected rather
    than silently selecting the last provider call.
    """
    values = responses.get(finish.get("correlationId"), []) if finish.get("correlationId") else [
        response for response in responses.get("__all__", []) if response.get("timestamp") == finish.get("timestamp")
    ]
    candidates = []
    bounded_candidates = []
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
            bounded = [start for start in adjacent if _bounded_candidate(start, response, finish)]
            if executions is not None and not bounded:
                if adjacent:
                    bounded_candidates.append(call_id)
                continue
            candidates.append((response, call, bounded if executions is not None else adjacent))
    if not candidates:
        if bounded_candidates:
            return {"status": "bounded_candidate", "callIds": bounded_candidates}
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


def _canonical_failure_evidence(rows):
    """Return semantic failure evidence without interpreting output text."""
    for row in _canonical_result_rows(rows):
        event = row["record"].get("event", {})
        item = _event_item(event)
        if isinstance(item.get("success"), bool) and item["success"] is False:
            return True
        if isinstance(item.get("ok"), bool) and item["ok"] is False:
            return True
        if item.get("status") in {"failed", "aborted"}:
            return True
    return False


def _canonical_body_evidence(failure, rows):
    """Separate a located result body from a proven failed-call join.

    A non-empty journal output is only a located body.  In particular, output
    text is not searched for words such as ``error`` and a journal
    ``status:completed`` is not treated as success or failure.  A failed join
    needs the app timestamp, a direct result row, and explicit failure
    settlement when one is present.
    """
    result_rows = _canonical_result_rows(rows)
    timestamp_rows = [
        row for row in result_rows
        if _timestamp_match(failure.get("timestamp"), row["record"].get("ts"))
    ]
    expected = _failure_body(failure)
    expected = expected.strip() if isinstance(expected, str) else None
    body_match = False
    for row in timestamp_rows:
        actual = _event_result(row["record"].get("event", {}))
        if actual in (None, "", []):
            continue
        if expected is None:
            # This is deliberately only a direct result row at the matching
            # timestamp, not a tool call or embedded transcript copy.
            body_match = True
            break
        if isinstance(actual, str) and (actual.strip() == expected or expected in actual or actual.strip() in expected):
            body_match = True
            break
    failure_proven = body_match and _canonical_failure_evidence(timestamp_rows)
    return {
        "locatedBody": body_match,
        "provenFailure": failure_proven,
        "status": "proven" if failure_proven else "located" if body_match else "unknown",
        "directResult": bool(result_rows),
        "timestampMatch": bool(timestamp_rows),
        "explicitFailure": _canonical_failure_evidence(timestamp_rows),
    }


def _canonical_body_matches(failure, rows):
    """Compatibility predicate for a *proven* canonical failure body."""
    return _canonical_body_evidence(failure, rows)["provenFailure"]


def _canonical_result_rows(rows):
    return [
        row for row in rows
        if _event_kind(row["record"].get("event", {})) == "tool_result"
    ]


def main():
    skipped = []
    failures = app_records(skipped=skipped)
    responses = response_indexes(skipped=skipped)
    executions = execution_indexes(skipped=skipped)
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
    canonical = canonical_index(call_ids, skipped=skipped)
    validation = {
        "callIds": 0,
        "failedTimestamp": 0,
        "errorBody": 0,
        "errorBodyChecked": 0,
        "bodyLocated": 0,
        "provenFailure": 0,
        "provenJoin": 0,
    }
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
        join["nextObserved"] = next_observed(rows, skipped)
        validation_rows = rows or [row for candidate in candidate_rows.values() for row in candidate]
        result_rows = _canonical_result_rows(validation_rows)
        body_evidence = _canonical_body_evidence(failure, validation_rows)
        join["canonicalBody"] = body_evidence
        join["validation"] = {
            "callId": bool(candidate_rows and all(
                _event_call_id(row["record"].get("event", {})) == candidate
                for candidate, candidate_rows_for_call in candidate_rows.items()
                for row in candidate_rows_for_call
            )),
            "failedTimestamp": any(_timestamp_match(failure.get("timestamp"), row["record"].get("ts")) for row in result_rows),
            "errorBody": body_evidence["provenFailure"],
            "bodyLocated": body_evidence["locatedBody"],
            "provenJoin": join.get("joinStatus") == "matched" and body_evidence["provenFailure"],
        }
        validation["callIds"] += int(join["validation"]["callId"])
        validation["failedTimestamp"] += int(join["validation"]["failedTimestamp"])
        validation["errorBodyChecked"] += int(bool(result_rows))
        validation["errorBody"] += int(join["validation"]["errorBody"])
        validation["bodyLocated"] += int(join["validation"]["bodyLocated"])
        validation["provenFailure"] += int(join["validation"]["errorBody"])
        validation["provenJoin"] += int(join["validation"]["provenJoin"])
    unique_skips = {json.dumps(item, sort_keys=True): item for item in skipped}
    print(json.dumps({
        "window": [LO, HI],
        "failedCount": len(failures),
        "joins": joins,
        "validation": validation,
        "skippedFiles": list(unique_skips.values()),
    }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
