# Changelog

## Unreleased (0.1.0)

### Added

- `createGraph(store, policy)` links subjects that share identifiers; every link carries a score and the reasons for it.
- `observe` returns the subjects whose cluster moved; `links`, `cluster`, and `history` read the graph.
- `defaultPolicy` sets a weight, cap, and half-life per identifier kind; `docs/deciding.md` has the table.
- A link below `policy.bridge` (default 0.97) cannot alone join two groups of two or more subjects into one cluster.
- `separate`, `join`, and `ignore` record reviewer decisions; `decisions` lists them and `audit` checks their hash chain.
- `asOf(time)` rebuilds the graph from what had been recorded by then; `prune(before)` deletes older sightings.
- `forget(subject)` deletes a subject with its sightings, edges, touches, flows, consent, and unsent conversions.
- `transfer`, `flows`, `collusion`, and `rings` report value moving between subjects, with the identity tie between them.
- `touch` and `attribute` trace a conversion to its touches; a touch is credited at `policy.same` confidence or above.
- `createOutbox` records an outcome once and sends it with leases, backoff, and per-event retry; `restate` changes a sent value.
- `googleAds`, `meta`, `microsoftAds`, and `tiktok` are outbox targets; `outbox.list` and `outbox.retry` show and requeue failed jobs.
- `consent` and the Global Privacy Control signal stop advertising data from being kept or sent.
- `createMemoryStore` and `createPostgresStore` pass one shared suite; `verify` compares stored clusters with a full recompute.
- `createBatcher` writes observations that arrive together in one transaction.
- `createHandler` serves `/collect`, the reviewer screen at `/review`, and token-protected routes; `reviewToken` opens only the review routes.
- `npm start` runs the server from environment variables (`serve`, `configFrom`); `docs/operations.md` lists them.
- `GET /collect.js` is a script tag that reports to the server it was loaded from.
- `PostgresStore.migrate` applies numbered upgrades once, in order (`upgrades`).
- `/collect` is limited per address (`HandlerOptions.limit`, default 120 a minute and 60 at once, answers `429`).
- `GET /health` answers once the database does; `GET /stats` and `counts` report what the graph holds.
- `collect` reports a browser visit; with `cookie: true` the server keeps the device id in an `HttpOnly` cookie.
- `createFingerprintVerifier`, `hardwareId`, `createMaxMindLookup`, `createGoogleTokens`, and `createMicrosoftTokens` are the integration entry points.
- `measure` and `fit` compute identifier weights from reviewed pairs; `reviewed` turns reviewer decisions into those pairs.
- `clusters`, `search`, and `recent` are the reviewer's queue: largest clusters, subjects by prefix, newest cluster changes.
