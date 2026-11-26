"""Synchronous client for the six account-graph HTTP calls."""

import ipaddress
import json
import re
import ssl
import time
import uuid
from datetime import timezone
from email.utils import parsedate_to_datetime
from typing import Any, Dict, Iterator, Optional, Union, cast, overload
from urllib.parse import urlsplit

from . import transport, types
from .types import (
    DecideRequest, DecideResponse, EventsRequest, EventsResponse, ForgetRequest, ForgetResponse,
    JourneyPage, JourneyRequest, LookupRequest, LookupValue, PagedReportRequest, PagedReportResponse,
    RecordRequest, RecordResponse, ReportRequest, ReportResponse,
)

_RETRYABLE = {"GRAPH.UNAVAILABLE", "TRANSPORT.INDETERMINATE"}
_CODES = _RETRYABLE | {
    "GRAPH.CLOSED", "GRAPH.INTERNAL", "CONFIG.INVALID", "CONFIG.UNSUPPORTED", "CONFIG.MISMATCH",
    "INPUT.MALFORMED", "INPUT.TOO_LARGE", "AUTH.REJECTED", "AUTH.FORBIDDEN", "TRANSPORT.ABORTED",
}
_EVENTS = {"cluster.changed", "conversion.failed", "delivery.paused", "delivery.late", "costs.failed", "feed.quiet", "callback.overdue", "audit.head"}


class Fault(Exception):
    def __init__(self, code: str, retryable: bool = False, detail: Optional[Dict[str, Any]] = None):
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.detail = detail if detail is not None else {}


def stable_key(source: str, row_id: Union[int, str], revision: Union[int, str]) -> str:
    """Make one graph key for a particular revision in a host table or feed."""
    if not isinstance(source, str) or not source or any(type(part) not in (str, int) or part == "" for part in (row_id, revision)):
        raise ValueError("Supply a source, row ID and revision")
    parts = json.dumps([source, row_id, revision], separators=(",", ":"))
    return str(uuid.uuid5(uuid.NAMESPACE_URL, parts))


def _retry_after(header: Optional[str]) -> Optional[float]:
    if not header:
        return None
    header = header.strip()
    if re.fullmatch(r"[0-9]+", header):
        digits = header.lstrip("0") or "0"
        return min(900, int(digits[:4]))
    try:
        date = parsedate_to_datetime(header)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        return min(900, max(0, date.timestamp() - time.time()))
    except (ValueError, TypeError, OverflowError, OSError, IndexError):
        pass
    return None


def _failure(response: transport.Response, given: Any, write: bool, token: str) -> Fault:
    status = response.status
    detail: Dict[str, Any] = {"status": status}
    if 300 <= status < 400:
        return Fault("CONFIG.INVALID", detail=detail)
    if isinstance(given, dict) and isinstance(given.get("code"), str) and given["code"] in _CODES:
        code = given["code"]
        retryable = code in _RETRYABLE and given.get("retryable") is True
        # Graph validation names a field. Free-form server messages and proxy bodies may contain credentials.
        detail = {}
        server_detail = given.get("detail")
        path = server_detail.get("path") if isinstance(server_detail, dict) else None
        if isinstance(path, str) and len(path) <= 512 and token not in path and re.fullmatch(r"request(?:\.[A-Za-z_][A-Za-z_0-9]*|\[[0-9]+\])*", path):
            detail["path"] = path
    elif status in (429, 503):
        code, retryable = "GRAPH.UNAVAILABLE", True
    elif status in (502, 504) or (200 <= status < 300 and write):
        code, retryable = "TRANSPORT.INDETERMINATE", True
    else:
        code = {401: "AUTH.REJECTED", 403: "AUTH.FORBIDDEN", 404: "CONFIG.INVALID", 405: "CONFIG.INVALID", 413: "INPUT.TOO_LARGE"}.get(status, "GRAPH.INTERNAL")
        retryable = False
    wait = _retry_after(response.retry_after)
    if retryable and wait is not None:
        detail["retryAfter"] = wait
    return Fault(code, retryable, detail)


def _invalid_number(value: str) -> None:
    raise ValueError()


def _safe_int(value: Any) -> bool:
    return type(value) is int and abs(value) <= 2**53 - 1


def _read_event(raw: Any) -> Any:
    event = raw if isinstance(raw, dict) else {}
    kind = event.get("type")
    if type(event.get("schemaVersion")) is int and event["schemaVersion"] == 1 and isinstance(kind, str) and kind in _EVENTS and _safe_int(event.get("seq")) and _safe_int(event.get("at")) and isinstance(event.get("data"), dict):
        return event
    return {"schemaVersion": 1, "seq": event["seq"] if _safe_int(event.get("seq")) else 0, "type": "Unrecognized", "raw": raw}


def _answered(name: str, answer: Any, kind: Any, entry_count: Optional[int]) -> bool:
    if not isinstance(answer, dict):
        return answer is None and name == "lookup" and kind in ("party", "record")
    if name == "record":
        results = answer.get("results")
        return isinstance(results, list) and len(results) == entry_count and all(_decided(row) for row in results)
    if name in ("decide", "forget"):
        return _decided(answer)
    if name == "lookup" and kind == "journey":
        return isinstance(answer.get("entries"), list) and "next" in answer and (answer["next"] is None or _safe_int(answer["next"]))
    if name == "report":
        page = answer.get("value")
        if not _safe_int(answer.get("asOf")) or not isinstance(page, dict):
            return False
        return kind not in ("callbacks", "texts") or (isinstance(page.get("rows"), list) and "next" in page and (page["next"] is None or isinstance(page["next"], str)))
    if name == "events":
        if not _decided(answer) or not answer["ok"]:
            return answer.get("ok") is False and answer.get("reason") == "CURSOR_LOST"
        page = answer["value"]
        return isinstance(page.get("cursor"), str) and type(page.get("more")) is bool and isinstance(page.get("events"), list)
    return True


def _decided(answer: Any) -> bool:
    if not isinstance(answer, dict):
        return False
    if answer.get("ok") is False:
        return isinstance(answer.get("reason"), str)
    return answer.get("ok") is True and isinstance(answer.get("value"), dict)


class AccountGraph:
    def __init__(self, url: str, token: str, *, connect_timeout: float = 5.0, total_timeout: float = 30.0, retries: int = 2):
        try:
            if not isinstance(url, str) or not url.isascii() or any(ord(c) <= 32 or ord(c) == 127 for c in url):
                raise ValueError()
            base = urlsplit(url)
            host = base.hostname
            port = base.port
            if not host or base.scheme not in ("http", "https") or base.username is not None or any(c in url for c in "?#\\"):
                raise ValueError()
            if not re.fullmatch(r"(?:[A-Za-z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]+)?", base.netloc):
                raise ValueError()
            if base.scheme == "http" and host != "localhost":
                address = ipaddress.ip_address(host)
                if not address.is_loopback:
                    raise ValueError()
                host = str(address)
        except ValueError:
            host = None
        if not host or not isinstance(token, str) or not re.fullmatch(r"[!-~]+", token):
            raise Fault("CONFIG.INVALID")
        if any(type(v) not in (float, int) or not 0 < v <= 1_000_000 for v in (connect_timeout, total_timeout)) or type(retries) is not int or retries < 0:
            raise Fault("CONFIG.INVALID")
        self._host = host
        self._port = port
        self._tls = ssl.create_default_context() if base.scheme == "https" else None
        self._path = base.path.rstrip("/") + "/v1/"
        self._token = token
        self._connect_timeout = connect_timeout
        self._total_timeout = total_timeout
        self._retries = retries

    def _call(self, name: str, request: Any, correlation_id: Optional[str]) -> Any:
        deadline = time.monotonic() + self._total_timeout
        headers = {"Authorization": "Bearer " + self._token, "Content-Type": "application/json"}
        if isinstance(correlation_id, str) and re.fullmatch(r"[!-~]{1,200}", correlation_id):
            headers["X-Request-Id"] = correlation_id
        if not isinstance(request, dict):
            raise Fault("INPUT.MALFORMED")
        kind = request.get("kind")
        entries = request.get("entries")
        entry_count = len(entries) if isinstance(entries, (list, tuple)) else None
        if name == "record" and entry_count is not None and entry_count > 100:
            raise Fault("INPUT.TOO_LARGE")
        try:
            body = json.dumps(request, allow_nan=False, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError, RecursionError):
            body = None
        if body is None:
            raise Fault("INPUT.MALFORMED")
        if len(body) > 1_000_000:
            raise Fault("INPUT.TOO_LARGE")
        write = name in ("record", "decide", "forget")
        if write:
            if name == "record" and not entry_count:
                raise Fault("INPUT.MALFORMED", detail={"path": "request.entries"})
            for index, item in enumerate(entries if name == "record" else [request]):
                path = f"request.entries[{index}]" if name == "record" else "request"
                key = item.get("key") if isinstance(item, dict) else None
                # The HTTP contract measures a key in UTF-16 code units.
                if not isinstance(key, str) or not key or len(key.encode("utf-16-le")) // 2 > 200:
                    raise Fault("INPUT.MALFORMED", detail={"path": path + ".key"})
                at = item.get("at")
                if type(at) not in (int, float) or not 0 <= at <= 8_640_000_000_000_000 or at != int(at):
                    raise Fault("INPUT.MALFORMED", detail={"path": path + ".at"})
        backoff = 0.25
        for attempt in range(self._retries + 1):
            try:
                response = transport.post(self._host, self._port, self._tls, self._path + name, headers, body, self._connect_timeout, deadline)
            except transport.InvalidOrigin:
                failure = Fault("CONFIG.INVALID")
            except OSError:
                failure = Fault("TRANSPORT.INDETERMINATE", True)
            else:
                answer = None
                try:
                    answer = json.loads(response.body.decode("utf-8"), parse_constant=_invalid_number)
                except (ValueError, RecursionError):
                    pass
                else:
                    if response.status == 200 and _answered(name, answer, kind, entry_count):
                        return answer
                given = answer.get("fault") if response.status != 200 and isinstance(answer, dict) else None
                failure = _failure(response, given, write, self._token)
            if not failure.retryable or attempt == self._retries:
                raise failure
            jitter = uuid.uuid4().int / 2**128
            wait = max(failure.detail.get("retryAfter", 0), backoff * (1 + jitter))
            if time.monotonic() + wait >= deadline:
                raise failure
            time.sleep(wait)
            backoff = min(450, backoff * 2)

    def record(self, request: RecordRequest, *, correlation_id: Optional[str] = None) -> RecordResponse:
        return self._call("record", request, correlation_id)

    def decide(self, request: DecideRequest, *, correlation_id: Optional[str] = None) -> DecideResponse:
        return self._call("decide", request, correlation_id)

    def forget(self, request: ForgetRequest, *, correlation_id: Optional[str] = None) -> ForgetResponse:
        return self._call("forget", request, correlation_id)

    @overload
    def lookup(self, request: types.PersonRequest, *, correlation_id: Optional[str] = None) -> types.PersonValue: ...

    @overload
    def lookup(self, request: types.JourneyRequest, *, correlation_id: Optional[str] = None) -> types.JourneyPage: ...

    @overload
    def lookup(self, request: types.FindRequest, *, correlation_id: Optional[str] = None) -> types.FindValue: ...

    @overload
    def lookup(self, request: types.MatchRequest, *, correlation_id: Optional[str] = None) -> types.MatchValue: ...

    @overload
    def lookup(self, request: types.CallerRequest, *, correlation_id: Optional[str] = None) -> types.CallerValue: ...

    @overload
    def lookup(self, request: types.PartyRequest, *, correlation_id: Optional[str] = None) -> types.PartyValue: ...

    @overload
    def lookup(self, request: types.ConflictsRequest, *, correlation_id: Optional[str] = None) -> types.ConflictsValue: ...

    @overload
    def lookup(self, request: types.RecordLookupRequest, *, correlation_id: Optional[str] = None) -> Optional[types.RecordView]: ...

    @overload
    def lookup(self, request: types.TransfersRequest, *, correlation_id: Optional[str] = None) -> types.TransfersValue: ...

    def lookup(self, request: LookupRequest, *, correlation_id: Optional[str] = None) -> LookupValue:
        return self._call("lookup", request, correlation_id)

    @overload
    def report(self, request: types.CampaignsRequest, *, correlation_id: Optional[str] = None) -> types.CampaignsResponse: ...

    @overload
    def report(self, request: types.PipelineRequest, *, correlation_id: Optional[str] = None) -> types.PipelineResponse: ...

    @overload
    def report(self, request: types.CallsRequest, *, correlation_id: Optional[str] = None) -> types.CallsResponse: ...

    @overload
    def report(self, request: types.CallbacksRequest, *, correlation_id: Optional[str] = None) -> types.CallbacksResponse: ...

    @overload
    def report(self, request: types.TextsRequest, *, correlation_id: Optional[str] = None) -> types.TextsResponse: ...

    @overload
    def report(self, request: types.AfterCallsRequest, *, correlation_id: Optional[str] = None) -> types.AfterCallsResponse: ...

    @overload
    def report(self, request: types.DeliveriesRequest, *, correlation_id: Optional[str] = None) -> types.DeliveriesResponse: ...

    def report(self, request: ReportRequest, *, correlation_id: Optional[str] = None) -> ReportResponse:
        return self._call("report", request, correlation_id)

    def events(self, request: EventsRequest, *, correlation_id: Optional[str] = None) -> EventsResponse:
        answer = self._call("events", request, correlation_id)
        if answer["ok"]:
            page = answer["value"]
            page["events"] = [_read_event(raw) for raw in page["events"]]
        return answer

    def event_pages(self, request: EventsRequest) -> Iterator[EventsResponse]:
        seen = {request.get("after")}
        while True:
            answer = self.events(request)
            if not answer["ok"] or not answer["value"]["more"]:
                yield answer
                return
            cursor = answer["value"]["cursor"]
            if cursor in seen:
                raise Fault("GRAPH.INTERNAL")
            yield answer
            seen.add(cursor)
            request = {**request, "after": cursor}

    @overload
    def report_pages(self, request: types.CallbacksRequest) -> Iterator[types.CallbacksResponse]: ...

    @overload
    def report_pages(self, request: types.TextsRequest) -> Iterator[types.TextsResponse]: ...

    def report_pages(self, request: PagedReportRequest) -> Iterator[PagedReportResponse]:
        if request.get("kind") not in ("texts", "callbacks"):
            raise Fault("INPUT.MALFORMED", detail={"path": "request.kind"})
        seen = {request.get("after")}
        while True:
            answer = cast(PagedReportResponse, self.report(request))
            cursor = answer["value"]["next"]
            if cursor is not None and cursor in seen:
                raise Fault("GRAPH.INTERNAL")
            yield answer
            if cursor is None:
                return
            seen.add(cursor)
            request = {**request, "after": cursor}

    def journey_pages(self, request: JourneyRequest) -> Iterator[JourneyPage]:
        if request.get("kind") != "journey":
            raise Fault("INPUT.MALFORMED", detail={"path": "request.kind"})
        while True:
            answer = cast(JourneyPage, self.lookup(request))
            cursor = answer["next"]
            if cursor is not None and "before" in request and cursor >= request["before"]:
                raise Fault("GRAPH.INTERNAL")
            yield answer
            if cursor is None:
                return
            request = {**request, "before": cursor}
