// A client for the six account-graph HTTP calls. It follows the same rules as the Python client in clients/python.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace AccountGraph;

/// <summary>A call that did not succeed. <see cref="Code"/> is one of the graph's fault codes.</summary>
public sealed class Fault : Exception
{
    public Fault(string code, bool retryable = false, IReadOnlyDictionary<string, object>? detail = null) : base(code)
    {
        Code = code;
        Retryable = retryable;
        Detail = detail ?? new Dictionary<string, object>();
    }

    public string Code { get; }

    /// <summary>True when the same request, with the same keys, may be sent again.</summary>
    public bool Retryable { get; }

    /// <summary>The HTTP status, the request field at fault as <c>path</c>, and <c>retryAfter</c> in seconds.</summary>
    public IReadOnlyDictionary<string, object> Detail { get; }
}

public sealed class Client : IDisposable
{
    static readonly HashSet<string> RetryableCodes = new() { "GRAPH.UNAVAILABLE", "TRANSPORT.INDETERMINATE" };
    static readonly HashSet<string> Codes = new(RetryableCodes)
    {
        "GRAPH.CLOSED", "GRAPH.INTERNAL", "CONFIG.INVALID", "CONFIG.UNSUPPORTED", "CONFIG.MISMATCH",
        "INPUT.MALFORMED", "INPUT.TOO_LARGE", "AUTH.REJECTED", "AUTH.FORBIDDEN", "TRANSPORT.ABORTED",
    };
    static readonly HashSet<string> Events = new()
    {
        "cluster.changed", "conversion.failed", "delivery.paused", "delivery.late", "costs.failed", "feed.quiet", "callback.overdue", "audit.head",
    };
    const long MaxSafe = 9_007_199_254_740_991;

    readonly HttpClient http;
    readonly Uri root;
    readonly string token;
    readonly TimeSpan total;
    readonly int retries;

    /// <param name="url">The graph's address. Plain http is allowed only to this machine.</param>
    /// <param name="token">A service token.</param>
    /// <param name="connectTimeout">Seconds to connect, 5 by default.</param>
    /// <param name="totalTimeout">Seconds for a whole call with its retries, 30 by default.</param>
    /// <param name="retries">Further tries of a call that may be sent again, 2 by default.</param>
    public Client(string url, string token, double connectTimeout = 5, double totalTimeout = 30, int retries = 2)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || url.Any(c => c <= ' ' || c >= 127) || url.IndexOfAny(new[] { '?', '#', '\\' }) >= 0
            || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.UserInfo.Length > 0
            || (parsed.Scheme == "http" && !IsLoopbackName(parsed.Host)))
            throw new Fault("CONFIG.INVALID");
        if (token is null || !Regex.IsMatch(token, "^[!-~]+$"))
            throw new Fault("CONFIG.INVALID");
        if (!(connectTimeout > 0 && connectTimeout <= 1_000_000 && totalTimeout > 0 && totalTimeout <= 1_000_000) || retries < 0)
            throw new Fault("CONFIG.INVALID");
        var plain = parsed.Scheme == "http";
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            UseProxy = false,
            ConnectTimeout = TimeSpan.FromSeconds(connectTimeout),
            ConnectCallback = async (context, cancel) =>
            {
                var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(context.DnsEndPoint, cancel);
                    // A bearer token goes over plain http only to a peer on this machine, whatever the name resolved to.
                    if (plain && !(socket.RemoteEndPoint is IPEndPoint peer && IPAddress.IsLoopback(peer.Address)))
                        throw new InvalidOriginException();
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            },
        };
        http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        root = new Uri(parsed.GetLeftPart(UriPartial.Path).TrimEnd('/') + "/v1/");
        this.token = token;
        total = TimeSpan.FromSeconds(totalTimeout);
        this.retries = retries;
    }

    public Task<JsonObject> RecordAsync(JsonObject request, string? correlationId = null, CancellationToken cancel = default) => CallObject("record", request, correlationId, cancel);
    public Task<JsonObject> DecideAsync(JsonObject request, string? correlationId = null, CancellationToken cancel = default) => CallObject("decide", request, correlationId, cancel);
    public Task<JsonObject> ForgetAsync(JsonObject request, string? correlationId = null, CancellationToken cancel = default) => CallObject("forget", request, correlationId, cancel);
    public Task<JsonObject> ReportAsync(JsonObject request, string? correlationId = null, CancellationToken cancel = default) => CallObject("report", request, correlationId, cancel);
    public Task<JsonObject> EventsAsync(JsonObject request, string? correlationId = null, CancellationToken cancel = default) => CallObject("events", request, correlationId, cancel);

    /// <summary>The answer, or null where a party or record lookup finds nothing.</summary>
    public Task<JsonNode?> LookupAsync(JsonObject request, string? correlationId = null, CancellationToken cancel = default) => Call("lookup", request, correlationId, cancel);

    /// <summary>
    /// Every page of events from <c>after</c> on. The last page has <c>more</c> false, or is a <c>CURSOR_LOST</c> refusal.
    /// A cursor seen twice is a <see cref="Fault"/> with <c>GRAPH.INTERNAL</c>, so a server fault never loops forever.
    /// </summary>
    public async IAsyncEnumerable<JsonObject> EventPagesAsync(JsonObject request, [EnumeratorCancellation] CancellationToken cancel = default)
    {
        var next = (JsonObject)request.DeepClone();
        var seen = new HashSet<string?> { Text(next["after"]) };
        while (true)
        {
            var answer = await EventsAsync(next, null, cancel);
            if (answer["ok"]!.GetValueKind() == JsonValueKind.False || answer["value"]!["more"]!.GetValueKind() == JsonValueKind.False)
            {
                yield return answer;
                yield break;
            }
            var cursor = (string?)answer["value"]!["cursor"];
            if (!seen.Add(cursor)) throw new Fault("GRAPH.INTERNAL");
            yield return answer;
            next["after"] = cursor;
        }
    }

    /// <summary>Every page of a <c>texts</c> or <c>callbacks</c> report, following <c>next</c> until it is null.</summary>
    public async IAsyncEnumerable<JsonObject> ReportPagesAsync(JsonObject request, [EnumeratorCancellation] CancellationToken cancel = default)
    {
        if (Text(request["kind"]) is not ("texts" or "callbacks"))
            throw new Fault("INPUT.MALFORMED", false, new Dictionary<string, object> { ["path"] = "request.kind" });
        var next = (JsonObject)request.DeepClone();
        var seen = new HashSet<string?> { Text(next["after"]) };
        while (true)
        {
            var answer = await ReportAsync(next, null, cancel);
            var cursor = Text(answer["value"]!["next"]);
            if (cursor is not null && !seen.Add(cursor)) throw new Fault("GRAPH.INTERNAL");
            yield return answer;
            if (cursor is null) yield break;
            next["after"] = cursor;
        }
    }

    /// <summary>Every page of a journey, following <c>next</c> as <c>before</c> until it is null.</summary>
    public async IAsyncEnumerable<JsonObject> JourneyPagesAsync(JsonObject request, [EnumeratorCancellation] CancellationToken cancel = default)
    {
        if (Text(request["kind"]) != "journey")
            throw new Fault("INPUT.MALFORMED", false, new Dictionary<string, object> { ["path"] = "request.kind" });
        var next = (JsonObject)request.DeepClone();
        while (true)
        {
            var answer = (JsonObject)(await LookupAsync(next, null, cancel))!;
            var cursor = answer["next"];
            // Each page must reach further back than the one before it.
            if (cursor is not null && next["before"] is JsonNode before && (long)cursor >= (long)before) throw new Fault("GRAPH.INTERNAL");
            yield return answer;
            if (cursor is null) yield break;
            next["before"] = (long)cursor;
        }
    }

    static string? Text(JsonNode? node) => node?.GetValueKind() == JsonValueKind.String ? (string?)node : null;

    /// <summary>One graph key for one revision of a row in a host table or feed. The Python client's stable_key gives the same key.</summary>
    public static string StableKey(string source, object rowId, object revision)
    {
        static bool Part(object? part) => part is int or long || part is string { Length: > 0 };
        if (string.IsNullOrEmpty(source) || !Part(rowId) || !Part(revision))
            throw new ArgumentException("Supply a source, row ID and revision");
        var parts = "[" + string.Join(",", new[] { source, rowId, revision }.Select(PythonJson)) + "]";
        return UuidV5(new Guid("6ba7b811-9dad-11d1-80b4-00c04fd430c8"), parts);
    }

    public void Dispose() => http.Dispose();

    async Task<JsonObject> CallObject(string name, JsonObject request, string? correlationId, CancellationToken cancel) =>
        (JsonObject)(await Call(name, request, correlationId, cancel))!;

    async Task<JsonNode?> Call(string name, JsonObject request, string? correlationId, CancellationToken cancel)
    {
        var deadline = DateTime.UtcNow + total;
        if (request is null) throw new Fault("INPUT.MALFORMED");
        var kind = request["kind"]?.GetValueKind() == JsonValueKind.String ? (string?)request["kind"] : null;
        var entries = request["entries"] as JsonArray;
        if (name == "record" && entries is { Count: > 100 }) throw new Fault("INPUT.TOO_LARGE");
        byte[] body;
        try { body = JsonSerializer.SerializeToUtf8Bytes(request); }
        catch (Exception error) when (error is JsonException or InvalidOperationException or ArgumentException) { throw new Fault("INPUT.MALFORMED"); }
        if (body.Length > 1_000_000) throw new Fault("INPUT.TOO_LARGE");
        var write = name is "record" or "decide" or "forget";
        if (write) CheckKeys(name, request, entries);

        var backoff = 0.25;
        for (var attempt = 0; ; attempt++)
        {
            Fault failure;
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            var left = deadline - DateTime.UtcNow;
            if (left <= TimeSpan.Zero) throw new Fault("TRANSPORT.INDETERMINATE", true);
            limit.CancelAfter(left);
            try
            {
                using var message = new HttpRequestMessage(HttpMethod.Post, new Uri(root, name)) { Content = new ByteArrayContent(body) };
                message.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
                message.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
                if (correlationId is not null && Regex.IsMatch(correlationId, "^[!-~]{1,200}$")) message.Headers.TryAddWithoutValidation("X-Request-Id", correlationId);
                using var response = await http.SendAsync(message, HttpCompletionOption.ResponseContentRead, limit.Token);
                var text = await response.Content.ReadAsByteArrayAsync(limit.Token);
                JsonNode? answer = null;
                var parsed = false;
                try { answer = JsonNode.Parse(text); parsed = true; }
                catch (JsonException) { }
                var status = (int)response.StatusCode;
                if (parsed && status == 200 && Answered(name, answer, kind, entries?.Count))
                    return name == "events" ? ReadEvents((JsonObject)answer!) : answer;
                var given = status != 200 ? (answer as JsonObject)?["fault"] as JsonObject : null;
                failure = Failure(status, RetryAfter(response), given, write);
            }
            catch (InvalidOriginException) { failure = new Fault("CONFIG.INVALID"); }
            catch (HttpRequestException error) when (error.InnerException is InvalidOriginException) { failure = new Fault("CONFIG.INVALID"); }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested) { throw new Fault("TRANSPORT.ABORTED"); }
            catch (Exception error) when (error is HttpRequestException or OperationCanceledException or System.IO.IOException) { failure = new Fault("TRANSPORT.INDETERMINATE", true); }

            if (!failure.Retryable || attempt == retries) throw failure;
            var wait = Math.Max(failure.Detail.TryGetValue("retryAfter", out var after) ? (double)after : 0, backoff * (1 + Random.Shared.NextDouble()));
            if (DateTime.UtcNow.AddSeconds(wait) >= deadline) throw failure;
            await Task.Delay(TimeSpan.FromSeconds(wait), cancel);
            backoff = Math.Min(450, backoff * 2);
        }
    }

    static void CheckKeys(string name, JsonObject request, JsonArray? entries)
    {
        if (name == "record" && (entries is null || entries.Count == 0))
            throw new Fault("INPUT.MALFORMED", false, new Dictionary<string, object> { ["path"] = "request.entries" });
        var items = name == "record" ? entries!.Select((item, i) => (item, $"request.entries[{i}]")) : new[] { ((JsonNode?)request, "request") };
        foreach (var (item, path) in items)
        {
            var key = item is JsonObject entry && entry["key"]?.GetValueKind() == JsonValueKind.String ? (string?)entry["key"] : null;
            // The HTTP contract measures a key in UTF-16 code units, as .NET strings are.
            if (string.IsNullOrEmpty(key) || key.Length > 200)
                throw new Fault("INPUT.MALFORMED", false, new Dictionary<string, object> { ["path"] = path + ".key" });
            var at = (item as JsonObject)?["at"];
            // Read from its JSON text, since a value set in code as a long does not read back as a double.
            if (at?.GetValueKind() != JsonValueKind.Number || !double.TryParse(at.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var when)
                || when < 0 || when > 8_640_000_000_000_000 || when != Math.Floor(when))
                throw new Fault("INPUT.MALFORMED", false, new Dictionary<string, object> { ["path"] = path + ".at" });
        }
    }

    Fault Failure(int status, double? retryAfter, JsonObject? given, bool write)
    {
        var detail = new Dictionary<string, object> { ["status"] = status };
        string code;
        bool retryable;
        if (status >= 300 && status < 400) return new Fault("CONFIG.INVALID", false, detail);
        var named = given?["code"]?.GetValueKind() == JsonValueKind.String ? (string?)given["code"] : null;
        if (named is not null && Codes.Contains(named))
        {
            code = named;
            retryable = RetryableCodes.Contains(code) && given!["retryable"]?.GetValueKind() == JsonValueKind.True;
            // Graph validation names a field. Free-form server messages and proxy bodies may hold credentials.
            detail = new Dictionary<string, object>();
            var path = (given!["detail"] as JsonObject)?["path"];
            if (path?.GetValueKind() == JsonValueKind.String && (string)path! is var field && field.Length <= 512 && !field.Contains(token)
                && Regex.IsMatch(field, @"^request(?:\.[A-Za-z_][A-Za-z_0-9]*|\[[0-9]+\])*$"))
                detail["path"] = field;
        }
        else if (status is 429 or 503) (code, retryable) = ("GRAPH.UNAVAILABLE", true);
        else if (status is 502 or 504 || (status >= 200 && status < 300 && write)) (code, retryable) = ("TRANSPORT.INDETERMINATE", true);
        else
        {
            code = status switch { 401 => "AUTH.REJECTED", 403 => "AUTH.FORBIDDEN", 404 or 405 => "CONFIG.INVALID", 413 => "INPUT.TOO_LARGE", _ => "GRAPH.INTERNAL" };
            retryable = false;
        }
        if (retryable && retryAfter is double seconds) detail["retryAfter"] = seconds;
        return new Fault(code, retryable, detail);
    }

    /// <summary>Seconds from a Retry-After header, at most 900.</summary>
    static double? RetryAfter(HttpResponseMessage response)
    {
        if (!response.Headers.TryGetValues("Retry-After", out var values)) return null;
        var header = values.FirstOrDefault()?.Trim();
        if (string.IsNullOrEmpty(header)) return null;
        if (Regex.IsMatch(header, "^[0-9]+$"))
        {
            var digits = header.TrimStart('0');
            return Math.Min(900, digits.Length == 0 ? 0 : int.Parse(digits.Length > 4 ? digits[..4] : digits, CultureInfo.InvariantCulture));
        }
        if (DateTimeOffset.TryParse(header, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date))
            return Math.Min(900, Math.Max(0, (date - DateTimeOffset.UtcNow).TotalSeconds));
        return null;
    }

    static bool SafeInt(JsonNode? node) =>
        node?.GetValueKind() == JsonValueKind.Number && node.AsValue().TryGetValue(out long value) && Math.Abs(value) <= MaxSafe;

    static bool Decided(JsonNode? answer) =>
        answer is JsonObject row && (row["ok"]?.GetValueKind() == JsonValueKind.False
            ? row["reason"]?.GetValueKind() == JsonValueKind.String
            : row["ok"]?.GetValueKind() == JsonValueKind.True && row["value"] is JsonObject);

    static bool Answered(string name, JsonNode? answer, string? kind, int? entryCount)
    {
        if (answer is not JsonObject body) return answer is null && name == "lookup" && kind is "party" or "record";
        switch (name)
        {
            case "record":
                return body["results"] is JsonArray results && results.Count == entryCount && results.All(Decided);
            case "decide" or "forget":
                return Decided(body);
            case "lookup" when kind == "journey":
                return body["entries"] is JsonArray && body.ContainsKey("next") && (body["next"] is null || SafeInt(body["next"]));
            case "report":
                if (!SafeInt(body["asOf"]) || body["value"] is not JsonObject page) return false;
                return kind is not ("callbacks" or "texts")
                    || (page["rows"] is JsonArray && page.ContainsKey("next") && (page["next"] is null || page["next"]!.GetValueKind() == JsonValueKind.String));
            case "events":
                if (!Decided(body) || body["ok"]!.GetValueKind() == JsonValueKind.False)
                    return body["ok"]?.GetValueKind() == JsonValueKind.False && (string?)body["reason"] == "CURSOR_LOST";
                var events = (JsonObject)body["value"]!;
                return events["cursor"]?.GetValueKind() == JsonValueKind.String && events["more"]?.GetValueKind() is JsonValueKind.True or JsonValueKind.False && events["events"] is JsonArray;
            default:
                return true;
        }
    }

    /// <summary>An event of a type this client does not know becomes <c>Unrecognized</c>, with the original in <c>raw</c>.</summary>
    static JsonObject ReadEvents(JsonObject answer)
    {
        if (answer["value"] is not JsonObject page || page["events"] is not JsonArray events) return answer;
        for (var i = 0; i < events.Count; i++)
        {
            var raw = events[i];
            var row = raw as JsonObject;
            var type = row?["type"]?.GetValueKind() == JsonValueKind.String ? (string?)row["type"] : null;
            var known = row is not null && row["schemaVersion"]?.GetValueKind() == JsonValueKind.Number && (double)row["schemaVersion"]! == 1
                && type is not null && Events.Contains(type) && SafeInt(row["seq"]) && SafeInt(row["at"]) && row["data"] is JsonObject;
            if (!known)
                events[i] = new JsonObject { ["schemaVersion"] = 1, ["seq"] = row is not null && SafeInt(row["seq"]) ? (long)row["seq"]! : 0, ["type"] = "Unrecognized", ["raw"] = raw?.DeepClone() };
        }
        return answer;
    }

    static bool IsLoopbackName(string host) =>
        host == "localhost" || (IPAddress.TryParse(host.Trim('[', ']'), out var address) && IPAddress.IsLoopback(address));

    /// <summary>A value as Python's json.dumps writes it by default, with every character past ASCII escaped.</summary>
    static string PythonJson(object part)
    {
        if (part is not string text) return Convert.ToString(part, CultureInfo.InvariantCulture)!;
        var json = new StringBuilder("\"");
        foreach (var c in text)
        {
            json.Append(c switch
            {
                '"' => "\\\"",
                '\\' => "\\\\",
                '\n' => "\\n",
                '\r' => "\\r",
                '\t' => "\\t",
                '\b' => "\\b",
                '\f' => "\\f",
                _ when c < 0x20 || c > 0x7e => "\\u" + ((int)c).ToString("x4", CultureInfo.InvariantCulture),
                _ => c.ToString(),
            });
        }
        return json.Append('"').ToString();
    }

    /// <summary>A name-based UUID, version 5, as RFC 9562 sets it out.</summary>
    static string UuidV5(Guid space, string name)
    {
        var bytes = space.ToByteArray(bigEndian: true).Concat(Encoding.UTF8.GetBytes(name)).ToArray();
        var hash = SHA1.HashData(bytes);
        hash[6] = (byte)((hash[6] & 0x0f) | 0x50);
        hash[8] = (byte)((hash[8] & 0x3f) | 0x80);
        return new Guid(hash.AsSpan(0, 16), bigEndian: true).ToString();
    }

    sealed class InvalidOriginException : Exception { }
}
