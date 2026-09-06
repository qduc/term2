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
        self.assertEqual(analyze.usage_from_received(chat)["cached"], 40)
        self.assertEqual(analyze.usage_from_received(responses)["cached"], 0)
        self.assertIsNone(analyze.usage_from_received(no_cache)["cached"])

    def test_classification_is_structural(self):
        ordinary = {"body": {"messages": [{"role": "user", "content": "please summarize this"}]}}
        native = {"body": {"input": [{"type": "compaction", "id": "cmp_123"}]}}
        summarizer = {"body": {"operation": "compact"}}
        ok = {"summary": {"status": 200, "payload": {}}}
        self.assertEqual(analyze.classify_exchange(ordinary, ok), "ordinary")
        self.assertEqual(analyze.classify_exchange(native, ok), "native_compaction_reset")
        self.assertEqual(analyze.classify_exchange(summarizer, ok), "summarizer_request")
        self.assertEqual(analyze.classify_exchange(ordinary, {"summary": {"status": 500}}), "incomplete_or_error")

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


if __name__ == "__main__":
    unittest.main()
