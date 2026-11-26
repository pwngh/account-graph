import json
import os
from pathlib import Path
import re
import unittest
from unittest.mock import Mock, patch

from test_client import start


class CloudFunctionExampleTests(unittest.TestCase):
    def setUp(self):
        self.server = start(self)
        readme = Path(__file__).resolve().parents[1] / "README.md"
        examples = re.findall(r"^```python\n(.*?)^```$", readme.read_text(), re.MULTILINE | re.DOTALL)
        function, = (source for source in examples if "def record_activity(" in source)
        env = {"GRAPH_URL": "http://127.0.0.1:%d" % self.server.server_port, "GRAPH_TOKEN": "function-test"}
        settings = patch.dict(os.environ, env)
        settings.start()
        self.addCleanup(settings.stop)
        module = {}
        exec(compile(function, str(readme), "exec"), module)
        self.invoke = module["record_activity"]
        self.visit = {"kind": "visit", "id": "visit-7", "revision": 1, "at": 1795460000000, "subject": "contact:7", "landing": "https://example.org/visit"}
        self.sale = {"kind": "sale", "id": "sale-7", "revision": 1, "at": 1795463600000, "subject": "contact:7", "value": 20, "currency": "USD"}

    def tell(self, event):
        request = Mock()
        request.get_json.return_value = event.copy()
        return self.invoke(request)

    def receipt(self, ok=True):
        def answer(handler):
            entry, = json.loads(self.server.received[-1][2])["entries"]
            result = {"key": entry["key"], "type": entry["type"], "ok": ok}
            if ok:
                result["value"] = {"duplicate": False, "stands": True}
                if entry["type"] == "arrival":
                    result["value"]["subject"] = entry["subject"]
                else:
                    result["value"].update(value=entry["value"], currency=entry["currency"], deliveries=[])
            else:
                result.update(reason="KEY_REUSED", fields=["at"])
            handler.send_response(200)
            handler.end_headers()
            handler.wfile.write(json.dumps({"results": [result]}).encode())
        return answer

    def test_records_visit_and_offline_sale_with_stable_revisions(self):
        events = (self.visit, self.sale, self.sale, dict(self.sale, revision=2))
        self.server.replies = [self.receipt() for _ in events]
        for event in events:
            self.assertEqual(self.tell(event), ("", 204))
        entries = []
        for (path, headers, raw), event in zip(self.server.received, events):
            self.assertEqual((path, headers["Authorization"]), ("/v1/record", "Bearer function-test"))
            entry, = json.loads(raw)["entries"]
            self.assertEqual((entry["at"], entry["subject"]), (event["at"], event["subject"]))
            entries.append(entry)
        arrival, sale, replay, revised = entries
        self.assertEqual((arrival["type"], arrival["source"], arrival["landing"]), ("arrival", "website", self.visit["landing"]))
        self.assertEqual((sale["type"], sale["stage"], sale["channel"], sale["value"], sale["currency"]), ("conversion", "sale", "IN_STORE", 20, "USD"))
        self.assertEqual(replay, sale)
        self.assertNotEqual(sale["key"], revised["key"])

    def test_returns_item_refusal_and_call_fault_to_the_invoker(self):
        self.server.replies = [self.receipt(False), (503, b"", {}), (401, b"", {})]
        self.assertEqual(self.tell(self.sale), ({"reason": "KEY_REUSED"}, 409))
        self.assertEqual(self.tell(self.sale), ({"code": "GRAPH.UNAVAILABLE"}, 503))
        self.assertEqual(self.tell(self.sale), ({"code": "AUTH.REJECTED"}, 400))
        self.assertEqual(len(self.server.received), 3)

    def test_invalid_events_are_refused_before_recording(self):
        for event in ([], {"kind": "unknown"}, {"kind": "visit"}, dict(self.sale, id="")):
            self.assertEqual(self.tell(event)[1], 400)
        self.assertFalse(self.server.received)
