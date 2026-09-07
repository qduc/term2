#!/usr/bin/env python3
"""Deterministic contract tests for the evidence-only ledger helper."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("script-failure-ledger-2026-09-07.py")
SPEC = importlib.util.spec_from_file_location("script_failure_ledger", MODULE_PATH)
LEDGER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(LEDGER)


def write_jsonl(directory, name, records):
    path = Path(directory) / name
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
    return str(path)


def envelope(seq, event, ts="2026-09-06T01:00:00Z"):
    return {"seq": seq, "ts": ts, "event": event}


class LedgerParserTests(unittest.TestCase):
    def test_journal_only_result_uses_nested_item_call_id(self):
        with tempfile.TemporaryDirectory() as directory:
            path = write_jsonl(directory, "journal.jsonl", [envelope(7, {
                "type": "assistant_journal_item",
                "item": {"type": "tool_result", "callId": "call-journal", "toolName": "run_code", "status": "failed", "output": "bad"},
            })])
            found = LEDGER.canonical_index(["call-journal"], path)
            self.assertEqual(len(found["call-journal"]), 1)

    def test_duplicate_copies_are_all_kept_but_embedded_history_is_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = write_jsonl(directory, "copies.jsonl", [
                envelope(1, {"type": "tool_started", "toolCallId": "call-copy", "toolName": "run_code"}),
                envelope(2, {"type": "assistant_journal_item", "item": {"type": "tool_call", "callId": "call-copy", "toolName": "run_code"}}),
                envelope(3, {"type": "tool_result", "callId": "call-copy", "toolName": "run_code", "status": "failed", "output": "bad"}),
                envelope(4, {"type": "command_message", "message": {"callId": "call-copy", "output": "bad"}}),
                envelope(5, {"type": "assistant_turn", "turn": {"items": [{"type": "tool_result", "callId": "call-copy"}]}}),
            ])
            found = LEDGER.canonical_index(["call-copy"], path)
            self.assertEqual(len(found["call-copy"]), 4)

    def test_multiple_adjacent_run_code_calls_are_ambiguous(self):
        finish = {"timestamp": "2026-09-06 01:00:00", "messageId": "3", "correlationId": "corr"}
        response = {"timestamp": "2026-09-06 01:00:00", "messageId": "1", "correlationId": "corr", "toolCalls": [
            {"id": "call-a", "function": {"name": "run_code"}},
            {"id": "call-b", "function": {"name": "run_code"}},
        ]}
        executions = {
            "call-a": [{"timestamp": finish["timestamp"], "messageId": "2", "correlationId": "corr"}],
            "call-b": [{"timestamp": finish["timestamp"], "messageId": "2", "correlationId": "corr"}],
        }
        detail = LEDGER.nearest_response_detail(finish, {"corr": [response]}, executions)
        self.assertEqual(detail["status"], "ambiguous")
        self.assertEqual(LEDGER.nearest_response(finish, {"corr": [response]}, executions), (None, None))

    def test_wrong_time_execution_cannot_false_join(self):
        finish = {"timestamp": "2026-09-06 01:00:00", "messageId": "3", "correlationId": "corr"}
        response = {"timestamp": "2026-09-06 01:00:00", "messageId": "1", "correlationId": "corr", "toolCalls": [
            {"id": "call-old", "function": {"name": "run_code"}},
        ]}
        executions = {"call-old": [{"timestamp": "2026-09-06 00:59:59", "messageId": "2", "correlationId": "corr"}]}
        detail = LEDGER.nearest_response_detail(finish, {"corr": [response]}, executions)
        self.assertEqual(detail["status"], "no_execution_start")


if __name__ == "__main__":
    unittest.main()
