# account_graph for Python

Call a running account-graph server from Python 3.9 or later. The client uses the standard library. The optional outbox also needs Python's `sqlite3` module.

## Install

From the repository root, install the Python package into your application's virtual environment.

```sh
python3 -m pip install ./clients/python
```

To install from Git, replace `REVISION` with the commit containing the client.

```sh
python3 -m pip install 'account-graph @ git+https://github.com/pwngh/account-graph.git@REVISION#subdirectory=clients/python'
```

## Record an entry

Give every write a key and an epoch-millisecond timestamp from your system. Keep the original fields for redelivery. `stable_key(source, row_id, revision)` returns a UUID derived from all three inputs. A new revision produces a new key. Use the same input types each time.

```python
import os
from account_graph import AccountGraph, Fault, stable_key
from account_graph.types import ArrivalEntry

graph = AccountGraph(os.environ["GRAPH_URL"], os.environ["GRAPH_TOKEN"])
visit: ArrivalEntry = {
    "type": "arrival", "key": stable_key("visits", 7, 1), "at": 1795460000000,
    "subject": "contact:7", "source": "website", "landing": "https://example.org/appointments",
}
try:
    result = graph.record({"entries": [visit]}, correlation_id="visit-7")["results"][0]
except Fault as error:
    print(error.code, error.retryable)
else:
    if result["ok"]:
        print(result["value"]["duplicate"])
    else:
        print(result["reason"])
```

`record` returns one result per entry in order. A batch can hold both refused and accepted entries. `decide` and `forget` return a single result with `ok`. `lookup` returns the value for its requested kind. `report` returns `asOf` and `value`. `events` returns a page or a `CURSOR_LOST` refusal. Request and response fields keep their HTTP names, including `timeZone` and `asOf`. The package supplies their types in `account_graph.types`. See [HTTP contract](../../docs/http.md).

## Connection and retries

| Argument | Default | Meaning |
| --- | --- | --- |
| `url` | Required | Base URL before `/v1`. HTTPS verifies the certificate chain and hostname using Python's trust store. HTTP is available for localhost and loopback IP addresses. |
| `token` | Required | Service or reviewer token sent in the Authorization header. |
| `connect_timeout` | 5 seconds | Maximum time to establish one connection, including DNS and TLS. |
| `total_timeout` | 30 seconds | Budget for the call, including connection attempts, response reads and retry waits. |
| `retries` | 2 | Maximum additional attempts. Zero sends once. |

Calls connect directly to the configured origin and reject redirects. Every call accepts an optional `correlation_id` keyword. One to 200 printable ASCII characters without spaces are sent as `x-request-id`.

Only `GRAPH.UNAVAILABLE` and `TRANSPORT.INDETERMINATE` can trigger a retry. A structured fault must also set `retryable` to true. The client reuses the serialized bytes, including every original key and timestamp. The first wait is between a quarter and half a second. The range doubles on each retry, up to 15 minutes. A longer `Retry-After` in seconds or as an HTTP date takes precedence, capped at 15 minutes. If the wait would exhaust the call budget, the client raises the last fault immediately.

`Fault.code` identifies the fault. `Fault.detail` can contain the validation field path, a fallback HTTP status, or the capped retry interval in seconds as `retryAfter`. Exception messages contain the code. A write whose reply was lost may already be committed.

## Read all pages

Each iterator yields complete responses, starting with the supplied request. Save an event cursor after processing its page. If the server returns `CURSOR_LOST`, the iterator yields that refusal and stops. Rebuild your view from the oldest kept event with `after=None`.

```python
from account_graph.types import Window

for answer in graph.event_pages({"after": None, "limit": 100}):
    if not answer["ok"]:
        print(answer["reason"])
        break
    for event in answer["value"]["events"]:
        print(event["seq"], event["type"])
    print("processed through", answer["value"]["cursor"])

for page in graph.journey_pages({"kind": "journey", "subject": "contact:7"}):
    for entry in page["entries"]:
        print(entry["at"], entry["kind"])

window: Window = {"from": "2026-11-01", "to": "2026-11-30", "timeZone": "UTC"}
for report in graph.report_pages({"kind": "callbacks", "window": window, "at": 1795460000000}):
    for row in report["value"]["rows"]:
        print(row["call"], row["attempts"])
```

`report_pages` accepts `callbacks` and `texts`. Other report kinds return their full result from `report`. Resume a report with `after` or a journey with `before` set to the previous page's `next`.

## SQLite outbox

Use a persistent SQLite file for each destination graph. Enqueue the entry before acknowledging the source. A worker can open the file again after a restart. Each thread or process opens its own `Outbox`.

```python
from account_graph import Outbox

sale = {"type": "conversion", "key": stable_key("sales", 8, 1), "at": 1795463600000,
        "subject": "contact:7", "stage": "sale", "value": 120, "currency": "USD"}
refund = {"type": "restatement", "key": stable_key("refunds", 3, 1), "at": 1795470000000,
          "of": {"type": "conversion", "key": sale["key"]}, "change": {"kind": "refund", "amount": 20}}

with Outbox("graph-outbox.sqlite") as box:
    sale_row = box.enqueue("order:8", sale)
    box.enqueue("order:8", refund, depends_on=sale_row)
    box.enqueue("contact:7", visit)

with Outbox("graph-outbox.sqlite") as box:
    try:
        settled = box.flush(graph, limit=100)
    except Fault as error:
        print(error.code)
    for row in box.rows():
        print(row.id, row.record_id, row.key, row.status, row.reason, row.depends_on)
```

`enqueue` checks the entry against the HTTP contract and saves it unchanged. An unknown type, a missing or unknown field, a bad `key`, `at` or `subject`, or a value JSON cannot carry raises `Fault("INPUT.MALFORMED")` with the field path in `detail`. An unknown field is reported as `entry.*`, since its name can carry contact details. An entry over 1 MB raises `INPUT.TOO_LARGE`. Nothing is queued in either case.

The `record_id` is an ordering group, usually one host record. Rows for one record are sent in the order they were enqueued. Rows for other records do not wait for them. Pass `depends_on` with an earlier row ID when a write needs that particular write to succeed first, such as a restatement after its conversion. The two rows can belong to different records.

`flush` claims one row at a time in a short SQLite transaction, then sends it with no transaction open. `enqueue` and other workers carry on during the send. The claim lasts `lease` seconds, by default the client's `total_timeout` plus a minute. A worker that dies mid-send leaves the row pending. Once the claim expires, another worker sends the same key again and the graph answers `duplicate`. Until then, later rows for that record and rows depending on it wait.

| Status | Meaning |
| --- | --- |
| `pending` | Not yet sent, or in flight. |
| `sent` | Accepted, including a duplicate receipt. The stored body is cleared. |
| `refused` | The graph refused the entry. `reason` holds the refusal. |
| `failed` | The graph called the entry malformed or too large. `reason` holds the fault code and field path. |
| `blocked` | Its `depends_on` row was refused, failed or blocked. It is sent once that row is sent. |

A refused, failed or blocked row keeps its entry for inspection and holds back only the rows that depend on it. Later rows for the same record go on. An entry answered `NOT_ATTEMPTED` stays pending, and so do later rows for its record. An authentication, configuration, graph or transport fault stops the pass and leaves its row and every unsent row pending. `limit` caps the rows one pass takes. The return value counts rows the pass sent, refused, set aside or blocked.

## Google Cloud Function

This HTTP function accepts events from an authenticated host application. Configure the function with entry point `record_activity`, grant its caller permission to invoke it, and supply `GRAPH_URL` and `GRAPH_TOKEN` through its environment. Include the Git requirement above, pinned to your revision, in the function's `requirements.txt` alongside the Functions Framework.

The host sends one immutable event per invocation. Keep the original sale revision with the transaction. To correct the value later, send a restatement referencing its conversion key. A new conversion key counts another sale. For a visit it supplies the landing URL. For an offline sale it supplies the value and currency. Both carry the host row ID, revision, timestamp and subject. The host retries a 503 with the same event and sets aside a 409 for review.

```python
import os
from account_graph import AccountGraph, Fault, stable_key

graph = AccountGraph(os.environ["GRAPH_URL"], os.environ["GRAPH_TOKEN"], retries=0)

def record_activity(request):
    event = request.get_json(silent=True)
    if not isinstance(event, dict):
        return {"error": "expected a JSON object"}, 400
    try:
        kind = event["kind"]
        if kind == "visit":
            entry = {"type": "arrival", "source": "website", "landing": event["landing"]}
        elif kind == "sale":
            entry = {"type": "conversion", "stage": "sale", "channel": "IN_STORE",
                     "value": event["value"], "currency": event["currency"]}
        else:
            return {"error": "unknown event kind"}, 400
        entry.update(key=stable_key(kind, event["id"], event["revision"]), at=event["at"], subject=event["subject"])
    except (KeyError, ValueError, TypeError):
        return {"error": "incomplete event"}, 400
    try:
        result = graph.record({"entries": [entry]})["results"][0]
    except Fault as error:
        return {"code": error.code}, 503 if error.retryable else 400
    if not result["ok"]:
        return {"reason": result["reason"]}, 409
    return "", 204
```

Two example request bodies for the same contact follow.

```json
{"kind":"visit","id":"visit-7","revision":1,"at":1795460000000,"subject":"contact:7","landing":"https://example.org/appointments"}
```

```json
{"kind":"sale","id":"sale-8","revision":1,"at":1795463600000,"subject":"contact:7","value":120,"currency":"USD"}
```
