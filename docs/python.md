# Python

Use `AccountGraph` to call a running graph from Python 3.9 or later. Install the package from `clients/python` in the checkout. The client uses the standard library and accepts the same JSON fields as the HTTP API. [Installation and examples](../clients/python/README.md)

`record`, `decide` and `forget` preserve the distinction between a refused write and a call fault. Keep your key and timestamp with the original record so an uncertain write can be sent again. The optional SQLite outbox checks entries as it queues them, keeps pending entries across restarts and sends each record’s entries in order. Several workers can share it. A refused or malformed entry is set aside with its reason and holds back only the entries that depend on it. [HTTP faults and retry rules](http.md#faults)

Use `event_pages`, `report_pages` and `journey_pages` to follow each cursor. The client README shows checkpoint handling, outbox delivery and an HTTP Google Cloud Function that records website visits and offline sales. [Python client guide](../clients/python/README.md)
