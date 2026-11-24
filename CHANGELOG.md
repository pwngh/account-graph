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
- `POST /identify` takes a subject's device, email, phone, address and IP as plain values, hashes and checks them, and answers `{ changes, identifiers, notes }`.
- `createAddressVerifier` checks a US postal address with Smarty; `addressIdentifier` keeps one confirmed to the door as the `address` kind (0.6).
- `createLineTypeLookup` asks Twilio what kind of line a number is; `phoneOfType` records a throwaway number as the `voip` kind (0.5) and a switchboard as nothing. `CallOptions.lineType` applies the same to callers.
- With `cookie` on, `/collect` keeps the id a page quotes on the visitor the server's cookie names.
- `/collect` and `/event` drop visits whose user agent names a crawler, previewer or uptime check (`bots` in `GET /stats`), and note a visit's `place` when the address lookup gives one.
- `collect.js` adds `ag_device` and `ag_landing` to forms marked `data-ag-fields`, or to every form with `?forms=all` (`fill`, `fields`, `accountGraph.fields()`).
- `/collect` records no touch for an arrival whose only source is a referrer among `origins`: a visitor moving between your own sites.
- `compose.yaml` passes every server setting through, and switches on page events, a tracking number and signed links for the example site.
- `ignore` records no decision when the identifier is already in the state asked for.
- The reviewer screen has a view per address (`/review#/accounts/…`, `/review#/channels/…`), keyboard-operable pictures, and tables that scroll inside their own box.
- `GET /pulse` answers `{ version }` with an `etag`, and 304 until something is written (`graph.version`); the reviewer screen reads a view again only then.
- `GET /report` names the `timeZone` its days are in.
- `POLICY` or `POLICY_FILE` lays your weights, caps and half-lives over the default policy (`policyFrom`, `policyProblems`); a problem stops the server at start.
- `graph.policy()`, `GET /policy`, `GET /stats` and the reviewer screen's Health view say when the running policy is not the one the stored clusters were built with; `POST /rebuild` recomputes them.
- `POST /separate` and `POST /join` take `{ source, pairs }` with the service token: one transaction, one decision each by `system:<source>` (`separateAll`, `joinAll`).
- `GET /disputes` and the Health view list pairs that systems have reversed three times or more (`disputes`, `verdicts`).
- `reviewed({ exclude: 'system:' })` leaves out what systems decided.
- The reviewer screen labels system decisions, filters and pages the record, and draws every kept-apart pair among the subjects shown.

### Changed

- Breaking: `GET /decisions` answers `{ decisions, next, total }`, newest first, a page at a time (`decisionPage`).
- A name that starts with `system:` is refused with the reviewer token.

- Breaking: in `defaultPolicy`, `phone` and `voip` thin as more subjects share them (dilution 1), and `phone`, `email` and `voip` link nothing past 10 subjects. Run `rebuild`, or keep the earlier rules with `POLICY`.
- Breaking: `GET /verify` answers `{ changes, policy }`, not a list.
- A server whose database holds an identifier of a kind the policy does not name refuses to start.

### Fixed

- `recordCall` ties no call to a visitor a reviewer kept apart from the caller; the call is filed under its number.
- `CallOptions.numbers` with a key that is not a phone number no longer stops calls to the other numbers.
- `/collect` records no touch for an arrival whose fields are all empty.
- `fill` clears `ag_landing` in a form it filled before the visitor opted out of advertising.
