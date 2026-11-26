# .NET

Use `AccountGraph.Client` to call a running graph from .NET 10. Reference the project in `clients/dotnet/AccountGraph` from the checkout. The client uses only the base class library. Requests and answers are `System.Text.Json` objects with the same fields as the HTTP API. See [Installation and examples](../clients/dotnet/README.md).

`RecordAsync`, `DecideAsync` and `ForgetAsync` keep a refused write apart from a call fault. A refused write is an answer with `ok: false` and a reason. A call fault is a `Fault` with a code. Retry a `Fault` only when `Retryable` is true, with the same key and timestamp. The client already does this up to `retries` times. See [HTTP faults and retry rules](http.md#faults).

`Client.StableKey(source, rowId, revision)` gives the same key as the Python client's `stable_key`, so a row sent from either gets one key.

The client has no outbox and no page helpers yet. Follow `next` and `cursor` yourself.
