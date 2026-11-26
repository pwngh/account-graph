import json
from pathlib import Path
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
import subprocess
from tempfile import TemporaryDirectory
from threading import Event
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from account_graph import AccountGraph, Fault, Outbox
from test_client import start


def profile(key):
    return {"type": "profile", "key": key, "at": 1795460000000, "subject": "contact:7", "facts": {"email": "pat@example.org"}}


def accepted(key, duplicate=False):
    return {"results": [{"type": "profile", "key": key, "ok": True, "value": {"stands": True, "duplicate": duplicate, "changes": [], "notes": {}}}]}


def answer(handler):
    entry, = json.loads(handler.server.received[-1][2])["entries"]
    body = json.dumps(accepted(entry["key"])).encode()
    handler.send_response(200)
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class OutboxTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        self.path = str(Path(directory.name) / "outbox.sqlite")

    def bodies(self):
        db = sqlite3.connect(self.path)
        try:
            return [json.loads(body) if body else None for (body,) in db.execute("SELECT body FROM account_graph_outbox ORDER BY id")]
        finally:
            db.close()

    def test_fault_stops_pass_and_restart_replays_frozen_entry(self):
        first = profile("revision-1")
        second = profile("revision-2")
        last = profile("revision-3")
        failure = Fault("AUTH.REJECTED")
        client = Mock()
        client.record.side_effect = [accepted(first["key"]), failure]
        with Outbox(self.path) as box:
            ids = [box.enqueue("7", entry) for entry in (first, second, last)]
            second["facts"]["email"] = "changed@example.org"
            with self.assertRaises(Fault) as caught:
                box.flush(client)
            self.assertIs(caught.exception, failure)
            self.assertEqual([c.args[0]["entries"] for c in client.record.call_args_list], [[first], [profile("revision-2")]])
            self.assertEqual([row.status for row in box.rows()], ["sent", "pending", "pending"])
            self.assertEqual(self.bodies(), [None, profile("revision-2"), last])

        client = Mock()
        client.record.side_effect = [accepted("revision-2", duplicate=True), accepted("revision-3")]
        with Outbox(self.path) as box:
            self.assertEqual(box.flush(client, limit=1), 1)
            self.assertEqual(box.flush(client), 1)
            self.assertEqual(box.flush(client), 0)
            self.assertEqual([c.args[0]["entries"] for c in client.record.call_args_list], [[profile("revision-2")], [last]])
            self.assertEqual([(r.id, r.record_id, r.key, r.status, r.reason) for r in box.rows()],
                             [(row_id, "7", entry["key"], "sent", None) for row_id, entry in zip(ids, (first, second, last))])
            self.assertEqual(self.bodies(), [None, None, None])

    def test_refusal_remains_available_and_later_rows_can_be_sent(self):
        refused = profile("older")
        client = Mock()
        client.record.side_effect = [{"results": [{"type": "profile", "key": "older", "ok": False, "reason": "KEY_REUSED", "fields": ["at"]}]}, accepted("newer")]
        with Outbox(self.path) as box:
            box.enqueue("7", refused)
            box.enqueue("7", profile("newer"))
            self.assertEqual(box.flush(client), 2)
        with Outbox(self.path) as box:
            self.assertEqual(box.flush(client), 0)
            self.assertEqual([(r.status, r.reason) for r in box.rows()], [("refused", "KEY_REUSED"), ("sent", None)])
            self.assertEqual(self.bodies(), [refused, None])

    def test_unconfirmed_response_is_indeterminate_and_leaves_body_pending(self):
        entry = profile("saved")
        result = accepted("saved")["results"][0]
        replies = [None, {}, {"results": []}, {"results": [result, result]}, accepted("wrong"),
                   {"results": [{**result, "type": "arrival"}]}, {"results": [{**result, "ok": 1}]},
                   {"results": [{**result, "value": {}}]}, {"results": [{**result, "ok": False}]}]
        client = Mock()
        with Outbox(self.path) as box:
            box.enqueue("7", entry)
            for reply in replies:
                with self.subTest(reply=reply):
                    client.record.return_value = reply
                    with self.assertRaises(Fault) as caught:
                        box.flush(client)
                    self.assertEqual(caught.exception.code, "TRANSPORT.INDETERMINATE")
                    self.assertTrue(caught.exception.retryable)
                    self.assertEqual(box.rows()[0].status, "pending")
                    self.assertEqual(self.bodies(), [entry])

    def test_pass_limit(self):
        client = Mock()
        with Outbox(self.path) as box:
            box.enqueue("7", profile("first"))
            self.assertEqual(box.flush(client, limit=0), 0)
            for invalid in (-1, 2.5, True):
                with self.assertRaises(ValueError):
                    box.flush(client, limit=invalid)
            client.record.assert_not_called()
            self.assertEqual(box.rows()[0].status, "pending")

    def test_enqueue_and_a_second_worker_go_on_while_a_send_waits_on_a_slow_graph(self):
        server = start(self)
        arrived, release = Event(), Event()

        def slow(handler):
            arrived.set()
            release.wait(10)
            answer(handler)

        server.replies = [slow, answer]
        graph = AccountGraph("http://127.0.0.1:%d" % server.server_port, "outbox-test", retries=0, total_timeout=15)
        with Outbox(self.path) as box:
            box.enqueue("7", profile("first"))

        def send():
            with Outbox(self.path) as box:
                return box.flush(graph)

        with ThreadPoolExecutor(max_workers=1) as pool:
            try:
                sending = pool.submit(send)
                self.assertTrue(arrived.wait(5))
                began = time.monotonic()
                with Outbox(self.path) as box:
                    box.enqueue("7", profile("second"))
                    # The first row is in flight, so a second worker has nothing it may send yet.
                    self.assertEqual(box.flush(graph), 0)
                self.assertLess(time.monotonic() - began, 1)
            finally:
                release.set()
            self.assertEqual(sending.result(10), 2)
        self.assertEqual([json.loads(raw)["entries"][0]["key"] for _, _, raw in server.received], ["first", "second"])
        with Outbox(self.path) as box:
            self.assertEqual([row.status for row in box.rows()], ["sent", "sent"])

    def test_claim_of_a_worker_that_died_mid_send_expires_and_the_same_key_is_sent_again(self):
        entry = profile("first")
        with Outbox(self.path) as box:
            box.enqueue("7", entry)
        crash = "import os, sys; sys.path.insert(0, sys.argv[1]); from account_graph import Outbox\n" \
                "class Dies:\n    def record(self, request): os._exit(3)\n" \
                "Outbox(sys.argv[2]).flush(Dies(), lease=30)"
        died = subprocess.run([sys.executable, "-c", crash, str(Path(__file__).resolve().parents[1]), self.path], timeout=30)
        self.assertEqual(died.returncode, 3)

        client = Mock()
        client.record.return_value = accepted("first", duplicate=True)
        with Outbox(self.path) as box:
            self.assertEqual(box.flush(client), 0)
            client.record.assert_not_called()
            self.assertEqual(box.rows()[0].status, "pending")
            with patch("account_graph.outbox.time") as clock:
                clock.time.return_value = time.time() + 31
                self.assertEqual(box.flush(client), 1)
            client.record.assert_called_once_with({"entries": [entry]})
            self.assertEqual(box.rows()[0].status, "sent")
            self.assertEqual(self.bodies(), [None])

    def test_lease_outlasts_the_call_budget(self):
        graph = AccountGraph("http://127.0.0.1:9", "outbox-test", total_timeout=30)
        with Outbox(self.path) as box:
            for lease in (0, 30, -1, True, "60"):
                with self.subTest(lease=lease), self.assertRaises(ValueError):
                    box.flush(graph, lease=lease)
            self.assertEqual(box.flush(graph, lease=31), 0)

    def test_enqueue_refuses_an_entry_the_contract_refuses(self):
        good = profile("good")
        # The entry and its facts are two levels. The graph takes 32 with the request and its list.
        nested = "x"
        for _ in range(29):
            nested = [nested]
        cases = [
            ([], "INPUT.MALFORMED", "entry"),
            ({k: v for k, v in good.items() if k != "at"}, "INPUT.MALFORMED", "entry.at"),
            ({k: v for k, v in good.items() if k != "facts"}, "INPUT.MALFORMED", "entry.facts"),
            (dict(good, type="visit"), "INPUT.MALFORMED", "entry.type"),
            (dict(good, email="pat@example.org"), "INPUT.MALFORMED", "entry.*"),
            (dict(good, key=""), "INPUT.MALFORMED", "entry.key"),
            (dict(good, key="k" * 201), "INPUT.MALFORMED", "entry.key"),
            (dict(good, at=1.5), "INPUT.MALFORMED", "entry.at"),
            (dict(good, at=True), "INPUT.MALFORMED", "entry.at"),
            (dict(good, at=-1), "INPUT.MALFORMED", "entry.at"),
            (dict(good, subject=" contact:7"), "INPUT.MALFORMED", "entry.subject"),
            (dict(good, facts={"email": float("nan")}), "INPUT.MALFORMED", "entry"),
            (dict(good, facts={"email": "pat\0@example.org"}), "INPUT.MALFORMED", "entry"),
            (dict(good, facts={"email": "\ud800"}), "INPUT.MALFORMED", "entry"),
            (dict(good, facts={"identifiers": nested}), "INPUT.MALFORMED", "entry"),
            (dict(good, facts={"identifiers": ["x" * 1_000_000]}), "INPUT.TOO_LARGE", None),
        ]
        with Outbox(self.path) as box:
            for entry, code, path in cases:
                with self.subTest(code=code, path=path), self.assertRaises(Fault) as caught:
                    box.enqueue("7", entry)
                self.assertEqual((caught.exception.code, caught.exception.detail.get("path")), (code, path))
            with self.assertRaises(ValueError):
                box.enqueue("", good)
            self.assertEqual(box.rows(), [])
            box.enqueue("7", dict(good, facts={"identifiers": nested[0]}))
            self.assertEqual(len(box.rows()), 1)

    def test_rows_the_graph_calls_malformed_are_set_aside_and_the_rest_are_sent(self):
        server = start(self)
        refused = {"fault": {"code": "INPUT.MALFORMED", "message": "email", "detail": {"path": "request.entries[0].facts.email"}}}
        server.replies = [answer, (400, refused, {}), answer]
        graph = AccountGraph("http://127.0.0.1:%d" % server.server_port, "outbox-test", retries=0)
        bad = dict(profile("bad"), facts={"email": "not an address"})
        # A row an earlier version accepted without its time.
        legacy = {k: v for k, v in profile("legacy").items() if k != "at"}
        with Outbox(self.path) as box:
            box.enqueue("7", profile("first"))
            box._db.execute("INSERT INTO account_graph_outbox (record_id, key, body) VALUES ('7', 'legacy', ?)", (json.dumps(legacy),))
            box.enqueue("7", bad)
            box.enqueue("7", profile("last"))
            self.assertEqual(box.flush(graph), 4)
            self.assertEqual(box.flush(graph), 0)
            self.assertEqual([(row.key, row.status, row.reason) for row in box.rows()], [
                ("first", "sent", None),
                ("legacy", "failed", "INPUT.MALFORMED request.entries[0].at"),
                ("bad", "failed", "INPUT.MALFORMED request.entries[0].facts.email"),
                ("last", "sent", None),
            ])
        self.assertEqual(self.bodies(), [None, legacy, bad, None])
        self.assertEqual([json.loads(raw)["entries"][0]["key"] for _, _, raw in server.received], ["first", "bad", "last"])

    def keys(self, client):
        return [c.args[0]["entries"][0]["key"] for c in client.record.call_args_list]

    def test_other_records_go_on_while_one_record_waits_on_a_send_in_flight(self):
        arrived, release = Event(), Event()

        def record(request):
            key = request["entries"][0]["key"]
            if key == "a1":
                arrived.set()
                release.wait(10)
            return accepted(key)

        with Outbox(self.path) as box:
            a1 = box.enqueue("a", profile("a1"))
            box.enqueue("a", profile("a2"))
            box.enqueue("b", profile("b1"))
            box.enqueue("c", profile("c1"), depends_on=a1)
            box.enqueue("b", profile("b2"))

        first = Mock()
        first.record.side_effect = record

        def send():
            with Outbox(self.path) as box:
                return box.flush(first, limit=1)

        second = Mock()
        second.record.side_effect = record
        with ThreadPoolExecutor(max_workers=1) as pool:
            try:
                sending = pool.submit(send)
                self.assertTrue(arrived.wait(5))
                with Outbox(self.path) as box:
                    # a2 follows a1 on its record, and c1 names a1 as its prerequisite.
                    self.assertEqual(box.flush(second), 2)
                    self.assertEqual(self.keys(second), ["b1", "b2"])
                    self.assertEqual([row.status for row in box.rows()], ["pending", "pending", "sent", "pending", "sent"])
            finally:
                release.set()
            self.assertEqual(sending.result(10), 1)
        with Outbox(self.path) as box:
            self.assertEqual(box.flush(second), 2)
            self.assertEqual(self.keys(second), ["b1", "b2", "a2", "c1"])
            self.assertEqual([(row.status, row.depends_on) for row in box.rows()], [("sent", None)] * 3 + [("sent", a1), ("sent", None)])

    def test_a_row_set_aside_holds_back_only_the_rows_that_depend_on_it(self):
        client = Mock()
        client.record.side_effect = lambda request: (
            {"results": [{"type": "profile", "key": "a1", "ok": False, "reason": "UNKNOWN_REFERENCE"}]}
            if request["entries"][0]["key"] == "a1" else accepted(request["entries"][0]["key"]))
        with Outbox(self.path) as box:
            a1 = box.enqueue("a", profile("a1"))
            box.enqueue("a", profile("a2"))
            b1 = box.enqueue("b", profile("b1"), depends_on=a1)
            box.enqueue("b", profile("b2"))
            box.enqueue("c", profile("c1"), depends_on=b1)
            self.assertEqual(box.flush(client), 5)
            self.assertEqual(self.keys(client), ["a1", "a2", "b2"])
            self.assertEqual([(row.key, row.status) for row in box.rows()],
                             [("a1", "refused"), ("a2", "sent"), ("b1", "blocked"), ("b2", "sent"), ("c1", "blocked")])
            self.assertEqual(box.flush(client), 0)

            # Once the prerequisite is put right and sent, the rows waiting on it follow in the same pass.
            box._db.execute("UPDATE account_graph_outbox SET status = 'pending', reason = NULL WHERE id = ?", (a1,))
            client.record.side_effect = lambda request: accepted(request["entries"][0]["key"])
            self.assertEqual(box.flush(client), 3)
            self.assertEqual(self.keys(client)[3:], ["a1", "b1", "c1"])
            self.assertEqual({row.status for row in box.rows()}, {"sent"})

            for invalid in (b1 + 10, True, "1"):
                with self.subTest(depends_on=invalid), self.assertRaises(ValueError):
                    box.enqueue("d", profile("d1"), depends_on=invalid)

    def test_an_entry_not_attempted_keeps_its_place_and_a_call_fault_ends_the_pass(self):
        client = Mock()
        client.record.side_effect = [
            {"results": [{"type": "profile", "key": "a1", "ok": False, "reason": "NOT_ATTEMPTED"}]},
            accepted("b1"),
            Fault("GRAPH.CLOSED"),
        ]
        with Outbox(self.path) as box:
            box.enqueue("a", profile("a1"))
            box.enqueue("a", profile("a2"))
            box.enqueue("b", profile("b1"))
            box.enqueue("c", profile("c1"))
            box.enqueue("d", profile("d1"))
            with self.assertRaises(Fault) as caught:
                box.flush(client)
            self.assertEqual(caught.exception.code, "GRAPH.CLOSED")
            self.assertEqual(self.keys(client), ["a1", "b1", "c1"])
            self.assertEqual([row.status for row in box.rows()], ["pending", "pending", "sent", "pending", "pending"])
