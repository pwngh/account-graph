# HTTP API

Six calls over plain HTTP, in JSON. Your services authenticate with a token. Browsers and Twilio have routes of their own. Long answers on this page are shortened.

> **One rule.** `POST /v1/<call>` takes the call's argument as its body, and the 200 body is the call's answer. The [library](library.md) makes the same calls with the same shapes.

```bash
curl -X POST https://graph.example.org/v1/record \
  -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"entries":[{"type":"profile","key":"login-9001","at":1795460000000,"subject":"account:42","event":"login","facts":{"device":"9f3c"}}]}'
```

```json
{ "results": [{ "type": "profile", "key": "login-9001", "ok": true,
    "value": { "duplicate": false, "stands": true, "changes": [{ "subject": "account:42", "from": "account:42", "to": "account:17" }], "notes": {} } }] }
```

`changes` lists the subjects whose cluster changed. This login joined `account:42` to the cluster of `account:17`.

| Call | Does | Keyed |
| --- | --- | --- |
| [`record`](#record) | Writes what happened: 1 to 100 entries | Each entry |
| [`decide`](#decide) | Merges, splits and mutes, and takes each back | Yes |
| [`forget`](#forget) | Deletes 1 to 50 subjects | Yes |
| [`lookup`](#lookup) | Reads about people and records | No |
| [`report`](#report) | Reads figures and lists | No |
| [`events`](#events) | Reads what happened since a cursor | No |

## Tokens

Send a token in the `authorization` header as `Bearer …`.

| Call | Service token (`GRAPH_TOKEN`) | Reviewer token (`REVIEW_TOKENS`) |
| --- | --- | --- |
| `record` | Every entry | Only call party statements signed with the owner’s name |
| `events` | Yes | 403 |
| `decide`, `forget` | Any `by` | `by` must be the owner of the token |
| `lookup` | Every kind | `journey` and `find` |
| `report` | Every kind | Every kind |

A missing or wrong token gets 401. A name that begins with `system:` is a system's. No reviewer can have one, so `"by": "system:cases"` needs the service token.

An `x-request-id` header of 1 to 200 printable characters comes back with the answer of a call.

## Requests

| Rule | Detail |
| --- | --- |
| Method | `POST`. Any other gets 405. |
| Size | 1 MB as JSON, 32 levels. A `record` has at most 100 entries. |
| Fields | Exactly those listed. An unknown field is refused. |
| `at` | When it happened, in epoch milliseconds, an integer. Every write requires it. The server never fills it in. |
| `key` | Yours, 1 to 200 characters. Every write requires one. Unique within its `type` across the whole database, so two systems that write here must prefix their own. |
| `subject` | Yours, 1 to 512 characters, with no space around it: `account:42`, `contact:7`. |
| Text | A NUL or half of a character is refused. |

## record

Entries run one at a time, in order, one transaction each. A later entry sees what an earlier one wrote, and one refusal undoes nothing.

```http
POST /v1/record

{ "entries": [
  { "type": "conversion", "key": "enroll-1001", "at": 1795460000000, "subject": "account:42", "stage": "enrolled", "value": 200, "currency": "USD" },
  { "type": "restatement", "key": "refund-7", "at": 1795463600000, "of": { "type": "conversion", "key": "enroll-1001" }, "change": { "kind": "refund", "amount": 80 } },
  { "type": "restatement", "key": "refund-8", "at": 1795463600000, "of": { "type": "conversion", "key": "nope" }, "change": { "kind": "refund", "amount": 80 } }
] }
```

```json
{ "results": [
  { "type": "conversion", "key": "enroll-1001", "ok": true, "value": { "duplicate": false, "stands": true, "value": 200, "currency": "USD", "deliveries": [{ "conversion": "enroll-1001", "platform": "google", "state": "pending" }] } },
  { "type": "restatement", "key": "refund-7", "ok": true, "value": { "duplicate": false, "stands": true, "counts": true, "value": 120, "deliveries": [{ "conversion": "enroll-1001", "platform": "google", "state": "pending" }] } },
  { "type": "restatement", "key": "refund-8", "ok": false, "reason": "UNKNOWN_REFERENCE", "of": { "type": "conversion", "key": "nope" } }
] }
```

There is one result per entry, in order. Every accepted entry answers two fields beside its own:

| Field | Meaning |
| --- | --- |
| `duplicate` | The key was recorded before. The rest of the answer says how it stands now. |
| `stands` | `false` when something newer already does. See [order](#order). |

### Entry types

Each entry has `type`, `key` and `at`. A field with `?` may be left out.

| Type | Fields | Answers |
| --- | --- | --- |
| `profile` | `subject`, `facts`, `event?`, `speaker?` | `changes`, `notes`. See [identify](identify.md). |
| `arrival` | `subject`, `source?`, `medium?`, `campaign?`, `campaignId?`, `adGroupId?`, `adId?`, `term?`, `content?`, `landing?`, `referrer?`, `clicks?`, `custom?` | `subject` |
| `cost` | `rows`, 1 to 5,000: `day`, `source`, `amount`, `currency`, `campaignId?`, `campaign?`, `clicks?`, `impressions?`, `conversions?`, `conversionValue?` | `written`, `older`: rows written, and rows a newer reading already had |
| `conversion` | `subject`, `stage`, `value?`, `currency?`, `actions?`, `channel?`, `email?`, `phone?`, `consent?`, `tags?` | `value`, `currency`, `deliveries` |
| `restatement` | `of: { type, key }`, `change` | `counts`, `value`, `deliveries` |
| `payment` | `conversion`, `direction`, `amount`, `currency?` | `value`, `null` until there is a conversion, and `deliveries` |
| `call` | `direction`, `from?`, `to`, `duration?`, `result?`, `code?`, `tags?` | `subject`, `state`, `counted`, `flags`, `visitor?`. See [calls](calls.md). |
| `call_update` | `call`, `change` | `state`, `counted`, `followUp` |
| `text` | `direction`, `from`, `to`, `text?`, `code?`, `tags?` | `subject`, `flags`, `counted`, `visitor?`. See [texts](calls.md#text-messages). |
| `consent` | `subject`, `consent: { adUserData, adPersonalization }`, `source?` | The answer that applies |
| `link` | `subject`, `url`, `expires`, `purpose?` | `url`. See [signed links](identify.md#signed-links). |
| `transfer` | `from`, `to`, `amount`, `asset?` | `relation`, `score` |

| Field | Values |
| --- | --- |
| `facts` | At least one, unless there is a `speaker`: `email`, `phone`, `device`, `ip`, `address`, `name`, `dob`, `identifiers` |
| `clicks` | `gclid`, `gbraid`, `wbraid`, `fbclid`, `fbp`, `msclkid`, `ttclid` |
| `custom` | At most 10 names of your own, each with text up to 256 characters |
| `actions` | What it counts as on each platform, `{ "google": "987654321" }`. Left out, the stage's own. |
| `channel` | `WEB`, `APP`, `IN_STORE`, `PHONE`, `MESSAGE` or `OTHER` |
| `tags` | At most 8. A name is lowercase letters and underscores, up to 32. A value is up to 64 characters. |
| Payment `direction` | `received` or `refunded` |
| Payment `amount` | From 0.00001 to 10,000,000,000 |
| Call and text `direction` | `inbound` or `outbound`. An outbound call requires `from`. |
| Call `result` | `{ answered, voicemail?, waited? }` |
| Call and text `code` | 1 to 64 characters. One that names nobody is not refused. Pages are given codes where [`TEXT_CODES`](operations.md#environment-variables) is on. |
| Call and text `key` | The provider's id: 1 to 128 letters, digits, dots, dashes and underscores |
| Conversion `key` | The transaction id. It cannot begin with `call:`, `text:` or `page:`, which the graph uses for its own outcomes. |
| Transfer `amount` | A whole number of the asset's smallest unit, above zero |

`restatement` takes one `change`:

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `correct` | `value`, `currency?` | What it is worth |
| `refund` | `amount`, `currency?` | How much was given back |
| `write_off` | `amount`, `currency?` | How much will not be paid |
| `reverse` | `restatement` | Takes back one earlier refund or write-off, by its key |
| `not_lead` | `why`: `spam` or `other` | It was nobody's inquiry |
| `lead` | none | It is a lead after all |

A refund and a write-off are amounts, and not what is left. `of.type` is `conversion`, `call` or `text`.

`call_update` takes one `change`:

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `result` | `result: { answered, voicemail?, waited? }` | How the call went |
| `returned` | `reachedAt` | Somebody reached the caller then |
| `not_returned` | none | Nobody did |
| `party` | `role`, `by`, `subject` for every role except `unknown` | Who was on this call |

`role` is `self`, `representative`, `excluded` or `unknown`. The subject names one of your records. A reviewer can sign only their own name. A later party statement can name a different record or undo identification with `unknown`. Results, returns and parties each have their own newest statement, ordered by time and then key. A statement may precede the call.

```json
{"type":"call_update","key":"desk-14","at":1790000000000,"call":"incoming-4","change":{"kind":"party","role":"representative","subject":"record:17","by":"intake"}}
```

A call record lookup includes the current `party` and ordered `partyHistory` with the time, key and signer of each statement. A journey shows only the current statement on a visible call. Before the phone report arrives, the call lookup returns `null`.

A `delivery` is `{ conversion, platform, state, note? }`. `state` is `held`, `pending`, `sent`, `skipped` or `failed`. `held` waits for a call's result. No answer holds a hashed email or phone.

### Refusals

A refusal is an answer, with status 200 and `"ok": false`. None is kept with the key, so put right what was wrong and send the same key again.

| `reason` | Meaning | With it |
| --- | --- | --- |
| `KEY_REUSED` | The key was used for something else | `fields`: the names of what differs |
| `UNKNOWN_REFERENCE` | What it is about is not recorded | `of` |
| `KIND_NOT_IN_POLICY` | An identifier has a kind the policy lacks | `kind` |
| `KIND_RESERVED` | An identifier has a kind the graph writes itself | `kind` |
| `NO_FACT_USED` | No fact of a profile says who somebody is | `notes` |
| `CURRENCY_MISMATCH` | It names another currency | `expected` |
| `PAID` | The conversion has payments, so it is worth what was paid | |
| `FORGOTTEN` | The key, or what it is about, belongs to somebody who was deleted | |
| `NOT_ATTEMPTED` | The time ran out before its turn. Nothing was tried. | |

The reserved kinds are `review`, `link`, `carry`, `opened`, `lease`, `dial`, `text`, `place`, `birth`, `dialed`, `behalf`, `named`, `ward`, `given`, `dated` and `initial`.

### Batches

| Step | What happens |
| --- | --- |
| 1 | The whole request is checked. A malformed entry refuses the request with a [fault](#faults), and nothing is written. |
| 2 | Addresses and phone lines are checked with their services, at most 8 at once and 3 seconds each. One that fails is a note on its entry. |
| 3 | Each entry is written with its receipt, deliveries and events, as one transaction. |

Entries not begun when nine tenths of the time are out answer `NOT_ATTEMPTED`. The time is 30 seconds. Send those again.

If a fault ends a `record` part way, send the whole list again. The entries that stand answer `duplicate: true`.

Put a `profile` before its `conversion`. The other way round, a conversion can be sent in between, without the click.

### Idempotency

Sending an entry again with its key writes nothing and answers `duplicate: true`. Nothing of the first answer is kept. The answer is read from the graph as it stands, so a `profile` sent again has no `changes`.

The same key with other details answers `KEY_REUSED`. What is compared depends on the type:

| Type | Compared | Not compared |
| --- | --- | --- |
| `call` | `direction`, `to`, and `from` where both reports name it | `at`, `duration`, `result`, `code`, `tags`. A second reporter often knows more: a `result`, or a `code` the call did not have, counts. |
| `text` | `direction`, `from`, `to` | `at`, `text`, `code`, `tags`. Twilio sends no time. |
| `cost` | `at` and the rows, in any order | |
| `decide` | `at`, `by`, `action`, and the pairs or the fact. Pairs may be in any order, and so may the two of a pair. | `reason`, the reason of a pair, `seen` |
| `forget` | `at`, `by`, `platforms`, and the subjects in any order | `reason`, `seen` |
| Every other entry | Every field | |

Emails and phones are compared as they are normalized, currencies in capitals, identifiers in any order. `Pat.Lee@gmail.com` and `patlee@gmail.com` are one.

> **Keep `at` with the key.** A retry that stamps a new `at` is refused with `KEY_REUSED` for most types.

A key is remembered for a year, or longer until receipts are [pruned](operations.md#receipts). A key of somebody who was deleted is remembered for good, as a keyed hash.

A call or a conversion can come from two reporters, such as Twilio and your backend. Both name it by one id, so it is one record.

### Order

Entries may arrive late and in any order. Nothing is refused for being late.

| What | Which stands |
| --- | --- |
| `correct`, `not_lead` and `lead`, call results, call returns, `consent` | The newest by `at`, then by `key`. One that arrives late is kept, changes nothing, and answers `stands: false`. |
| A cost row | The newest `at` for its day, source and campaign |
| The `code` of a `call` | The first that names a visitor, by when the call was. See [a code read out](calls.md#a-code-read-out). |
| `refund`, `write_off`, `reverse` | All of them, whatever order they arrive in |
| `payment` | All of them. From the first on, the conversion is worth what was paid less what was refunded. |

A conversion without payments is worth the newest `correct`, or else its first value, less every refund and write-off that was not reversed. It is never worth less than zero.

| Before what it is about | Result |
| --- | --- |
| `payment`, `call_update`, `not_lead`, `lead` | Kept, and counts once the conversion, call or text arrives |
| `correct`, `refund`, `write_off`, `reverse` | `UNKNOWN_REFERENCE`. Send the same key again later. |

## decide

Merges, splits and mutes, with the author and the reason. [Matching](matching.md#decisions-from-your-own-systems) says when to use which.

```http
POST /v1/decide

{ "key": "ticket-88", "at": 1795460000000, "by": "dana", "seen": 418, "action": "merge",
  "pairs": [{ "a": "contact:7", "b": "contact:12", "reason": "one person, two intakes" }] }
```

```json
{ "ok": true, "value": { "duplicate": false, "changes": [{ "subject": "contact:7", "from": "contact:7", "to": "contact:12" }], "recorded": 1, "already": 0, "notAsAsked": [] } }
```

| `action` | Takes | Effect |
| --- | --- | --- |
| `merge` | `pairs`, 1 to 1,000 | Each pair is one person |
| `unmerge` | `pairs` | Takes back the merges of each pair |
| `split` | `pairs` | Each pair is two people. Holds whatever they share later. |
| `unsplit` | `pairs` | Takes back the splits |
| `mute` | `fact` | Nothing links through it |
| `unmute` | `fact` | It links again |

`fact` names one of `{ "email" }`, `{ "phone" }`, `{ "ip" }` or `{ "identifier" }`. All of the pairs are written, or none. `by` is 1 to 100 characters, and a reason is at most 1,000.

| Answer | Meaning |
| --- | --- |
| `recorded` | How many were decided |
| `already` | How many already stood that way |
| `notAsAsked` | Pairs that are not as asked afterwards: `{ a, b, because }` |

| `because` in `notAsAsked` | Meaning |
| --- | --- |
| `split` | A split holds a merged pair apart |
| `evidence` | What the two share still joins them after `unmerge`. Use `split` to keep them apart. |
| `other_merges` | Other merges still join them after `unmerge` |

| `reason` | Meaning | With it |
| --- | --- | --- |
| `STALE` | A decision newer than `seen` names one of them | `decision`, `by`, `at` |
| `NOT_JOINED` | `unmerge` of a pair with no merge to take back. None of the pairs is unmerged. | `pairs`: `{ a, b, because }`, where `because` is `apart`, `evidence` or `other_merges` |
| `KEY_REUSED`, `KIND_NOT_IN_POLICY`, `FORGOTTEN` | As for `record` | |

In `NOT_JOINED`, `apart` means the two are not together, `evidence` that what they share joins them, and `other_merges` that merges with others do.

`seen` is the `decisions` number of the `person` lookup you decided by. Left out, nothing is checked. `unmute` is not checked.

## forget

Deletes subjects and everything recorded about them: all, or none. [Privacy](privacy.md#deletion) lists what goes and what stays.

```http
POST /v1/forget

{ "key": "request-31", "at": 1795460000000, "by": "dana", "subjects": ["contact:42", "visitor:9f3c"], "platforms": "report" }
```

```json
{ "ok": true, "value": { "duplicate": false, "changes": [], "sent": [{ "conversion": "client-42", "platform": "google", "action": "333", "at": 1795460000000, "state": "not_requested" }] } }
```

| `platforms` | Effect |
| --- | --- |
| `report` | `sent` lists the conversions that reached an ad platform |
| `retract` | Each platform that has a way is also asked to take them back. Without such a platform, the fault `CONFIG.UNSUPPORTED`, and nothing is deleted. |

`sent` is kept with the key, so a lost answer can be asked for again. The refusals are `STALE` and `KEY_REUSED`.

## lookup

Reads. Nothing is written.

```http
POST /v1/lookup

{ "kind": "person", "subjects": ["account:42"], "at": 1795460000000 }
```

```json
{ "decisions": 418, "people": [{ "subject": "account:42", "known": true, "members": ["account:42", "visitor:9f3c"], "oversized": false,
    "arrival": { "at": 1795460000000, "source": "google", "campaign": null, "campaignId": "20111", "landing": null, "custom": {}, "confidence": 0.98, "how": "cluster" },
    "possible": null, "consent": { "adUserData": true, "adPersonalization": false }, "textsOptedOut": false }] }
```

| `kind` | Asks | Answers |
| --- | --- | --- |
| `person` | `subjects`, 1 to 100, `at` | `decisions`, `people`: each one's cluster, the arrival that can be credited, the strongest one that cannot (`possible`), consent, and whether they asked for no texts |
| `journey` | `subject`, `before?` | `subjects`, `entries`, `next`, `more`: everything recorded about the person, oldest first, the newest 200. Pass `next` as `before` for earlier ones. |
| `find` | `text` | `by`, `subjects`: a full email or phone, the start of a subject's id, or a full ad click id. At most 20. |
| `match` | `facts`, `at` | `candidates`, `notes`: who somebody may be, before you save them |
| `caller` | `from?`, `to`, `at` | Who is calling, [while the phone rings](calls.md#while-the-phone-rings) |
| `conflicts` | `subjects`, 1 to 50 | `conflicts`: who of them is [kept apart](matching.md#asking-about-conflicts) |
| `record` | `type`, `key`, `at` | One conversion, call or text, or `null` |
| `transfers` | `subject`, `tiedOnly?` | `counterparties`, `rings` |

`match`, `transfers`, `caller` and `journey` say why by `kinds`, such as `["phone", "device"]`. No identifier leaves the graph, because most are hashes of an email or a phone. A candidate with `unconfirmed` shares what would join it, and [nothing confirms](matching.md#records-that-have-to-be-confirmed) that the two are one person.

A `find` by id matches the start of it and reads the subject table. The person of a journey is the subject's cluster, plus any subject linked strongly enough that its visits would be credited. A subject split from any of them is left out. `subjects` gives the reason and score for each. A `journey` reads up to 60 subjects of one person, and keeps the state of a conversion without the time it was sent.

`tiedOnly` keeps the counterparties tied by identity with three or more transfers.

## report

Reads figures. Each kind is described with [the report](report.md) and [calls and texts](calls.md).

```http
POST /v1/report

{ "kind": "campaigns", "window": { "from": "2026-11-01", "to": "2026-11-14", "timeZone": "America/Chicago" }, "per": "enrolled" }
```

```json
{ "asOf": 1795460000000, "value": { "from": "2026-11-01", "to": "2026-11-14", "timeZone": "America/Chicago", "steps": ["inquiry", "enrolled"], "rows": [], "total": { "cost": 0, "outcomes": 0, "value": 0 } } }
```

| `kind` | Asks | Answers |
| --- | --- | --- |
| `campaigns` | `window`, `by?`, `per?` | [Cost and results of each campaign](report.md) |
| `pipeline` | `at`, `days` from 1 to 365 | [People by the furthest step](report.md#board) they reached |
| `calls` | `window`, `at` | Inbound calls by result, hour and weekday |
| `callbacks` | `window`, `at`, `after?` | Missed calls nobody has returned, oldest first |
| `texts` | `window`, `at`, `after?` | The oldest unanswered text of each sender |
| `after_calls` | `window`, `at`, `step`, `days` from 1 to 365 | [How many callers reached a step](report.md#outcomes-after-a-call) |
| `deliveries` | `state` | The 100 deliveries in one state that were most recently due |

`window` is two days and a time zone. `callbacks` and `texts` answer `{ rows, next }`, 50 rows at a time. Pass `next` as `after`.

`asOf` is the moment the answer is of. `campaigns`, `pipeline`, `calls` and `after_calls` are worked out once for everybody who asks at the same time, and shared until something is written. While data is being written, an answer is shared for four times as long as it took, and a minute at most. A `decide` or `forget` through the same process ends that at once. A change of call party invalidates report answers across processes. An `at` within a minute of now is answered from the shared answer.

## events

Reads what happened, oldest first. [Operations](operations.md#events) covers following along and the webhook.

```http
POST /v1/events

{ "after": "1fc21682.4180", "limit": 500 }
```

```json
{ "ok": true, "value": { "schemaVersion": 1, "cursor": "1fc21682.4181", "more": false, "events": [
  { "schemaVersion": 1, "seq": 4181, "type": "cluster.changed", "at": 1795460000000, "data": { "subject": "account:42", "from": "account:42", "to": "account:17" } }] } }
```

| Field | Meaning |
| --- | --- |
| `after` | The `cursor` of the last page you acted on, or `null` to start with the oldest event that is kept |
| `limit` | 1 to 1,000 |
| `more` | Another page is there already |

A cursor is opaque. It names the history of the database as well as a place in it. A cursor of another history, or older than what is kept, answers `{ "ok": false, "reason": "CURSOR_LOST" }`. Read everything again from `null`.

`seq` only grows. Some numbers are missing, because a deletion takes a person's events with it. A hole is not a loss.

| Type | `data` |
| --- | --- |
| `cluster.changed` | `subject`, `from`, `to` |
| `conversion.failed` | `conversion`, `platform`, `note` |
| `delivery.paused` | `reason` |
| `delivery.late` | `oldestDue` |
| `costs.failed` | `source`, `reason` |
| `feed.quiet` | `feed`, `last`, `hours` |
| `callback.overdue` | `call`, `subject`, `missedAt`, `attempts`, `source`, `campaign`, `campaignId` |
| `audit.head` | `seq`, `hash`, `sound`, `brokenAt` |

## Faults

A fault is any answer that is not 200. The library throws it as a `Fault` with the same code.

```json
{ "fault": { "code": "INPUT.MALFORMED", "message": "request.entries[0].at is required", "retryable": false, "detail": { "path": "request.entries[0].at" } } }
```

| Code | Status | Retryable | When |
| --- | --- | --- | --- |
| `INPUT.MALFORMED` | 400 | no | The body is not JSON, or a field is missing, unknown or malformed. `detail.path` names it where there is one. |
| `INPUT.TOO_LARGE` | 413 | no | Over 1 MB, or over 100 entries |
| `AUTH.REJECTED` | 401 | no | The token is missing or wrong |
| `AUTH.FORBIDDEN` | 403 | no | The token does not open this call, or `by` is not its owner |
| `CONFIG.UNSUPPORTED` | 422 | no | A `link` without `LINK_SECRET`, or `retract` where no platform can |
| `CONFIG.MISMATCH` | 503 | no | The server's [settings differ](operations.md#settings-that-must-match) from the database's |
| `CONFIG.INVALID` | 500 | no | Settings that cannot be. A server with these does not start. |
| `GRAPH.UNAVAILABLE` | 503 | yes | The database is not available. Nothing was committed. |
| `GRAPH.CLOSED` | 503 | no | The instance is closed |
| `GRAPH.INTERNAL` | 500 | no | The server failed. Its log has the cause. |
| `TRANSPORT.INDETERMINATE` | 504 | yes | The time ran out, or the connection was lost as a write was committed. It may have been written. Send it again with the same key. |
| `TRANSPORT.ABORTED` | 499 | no | The caller went away. Effects are unknown until you look. |

`retryable` says whether the same call, with the same key, may succeed. Tell a fault by its code, never by its message.

Every other route answers an error as `{ "error": "…" }`. So do two answers under `/v1`: 404 for a call that does not exist, and 405 for a method other than `POST`.

## Routes for browsers

Browsers post to `/collect` without a token. The [script tag](operations.md#script-tag) does it for you. `kind` says what the page asks.

| `kind` | Body | Answers |
| --- | --- | --- |
| `visit`, or left out | `device` and what the visit carried | 204. Records one visit. |
| `event` | `device`, `event`, `id?`, `number?` | 204. Records a page event named in `EVENTS`. |
| `carry` | `device` | `{ token }`, which the script adds to links to your other sites. Requires `LINK_SECRET`. |
| `number` | `device` | `{ number, until, lasts }`, or 204 when none is available to the visitor. Requires `POOL_NUMBERS`. |
| `text_code` | `device` | `{ code }`, or 204 for a visitor who refused ad measurement. Requires `TEXT_CODES`. |

| Status | Condition |
| --- | --- |
| 400 | The body is malformed, names an unknown `kind`, or an event that `EVENTS` does not list |
| 403 | The request's origin is not in `ORIGINS` |
| 404 | The `kind` is not set up |
| 405 | A method other than `POST` |
| 413 | The body is over 1 MB |
| 429 | Too many requests from one address. `retry-after` gives the wait. |

> **Old paths.** `/event`, `/carry`, `/number` and `/text-code` were routes of their own. They still answer for one release, for pages that keep an old script.

## Other routes

| Route | Description |
| --- | --- |
| `POST /calls/twilio` | Receives Twilio's status callback for a call and checks Twilio's signature. Requires Twilio settings. |
| `POST /texts/twilio` | Receives Twilio's incoming texts and checks Twilio's signature. Requires Twilio settings. |
| `GET /collect.js` | The script tag |
| `GET /fingerprint.js` | Fingerprint helpers, loaded by the script on request |
| `GET /review` | The [reviewer screen](operations.md#reviewer-screen). Its data requires a token. |
| `/review/api/*` | The routes the screen calls, with a service or reviewer token. They serve the screen and are not part of the six calls. |
| `GET /health` | `{"ok":true}` once the database answers |

A Twilio request with a missing or wrong signature gets 403. A call or text that is already known, or whose person was deleted, gets the usual answer, so Twilio does not send it again.
