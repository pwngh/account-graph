// A durable outbox of record entries for one account graph, ordered per record. It follows the rules of the
// Python client's outbox in clients/python/account_graph/outbox.py, and uses a table of the same shape.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;

namespace AccountGraph;

/// <summary>One row of the outbox. <see cref="Status"/> is pending, sent, refused, failed or blocked.</summary>
public sealed record OutboxRow(long Id, string RecordId, string Key, string Status, string? Reason, long? DependsOn);

public sealed class Outbox : IDisposable
{
    static readonly HashSet<string> SetAside = new() { "INPUT.MALFORMED", "INPUT.TOO_LARGE" };

    // Required fields of each entry type, as the HTTP contract lists them.
    static readonly Dictionary<string, string[]> Required = new()
    {
        ["arrival"] = new[] { "at", "key", "subject", "type" },
        ["call"] = new[] { "at", "direction", "key", "to", "type" },
        ["call_update"] = new[] { "at", "call", "change", "key", "type" },
        ["consent"] = new[] { "at", "consent", "key", "subject", "type" },
        ["conversion"] = new[] { "at", "key", "stage", "subject", "type" },
        ["cost"] = new[] { "at", "key", "rows", "type" },
        ["link"] = new[] { "at", "expires", "key", "subject", "type", "url" },
        ["payment"] = new[] { "amount", "at", "conversion", "direction", "key", "type" },
        ["profile"] = new[] { "at", "facts", "key", "subject", "type" },
        ["restatement"] = new[] { "at", "change", "key", "of", "type" },
        ["text"] = new[] { "at", "direction", "from", "key", "to", "type" },
        ["transfer"] = new[] { "amount", "at", "from", "key", "to", "type" },
    };

    // A row waits for an earlier unsettled row of its record and for its prerequisite to be sent.
    // A prerequisite set aside blocks the row, and a blocked row resumes once its prerequisite is sent.
    const string Next = """
        SELECT j.id, j.body, p.status FROM account_graph_outbox j LEFT JOIN account_graph_outbox p ON p.id = j.depends_on
        WHERE j.id > $after AND (j.lease_until IS NULL OR j.lease_until <= $now)
        AND (j.status = 'pending' OR (j.status = 'blocked' AND (p.id IS NULL OR p.status = 'sent')))
        AND (p.id IS NULL OR p.status <> 'pending')
        AND NOT EXISTS (
            SELECT 1 FROM account_graph_outbox r LEFT JOIN account_graph_outbox rp ON rp.id = r.depends_on
            WHERE r.record_id = j.record_id AND r.id < j.id
            AND (r.status = 'pending' OR (r.status = 'blocked' AND (rp.id IS NULL OR rp.status = 'sent'))))
        ORDER BY j.id LIMIT 1
        """;

    readonly SqliteConnection db;

    /// <param name="path">The SQLite file. Several processes may share it.</param>
    public Outbox(string path)
    {
        db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false, DefaultTimeout = 30 }.ToString());
        try
        {
            db.Open();
            Execute("""
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
                """);
            Execute("CREATE INDEX IF NOT EXISTS account_graph_outbox_pending ON account_graph_outbox (status, id)");
            Execute("CREATE INDEX IF NOT EXISTS account_graph_outbox_record ON account_graph_outbox (record_id, id)");
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    public void Dispose() => db.Dispose();

    /// <summary>
    /// Checks the entry against the contract, then keeps its original key, timestamp and fields. Rows of one
    /// <paramref name="recordId"/> are sent in order. <paramref name="dependsOn"/> names an earlier row of any record
    /// that must be sent first. Returns the row's ID.
    /// </summary>
    public long Enqueue(string recordId, JsonObject entry, long? dependsOn = null)
    {
        if (string.IsNullOrEmpty(recordId)) throw new ArgumentException("recordId must be a nonempty string");
        if (dependsOn is long prerequisite && Scalar("SELECT 1 FROM account_graph_outbox WHERE id = $id", ("$id", prerequisite)) is null)
            throw new ArgumentException("dependsOn must be the ID of an earlier outbox row");
        var body = Body(entry);
        return (long)Scalar("INSERT INTO account_graph_outbox (record_id, key, body, depends_on) VALUES ($record, $key, $body, $depends) RETURNING id",
            ("$record", recordId), ("$key", (string)entry["key"]!), ("$body", body), ("$depends", (object?)dependsOn ?? DBNull.Value))!;
    }

    public IReadOnlyList<OutboxRow> Rows()
    {
        using var command = db.CreateCommand();
        command.CommandText = "SELECT id, record_id, key, status, reason, depends_on FROM account_graph_outbox ORDER BY id";
        using var reader = command.ExecuteReader();
        var rows = new List<OutboxRow>();
        while (reader.Read())
            rows.Add(new OutboxRow(reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.IsDBNull(5) ? null : reader.GetInt64(5)));
        return rows;
    }

    /// <summary>
    /// Takes up to <paramref name="limit"/> ready rows and returns how many were sent, refused, set aside or blocked.
    /// Each row is claimed for <paramref name="leaseSeconds"/>, then sent outside any transaction. A worker that dies
    /// mid-send leaves its claim to expire, and the next worker sends the same key again. A call fault propagates
    /// with the row still pending.
    /// </summary>
    public async Task<int> FlushAsync(Client client, int limit = 100, double leaseSeconds = 120, CancellationToken cancel = default)
    {
        if (limit < 0) throw new ArgumentException("limit must be a nonnegative integer");
        if (!(leaseSeconds > 0 && leaseSeconds <= 1_000_000)) throw new ArgumentException("leaseSeconds must be a number of seconds longer than the client's totalTimeout");
        var owner = Guid.NewGuid().ToString("N");
        var settled = 0;
        long after = 0;
        for (var i = 0; i < limit; i++)
        {
            var claimed = Claim(owner, leaseSeconds, after);
            if (claimed is null) break;
            var (rowId, entry) = claimed.Value;
            after = rowId;
            if (entry is null)
            {
                settled += 1;
                continue;
            }
            string? reason;
            try
            {
                var reply = await client.RecordAsync(new JsonObject { ["entries"] = new JsonArray(entry) }, null, cancel);
                reason = Refusal(reply, entry);
            }
            catch (Fault fault) when (SetAside.Contains(fault.Code))
            {
                // The graph refuses this kept entry every time. Keep it for inspection and go on.
                reason = fault.Code + (fault.Detail.TryGetValue("path", out var path) ? " " + path : "");
                Finish(rowId, owner, "UPDATE account_graph_outbox SET status = 'failed', reason = $reason, owner = NULL, lease_until = NULL WHERE id = $id AND owner = $owner", reason);
                settled += 1;
                continue;
            }
            catch
            {
                Release(rowId, owner);
                throw;
            }
            if (reason == "NOT_ATTEMPTED")
            {
                // Nothing was tried. The row keeps its place and the next pass sends it again.
                Release(rowId, owner);
                continue;
            }
            if (reason is null) Finish(rowId, owner, "UPDATE account_graph_outbox SET status = 'sent', body = NULL, owner = NULL, lease_until = NULL WHERE id = $id AND owner = $owner");
            else Finish(rowId, owner, "UPDATE account_graph_outbox SET status = 'refused', reason = $reason, owner = NULL, lease_until = NULL WHERE id = $id AND owner = $owner", reason);
            settled += 1;
        }
        return settled;
    }

    (long, JsonObject?)? Claim(string owner, double lease, long after)
    {
        // A short write transaction marks the row in flight. Nothing waits on the network inside it.
        // A row in flight stays pending, so another worker cannot overtake it until its claim expires.
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
        Execute("BEGIN IMMEDIATE");
        try
        {
            long rowId;
            string? body;
            string? prerequisite;
            using (var command = db.CreateCommand())
            {
                command.CommandText = Next;
                command.Parameters.AddWithValue("$after", after);
                command.Parameters.AddWithValue("$now", now);
                using var reader = command.ExecuteReader();
                if (!reader.Read())
                {
                    Execute("COMMIT");
                    return null;
                }
                rowId = reader.GetInt64(0);
                body = reader.IsDBNull(1) ? null : reader.GetString(1);
                prerequisite = reader.IsDBNull(2) ? null : reader.GetString(2);
            }
            if (prerequisite is "refused" or "failed" or "blocked")
            {
                Execute("UPDATE account_graph_outbox SET status = 'blocked' WHERE id = $id", ("$id", rowId));
                Execute("COMMIT");
                return (rowId, null);
            }
            Execute("UPDATE account_graph_outbox SET status = 'pending', owner = $owner, lease_until = $until WHERE id = $id", ("$owner", owner), ("$until", now + lease), ("$id", rowId));
            Execute("COMMIT");
            return (rowId, JsonNode.Parse(body!)!.AsObject());
        }
        catch
        {
            Execute("ROLLBACK");
            throw;
        }
    }

    void Release(long rowId, string owner) =>
        Execute("UPDATE account_graph_outbox SET owner = NULL, lease_until = NULL WHERE id = $id AND owner = $owner", ("$id", rowId), ("$owner", owner));

    // A claim that expired and passed to another worker is no longer this worker's to settle.
    void Finish(long rowId, string owner, string sql, string? reason = null) =>
        Execute(sql, ("$id", rowId), ("$owner", owner), ("$reason", (object?)reason ?? DBNull.Value));

    void Execute(string sql, params (string Name, object Value)[] values)
    {
        using var command = db.CreateCommand();
        command.CommandText = sql;
        foreach (var (name, value) in values) if (sql.Contains(name)) command.Parameters.AddWithValue(name, value);
        command.ExecuteNonQuery();
    }

    object? Scalar(string sql, params (string Name, object Value)[] values)
    {
        using var command = db.CreateCommand();
        command.CommandText = sql;
        foreach (var (name, value) in values) command.Parameters.AddWithValue(name, value);
        return command.ExecuteScalar();
    }

    static Fault Malformed(string path) => new("INPUT.MALFORMED", false, new Dictionary<string, object> { ["path"] = path });

    static string Body(JsonObject? entry)
    {
        if (entry is null) throw Malformed("entry");
        var kind = entry["type"]?.GetValueKind() == JsonValueKind.String ? (string?)entry["type"] : null;
        if (kind is null || !Required.TryGetValue(kind, out var required)) throw Malformed("entry.type");
        var missing = required.Where(field => !entry.ContainsKey(field)).Order(StringComparer.Ordinal).FirstOrDefault();
        if (missing is not null) throw Malformed("entry." + missing);
        // The HTTP contract measures a key in UTF-16 code units, as .NET strings are.
        var key = entry["key"]?.GetValueKind() == JsonValueKind.String ? (string?)entry["key"] : null;
        if (string.IsNullOrEmpty(key) || key.Length > 200) throw Malformed("entry.key");
        var at = entry["at"];
        if (at?.GetValueKind() != JsonValueKind.Number || !double.TryParse(at.ToJsonString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var when)
            || when < 0 || when > 8_640_000_000_000_000 || when != Math.Floor(when))
            throw Malformed("entry.at");
        if (entry.ContainsKey("subject"))
        {
            var subject = entry["subject"]?.GetValueKind() == JsonValueKind.String ? (string?)entry["subject"] : null;
            if (subject is null || subject.Length is < 1 or > 512 || subject != subject.Trim()) throw Malformed("entry.subject");
        }
        if (Levels(entry) > 30) throw Malformed("entry");
        var body = entry.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        // {"entries":[...]} adds 14 bytes.
        if (Encoding.UTF8.GetByteCount(body) + 14 > 1_000_000) throw new Fault("INPUT.TOO_LARGE");
        return body;
    }

    static int Levels(JsonNode? value)
    {
        switch (value)
        {
            case JsonObject map:
                // The graph cannot store a NUL, in a field name or a value.
                if (map.Any(pair => pair.Key.Contains('\0'))) throw Malformed("entry");
                return 1 + map.Select(pair => Levels(pair.Value)).DefaultIfEmpty(0).Max();
            case JsonArray list:
                return 1 + list.Select(Levels).DefaultIfEmpty(0).Max();
            case JsonValue leaf when leaf.GetValueKind() == JsonValueKind.String && ((string)leaf!).Contains('\0'):
                throw Malformed("entry");
            default:
                return 0;
        }
    }

    /// <summary>Null when the reply acknowledges the row, the reason when it refuses it. An incomplete or mismatched reply is indeterminate.</summary>
    static string? Refusal(JsonObject reply, JsonObject entry)
    {
        if (reply["results"] is JsonArray { Count: 1 } results && results[0] is JsonObject result
            && (string?)result["type"] == (string?)entry["type"] && (string?)result["key"] == (string?)entry["key"])
        {
            var ok = result["ok"]?.GetValueKind();
            if (ok == JsonValueKind.True && result["value"] is JsonObject value
                && value["duplicate"]?.GetValueKind() is JsonValueKind.True or JsonValueKind.False
                && value["stands"]?.GetValueKind() is JsonValueKind.True or JsonValueKind.False)
                return null;
            if (ok == JsonValueKind.False && result["reason"]?.GetValueKind() == JsonValueKind.String && (string)result["reason"]! is { Length: > 0 } reason)
                return reason;
        }
        throw new Fault("TRANSPORT.INDETERMINATE", true);
    }
}
