import json
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from account_graph import AccountGraph, Fault, stable_key


TOKEN = "unit-token"
ENTRY = {"type": "arrival", "key": "visit-7", "at": 1795460000000, "subject": "contact:7"}
RECORDED = {"results": [{"type": "arrival", "key": "visit-7", "ok": True, "value": {"subject": "contact:7", "duplicate": False, "stands": True}}]}
FIND = {"kind": "find", "text": "contact:7"}
FOUND = {"by": "subject", "subjects": ["contact:7"]}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.received.append((self.path, self.headers, raw))
        handler = self.server.replies.pop(0) if self.server.replies else (500, b"", {})
        if callable(handler):
            handler(self)
            return
        status, body, headers = handler
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body if isinstance(body, bytes) else json.dumps(body).encode())

    def do_GET(self):
        self.server.received.append((self.path, self.headers, b""))
        self.send_error(405)

    def log_message(self, *args):
        pass


def start(test, context=None):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    if context:
        server.socket = context.wrap_socket(server.socket, server_side=True)
    server.replies = []
    server.received = []
    thread = threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True)
    thread.start()
    test.addCleanup(server.server_close)
    test.addCleanup(thread.join)
    test.addCleanup(server.shutdown)
    return server


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.server = start(self)
        self.url = "http://127.0.0.1:" + str(self.server.server_port)

    def graph(self, **options):
        return AccountGraph(self.url, TOKEN, **options)

    def failure(self, code, retryable, fn):
        with self.assertRaises(Fault) as caught:
            fn()
        err = caught.exception
        self.assertEqual((err.code, err.retryable), (code, retryable))
        self.assertIsNone(err.__context__)
        return err

    def test_request_headers_base_path_and_refusal(self):
        refusal = {"ok": False, "reason": "KEY_REUSED", "fields": ["at"]}
        self.server.replies = [(200, refusal, {}), (200, FOUND, {})]
        graph = AccountGraph(self.url + "/graph/", TOKEN)
        self.assertEqual(graph.decide({"key": "choice-1", "at": 1, "by": "desk", "action": "mute", "fact": {"email": "pat@example.org"}}, correlation_id="ticket-1"), refusal)
        graph.lookup(FIND, correlation_id="invalid\nvalue")
        path, headers, body = self.server.received[0]
        self.assertEqual((path, headers["Authorization"], headers["Content-Type"], headers["X-Request-Id"]), ("/graph/v1/decide", "Bearer " + TOKEN, "application/json", "ticket-1"))
        self.assertEqual(json.loads(body)["by"], "desk")
        self.assertNotIn("X-Request-Id", self.server.received[1][1])

    def test_requires_https_outside_loopback_and_valid_settings(self):
        for url in ("http://example.org", "http://localhost.example.org", "http://127.0.0.1.example.org", "http://127.1", "http://[::ffff:192.0.2.1]", "https://u:p@example.org", "http://[::1]example.org", "http://localhost:65536", self.url + "?query", self.url + "#fragment", "file:///graph", self.url + "\n"):
            with self.subTest(url=url):
                self.failure("CONFIG.INVALID", False, lambda: AccountGraph(url, TOKEN))
        for url in ("http://localhost", "http://127.5.4.3", "http://[::1]", "https://example.org"):
            AccountGraph(url, TOKEN)
        for token in ("", "bad token", "token\r\n"):
            self.failure("CONFIG.INVALID", False, lambda: AccountGraph(self.url, token))
        for options in ({"total_timeout": 0}, {"connect_timeout": -1}, {"total_timeout": float("nan")}, {"retries": True}, {"retries": -1}, {"connect_timeout": float("inf")}):
            self.failure("CONFIG.INVALID", False, lambda: self.graph(**options))

    def test_status_fallbacks_and_unreadable_answers(self):
        cases = [(401, "AUTH.REJECTED"), (403, "AUTH.FORBIDDEN"), (404, "CONFIG.INVALID"), (405, "CONFIG.INVALID"),
                 (413, "INPUT.TOO_LARGE"), (429, "GRAPH.UNAVAILABLE"), (503, "GRAPH.UNAVAILABLE"), (500, "GRAPH.INTERNAL"),
                 (502, "TRANSPORT.INDETERMINATE"), (504, "TRANSPORT.INDETERMINATE"), (400, "GRAPH.INTERNAL")]
        graph = self.graph(retries=0)
        for status, code in cases:
            with self.subTest(status=status):
                self.server.replies.append((status, b"private body from proxy", {}))
                err = self.failure(code, status in (429, 502, 503, 504), lambda: graph.lookup(FIND))
                self.assertNotIn("private", repr(err) + repr(vars(err)))
        for raw in (b"", b"not json", b"\xff", b'"wrong"', b"NaN", b"{}", b'{"results":[]}'):
            self.server.replies.append((200, raw, {}))
            self.failure("TRANSPORT.INDETERMINATE", True, lambda: graph.record({"entries": [ENTRY]}))
        for status, value in ((200, b"["), (201, FOUND)):
            self.server.replies.append((status, value, {}))
            self.failure("GRAPH.INTERNAL", False, lambda: graph.lookup(FIND))
        self.server.replies.append((200, {}, {}))
        self.failure("GRAPH.INTERNAL", False, lambda: graph.events({"after": None, "limit": 1}))

    def test_unsafe_fault_details_and_retry_flags(self):
        for code, flag in (("INPUT.MALFORMED", True), ("CONFIG.MISMATCH", True), ("GRAPH.CLOSED", True), ("AUTH.REJECTED", True), ("TRANSPORT.ABORTED", True), ("GRAPH.UNAVAILABLE", False)):
            value = {"code": code, "message": TOKEN, "retryable": flag, "detail": {"path": "request.entries[0].at", "body": ENTRY, "token": TOKEN}}
            self.server.replies.append((503, {"fault": value}, {"Retry-After": TOKEN}))
            err = self.failure(code, False, lambda: self.graph().record({"entries": [ENTRY]}))
            self.assertEqual(err.detail, {"path": "request.entries[0].at"})
            self.assertNotIn(TOKEN, str(err) + repr(vars(err)))
            self.assertNotIn(ENTRY["subject"], str(err) + repr(vars(err)))
        value["detail"] = {"path": "request." + TOKEN}
        self.server.replies.append((503, {"fault": value}, {}))
        self.assertEqual(self.failure(code, False, lambda: self.graph().record({"entries": [ENTRY]})).detail, {})

    def test_replay_exact_bytes_with_growing_jitter(self):
        self.server.replies = [(504, b"", {}), (503, {"fault": {"code": "GRAPH.UNAVAILABLE", "retryable": True}}, {}), (200, RECORDED, {})]
        request = {"entries": [ENTRY.copy()]}
        def change_original(delay):
            request["entries"].clear()
        random_ids = [uuid.UUID(int=2**127), uuid.UUID(int=2**126)]
        with patch("account_graph.client.uuid.uuid4", side_effect=random_ids), patch("account_graph.client.time.sleep", side_effect=change_original) as sleep:
            result = self.graph().record(request)
        self.assertEqual(result, RECORDED)
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [0.375, 0.625])
        sent = [raw for _, _, raw in self.server.received]
        self.assertEqual(len(sent), 3)
        self.assertEqual(len(set(sent)), 1)
        self.assertEqual(json.loads(sent[0]), {"entries": [ENTRY]})

    def test_retry_after_delta_date_and_cap(self):
        for header, wait in (("6", 6), ("9999999999999", 900), ("Thu, 01 Jan 2026 00:00:06 GMT", 6), ("Thu Jan  1 00:00:06 2026", 6)):
            with self.subTest(header=header):
                self.server.replies = [(429, b"", {"Retry-After": header}), (200, FOUND, {})]
                with patch("account_graph.client.time.time", return_value=1767225600), patch("account_graph.client.time.sleep") as sleep:
                    self.assertEqual(self.graph(total_timeout=1200).lookup(FIND), FOUND)
                    sleep.assert_called_once_with(wait)
        self.server.replies = [(503, {"fault": {"code": "GRAPH.UNAVAILABLE", "retryable": True}}, {"Retry-After": "2000"})]
        with patch("account_graph.client.time.sleep") as sleep:
            err = self.failure("GRAPH.UNAVAILABLE", True, lambda: self.graph(total_timeout=1).lookup(FIND))
            self.assertEqual(err.detail["retryAfter"], 900)
            sleep.assert_not_called()

    def test_plaintext_checks_the_connected_peer_before_sending(self):
        with patch.object(socket.socket, "getpeername", return_value=("192.0.2.1", 80)):
            self.failure("CONFIG.INVALID", False, lambda: self.graph().lookup(FIND))
        self.assertFalse(self.server.received)

    def test_rejects_unpaged_kinds_before_sending(self):
        graph = self.graph()
        for pages in (graph.report_pages({"kind": "calls"}), graph.journey_pages({"kind": "person"})):
            err = self.failure("INPUT.MALFORMED", False, lambda: next(pages))
            self.assertEqual(err.detail, {"path": "request.kind"})
        self.assertFalse(self.server.received)

    def test_redirect_never_sends_token_to_the_destination(self):
        destination = start(self)
        for status in (301, 302, 303, 307, 308):
            self.server.replies.append((status, {"fault": {"code": "GRAPH.UNAVAILABLE", "retryable": True}}, {"Location": "http://127.0.0.1:%d/" % destination.server_port}))
            self.failure("CONFIG.INVALID", False, lambda: self.graph().lookup(FIND))
        self.assertFalse(destination.received)
        self.assertEqual(len(self.server.received), 5)

    @unittest.skipUnless(shutil.which("openssl"), "openssl is needed to issue the loopback test certificate")
    def test_tls_verifies_the_issuer_and_hostname(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp:
            cert, key, conf = [Path(temp, name) for name in ("cert.pem", "key.pem", "openssl.cnf")]
            conf.write_text("[req]\ndistinguished_name=dn\nx509_extensions=test\n[dn]\n[test]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n")
            subprocess.run(["openssl", "req", "-x509", "-days", "1", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-config", str(conf), "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(cert, key)
            server = start(self, ctx)
            server.replies = [(200, FOUND, {})]
            url = "https://localhost:%d" % server.server_port
            self.failure("CONFIG.INVALID", False, lambda: AccountGraph(url, TOKEN).lookup(FIND))
            trusted = ssl.create_default_context(cafile=str(cert))
            with patch("account_graph.client.ssl.create_default_context", return_value=trusted):
                self.failure("CONFIG.INVALID", False, lambda: AccountGraph(url.replace("localhost", "127.0.0.1"), TOKEN).lookup(FIND))
                self.assertEqual(AccountGraph(url, TOKEN).lookup(FIND), FOUND)
            self.assertEqual(len(server.received), 1)

    def test_connect_timeout_includes_name_resolution(self):
        resolve = socket.getaddrinfo
        release = threading.Event()
        entered = threading.Event()
        def delayed(*args, **kwargs):
            entered.set()
            release.wait(2)
            return resolve(*args, **kwargs)
        try:
            with patch("socket.getaddrinfo", side_effect=delayed):
                start_time = time.monotonic()
                self.failure("TRANSPORT.INDETERMINATE", True, lambda: self.graph(connect_timeout=0.1, total_timeout=5, retries=0).lookup(FIND))
                self.assertTrue(entered.is_set())
                self.assertLess(time.monotonic() - start_time, 1)
        finally:
            release.set()
        self.assertFalse(self.server.received)

    def test_connect_timeout_ends_at_connection_and_total_covers_trickling_response(self):
        def slow(handler):
            time.sleep(0.2)
            handler.send_response(200)
            handler.end_headers()
            handler.wfile.write(json.dumps(FOUND).encode())
        def trickle(handler):
            handler.send_response(200)
            handler.end_headers()
            try:
                for _ in range(50):
                    handler.wfile.write(b" ")
                    handler.wfile.flush()
                    time.sleep(0.03)
            except OSError:
                pass
        self.server.replies = [slow, trickle]
        self.assertEqual(self.graph(connect_timeout=0.1, total_timeout=2, retries=0).lookup(FIND), FOUND)
        start_time = time.monotonic()
        self.failure("TRANSPORT.INDETERMINATE", True, lambda: self.graph(total_timeout=0.2, retries=0).lookup(FIND))
        self.assertLess(time.monotonic() - start_time, 1)

    def test_unserializable_and_oversize_requests(self):
        for entry in ({"at": float("nan")}, {"at": object()}, {"key": "\ud800"}):
            self.failure("INPUT.MALFORMED", False, lambda: self.graph().record({"entries": [entry]}))
        for entries in ([ENTRY] * 101, [{"key": "a" * 1_000_000}]):
            self.failure("INPUT.TOO_LARGE", False, lambda: self.graph().record({"entries": entries}))
        self.assertFalse(self.server.received)

    def test_write_requires_the_callers_key_and_timestamp_before_sending(self):
        graph = self.graph()
        for send, request, path in ((graph.record, {"entries": [ENTRY, {"at": 1}]}, "request.entries[1].key"),
                                    (graph.decide, {"key": "desk-1"}, "request.at"),
                                    (graph.decide, {"key": "desk-1", "at": 1.5}, "request.at"),
                                    (graph.forget, {"key": "😀" * 101, "at": 1}, "request.key"),
                                    (graph.forget, {"key": "", "at": 1}, "request.key")):
            err = self.failure("INPUT.MALFORMED", False, lambda: send(request))
            self.assertEqual(err.detail, {"path": path})
        self.assertFalse(self.server.received)

    def test_total_timeout_is_shared_by_attempts_and_backoff(self):
        def late(handler):
            time.sleep(0.55)
            try:
                handler.send_response(200)
                handler.end_headers()
                handler.wfile.write(json.dumps(FOUND).encode())
            except OSError:
                pass
        self.server.replies = [(503, b"", {}), late]
        with patch("account_graph.client.uuid.uuid4", return_value=uuid.UUID(int=0)):
            self.failure("TRANSPORT.INDETERMINATE", True, lambda: self.graph(total_timeout=0.65, retries=1).lookup(FIND))
        self.assertEqual(len(self.server.received), 2)

    def test_unknown_events_and_pagination_cycles(self):
        raw = {"type": "future", "schemaVersion": 2, "seq": 7, "data": {}}
        known = {"schemaVersion": 1, "type": "cluster.changed", "seq": 6, "at": 123, "data": {"subject": "contact:7", "from": None, "to": "contact:1"}}
        page = {"schemaVersion": 1, "events": [known, raw, None], "cursor": "p2", "more": True}
        self.server.replies = [(200, {"ok": True, "value": page}, {})] * 2
        request = {"after": "p1", "limit": 2}
        pages = self.graph().event_pages(request)
        self.assertEqual(next(pages)["value"]["events"], [known, {"schemaVersion": 1, "type": "Unrecognized", "seq": 7, "raw": raw}, {"schemaVersion": 1, "type": "Unrecognized", "seq": 0, "raw": None}])
        self.failure("GRAPH.INTERNAL", False, lambda: next(pages))
        self.assertEqual(request, {"after": "p1", "limit": 2})
        self.server.replies = [(200, {"asOf": 3, "value": {"rows": [], "next": "p1"}}, {})]
        self.failure("GRAPH.INTERNAL", False, lambda: next(self.graph().report_pages({"kind": "callbacks", "after": "p1"})))
        self.server.replies = [(200, {"entries": [], "next": 5}, {})]
        self.failure("GRAPH.INTERNAL", False, lambda: next(self.graph().journey_pages({"kind": "journey", "before": 4, "subject": "contact:7"})))

    def test_stable_keys_distinguish_fields_types_and_revisions(self):
        parts = ("visit", "row:7", 1)
        key = stable_key(*parts)
        # Keys already stored by an application must survive a package upgrade.
        self.assertEqual(key, "835919ef-7145-538c-a4ae-b20885f02fdc")  # gitleaks:allow (a key derived from a made-up row id, not a secret)
        self.assertEqual(key, stable_key(*parts))
        self.assertLessEqual(len(key), 128)
        self.assertEqual(len({key, stable_key("visit:row", "7", 1), stable_key("visit", "row:7", 2), stable_key("visit", "row:7", "1")}), 4)
        for bad in (("", "row", 1), ("visit", "", 1), ("visit", 7, True)):
            with self.assertRaises(ValueError):
                stable_key(*bad)
