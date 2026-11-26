// Run by test/dotnet.test.ts against its in-memory graph: dotnet run -- <graph> <lossy gateway>
using System;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using AccountGraph;

const long At = 1767225600000; // January 1, 2026 UTC
const string Token = "dotnet-test";
var (graphUrl, lossyUrl) = (args[0], args[1]);
using var graph = new Client(graphUrl, Token);

static void Check(bool condition, string what)
{
    if (!condition) throw new Exception("Failed: " + what);
}
static async Task<Fault> Refused(Func<Task> call)
{
    try { await call(); }
    catch (Fault fault) { return fault; }
    throw new Exception("Failed: a fault was expected");
}
static JsonObject Json(string text) => JsonNode.Parse(text)!.AsObject();

// The same keys as the Python client, for a row, a feed and characters past ASCII.
Check(Client.StableKey("lams.contacts", 42, 7) == "e09bf74f-4be8-5d3b-ab56-055a93095f54", "a stable key for a row");
Check(Client.StableKey("feed", "row-9", "r2") == "e6891483-53e8-5616-8b2b-7a9c4107a54b", "a stable key for a feed");
Check(Client.StableKey("crm<&>", "José", 0) == "922325a1-cde7-5eb7-8f8a-0355b5ed70ea", "a stable key past ASCII");

// A record refused and one accepted; then the same key again is a duplicate, and reused with other fields it is refused.
var sale = Json($$"""{"type":"conversion","key":"sale-1","subject":"contact:1","stage":"sale","value":12,"currency":"USD","at":{{At}}}""");
var reserved = Json($$"""{"type":"profile","key":"reserved","subject":"contact:1","facts":{"identifiers":["review:reserved"]},"at":{{At}}}""");
var first = (await graph.RecordAsync(new JsonObject { ["entries"] = new JsonArray(reserved, sale.DeepClone()) }))["results"]!.AsArray();
Check((bool)first[0]!["ok"]! == false && (string?)first[0]!["reason"] == "KIND_RESERVED", "a reserved kind is refused");
Check((bool)first[1]!["ok"]! && (bool)first[1]!["value"]!["duplicate"]! == false, "a conversion is recorded");
var other = sale.DeepClone().AsObject();
other["stage"] = "other";
var again = (await graph.RecordAsync(new JsonObject { ["entries"] = new JsonArray(sale.DeepClone(), other) }))["results"]!.AsArray();
Check((bool)again[0]!["value"]!["duplicate"]!, "the same entry again is a duplicate");
Check((string?)again[1]!["reason"] == "KEY_REUSED" && (string?)again[1]!["fields"]![0] == "stage", "a key reused with another stage is refused");
var found = await graph.LookupAsync(Json($$"""{"kind":"record","type":"conversion","key":"sale-1","at":{{At}}}"""));
Check((string?)found!["subject"] == "contact:1" && (string?)found["stage"] == "sale", "the recorded conversion is found");

// Faults: a malformed report, and a wrong token, neither to be tried again.
var malformed = await Refused(() => graph.ReportAsync(Json($$"""{"kind":"pipeline","at":{{At}},"days":0}""")));
Check(malformed.Code == "INPUT.MALFORMED" && !malformed.Retryable, "a malformed report");
using (var stranger = new Client(graphUrl, "wrong-token"))
{
    var denied = await Refused(() => stranger.EventsAsync(Json("""{"after":null,"limit":1}""")));
    Check(denied.Code == "AUTH.REJECTED" && !denied.Retryable, "a wrong token");
}
var noKey = await Refused(() => graph.RecordAsync(Json($$"""{"entries":[{"type":"arrival","subject":"visitor:x","source":"website","at":{{At}}}]}""")));
Check(noKey.Code == "INPUT.MALFORMED" && (string)noKey.Detail["path"] == "request.entries[0].key", "an entry without a key is refused before it is sent");
var bad = await Refused(() => Task.FromResult(new Client("http://198.51.100.7:8080", Token)));
Check(bad.Code == "CONFIG.INVALID", "plain http to another machine");

// Decide, take it back, forget.
var merge = Json($$"""{"key":"merge-1","at":{{At}},"by":"desk","action":"merge","pairs":[{"a":"contact:a","b":"contact:b"}]}""");
Check((int)(await graph.DecideAsync(merge))["value"]!["recorded"]! == 1, "a merge is recorded");
var undo = merge.DeepClone().AsObject();
(undo["key"], undo["action"], undo["at"]) = ("undo-1", "unmerge", At + 1);
Check((int)(await graph.DecideAsync(undo))["value"]!["recorded"]! == 1, "an unmerge is recorded");
Check((bool)(await graph.ForgetAsync(Json($$"""{"key":"forget-1","at":{{At + 1}},"by":"desk","subjects":["contact:1"],"platforms":"report"}""")))["ok"]!, "a subject is forgotten");
Check(await graph.LookupAsync(Json($$"""{"kind":"record","type":"conversion","key":"sale-1","at":{{At + 1}}}""")) is null, "a forgotten record is not found");

// The first answer is lost after the graph wrote it. The retry carries the same key, so it is a duplicate.
using (var lossy = new Client(lossyUrl, Token, retries: 1))
{
    var replay = (await lossy.RecordAsync(Json($$"""{"entries":[{"type":"arrival","key":"retry-visit","subject":"visitor:retry","source":"website","at":{{At}}}]}""")))["results"]![0]!;
    Check((bool)replay["ok"]! && (bool)replay["value"]!["duplicate"]!, "a retry after a lost answer is a duplicate");
}

// Events, a page at a time, and a cursor from another history.
var events = (await graph.EventsAsync(Json("""{"after":null,"limit":500}""")))["value"]!["events"]!.AsArray();
Check(events.Count > 0 && events.All(each => (string?)each!["type"] != "Unrecognized"), "every event is of a known type");
var lost = await graph.EventsAsync(Json("""{"after":"another-history.1","limit":1}"""));
Check((bool)lost["ok"]! == false && (string?)lost["reason"] == "CURSOR_LOST", "a cursor from another history");

// Pages: 201 visits are two journey pages, 51 texts and 51 missed calls are two report pages each, and events one at a time are every event.
var visits = Enumerable.Range(0, 201).Select(i => (JsonNode)Json($$"""{"type":"arrival","key":"visit-{{i}}","subject":"visitor:pages","source":"website","at":{{At + i}}}""")).ToList();
var texts = Enumerable.Range(0, 51).Select(i => (JsonNode)Json($$"""{"type":"text","direction":"inbound","from":"+120255501{{i:00}}","to":"+12025550199","at":{{At + i}},"key":"text-{{i}}"}""")).ToList();
var calls = Enumerable.Range(0, 51).Select(i => (JsonNode)Json($$$"""{"type":"call","direction":"inbound","from":"+120255501{{{i:00}}}","to":"+12025550199","at":{{{At + i}}},"key":"missed-{{{i}}}","result":{"answered":false}}""")).ToList();
foreach (var batch in new[] { visits.Take(100), visits.Skip(100).Take(100), visits.Skip(200), texts, calls })
{
    var results = (await graph.RecordAsync(new JsonObject { ["entries"] = new JsonArray(batch.Select(each => each.DeepClone()).ToArray()) }))["results"]!.AsArray();
    Check(results.All(each => (bool)each!["ok"]!), "a batch for the pages is recorded");
}
var journeys = await graph.JourneyPagesAsync(Json("""{"kind":"journey","subject":"visitor:pages"}""")).ToListAsync();
Check(journeys.Select(page => page["entries"]!.AsArray().Count).SequenceEqual(new[] { 200, 1 }) && journeys[^1]["next"] is null, "a journey in two pages");
Check(journeys.SelectMany(page => page["entries"]!.AsArray().Select(entry => (long)entry!["at"]!)).Order().SequenceEqual(Enumerable.Range(0, 201).Select(i => At + i)), "every visit once");
var report = Json($$"""{"window":{"from":"2026-01-01","to":"2026-01-01","timeZone":"UTC"},"at":{{At + 60_000}}}""");
foreach (var (kind, field, entries) in new[] { ("texts", "text", texts), ("callbacks", "call", calls) })
{
    var query = report.DeepClone().AsObject();
    query["kind"] = kind;
    var pages = await graph.ReportPagesAsync(query).ToListAsync();
    Check(pages.Select(page => page["value"]!["rows"]!.AsArray().Count).SequenceEqual(new[] { 50, 1 }) && pages[^1]["value"]!["next"] is null, $"{kind} in two pages");
    Check(pages.SelectMany(page => page["value"]!["rows"]!.AsArray().Select(row => (string?)row![field])).SequenceEqual(entries.Select(entry => (string?)entry["key"])), $"every {kind} row once, in order");
}
var malformedKind = await Refused(async () => await graph.ReportPagesAsync(Json("""{"kind":"pipeline"}""")).ToListAsync());
Check(malformedKind.Code == "INPUT.MALFORMED" && (string)malformedKind.Detail["path"] == "request.kind", "only texts and callbacks are paged");
var everything = (await graph.EventsAsync(Json("""{"after":null,"limit":500}""")))["value"]!["events"]!.AsArray().Select(each => each!.ToJsonString()).ToList();
var eventPages = await graph.EventPagesAsync(Json("""{"after":null,"limit":1}""")).ToListAsync();
Check(eventPages.SkipLast(1).All(page => (bool)page["value"]!["more"]!) && !(bool)eventPages[^1]["value"]!["more"]!, "every page but the last says more");
Check(eventPages.SelectMany(page => page["value"]!["events"]!.AsArray().Select(each => each!.ToJsonString())).SequenceEqual(everything), "events one at a time are every event");
var lostPages = await graph.EventPagesAsync(Json("""{"after":"another-history.1","limit":1}""")).ToListAsync();
Check(lostPages.Count == 1 && (string?)lostPages[0]["reason"] == "CURSOR_LOST", "a lost cursor is one page");

Console.WriteLine("ok");
