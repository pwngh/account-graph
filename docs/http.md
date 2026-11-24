# The HTTP routes

The server answers over plain HTTP with JSON. Your own services call it with a token; browsers reach only the few routes that need none.

```sh
curl -X POST https://graph.example.org/observe \
  -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"subject":"account:42","identifiers":["device:9f3c"],"at":1795460000000,"event":"login"}'
```

```json
[{ "subject": "account:42", "from": "account:42", "to": "account:17" }]
```

That answer says the login joined `account:42` to the cluster of `account:17`. An empty list means no cluster changed.

## Writing identifiers

The short way is `POST /identify`: send the email, phone and address as they are and the server hashes and checks them. [Telling the server who someone is](identify.md) covers it. The rest of this section is for writing identifiers yourself with `/observe`.

An identifier is `kind:value`. The kind must be one the policy names, or the request is refused with 400.

| Kind | What to send |
| --- | --- |
| `device` | The `ag_device` cookie the script tag set, read from the visitor's request. |
| `email`, `phone` | A hash, never the address itself: SHA-256 of the trimmed, lowercased email, or of the phone number in E.164 form. Hash the same way every time. |
| `hardware` | The hashed machine id your desktop client reports. |
| `passkey` | A passkey's credential id, after your server verified the sign-in. |
| `payment` | A card or bank token from your payment provider, never the number. |
| `ip` | The address your server saw the request from. |
| `fingerprint`, `canvas`, `ga` | Leave these to `/collect`, which confirms a fingerprint before recording it. |

[How it decides](deciding.md) says how much each kind counts.

## Tokens

A token goes in the `authorization` header as `Bearer …`. There are two.

- **Service**, `GRAPH_TOKEN`: opens every route. For your own backend.
- **Review**, `REVIEW_TOKEN`: opens what the reviewer screen needs. For people.

> **A wrong or missing token gets 401. The review token on a service-only route gets 403.**

## No token

| Route | What it does |
| --- | --- |
| `POST /collect` | Records one browser visit. Only from an origin in `ORIGINS`, and limited per address. Answers 204. |
| `POST /event` | Records something a visitor did on a page: `{ device, event, id?, number? }`. Same origins and limit as `/collect`; only names in `EVENTS` are kept. Answers 204. |
| `POST /carry` | Answers `{ token }`: a token the script tag adds to links that lead to your other sites. Same origins and limit as `/collect`. Only when `LINK_SECRET` is set. |
| `POST /calls/twilio` | Twilio's status callback for a phone call. Checked against Twilio's signature. Only when Twilio is set up. |
| `GET /collect.js` | The script tag that posts to `/collect` and `/event`. |
| `GET /fingerprint.js` | Fingerprint helpers the script loads when asked to. |
| `GET /review` | The reviewer screen. A page only; its data needs a token. |
| `GET /health` | `{"ok":true}` once the database answers. |

## Review or service token

| Route | What it does |
| --- | --- |
| `GET /subject?subject=` | Everything about one subject: cluster, ties, separations and who decided them, flows, rings, newest sightings. |
| `GET /cluster?subject=` | The cluster a subject is in: `{ id, members, oversized }`, or `null`. |
| `GET /links?subject=` | Every subject tied to this one, with score and reasons. |
| `GET /history?subject=` | Every sighting of the subject, oldest first. |
| `GET /clusters?offset=` | The largest clusters, 50 at a time. |
| `GET /search?q=` | Subjects whose id starts with the text. |
| `GET /policy` | The running rules by kind, the hash the stored clusters were built with, whether a rebuild is `due`, and which kinds were `changed` from the default. |
| `GET /ops` | How the server runs: `{ feeds, jobs, undelivered, alerts, outbox }`. |
| `GET /pulse` | `{ version }`, with an `etag`. Ask again with `if-none-match` and it answers 304 until something is written. |
| `GET /recent` | The newest cluster changes. |
| `GET /flows?subject=` | Everyone the subject exchanged value with, and the identity tie to each. |
| `GET /collusion?subject=` | The counterparties tied by identity, with three or more flows. |
| `GET /rings?subject=` | Value that left the subject and came back through others. |
| `GET /decisions?limit=&before=&author=` | The record of decisions, newest first, 50 at a time: `{ decisions, next, total }`. Pass `next` as `before` for the page after. `author` is `people`, `system`, or one name. |
| `GET /disputes` | Pairs whose reports from systems have switched between kept apart and joined (or withdrawn) three times or more. |
| `GET /consent?subject=` | Every answer the subject gave about advertising, the standing one first. |
| `GET /outcome?id=` | One outcome with every value it has had, or `null`. |
| `GET /call?id=` | One call with its state and, for a missed one, what became of it, or `null`. |
| `GET /calls?from=&to=&tz=&after=` | Missed calls nobody has returned, oldest first, 50 at a time: `{ from, to, timeZone, at, calls, next }`. Pass `next` as `after`. |
| `GET /calls/summary?from=&to=&tz=` | Calls to you by how they went, by hour and weekday, and how many could be placed. |
| `GET /audit` | Whether that record is whole: `{ sound, head }`, with `brokenAt` when it is not. `head` is the newest entry's `seq` and `hash`. |
| `GET /report?from=&to=&tz=&by=` | What each campaign cost and brought in between two days, with `steps` naming the steps in your order and `timeZone` the zone its days are in. See [the report](report.md). |
| `POST /separate` | `{ a, b, separated?, by?, reason? }`. Keeps two subjects apart, or with `separated: false` allows them again. |
| `POST /join` | `{ a, b, by?, reason? }`. Records that two subjects are one person. |
| `POST /ignore` | `{ identifier, ignored?, by?, reason? }`. Stops linking through one identifier, or resumes. |
| `POST /forget` | `{ subject, by?, reason? }`. Deletes a subject and everything recorded about it. |

The four `POST` routes answer with the subjects whose cluster moved. With the service token, `/separate` and `/join` also take a list from one of your systems: see [decisions from your own systems](deciding.md#decisions-from-your-own-systems). A name that starts with `system:` is refused with the reviewer token.

## Service token only

| Route | What it does |
| --- | --- |
| `POST /identify` | Who a subject is, from plain facts: `{ subject, device?, email?, phone?, ip?, address?, identifiers?, at?, event? }`. Answers `{ changes, identifiers, notes }`. See [identify](identify.md). |
| `POST /separate`, list | `{ source, pairs: [{ a, b, separated?, reason? }], reason? }`, at most 1,000 pairs. One transaction, one decision each, by `system:<source>`. Answers `{ changes, recorded, already }`. |
| `POST /join`, list | The same without `separated`: two records another system merged are one person here too. |
| `POST /observe` | One observation, or a list: `{ subject, identifiers, at, event? }`. Answers with the cluster changes. |
| `POST /touch` | A marketing touch: `{ subject, at, gclid?, source?, medium?, campaign?, campaignId?, … }`. |
| `POST /consent` | `{ subject, consent: { adUserData, adPersonalization }, at?, source? }`. Adds an answer about advertising; the newest by `at` stands. An `at` more than a day ahead is refused, and so is a `source` over 200 characters. |
| `GET /attribute?subject=&at=` | The touches that led to a conversion by this subject, and the one credited. |
| `POST /transfer` | `{ id, from, to, amount, at, asset? }`. Records value moving, and answers with the identity tie between the two and whether it was a `duplicate`. Sent again with the same details it adds nothing; the same `id` with other details is refused with 400. |
| `POST /convert` | An outcome: `{ transactionId, subject, at, stage?, value?, currency?, action?, email?, phone?, tags? }`. Counted for the report; with `action`, also sent to the ad platforms. A `stage` listed in `STAGES` supplies the value, currency and action it leaves out. |
| `POST /restate` | `{ transactionId, value, currency? }`. Changes an outcome's value, in the report and on the platforms that can restate. Earlier values are kept. |
| `POST /link` | `{ url, subject, days? }`. Answers `{ url }`: the address with a token naming the person it is for. See [links](links.md). |
| `POST /staff-link` | `{ url, days? }`. Answers `{ url }`: the address that marks the browser that opens it as staff. |
| `POST /call` | A phone call: `{ id, from?, to, at, duration?, direction?, answered?, voicemail?, waited?, tags? }`. With `direction: "outbound"` it is a call you placed, and `from` is yours. Answers `{ subject, flags, counted, state, visitor?, duplicate }`. See [calls](calls.md). |
| `POST /call/result` | How a call went: `{ id, answered, voicemail?, waited? }`, before or after the call. Answers `{ state, counted }`; `waiting` while the call itself has not come. |
| `POST /costs` | A list of `{ day, source, amount, campaignId?, campaign?, currency?, clicks?, impressions? }`. A row for the same day, source and campaign replaces the one before. |
| `GET /conversion?id=` | The jobs of one transaction, one per ad platform. |
| `GET /conversions?state=` | Jobs in one state: `held`, `pending`, `sent`, `skipped`, or `failed`. `held` waits for a call's result. |
| `POST /retry` | `{ transactionId }`. Puts its failed and skipped jobs back in line. |
| `POST /alerts/test` | Posts a test alert. Answers `{ delivered, error? }`. |
| `POST /prune` | `{ before, by?, reason? }`. Deletes sightings written down before a time, answers about advertising that no longer stand, and call results whose call never came. |
| `GET /stats` | Counts since start, what the graph holds, and outbox jobs by state. |
| `POST /rebuild` | `{ by?, reason? }`. Recomputes every cluster under the running policy, and answers with the subjects that moved. No other write runs meanwhile. |
| `GET /verify` | `{ changes, policy }`: the subjects whose stored cluster differs from a full recompute, and whether the policy changed since they were stored. |

`/conversion`, `/conversions` and `/retry` answer 404 when no ad platform is configured, and `/link` and `/staff-link` when `LINK_SECRET` is not set.

## Errors

| Status | When |
| --- | --- |
| 400 | The body is not JSON, or a field is missing or malformed. The answer is `{ "error": "…" }`. |
| 401, 403 | The token is wrong, or does not open the route. |
| 403 on `/collect`, `/event` | The request's origin is not in `ORIGINS`. |
| 403 on `/calls/twilio` | The request does not carry Twilio's signature. |
| 404 | No such route. |
| 413 | The body is over 1 MB. |
| 429 on `/collect`, `/event` | Too many visits from one address. `retry-after` says when to try again. |
| 500 | Something failed on the server. The cause is in its log, not in the answer. |
