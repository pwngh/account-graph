# HTTP API

The server speaks JSON over plain HTTP. Your services authenticate with a token, and browsers call the routes that need none.

```sh
curl -X POST https://graph.example.org/observe \
  -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"subject":"account:42","identifiers":["device:9f3c"],"at":1795460000000,"event":"login"}'
```

```json
[{ "subject": "account:42", "from": "account:42", "to": "account:17" }]
```

The response lists cluster changes. This login joined `account:42` to the cluster of `account:17`. An empty list means the clusters stayed the same.

## Authentication

Send a token in the `authorization` header as `Bearer …`.

| Token | Set in | Opens |
| --- | --- | --- |
| Service | `GRAPH_TOKEN` | Every route. Use it from your own backend. |
| Reviewer | `REVIEW_TOKENS` | The routes of the reviewer screen. Decisions are signed with the reviewer's name. |

A wrong or missing token gets 401. A reviewer's token on a service-only route gets 403.

## Identifiers

[`POST /identify`](identify.md) accepts a plain email, phone and address, then hashes and checks them. To write identifiers yourself, use `/observe`.

An identifier is written `kind:value`. A kind missing from the policy gets 400. [Matching](deciding.md) lists the weight of each kind.

| Kind | Value |
| --- | --- |
| `device` | The `ag_device` cookie set by the script tag, read from the visitor's request. |
| `email`, `phone` | A SHA-256 hash of the trimmed, lowercased email, or of the phone number in E.164 form. Hash the same way every time. `/identify` also removes dots and any `+suffix` from Gmail addresses before hashing. |
| `hardware` | The hashed machine id reported by your desktop client. |
| `passkey` | A passkey's credential id, after your server verified the sign-in. |
| `payment` | A card or bank token from your payment provider, in place of the number. |
| `ip` | The address your server received the request from. |
| `fingerprint`, `canvas`, `ga` | Recorded by `/collect`, which confirms a fingerprint first. |

## Routes without a token

| Route | Description |
| --- | --- |
| `POST /collect` | Records one browser visit. Requires an origin in `ORIGINS`, and is rate limited per address. Answers 204. |
| `POST /number` | Assigns the visitor a pool number: `{ device }`. Same origins and limit as `/collect`. Answers `{ number, until, lasts }`, or 204 when none is available to them. Requires `POOL_NUMBERS`. |
| `POST /event` | Records a page event: `{ device, event, id?, number? }`. Same origins and limit as `/collect`. Accepts only names in `EVENTS`. Answers 204. |
| `POST /carry` | Answers `{ token }`, which the script tag adds to links to your other sites. Same origins and limit as `/collect`. Requires `LINK_SECRET`. |
| `POST /calls/twilio` | Receives Twilio's status callback for a call and checks Twilio's signature. Requires Twilio settings. |
| `GET /collect.js` | The script tag that posts to `/collect` and `/event`. |
| `GET /fingerprint.js` | Fingerprint helpers, loaded by the script on request. |
| `GET /review` | The reviewer screen. Its data requires a token. |
| `GET /health` | `{"ok":true}` once the database answers. |

## Routes for reviewers and services

### Subjects and clusters

| Route | Description |
| --- | --- |
| `GET /subject?subject=` | One subject: cluster, links, separations and their authors, flows, rings, newest sightings. |
| `GET /cluster?subject=` | The subject's cluster: `{ id, members, oversized }`, or `null`. |
| `GET /links?subject=` | Every subject linked to this one, with score and reasons. |
| `GET /between?a=&b=` | What two subjects share at any strength, excluding reviewer marks: `{ known, joined, apart, score, reasons, idle }`. `idle` lists shared identifiers that are muted or over their cap. |
| `GET /history?subject=` | Every sighting of the subject, oldest first. |
| `GET /journey?subject=&before=` | Everything recorded about the subject's person, oldest first, newest 200: `{ entries, ties, next, more }`. Pass `next` as `before` for earlier entries. |
| `GET /clusters?offset=` | The largest clusters, 50 at a time. |
| `GET /search?q=` | Subjects whose id starts with the text. |
| `POST /find` | `{ text }`: a full email or phone number, looked up by hash; the start of a subject's id; or, with no such id, a full ad click id. Answers `{ by, subjects }`, at most 20. The body keeps the text out of address logs. |
| `GET /recent` | The newest cluster changes. |
| `GET /undecided?limit=` | Pairs that are related and not joined, strongest first: `{ pairs, total, seen }`. Covers the subjects of the newest 10,000 sightings, counted in `seen`. `limit` is at most 500. |
| `GET /flows?subject=` | Subjects that exchanged value with this one, and the identity link to each. |
| `GET /collusion?subject=` | Counterparties linked by identity, with three or more flows. |
| `GET /rings?subject=` | Value that left the subject and came back through others. |

### Decisions

| Route | Description |
| --- | --- |
| `POST /separate` | `{ a, b, separated?, by?, reason? }`. Separates two subjects. `separated: false` withdraws the separation. |
| `POST /join` | `{ a, b, by?, reason?, mark? }`. Records that two subjects are one person. With `mark: true` the answer is `{ moved, mark }`, where `mark` is the identifier to `/ignore` to undo the join. |
| `POST /ignore` | `{ identifier, ignored?, by?, reason? }`. Mutes one identifier, or with `ignored: false` restores it. |
| `POST /forget` | `{ subject, by?, reason?, ads? }`. Deletes a subject and everything recorded about it. With `ads: true` the answer is `{ changes, sent }`, where `sent` lists [conversions that reached an ad platform](privacy.md#data-at-ad-platforms). |
| `POST /foresee` | Previews a decision without making it: `{ action: "join", a, b }`, `{ action: "separate", a, b, separated? }` or `{ action: "ignore", identifier, ignored? }`. Answers `{ moved, before, after }`, with the affected clusters as `{ id, size }`. |
| `GET /decisions?limit=&before=&author=` | The audit log, newest first, 50 at a time: `{ decisions, next, total }`. Pass `next` as `before` for the next page. `author` is `people`, `system`, or one name. |
| `GET /disputes` | Pairs whose reports from systems switched between separated and joined (or withdrawn) three times or more. |
| `GET /audit` | Verifies the audit log: `{ sound, head }`, with `brokenAt` when it was altered. `head` is the newest entry's `seq` and `hash`. |

`/separate`, `/join`, `/ignore` and `/forget` answer with the subjects whose cluster changed. With the service token, `/separate` and `/join` also accept a list from one of your systems. See [decisions from your own systems](deciding.md#decisions-from-your-own-systems).

The same four routes accept `seen`: the number of the newest decision at the time you looked, from `head.seq` of `GET /audit`. If a newer decision names the same subject or identifier, yours gets 409. Omitting `seen` skips the check, as do undos (`ignored: false`, `separated: false`) and lists from a system.

Send `by` only with the service token. A reviewer's decision carries the name of their token, and any other name is rejected.

### Outcomes, calls and reports

| Route | Description |
| --- | --- |
| `GET /consent?subject=` | Every answer the subject gave about advertising. The one that applies comes first. |
| `GET /outcome?id=` | One outcome with every value it has had, or `null`. |
| `GET /board?days=` | People by the furthest step they reached, unreturned missed calls first: `{ columns, unplaced }`, each column with `people`, `fresh`, `late`, `done` and its `rows`. See [the report](report.md#board). |
| `GET /followed?from=&to=&tz=&step=&days=` | People who reached a step within some days of a call. See [the report](report.md#outcomes-after-a-call). |
| `GET /call?id=` | One call with its state and, when missed, its follow-up, or `null`. |
| `GET /calls?from=&to=&tz=&after=` | Unreturned missed calls, oldest first, 50 at a time: `{ from, to, timeZone, at, calls, next }`. Pass `next` as `after`. |
| `GET /calls/summary?from=&to=&tz=` | Inbound calls by result, hour and weekday, and how many were attributed. |
| `GET /report?from=&to=&tz=&by=&per=` | The cost and results of each campaign between two days. `steps` names the steps in your order, and `timeZone` the zone of the days. See [the report](report.md). |
| `GET /conversions?state=` | The 100 jobs in one state most recently due: `held`, `pending`, `sent`, `skipped`, or `failed`, without the hashed email and phone. `held` waits for a call's result. |
| `POST /retry` | `{ transactionId, target? }`. Queues its failed and skipped jobs again, optionally for one platform. |

### Status

| Route | Description |
| --- | --- |
| `GET /me` | `{ reviewer }`: the token's owner, or `null` for the service token. |
| `GET /policy` | The running rules by kind, the hash the stored clusters were built with, whether a rebuild is `due`, and which kinds were `changed` from the default. |
| `GET /ops` | Server operations: `{ feeds, jobs, undelivered, alerts, at, pool, outbox }`. |
| `GET /pulse` | `{ version }`, with an `etag`. Send it as `if-none-match` to get 304 until the next write. |

## Routes for services

### Identity and consent

| Route | Description |
| --- | --- |
| `POST /identify` | Identifies a subject from plain facts: `{ subject, device?, email?, phone?, ip?, address?, name?, dob?, identifiers?, at?, event? }`. Answers `{ changes, identifiers, notes }`. See [identify](identify.md). |
| `POST /observe` | One observation, or a list: `{ subject, identifiers, at, event? }`. Answers with the cluster changes. |
| `POST /separate`, list | `{ source, pairs: [{ a, b, separated?, reason? }], reason? }`, at most 1,000 pairs. One transaction, one decision each, by `system:<source>`. Answers `{ changes, recorded, already }`. |
| `POST /join`, list | The same without `separated`, for records another system merged. |
| `POST /consent` | `{ subject, consent: { adUserData, adPersonalization }, at?, source? }`. Adds an answer about advertising; the newest by `at` applies. Rejects an `at` more than a day ahead and a `source` over 200 characters. |
| `POST /link` | `{ url, subject, days? }`. Answers `{ url }`: the address with a token naming its person. See [links](links.md). |
| `POST /staff-link` | `{ url, days? }`. Answers `{ url }`: an address that marks the browser that opens it as [staff](operations.md#staff-traffic). |
| `POST /transfer` | `{ id, from, to, amount, at, asset? }`. Records a transfer of value. Answers with the identity link between the two and whether it was a `duplicate`. Repeating it with the same details adds no record; the same `id` with other details gets 400. |

### Attribution and outcomes

| Route | Description |
| --- | --- |
| `POST /touch` | A visit from an ad or campaign: `{ subject, at, gclid?, source?, medium?, campaign?, campaignId?, … }`. Each field is text. Unknown fields are rejected; put your own in `custom`. |
| `GET /attribute?subject=&at=` | The touches that led to a conversion by this subject, and the one credited. |
| `POST /convert` | An outcome: `{ transactionId, subject, at, stage?, value?, currency?, action?, email?, phone?, tags? }`. Counted in the report and, with `action`, sent to the ad platforms. A `stage` listed in `STAGES` supplies a missing value, currency and action. |
| `POST /restate` | `{ transactionId, value, currency?, kind? }`. Changes an outcome's value in the report and on platforms that support restating. Earlier values are kept. `kind` is `refund` or `write_off`, which the report [counts separately](report.md#value-changes). |
| `POST /not-lead` | Marks an outcome or a call as not a lead: `{ call }` or `{ transactionId }`, with `kind` `spam` or `other` (the default). `lead: true` undoes it. May precede the outcome or call. Answers `{ id, lead }`. |
| `POST /costs` | A list of `{ day, source, amount, campaignId?, campaign?, currency?, clicks?, impressions?, conversions?, conversionValue? }`. A row replaces an earlier one with the same day, source and campaign. |
| `GET /conversion?id=` | The jobs of one transaction, one per ad platform. |

### Calls

| Route | Description |
| --- | --- |
| `POST /call` | A phone call: `{ id, from?, to, at, duration?, direction?, answered?, voicemail?, waited?, tags? }`. With `direction: "outbound"` you placed the call, and `from` is yours. Answers `{ subject, flags, counted, state, visitor?, duplicate }`. See [calls](calls.md). |
| `POST /call/result` | A call's result: `{ id, answered, voicemail?, waited? }`, before or after the call. Answers `{ state, counted }`; `waiting` until the call arrives. |
| `POST /call/returned` | Records that staff reached a caller outside your phone system: `{ id, at?, returned? }`, before or after the call. `returned: false` undoes it. Answers `{ followUp }`, null until the call arrives or if it was not missed. |

### Maintenance

| Route | Description |
| --- | --- |
| `POST /alerts/test` | Posts a test alert. Answers `{ delivered, error? }`. |
| `POST /prune` | `{ before, by?, reason? }`. Deletes sightings, superseded consent answers, and call results without a call, all stored before a time. [Privacy](privacy.md#deletion) has the full list. |
| `GET /stats` | Counts since start, graph contents, and outbox jobs by state. |
| `POST /rebuild` | `{ by?, reason? }`. Recomputes every cluster under the running policy and answers with the subjects that moved. Blocks other writes while it runs. |
| `GET /verify` | `{ changes, policy }`: the subjects whose stored cluster differs from a full recompute, and whether the policy changed since they were stored. |

## Errors

Error responses have the form `{ "error": "…" }`.

| Status | Condition |
| --- | --- |
| 400 | The body is not JSON, or a field is missing or malformed. |
| 401, 403 | The token is wrong, or does not open the route. |
| 403 on `/collect`, `/event` | The request's origin is not in `ORIGINS`. Applies to `/carry` and `/number` too. |
| 403 on `/calls/twilio` | Twilio's signature is missing or wrong. |
| 404 | No such route. Also `/conversion`, `/conversions` and `/retry` without an ad platform, and `/link` and `/staff-link` without `LINK_SECRET`. |
| 405 | A method other than POST on `/collect`, `/event`, `/carry` or `/number`. |
| 409 | A decision newer than `seen` names the same subject or identifier. The answer has that `decision`. |
| 413 | The body is over 1 MB. |
| 429 on `/collect`, `/event` | Too many requests from one address. `retry-after` gives the wait. Applies to `/carry` and `/number` too. |
| 500 | The server failed. Its log has the cause. |
