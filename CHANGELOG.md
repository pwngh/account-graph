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
- `outcome` and `restate` record what a subject did and change its value; `POST /convert` counts an outcome with or without an ad platform.
- `spend` records campaign cost per day; `googleCosts`, `metaCosts`, and `costsFromCsv` read it, and `POST /costs` takes it.
- `report({ from, to, timeZone })` sets each campaign's cost beside the outcomes credited to it; `GET /report` and the reviewer screen's Channels view show it.
- `Touch` carries `campaignId`, `adGroupId`, `adId`, `term`, `content`, and `custom`; `collect.js?params=` names the custom parameters to keep.
- `POST /event` records a page event named in `HandlerOptions.events` as an outcome, once a day per browser unless it carries an id.
- `collect.js` reports taps on `tel:` links as `phone_click` and clicks on `data-ag-event` elements; `accountGraph.event(name)` reports from page code (`event`, `watch`).
- `recordCall` ties a phone call to the one visitor who tapped its number just before, else files it under the number's channel; `POST /call` takes one.
- `POST /calls/twilio` takes Twilio's status callbacks after checking the signature (`fromTwilio`, `twilioCall`).
- `holders(identifiers)` lists every subject seen with an identifier.
- The `dial` kind (0.92) links a caller to the visitor who tapped; the `dialed` kind is a note that links nothing.
- `knownLink(url, subject, { secret })` and `POST /link` make an address that names the person it is sent to; a visit through one ties up to three browsers to that person (`link` kind, 0.92) and notes every opening (`opened` kind).
- `collect.js?domains=` carries a visitor along links to the named sites: `POST /carry` issues a one-hour token bound to the browser, and `/collect` accepts it as `carried` (`carry` kind, 0.95, per receiving site).
- `HandlerOptions.trustProxy` takes a number of proxies and reads the visitor's address that many entries from the end of `x-forwarded-for` (`TRUST_PROXY=2`). Breaking: `true` now reads the last entry, not the first.
- `signToken` and `readToken` sign and check short tokens with an expiry and a purpose (`HandlerOptions.linkSecret`, `LINK_SECRET`).
- `HandlerOptions.stages` (`STAGES`) names your steps with a value, currency and action each; `withStage` fills an outcome from its step, and `GET /report` lists `steps` in that order.
- `OutboxOptions.onFailed` hears each pass's jobs that failed for good.
- `createAlerter` posts `{ text }` to a webhook at most once per subject per ten minutes; `ALERT_WEBHOOK` reports failed conversions, an outbox that cannot run, and costs that cannot be read.
