# AccountGraph for .NET

Call a running account-graph server from .NET 10. The client uses only the base class library.

## Install

Reference the project from your application's project file.

```xml
<ItemGroup>
  <ProjectReference Include="path/to/account-graph/clients/dotnet/AccountGraph/AccountGraph.csproj" />
</ItemGroup>
```

## Record an entry

Give every write a key and an epoch-millisecond timestamp from your system. Keep the original fields so the write can be sent again. `Client.StableKey(source, rowId, revision)` returns a UUID made from all three, the same one the Python client makes. A new revision makes a new key.

```csharp
using System.Text.Json.Nodes;
using AccountGraph;

using var graph = new Client(Environment.GetEnvironmentVariable("GRAPH_URL")!, Environment.GetEnvironmentVariable("GRAPH_TOKEN")!);
var visit = new JsonObject
{
    ["type"] = "arrival",
    ["key"] = Client.StableKey("visits", 7, 1),
    ["subject"] = "visitor:7",
    ["source"] = "website",
    ["at"] = 1795460000000,
};
try
{
    var result = (await graph.RecordAsync(new JsonObject { ["entries"] = new JsonArray(visit) }))["results"]![0]!;
    if (!(bool)result["ok"]!) Console.WriteLine($"Refused: {result["reason"]}");
}
catch (Fault fault) when (fault.Retryable)
{
    // Keep the entry and send it again later with the same key.
}
```

## The other calls

`DecideAsync`, `ForgetAsync`, `LookupAsync`, `ReportAsync` and `EventsAsync` take the request object the [HTTP API](../../docs/http.md) describes. `LookupAsync` answers null where a party or record lookup finds nothing.

## Pages

`EventPagesAsync` follows the events cursor until `more` is false, or until the cursor is lost. `ReportPagesAsync` pages a `texts` or `callbacks` report. `JourneyPagesAsync` pages a journey by `before`. Each is an `IAsyncEnumerable<JsonObject>`.

```csharp
await foreach (var page in graph.EventPagesAsync(new JsonObject { ["after"] = savedCursor, ["limit"] = 100 }))
{
    if (!(bool)page["ok"]!) break; // CURSOR_LOST: start again from the beginning.
    // Handle page["value"]["events"], then save page["value"]["cursor"].
}
```

## Outbox

Reference `clients/dotnet/AccountGraph.Outbox` as well to keep entries in a SQLite file until the graph has them. It uses the `Microsoft.Data.Sqlite` package.

```csharp
using var queue = new Outbox("account-graph-outbox.sqlite");
var sale = queue.Enqueue("order-7", saleEntry);
queue.Enqueue("order-7", refundEntry);                      // sent after the sale, in order
queue.Enqueue("invoice-12", paymentEntry, dependsOn: sale); // held until the sale is sent
await queue.FlushAsync(graph);                              // run it on a timer from one or many processes
```

`Enqueue` checks the entry and keeps its key, time and fields, so a resend is the same request. `FlushAsync` claims each ready row for `leaseSeconds`, which should be longer than the client's `totalTimeout`, then sends it. A row the graph refuses is `refused`, a row it can never take is `failed`, and a row that depends on either is `blocked` until its prerequisite is sent. A call fault ends the pass with the row still pending.

## Rules the client keeps

- Plain `http` is allowed only to this machine, checked again on the connected address before the token is sent.
- Redirects are not followed, so the token never goes to another address.
- A record with more than 100 entries, a body over 1,000,000 bytes, or a write without a key or a whole-number `at` is refused before it is sent.
- `GRAPH.UNAVAILABLE` and `TRANSPORT.INDETERMINATE` are tried again within `totalTimeout`, with doubling waits and `Retry-After` up to 15 minutes.
- An event of a type the client does not know comes back as `Unrecognized`, with the original in `raw`.

## Test

`test/dotnet.test.ts` starts an in-memory graph and runs `clients/dotnet/RealGraph` against it.

```sh
node --test test/dotnet.test.ts
```
