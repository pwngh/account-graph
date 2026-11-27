# .NET

Use `AccountGraph.Client` to call a running graph from .NET 10. Reference the project in `clients/dotnet/AccountGraph` from the checkout. The client uses only the base class library. Requests and answers are `System.Text.Json` objects with the same fields as the HTTP API. See [Installation and examples](../clients/dotnet/README.md).

`RecordAsync`, `DecideAsync` and `ForgetAsync` keep a refused write apart from a call fault. A refused write is an answer with `ok: false` and a reason. A call fault is a `Fault` with a code. Retry a `Fault` only when `Retryable` is true, with the same key and timestamp. The client already does this up to `retries` times. See [HTTP faults and retry rules](http.md#faults).

`Client.StableKey(source, rowId, revision)` gives the same key as the Python client's `stable_key`, so a row sent from either gets one key.

`EventPagesAsync`, `ReportPagesAsync` and `JourneyPagesAsync` follow each cursor to the last page, and stop with `GRAPH.INTERNAL` if the server hands back a cursor already followed.

`AccountGraph.Outbox`, a separate project in `clients/dotnet/AccountGraph.Outbox`, keeps entries in a SQLite file until the graph has them. It sends each record's entries in order, and several processes can share one file. A refused entry is set aside with its reason and holds back only the entries that depend on it. It has the same table and rules as the Python outbox, and needs the `Microsoft.Data.Sqlite` package. The client itself needs none.
