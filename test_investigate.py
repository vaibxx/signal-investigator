import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

from investigate import SCENARIOS, investigate, model_action


class InvestigationTests(unittest.TestCase):
    def test_scenario_verdicts(self):
        expected = ["within-segment-decline", "traffic-mix-shift", "below-alert-threshold", "mixed-decline"]
        for (name, data), verdict in zip(SCENARIOS.items(), expected):
            with self.subTest(name=name):
                result = investigate(data)
                self.assertEqual(result["verdict"], verdict)
                self.assertEqual(len(result["trace"]), 2 if name == "quiet-release" else 4)
                if len(result["trace"]) == 4:
                    score, _, mix, _ = result["trace"]
                    evidence = mix["evidence"]
                    self.assertAlmostEqual(score["evidence"]["delta"], evidence["within_effect"] + evidence["mix_effect"])

    def test_threshold_boundary(self):
        self.assertEqual(investigate({"x": [[80, 100], [77, 100]]})["verdict"], "within-segment-decline")

    def test_invalid_action_or_early_stop(self):
        for actions in [["finish"], ["score", "finish"], ["score", "score"], ["score", "unknown"]]:
            sequence = iter(actions)
            with self.assertRaises(ValueError):
                investigate(SCENARIOS["mixed-change"], lambda *_: next(sequence))

    def test_empty_segment(self):
        with self.assertRaises(ValueError):
            investigate({"x": [[3, 5], [0, 0]]})

    def test_model_transport_and_alternate_planning_order(self):
        received = []
        actions = iter(["score", "mix", "segments", "finish"])

        class Fixture(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append(json.loads(body["messages"][1]["content"]))
                result = {"choices": [{"message": {"content": json.dumps({"action": next(actions)})}}]}
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())

        with HTTPServer(("127.0.0.1", 0), Fixture) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/v1/chat/completions"
                with patch.dict("os.environ", {"SIGNAL_API_KEY": "", "NO_PROXY": "127.0.0.1"}):
                    result = investigate(SCENARIOS["traffic-shift"], lambda s, r: model_action(url, "fixture", s, r))
            finally:
                server.shutdown()
                thread.join()
        self.assertEqual(result["verdict"], "traffic-mix-shift")
        self.assertEqual(list(received[-1]["observations"]), ["score", "mix", "segments"])


if __name__ == "__main__":
    unittest.main()
