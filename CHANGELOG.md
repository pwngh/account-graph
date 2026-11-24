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
- `GET /disputes` and the Health view list pairs that systems have contradicted each other about three times or more (`disputes`, `verdicts`).
- `reviewed({ exclude: 'system:' })` leaves out what systems decided.
- The reviewer screen labels system decisions, filters and pages the record, and draws every kept-apart pair among the subjects shown.
- `Rule.group` makes kinds that come together count once: of the reasons in a group, only the strongest adds to the score (`Reason.group`, `Reason.counted`). The default policy has none.
- `examples/household.json` is a policy for contacts entered by staff; `docs/presets.md` explains it.
- Every advertising answer is kept (`consentHistory`, `GET /consent`); `POST /consent` takes `at` and `source`, and the newest by `at` stands.
- `GET /audit` names the newest decision and its hash (`head`); `AUDIT_HEAD_HOURS` posts it to `ALERT_WEBHOOK`.
- `STAFF_NETWORKS` (`HandlerOptions.staffNetworks`) and `POST /staff-link` (`staffLink`) drop visits and page events of your own staff; `GET /stats` counts them as `staff`.
- `Call` takes `answered`, `voicemail` and `waited`; `POST /call/result` (`recordCallResult`) reports how a call went, before or after the call. A call that was not answered is missed and never an outcome.
- `CALL_RESULTS=expected` (`CallOptions.results`) holds a call, uncounted and unsent, until its result says a person answered; after `CALL_RESULT_WAIT` minutes it reads as unknown.
- `POST /call` takes calls you place (`direction: "outbound"`); `followUp` and `GET /call` say whether a missed call was returned, after how long, and how often it was tried.
- The reviewer screen's Calls view lists missed calls not returned, how calls went by hour and weekday, and coverage (`GET /calls`, `GET /calls/summary`, `openCalls`, `callSummary`).
- `createOps` notices quiet feeds (`QUIET_TOUCHES_HOURS` and its siblings) and missed callers from paid arrivals not rung back within `RETURN_HOURS`; each is alerted once. An alert that is not delivered is kept and tried again.
- `GET /ops` and the Health view show feeds, jobs, undelivered alerts and the outbox; `POST /alerts/test` sends a test alert.
- `outbox.hold`, `release` and `withdraw` keep back, send and take back an outcome; a job can be `held`.
- `ReportRow.missed` counts missed calls per campaign; calls are kept with their results (`keptCall`, `callResult`).
- `Outcome.tags`, `Call.tags` and `Channel.tags` carry facts; `report({ by })` and `GET /report?by=` break each line down by `touch.<name>`, `outcome.<name>`, `hour` or `weekday`, with `(not recorded)` always a line of its own.
- `ReportRow` has `costPerOutcome` and `returnOnCost`, over the campaign's own outcomes on days with cost data, with `costDays`, `missingDays` and `thin`; both are null below half the days. The total leaves out thin campaigns (`Report.leftOut`).
- The report counts `people` beside outcomes, says how long each step takes (`StageCount.delay`), and marks a period that is too recent (`Report.filling`).
- Every value an outcome has had is kept (`values`, `GET /outcome`); the report shows what outcomes were first worth and are worth now, by campaign (`ReportRow.worth`) and by month of first record (`Report.months`).
- `followed` and `GET /followed` count who reached a step within some days of a call, by talk time, answer, language and whether a miss was returned, from a landmark a day after the miss; rows of fewer than 20 people are left out.
- `journey`, `GET /journey` and the reviewer screen's Journey view show everything recorded about one person in order, with why each subject is them.
- The Channels view has a Break down by selector; the Calls view shows tags.

### Changed

- Breaking: `fold` takes its options as one object.
- The Channels view shows `(not recorded)` where no cost was reported, marks missing days, and withholds a cost per outcome that too little data supports.
- Breaking: `Store` has `ops`, an `OpsStore`.
- Breaking: `OutboxStore` has `swap` and `standing` in place of `save`; a worker's pass no longer overwrites a change made since it claimed a job.
- Twilio's `busy`, `no-answer`, `failed` and `canceled` calls are recorded as not answered.
- `prune` also deletes advertising answers that no longer stand.
- Breaking: `GET /decisions` answers `{ decisions, next, total }`, newest first, a page at a time (`decisionPage`).
- A name that starts with `system:` is refused with the reviewer token.

- Breaking: in `defaultPolicy`, `phone` and `voip` thin as more subjects share them (dilution 1), and `phone`, `email` and `voip` link nothing past 10 subjects. Run `rebuild`, or keep the earlier rules with `POLICY`.
- Breaking: `Flow` and `POST /transfer` need an `id`. The same flow sent twice is counted once and answers `duplicate: true` (`Transferred`); the same id with other details is refused. A `Store` needs `flowOf`.
- Breaking: `GET /verify` answers `{ changes, policy }`, not a list.
- A server whose database holds an identifier of a kind the policy does not name refuses to start.

### Fixed

- `attribute` and `report` reach nothing of a subject kept apart from the one asked about, through a third subject either.
- `recordCall` ties no call to a visitor a reviewer kept apart from the caller; the call is filed under its number.
- `CallOptions.numbers` with a key that is not a phone number no longer stops calls to the other numbers.
- A request that holds a NUL, half of a character, or bytes that are not UTF-8 answers 400, not 500, and is not stored. Two subjects that differed only in such text were kept as one.
- `observe`, `touch`, `transfer`, `prune` and `outbox.record` take whole milliseconds only, on both stores; `GET /attribute` and `GET /clusters` no longer answer 500 to a malformed number.
- `/collect` records no touch for an arrival whose fields are all empty.
- `fill` clears `ag_landing` in a form it filled before the visitor opted out of advertising.
