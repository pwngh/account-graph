"""A durable outbox of record entries for one account graph, ordered per record."""

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Literal, Optional, Tuple, cast, get_args

from .client import AccountGraph, Fault
from .types import RecordEntry

# Required and permitted fields of each entry type, as the HTTP contract lists them.
_FIELDS = {get_args(kind.__annotations__["type"])[0]: (kind.__required_keys__, kind.__required_keys__ | kind.__optional_keys__) for kind in get_args(RecordEntry)}
_SET_ASIDE = {"INPUT.MALFORMED", "INPUT.TOO_LARGE"}

# A row waits for an earlier unsettled row of its record and for its prerequisite to be sent.
# A prerequisite set aside blocks the row, and a blocked row resumes once its prerequisite is sent.
_NEXT = """
    SELECT j.id, j.body, p.status FROM account_graph_outbox j LEFT JOIN account_graph_outbox p ON p.id = j.depends_on
    WHERE j.id > ? AND (j.lease_until IS NULL OR j.lease_until <= ?)
    AND (j.status = 'pending' OR (j.status = 'blocked' AND (p.id IS NULL OR p.status = 'sent')))
    AND (p.id IS NULL OR p.status <> 'pending')
    AND NOT EXISTS (
        SELECT 1 FROM account_graph_outbox r LEFT JOIN account_graph_outbox rp ON rp.id = r.depends_on
        WHERE r.record_id = j.record_id AND r.id < j.id
        AND (r.status = 'pending' OR (r.status = 'blocked' AND (rp.id IS NULL OR rp.status = 'sent'))))
    ORDER BY j.id LIMIT 1
"""


@dataclass(frozen=True)
class OutboxRow:
    id: int
    record_id: str
    key: str
    status: Literal["pending", "refused", "failed", "blocked", "sent"]
    reason: Optional[str]
    depends_on: Optional[int] = None


class Outbox:
    def __init__(self, path: str) -> None:
        # Client-only installations can use the graph without SQLite.
        import sqlite3

        self._db = sqlite3.connect(path, isolation_level=None)
        try:
            self._db.execute("""
                CREATE TABLE IF NOT EXISTS account_graph_outbox (
                    id INTEGER PRIMARY KEY,
                    record_id TEXT NOT NULL,
                    key TEXT NOT NULL,
                    body TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    reason TEXT,
                    depends_on INTEGER,
                    owner TEXT,
                    lease_until REAL
                )
            """)
            self._db.execute("CREATE INDEX IF NOT EXISTS account_graph_outbox_pending ON account_graph_outbox (status, id)")
            self._db.execute("CREATE INDEX IF NOT EXISTS account_graph_outbox_record ON account_graph_outbox (record_id, id)")
        except Exception:
            self._db.close()
            raise

    def __enter__(self) -> "Outbox":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._db.close()

    def enqueue(self, record_id: str, entry: RecordEntry, *, depends_on: Optional[int] = None) -> int:
        """Check the entry against the contract, then persist its original key, timestamp and fields.

        Rows for one record_id are sent in order. depends_on names an earlier row of any record that must be sent first.
        """
        if not isinstance(record_id, str) or not record_id:
            raise ValueError("record_id must be a nonempty string")
        if depends_on is not None and (type(depends_on) is not int or not self._db.execute("SELECT 1 FROM account_graph_outbox WHERE id = ?", (depends_on,)).fetchone()):
            raise ValueError("depends_on must be the ID of an earlier outbox row")
        body = _body(entry)
        cursor = self._db.execute("INSERT INTO account_graph_outbox (record_id, key, body, depends_on) VALUES (?, ?, ?, ?)", (record_id, entry["key"], body, depends_on))
        return cast(int, cursor.lastrowid)

    def rows(self) -> list[OutboxRow]:
        rows = self._db.execute("SELECT id, record_id, key, status, reason, depends_on FROM account_graph_outbox ORDER BY id")
        return [OutboxRow(*row) for row in rows]

    def flush(self, client: AccountGraph, *, limit: int = 100, lease: Optional[float] = None) -> int:
        """Take up to limit ready rows and return how many were sent, refused, set aside or blocked.

        Each row is claimed for lease seconds, then sent outside any transaction. A worker that
        dies mid-send leaves its claim to expire, and the next worker resends the same key.
        A call fault propagates with the row still pending.
        """
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
            raise ValueError("limit must be a nonnegative integer")
        budget = client._total_timeout if isinstance(client, AccountGraph) else 0
        if lease is None:
            lease = budget + 60 if budget else 120.0
        if isinstance(lease, bool) or not isinstance(lease, (int, float)) or not budget < lease <= 1_000_000:
            raise ValueError("lease must be a number of seconds longer than the client's total_timeout")
        owner = uuid.uuid4().hex
        settled = 0
        after = 0
        for _ in range(limit):
            claimed = self._claim(owner, lease, after)
            if claimed is None:
                break
            row_id, entry = claimed
            after = row_id
            if entry is None:
                settled += 1
                continue
            try:
                reply = client.record({"entries": [entry]})
                reason = _refusal(reply, entry)
            except Fault as fault:
                if fault.code not in _SET_ASIDE:
                    self._release(row_id, owner)
                    raise
                # The graph will refuse this frozen entry every time. Keep it for inspection and go on.
                path = fault.detail.get("path")
                reason = fault.code + (" " + path if isinstance(path, str) else "")
                self._finish(row_id, owner, "UPDATE account_graph_outbox SET status = 'failed', reason = ?, owner = NULL, lease_until = NULL WHERE id = ? AND owner = ?", reason)
                settled += 1
                continue
            except BaseException:
                self._release(row_id, owner)
                raise
            if reason == "NOT_ATTEMPTED":
                # Nothing was tried. The row keeps its place and the next pass sends it again.
                self._release(row_id, owner)
                continue
            if reason is None:
                self._finish(row_id, owner, "UPDATE account_graph_outbox SET status = 'sent', body = NULL, owner = NULL, lease_until = NULL WHERE id = ? AND owner = ?")
            else:
                self._finish(row_id, owner, "UPDATE account_graph_outbox SET status = 'refused', reason = ?, owner = NULL, lease_until = NULL WHERE id = ? AND owner = ?", reason)
            settled += 1
        return settled

    def _claim(self, owner: str, lease: float, after: int) -> Optional[Tuple[int, Optional[RecordEntry]]]:
        # A short write transaction marks the row in flight. Nothing waits on the network inside it.
        # A row in flight stays pending, so another worker cannot overtake it until its claim expires.
        now = time.time()
        with self._db:
            self._db.execute("BEGIN IMMEDIATE")
            row = self._db.execute(_NEXT, (after, now)).fetchone()
            if row is None:
                return None
            row_id, body, prerequisite = row
            if prerequisite in ("refused", "failed", "blocked"):
                self._db.execute("UPDATE account_graph_outbox SET status = 'blocked' WHERE id = ?", (row_id,))
                return row_id, None
            self._db.execute("UPDATE account_graph_outbox SET status = 'pending', owner = ?, lease_until = ? WHERE id = ?", (owner, now + lease, row_id))
        return row_id, json.loads(body)

    def _release(self, row_id: int, owner: str) -> None:
        self._db.execute("UPDATE account_graph_outbox SET owner = NULL, lease_until = NULL WHERE id = ? AND owner = ?", (row_id, owner))

    def _finish(self, row_id: int, owner: str, sql: str, *values: object) -> None:
        # A claim that expired and passed to another worker is no longer this worker's to settle.
        self._db.execute(sql, (*values, row_id, owner))


def _body(entry: Any) -> str:
    def malformed(path: str) -> Fault:
        return Fault("INPUT.MALFORMED", detail={"path": path})

    if not isinstance(entry, dict):
        raise malformed("entry")
    kind = entry.get("type")
    if not isinstance(kind, str) or kind not in _FIELDS:
        raise malformed("entry.type")
    required, known = _FIELDS[kind]
    missing = sorted(required - entry.keys())
    if missing:
        raise malformed("entry." + missing[0])
    if any(name not in known for name in entry):
        # A field name can itself carry contact details, so it is not repeated.
        raise malformed("entry.*")
    key = entry["key"]
    # The HTTP contract measures a key in UTF-16 code units.
    if not isinstance(key, str) or not key or len(key.encode("utf-16-le", "surrogatepass")) // 2 > 200:
        raise malformed("entry.key")
    at = entry["at"]
    if type(at) not in (int, float) or not 0 <= at <= 8_640_000_000_000_000 or at != int(at):
        raise malformed("entry.at")
    subject = entry.get("subject")
    if "subject" in entry and (not isinstance(subject, str) or not 1 <= len(subject) <= 512 or subject != subject.strip()):
        raise malformed("entry.subject")
    try:
        body = json.dumps(entry, separators=(",", ":"), allow_nan=False, ensure_ascii=False)
        # The request adds two levels around the entry. Half a character fails to encode.
        size = len(body.encode("utf-8"))
        if _levels(entry) > 30:
            raise ValueError()
    except (TypeError, ValueError, RecursionError):
        raise malformed("entry") from None
    # {"entries":[...]} adds 14 bytes.
    if size + 14 > 1_000_000:
        raise Fault("INPUT.TOO_LARGE")
    return body


def _levels(value: Any) -> int:
    # The graph cannot store a NUL.
    if isinstance(value, str) and "\0" in value:
        raise ValueError()
    if isinstance(value, dict):
        return 1 + max(map(_levels, [*value, *value.values()]), default=0)
    if isinstance(value, (list, tuple)):
        return 1 + max(map(_levels, value), default=0)
    return 0


def _refusal(reply: object, entry: RecordEntry) -> Optional[str]:
    # An incomplete or mismatched reply cannot acknowledge this row.
    results = reply.get("results") if isinstance(reply, dict) else None
    if isinstance(results, list) and len(results) == 1 and isinstance(results[0], dict):
        result = results[0]
        if result.get("type") == entry["type"] and result.get("key") == entry["key"]:
            value = result.get("value")
            if result.get("ok") is True and isinstance(value, dict) and isinstance(value.get("duplicate"), bool) and isinstance(value.get("stands"), bool):
                return None
            reason = result.get("reason")
            if result.get("ok") is False and isinstance(reason, str) and reason:
                return reason
    raise Fault("TRANSPORT.INDETERMINATE", retryable=True)
