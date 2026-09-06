import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
import analyze


class AnalysisTests(unittest.TestCase):
    def test_usage_variants_and_missing_cache_are_distinct(self):
        chat = {"summary": {"payload": {"usage": {"prompt_tokens": 100,
            "completion_tokens": 7, "prompt_tokens_details": {"cached_tokens": 40}}}}}
        responses = {"summary": {"payload": {"usage": {"input_tokens": 80,
            "output_tokens": 5, "input_tokens_details": {"cached_tokens": 0}}}}}
        no_cache = {"summary": {"payload": {"usage": {"input_tokens": 20}}}}
        no_usage = {"summary": {"status": 200, "payload": {}}}
        self.assertEqual(analyze.usage_from_received(chat)["cached"], 40)
        self.assertEqual(analyze.usage_from_received(responses)["cached"], 0)
        self.assertIsNone(analyze.usage_from_received(no_cache)["cached"])
        self.assertFalse(analyze.usage_from_received(no_usage)["present"])
        self.assertEqual(analyze.exchange_outcome({}, no_usage), "success")

    def test_classification_is_structural(self):
        ordinary = {"body": {"messages": [{"role": "user", "content": "please summarize this"}]}}
        trigger = {"body": {"input": [{"type": "compaction_trigger"}]}}
        replay = {"body": {"input": [{"type": "compaction", "id": "cmp_123"}]}}
        guessed = {"body": {"operation": "compact", "summarizer": True}}
        ok = {"summary": {"status": 200, "payload": {}}}
        self.assertEqual(analyze.classify_exchange(ordinary, ok), "ordinary")
        self.assertEqual(analyze.classify_exchange(trigger, ok), "native_compaction_trigger")
        self.assertEqual(analyze.classify_exchange(replay, ok), "native_compaction_replay")
        self.assertEqual(analyze.classify_exchange(guessed, ok), "ordinary")
        self.assertEqual(analyze.exchange_outcome(trigger, {"summary": {"status": 500}}), "http_error")
        failed_trigger = {"error": {"name": "TimeoutError", "marker": "compaction_trigger"}}
        self.assertEqual(analyze.classify_exchange(trigger, failed_trigger), "native_compaction_trigger")
        self.assertEqual(analyze.exchange_outcome(trigger, failed_trigger), "error")

    def test_marker_paths_are_exact_and_errors_do_not_change_mechanism(self):
        nested_trigger = {"body": {"metadata": {"type": "compaction_trigger"}}}
        self.assertEqual(analyze.classify_exchange(nested_trigger, {"summary": {"status": 200, "payload": {}}}), "ordinary")
        self.assertEqual(
            analyze.classify_exchange(
                {"body": {"input": [{"type": "compaction_trigger"}]}},
                {"summary": {"status": 400, "payload": {}}},
            ),
            "native_compaction_trigger",
        )

    def test_lane_uses_recorded_metadata_and_marks_unattributed_requests(self):
        request = {
            "provider": "codex", "model": "gpt", "mode": "standard",
            "model_class": "OpenAIResponsesWSModel", "model_wrapper_class": "CodexResponsesWSModel",
            "request_kind": "turn",
        }
        self.assertEqual(analyze.request_lane(request), "codex/gpt/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn")
        self.assertEqual(analyze.request_lane({"provider": "p", "model": "m"}), "p/m/unknown/unattributed")
        # A pooled session's auxiliary request has no role metadata, so it is
        # not silently admitted to the attributed root lane.
        self.assertNotEqual(analyze.request_lane(request), analyze.request_lane({
            "provider": "codex", "model": "gpt", "mode": "standard",
        }))

    def test_dedup_and_weighted_stats(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "traffic" / "2026-08-31" / "session"
            root.mkdir(parents=True)
            def write(name, request_id, input_tokens, cached):
                record = {"sent": {"requestId": request_id, "sessionId": "s", "provider": "p", "model": "m",
                    "timestamp": "2026-08-31T00:00:00Z", "body": {"messages": []}},
                    "received": {"summary": {"status": 200, "payload": {"usage": {"prompt_tokens": input_tokens,
                        "completion_tokens": 1, "prompt_tokens_details": ({"cached_tokens": cached} if cached is not None else {})}}}}}
                (root / name).write_text(json.dumps(record), encoding="utf-8")
            write("a.json", "r", 100, 50)
            write("b.json", "r", 100, 50)
            write("c.json", "r2", 100, None)
            result = analyze.analyze_traffic(Path(directory) / "traffic", [__import__("datetime").date(2026, 8, 31)])
            self.assertEqual(result["request_count"], 2)
            stat = result["provider_model"]["p/m"]
            self.assertEqual(stat["input_tokens"], 200)
            self.assertEqual(stat["cached_tokens"], 50)
            self.assertEqual(stat["cache_observed_input_tokens"], 100)
            self.assertEqual(stat["cache_ratio_weighted"], 0.5)
            self.assertEqual(result["coverage_by_date"]["2026-08-31"]["duplicate_request_ids"], 1)

    def test_bucket_and_relative_cost(self):
        self.assertEqual(analyze.bucket(7999), "<8k")
        self.assertEqual(analyze.bucket(128000), "128k+")
        traffic = {"requests": [{"kind": "ordinary", "input": 100, "cached": 25}]}
        result = analyze.relative_cost(traffic)
        self.assertEqual(result["cached_fraction_observed"], 0.25)
        self.assertEqual(result["counterfactual_relative_input_cost_by_cached_price_ratio"]["0.1"], 0.775)

    def test_linked_economics_exposes_size_sensitivity_without_claiming_costs(self):
        link = {"rolloverId": "r", "before_after": {
            "lane": "p/m/standard/unattributed",
            "before_last": {"request_id": "before", "input": 1000},
            "after_first": {"request_id": "after", "input": 200, "cached": 100},
        }}
        result = analyze.linked_economics([link])
        self.assertEqual(result["aggregate"]["usable_sample_count"], 1)
        self.assertEqual(result["aggregate"]["cold_start_delta_tokens"], 100)
        self.assertEqual(result["formula"], "n > reset_cost / (cached_price * removed_context)")
        self.assertAlmostEqual(result["cached_price_ratio_sensitivity"]["0.1"]["aggregate_n_strictly_greater_than"], 2.5)
        self.assertTrue(result["aggregate"]["unknown_handoff_or_rework_cost"])


if __name__ == "__main__":
    unittest.main()
