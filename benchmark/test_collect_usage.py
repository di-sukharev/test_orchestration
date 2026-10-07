import json
import tempfile
import unittest
import sqlite3
from pathlib import Path
from collect_usage import parse_session, price, parent_of, collect


class CollectorTests(unittest.TestCase):
    def test_cached_and_reasoning_not_double_charged(self):
        usage = dict(input_tokens=1000000, cached_input_tokens=800000, cache_write_input_tokens=0, output_tokens=10000, reasoning_output_tokens=5000)
        # Long request: uncached $4 + cached $1.6 + output $0.75.
        self.assertAlmostEqual(price("gpt-6-astra", usage)["api_equivalent_usd_standard"], 6.35)
        self.assertAlmostEqual(price("gpt-6-astra", usage)["codex_credits_standard"], 82.5)

    def test_duplicate_records_and_cumulative_snapshots(self):
        usage = dict(input_tokens=1000, cached_input_tokens=800, cache_write_input_tokens=0, output_tokens=10, reasoning_output_tokens=5, total_tokens=1010)
        record = {"timestamp": "2026-10-07T00:00:01Z", "type": "token_usage_record", "payload": {"response_id": "a", "usage": usage, "thread_token_usage": usage}}
        snapshot = {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": usage}}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "events.jsonl"
            path.write_text("\n".join(json.dumps(e) for e in [record, record, snapshot, snapshot]))
            session = parse_session({"id": "root", "source": "cli", "rollout_path": str(path), "model": "gpt-6-astra", "reasoning_effort": "high", "agent_path": None})
        self.assertEqual(session["usage"], usage)
        self.assertEqual(session["request_count"], 1)
        self.assertEqual(session["warnings"], [])

    def test_parent_link(self):
        self.assertEqual(parent_of({"source": json.dumps({"subagent": {"thread_spawn": {"parent_thread_id": "root"}}})}), "root")
        self.assertIsNone(parent_of({"source": "cli"}))

    def test_recursive_descendants_excludes_unrelated_sessions(self):
        usage = dict(input_tokens=1000, cached_input_tokens=800, cache_write_input_tokens=0, output_tokens=10, reasoning_output_tokens=5, total_tokens=1010)
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "state.sqlite"
            con = sqlite3.connect(database)
            con.execute("CREATE TABLE threads (id,source,rollout_path,model,reasoning_effort,agent_path)")
            for ident, parent, model in [("root", None, "gpt-6-astra"), ("worker", "root", "gpt-6-luna"), ("nested", "worker", "gpt-6.1-sol"), ("unrelated", None, "gpt-6-astra")]:
                path = Path(tmp) / (ident + ".jsonl")
                events = [
                    {"type": "event_msg", "timestamp": "2026-10-07T00:00:00Z", "payload": {"type": "task_started"}},
                    {"type": "token_usage_record", "timestamp": "2026-10-07T00:00:01Z", "payload": {"response_id": "a", "usage": usage, "thread_token_usage": usage}},
                    {"type": "event_msg", "timestamp": "2026-10-07T00:01:00Z", "payload": {"type": "task_complete"}},
                ]
                path.write_text("\n".join(map(json.dumps, events)))
                source = json.dumps({"subagent": {"thread_spawn": {"parent_thread_id": parent}}}) if parent else "cli"
                con.execute("INSERT INTO threads VALUES (?,?,?,?,?,?)", (ident, source, str(path), model, "high", None))
            con.commit()
            con.close()
            result = collect(database, "root")
        self.assertEqual(result["session_count"], 3)
        self.assertEqual(result["totals"]["input_tokens"], 3000)
        self.assertEqual(result["totals"]["cached_input_tokens"], 2400)
        self.assertEqual(result["totals"]["output_tokens"], 30)
        self.assertEqual(result["elapsed_seconds"], 60)
        self.assertEqual(set(result["by_model"]), {"gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"})

    def test_unknown_model_cost_is_unavailable(self):
        self.assertIsNone(price("unknown-model", {})["api_equivalent_usd_standard"])


if __name__ == "__main__":
    unittest.main()
