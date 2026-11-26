"""Run by test/python.test.ts against its in-memory graph."""

import sys
from unittest import TestCase

from account_graph import AccountGraph, Fault, Outbox


AT = 1767225600000  # January 1, 2026 UTC
TOKEN = "python-test"


def write(graph, base, lossy, path):
    sale = {"type": "conversion", "key": "sale-1", "subject": "contact:1", "stage": "sale", "value": 12, "currency": "USD", "at": AT}
    refused = {"type": "profile", "key": "reserved", "subject": "contact:1", "facts": {"identifiers": ["review:reserved"]}, "at": AT}
    rejected, accepted = graph.record({"entries": [refused, sale]})["results"]
    assert (rejected["ok"], rejected["reason"]) == (False, "KIND_RESERVED")
    assert accepted["ok"] and accepted["value"]["duplicate"] is False
    duplicate, reused = graph.record({"entries": [sale, dict(sale, stage="other")]})["results"]
    assert duplicate["ok"] and duplicate["value"]["duplicate"] is True
    assert (reused["ok"], reused["reason"], reused["fields"]) == (False, "KEY_REUSED", ["stage"])
    found = graph.lookup({"kind": "record", "type": "conversion", "key": "sale-1", "at": AT})
    assert (found["subject"], found["stage"]) == ("contact:1", "sale")

    with TestCase().assertRaises(Fault) as malformed:
        graph.report({"kind": "pipeline", "at": AT, "days": 0})
    assert malformed.exception.code == "INPUT.MALFORMED" and not malformed.exception.retryable
    with TestCase().assertRaises(Fault) as denied:
        AccountGraph(base, "wrong-token").events({"after": None, "limit": 1})
    assert denied.exception.code == "AUTH.REJECTED" and not denied.exception.retryable

    merge = {"key": "merge-1", "at": AT, "by": "desk", "action": "merge", "pairs": [{"a": "contact:a", "b": "contact:b"}]}
    assert graph.decide(merge)["value"]["recorded"] == 1
    assert graph.decide(dict(merge, key="undo-1", action="unmerge", at=AT + 1))["value"]["recorded"] == 1
    assert graph.forget({"key": "forget-1", "at": AT + 1, "by": "desk", "subjects": ["contact:1"], "platforms": "report"})["ok"]
    assert graph.lookup({"kind": "record", "type": "conversion", "key": "sale-1", "at": AT + 1}) is None

    visit = {"type": "arrival", "key": "retry-visit", "subject": "visitor:retry", "source": "website", "at": AT}
    replay = AccountGraph(lossy, TOKEN, retries=1).record({"entries": [visit]})["results"][0]
    assert replay["ok"] and replay["value"]["duplicate"] is True
    assert len(graph.lookup({"kind": "journey", "subject": "visitor:retry"})["entries"]) == 1

    check_pages(graph, visit)

    with Outbox(path) as queue:
        queue.enqueue("order-7", dict(sale, key="queued-sale", subject="contact:7"))
        with TestCase().assertRaises(Fault) as lost:
            queue.flush(AccountGraph(lossy, TOKEN, retries=0))
        assert lost.exception.code == "TRANSPORT.INDETERMINATE" and lost.exception.retryable
        assert [row.status for row in queue.rows()] == ["pending"]


def check_pages(graph, visit):
    journey = {"kind": "journey", "subject": "visitor:pages"}
    report = {"window": {"from": "2026-01-01", "to": "2026-01-01", "timeZone": "UTC"}, "at": AT + 60_000}
    empty_journey, = graph.journey_pages(journey)
    assert empty_journey["entries"] == [] and empty_journey["next"] is None
    empty_report, = graph.report_pages(dict(report, kind="callbacks"))
    assert empty_report["value"] == {"rows": [], "next": None}

    # Distinct timestamps and senders put exactly one entry past each page boundary.
    visits = [dict(visit, key=f"visit-{i}", subject=journey["subject"], at=AT + i) for i in range(201)]
    messages = [{"type": "text", "direction": "inbound", "from": f"+120255501{i:02}", "to": "+12025550199", "at": AT + i, "key": f"text-{i}"} for i in range(51)]
    calls = [dict(message, type="call", key=f"missed-{i}", result={"answered": False}) for i, message in enumerate(messages)]
    for entries in (visits[:100], visits[100:200], visits[200:], messages, calls):
        assert all(row["ok"] for row in graph.record({"entries": entries})["results"])
    journeys = list(graph.journey_pages(journey))
    assert [len(page["entries"]) for page in journeys] == [200, 1] and journeys[-1]["next"] is None
    assert sorted(entry["at"] for page in journeys for entry in page["entries"]) == [AT + i for i in range(201)]
    assert list(graph.journey_pages(dict(journey, before=journeys[0]["next"]))) == journeys[1:]
    for kind, field, entries in [("texts", "text", messages), ("callbacks", "call", calls)]:
        query = dict(report, kind=kind)
        reports = list(graph.report_pages(query))
        assert [len(page["value"]["rows"]) for page in reports] == [50, 1] and reports[-1]["value"]["next"] is None
        assert [row[field] for page in reports for row in page["value"]["rows"]] == [entry["key"] for entry in entries]
        assert list(graph.report_pages(dict(query, after=reports[0]["value"]["next"]))) == reports[1:]

    expected = graph.events({"after": None, "limit": 500})["value"]["events"]
    assert len(expected) > 1
    pages = list(graph.event_pages({"after": None, "limit": 1}))
    assert all(page["value"]["more"] for page in pages[:-1]) and pages[-1]["value"]["more"] is False
    assert [event for page in pages for event in page["value"]["events"]] == expected
    empty, = graph.event_pages({"after": pages[-1]["value"]["cursor"], "limit": 1})
    assert empty["value"]["events"] == [] and empty["value"]["more"] is False
    assert list(graph.event_pages({"after": "another-history.1", "limit": 1})) == [{"ok": False, "reason": "CURSOR_LOST"}]


def recover(graph, lossy, path):
    with Outbox(path) as queue:
        assert [row.status for row in queue.rows()] == ["pending"]
        assert queue.flush(AccountGraph(lossy, TOKEN)) == 1
        assert [row.status for row in queue.rows()] == ["sent"]
        assert queue.flush(graph) == 0
    journey = graph.lookup({"kind": "journey", "subject": "contact:7"})
    assert [entry["conversion"] for entry in journey["entries"] if entry["kind"] == "conversion"] == ["queued-sale"]


if __name__ == "__main__":
    phase, base, lossy, path = sys.argv[1:]
    graph = AccountGraph(base, TOKEN)
    if phase == "write":
        write(graph, base, lossy, path)
    else:
        recover(graph, lossy, path)
