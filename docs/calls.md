# Page events and phone calls

The script tag reports what a visitor does on a page. A phone call that follows a tap on your number is linked to the visitor who tapped, and credited to the ad click that brought them.

```html
<a href="tel:+15551230001">Call us</a>
<button data-ag-event="brochure">Request a brochure</button>
```

```sh
EVENTS=brochure,phone_click \
CALL_NUMBERS='{"+15551230001":{"source":"google","campaignId":"20222"}}' \
npm start
```

Tap the number on the page, then record the call the way a phone provider would:

```bash
curl -X POST https://graph.example.org/v1/record -H "authorization: Bearer $GRAPH_TOKEN" -d '{ "entries": [
  { "type": "call", "key": "CA1", "at": 1795460000000, "direction": "inbound", "from": "+15558675309", "to": "+15551230001", "duration": 140 }] }'
```

```json
{ "results": [{ "type": "call", "key": "CA1", "ok": true, "value": { "duplicate": false, "stands": true, "subject": "caller:96f2c503…", "state": "unknown", "counted": true, "flags": [], "visitor": "visitor:fb919054…" } }] }
```

`visitor` is the browser that tapped. The caller and that visitor are now one cluster, and [the report](report.md) lists the call under the visitor's campaign.

```text
visitor taps the number ──▶ POST /collect, kind event ──▶ a note on the visitor: which number, when
phone provider ──▶ record a call ──▶ caller ──▶ linked to the one visitor who tapped just before
                                           └──▶ otherwise filed under the number's own channel
```

## Page events

A page reports events without the service token, in one of three ways.

| On the page | Reported as |
| --- | --- |
| A link whose address starts with `tel:` | `phone_click`, with the number |
| A link whose address starts with `sms:` | `text_click`, with the number. See [texts](texts.md). |
| Any element with `data-ag-event="name"` | `name`, when clicked; on a form, when submitted |
| `accountGraph.event('name', { id })` from your own script | `name` |

The server keeps the names listed in `EVENTS` and answers 400 to any other. Each event is an outcome of the step with its name. A step in `STAGES` adds its value and the ad platforms it names; see [Steps](report.md#steps).

An event counts once a day per browser, as a conversion whose key begins with `page:`. To count each occurrence, such as each form submission, pass an id in `data-ag-id` or the `id` argument. The id is ignored for a step with a value or an action in `STAGES`.

> **Page events can be forged.** Anyone can send one from a browser. A step in both `EVENTS` and `STAGES` lets a browser create a conversion of that value, once a day per browser, limited per address. Keep such steps small, such as an inquiry, and record sales from your backend as a `conversion`.

## Phone calls

The server processes a reported call in four steps.

1. **Caller.** The caller becomes a subject carrying their phone number. An account that later gives the same number is linked to the call.
2. **Visitor.** If exactly one visitor tapped the number within the tap window (three minutes by default, thirty seconds on a [busy number](#busy-numbers)) before the call, and no other caller could have made the same tap, the two are linked at 0.92, which joins them. For a [pool](#number-pools) number, the visitor it was shown to takes precedence over a tap.
3. **Channel.** A call without a visitor is filed under the channel `CALL_NUMBERS` gives the number, with the medium `call`.
4. **Outcome.** A call of 30 seconds or more counts as an outcome of the step `call`. Where [results are expected](#call-results), a person must also have answered.

Each visitor is linked to one caller. Visitors already linked to another caller, or separated from this caller by a reviewer, are skipped.

`key` is the provider's id. Recording it again answers `"duplicate": true`. A result in the second report counts by its `at`, as a [result](#call-results) reported by itself would; the rest is ignored. Another direction or number under the same key is `KEY_REUSED`.

| Flag | Meaning | Effect |
| --- | --- | --- |
| `blocked` | The caller hid their number, or the carrier sent a placeholder for "anonymous" | The phone number links to no one. A tap can still link the call to a visitor. |
| `toll_free` | The caller's number is toll-free: a switchboard or a machine | The number is excluded from linking |
| `short` | The call ended before `CALL_MIN_SECONDS` | Recorded without being counted |
| `repeat` | This number has called before | None |
| `pool` | The number dialed was shown to one visitor | The call is linked to that visitor |
| `left_out` | The other number is in `CALL_EXCLUDE`: your own people, or a test phone | The call is not recorded |
| `ambiguous` | More than one visitor tapped the number just before, or another caller could have made the same tap | Filed under the number's channel |

### While the phone rings

The `caller` [lookup](http.md#lookup) says who is calling, for the screen of whoever picks up. Nothing is written, so record the call as usual when it ends.

```http
POST /v1/lookup

{ "kind": "caller", "from": "+15558675309", "to": "+15551230001", "at": 1795460000000 }
```

```json
{ "subject": "caller:96f2c503…", "area": null, "known": true, "people": [{ "subject": "contact:7", "members": ["caller:96f2c503…", "contact:7"], "score": 0.9, "level": "same", "kinds": ["phone"] }],
  "visitor": "visitor:fb919054…", "waiting": { "calls": 1, "texts": 0 },
  "arrival": { "at": 1795459900000, "source": "google", "campaign": "Search", "campaignId": "20222", "landing": "https://example.org/help", "custom": {}, "confidence": 0.92, "how": "cluster" } }
```

| Field | Meaning |
| --- | --- |
| `subject` | The caller, as the call will be recorded. `null` when they hid their number. |
| `area` | Where in Texas the number was first given out, where it was. People keep a number when they move |
| `known` | The number has called or texted before |
| `people` | Who they may be, strongest first: their ties when they are on record, or whoever has the number. Several share a number. `kinds` says why. |
| `visitor` | The one visitor who was shown the number or tapped it just before |
| `arrival` | What brought them, where it can be credited already |
| `waiting` | Their missed calls and texts nobody has returned |

### Busy numbers

A call is linked to a tap by time, so on a number that rings often, some calls follow a stranger's tap by chance. Four rules keep those few:

| Rule | Effect |
| --- | --- |
| A busy number has a shorter window | Where somebody else called or tapped the number in the last twenty minutes, a tap has to be within thirty seconds of its call. |
| A tap two callers could have made is neither's | A call from somebody else within a minute after the tap unties the first, in whichever order the two are reported. Both are `ambiguous`. A conversion already sent for an undone tie is not taken back. |
| A tie is undone and never added late | A call reported late can untie calls around it, and gives none of them a visitor it did not have. |
| A caller's own visitor is theirs | A tap by the visitor a caller is tied to already counts in the whole window, however busy the number is. |

```sh
CALL_TAP_SECONDS=180
```

A shorter window loses callers who took longer to dial. A number that is always busy needs a [pool](#number-pools): no window tells two callers apart who tap and call together.

Choose it from your own calls. Count the ties at each length, then move every tap by several amounts, such as a day and a week, to times as busy on the same number, and count again. The second counts estimate chance.

> **Twilio dates an unanswered call from the end of its ringing.** Leave room for the ringing if Twilio reports your calls, or missed calls lose their visitor.

### Twilio

Twilio can report calls directly. The server verifies Twilio's signature on each request, so the route needs no token.

1. In the Twilio console, open the phone number and set **Call status changes** to `https://graph.example.org/calls/twilio`, method POST.
2. Copy the account's **Auth Token** from the console's account page.

```sh
TWILIO_AUTH_TOKEN=…
TWILIO_WEBHOOK_URL=https://graph.example.org/calls/twilio   # exactly as entered in Twilio
```

The signature covers that address, so the two must match to the character. A request that fails the check gets 403.

| Reported by Twilio | Recorded as |
| --- | --- |
| `busy`, `no-answer`, `failed`, `canceled` | Not answered |
| `completed` | Result unknown: the call may have reached a person, a menu or voicemail |
| An outbound call | Skipped, because a forwarded call looks the same. Record outbound calls from your backend. |

> **Do not point an `action` address at this server.** The response to `<Dial action>`, `<Record action>` and similar tells Twilio what the call does next. Handle those in your own application, and record the result as a `call_update` from there. Status callbacks expect no instructions and get none.

### Other providers

Record each call from your backend.

| Field | Meaning |
| --- | --- |
| `key` | The provider's id for the call |
| `direction` | `inbound`, or `outbound` for a call you placed |
| `from`, `to` | Who called, and the number dialed. Leave `from` out where the caller hid it. |
| `at` | When the call began, in epoch milliseconds |
| `duration` | How long it lasted, in seconds |
| `result` | The [result](#call-results), if already known: `{ answered, voicemail?, waited? }` |

### A call tracking service

A service that swaps the numbers on your pages can stay. Keep its script, and have your backend record each of its finished calls. Taps are matched only if the script changes the `tel:` address of the link as well as the text, and `phone_click` is in `EVENTS`.

```text
visitor taps the number it put there ──▶ POST /collect, kind event: that number, when
the service's webhook ──▶ your backend ──▶ record a call { key, from, to, at, duration, … }
```

| Field | From the service |
| --- | --- |
| `key` | Its own id for the call, so a report sent twice counts once |
| `from` | Inbound: the caller's number. Outbound: yours. |
| `to` | Inbound: the number the visitor saw and dialed, not the one it was forwarded to, because a tap is matched on it. Outbound: the customer's number. |
| `at` | Its start time as epoch milliseconds. Convert a time with a zone. |
| `duration` | Seconds. Check its unit. |
| `result` | `answered: true` only where a person, and not a menu or a machine, is known to have answered. `answered: false` for a known miss, with `voicemail: true` where it went there. Leave `result` out when unknown, and report the [result](#call-results) later. |
| `direction` | `outbound` for calls you placed |

CallRail's API documents a call with `customer_phone_number`, `tracking_phone_number`, `start_time`, `duration`, `answered`, `voicemail` and `direction`. Check the body your account sends, and its signature, before relying on any field. [`examples/call-tracking.ts`](../examples/call-tracking.ts) takes its webhook, checks the signature and records the call, and keeps calls while the server is away. No such service has been tried against a live account here.

> **List its numbers or none.** With `CALL_NUMBERS` set, a tap on a number that is neither in it nor in the pool leaves no note to match a call by. Add each number the service shows, or leave `CALL_NUMBERS` unset.

## Number pools

A number pool shows each visitor a number of their own for a while, so a call dialed by hand is linked to them without a tap. Pools are off until you set the numbers:

```sh
POOL_NUMBERS=+15550100101,+15550100102,+15550100103
```

Mark the numbers to replace on your pages, and add `pool=1` to the script tag:

```html
<a href="tel:+15550100100" data-ag-pool>Call (555) 010-0100</a>
<script type="module" src="https://graph.example.org/collect.js?pool=1"></script>
```

| When | What happens |
| --- | --- |
| A visitor with a visit from an ad, a campaign or another site opens the page | They get the number they had last, or else the one that has rested longest, for `POOL_MINUTES` |
| The page stays in view | The page renews the number every five minutes |
| The page is hidden or closed | The lease expires, and the page shows its own number again |
| Every number is taken | The page keeps its own number. The Health view counts the request as exhausted. |
| A call reaches a pool number | It is linked at 0.90 to the visitor holding the number when the call began. For `POOL_GRACE_MINUTES` after a lease ends, the last holder still gets the call unless someone has held the number since. Where somebody else held it less than `POOL_GRACE_MINUTES` before, either may be dialing it, so the call is the holder's only if they tapped the number just before. One caller per visitor still applies, as do separations. |
| The number has no holder | A tap decides, as for any other number |

A number is held by one visitor at a time, across all servers. One network gets numbers for three browsers in ten minutes. `forget` removes a visitor from their leases and keeps the record that the number was held; `account-graph prune` deletes leases that ended before its day.

The page's own number also stays for staff, declared bots, visitors who opted out of advertising, and those without a visit in the last 90 days.

> **Size the pool.** Count the visitors with an ad click who come within `POOL_MINUTES` and `POOL_GRACE_MINUTES` together, at your busiest hours. That is enough for each number to rest for its grace, because whoever had it may still dial it. With fewer, a call to a number that did not rest needs a tap to be anyone's, and the exhausted count says how often there was none to show. Report calls to them as for any other number.

## Call results

A result says whether a person spoke to the caller. It is true, false or unknown, independent of call length. Report it from your backend, before or after the call itself:

```bash
curl -X POST https://graph.example.org/v1/record -H "authorization: Bearer $GRAPH_TOKEN" -d '{ "entries": [
  { "type": "call_update", "key": "result-CA1", "at": 1795460200000, "call": "CA1", "change": { "kind": "result", "result": { "answered": true, "waited": 12 } } }] }'
```

```json
{ "results": [{ "type": "call_update", "key": "result-CA1", "ok": true, "value": { "duplicate": false, "stands": true, "state": "answered", "counted": true, "followUp": null } }] }
```

`state` is `waiting` until the call itself is recorded.

| Field | Meaning |
| --- | --- |
| `answered` | A person spoke to the caller. Required. |
| `voicemail` | The caller reached voicemail. Refused together with `answered: true`. |
| `waited` | Seconds before someone answered or the caller gave up |

`at` is when the result was said. The newest by `at`, then by `key`, stands whole, whatever order they arrive in. A call with `answered: false` is **missed**: linked and credited like any call, counted under **Missed calls** in the report, and excluded from outcomes.

### Held calls

With `CALL_RESULTS=expected`, a call is held until its result arrives: it is left out of outcomes and conversions.

```text
call reported ──▶ waiting ──▶ result: answered ──▶ counted, and sent
                         ├──▶ result: not answered ──▶ missed or voicemail
                         └──▶ no result in 30 minutes ──▶ unknown, still not counted
                                                    (a later result settles it)
```

`CALL_RESULT_WAIT` sets the 30 minutes, counted from the end of the call. Set `CALL_RESULTS` only if a system posts results; otherwise every call stays unknown and uncounted.

Without the setting, a call is counted by its length when it is reported. If a later result says it was missed, it leaves the report as an outcome, and its conversion changes too.

| Conversion | When the call turns out missed |
| --- | --- |
| Not yet sent | Held, and not sent |
| Sent to a platform that can restate (Google) | Its value becomes 0. The platform may still count it as a conversion. |
| Sent to any other platform (Meta, Microsoft, TikTok) | It stays, and the job's note says so |

## Callbacks

Report the calls you place as well, and each missed call shows whether it was returned.

```bash
curl -X POST https://graph.example.org/v1/record -H "authorization: Bearer $GRAPH_TOKEN" -d '{ "entries": [
  { "type": "call", "key": "CB1", "at": 1795463600000, "direction": "outbound", "from": "+15550100001", "to": "+15550100041", "duration": 80, "result": { "answered": true } }] }'
curl -X POST https://graph.example.org/v1/lookup -H "authorization: Bearer $GRAPH_TOKEN" -d '{ "kind": "record", "type": "call", "key": "CA2", "at": 1795463700000 }'
```

```json
{ "type": "call", "subject": "caller:5b1e…", "at": 1795460000000, "direction": "inbound", "state": "missed", "followUp": { "state": "returned", "by": "CB1", "delay": 3600000, "attempts": 0 }, "notLead": null }
```

The `callbacks` [report](http.md#report) lists the missed calls nobody has returned, oldest first.

| State of a missed call | Meaning |
| --- | --- |
| `open` | The caller has not been reached since. `attempts` counts the calls you placed without a known answer. |
| `returned` | You called and the same number answered. `delay` is the time from the missed call, in milliseconds. |
| `called again` | The caller called again and got through |
| `hidden` | The caller hid their number, so a callback is not possible. A [reported return](#reported-returns) makes it `returned`. |

For an outbound call, `from` is your number and `to` is theirs, kept as its hash. Outbound calls are excluded from outcomes, and record no identifier about the person called.

Calls after the missed one decide its state, whatever order they are reported in. One answered call closes every earlier missed call of that number.

### Reported returns

Report a caller reached another way, such as by text, in person or from an unreported line:

```bash
curl -X POST https://graph.example.org/v1/record -H "authorization: Bearer $GRAPH_TOKEN" -d '{ "entries": [
  { "type": "call_update", "key": "return-CA1", "at": 1795467300000, "call": "CA1", "change": { "kind": "returned", "reachedAt": 1795467200000 } }] }'
```

```json
{ "results": [{ "type": "call_update", "key": "return-CA1", "ok": true, "value": { "duplicate": false, "stands": true, "state": "missed", "counted": false, "followUp": { "state": "returned", "by": "CA1", "delay": 7200000, "reported": true, "attempts": 1 } } }] }
```

`reported` marks a return known only from such a report. The call summary counts these separately.

| Rule | Behavior |
| --- | --- |
| `at` | When it was said |
| `reachedAt` | When the caller was reached |
| Scope | Closes every missed call of that caller that began before `reachedAt` |
| Eligibility | Applies to a missed call, from after it began. An answered call that reached them sooner takes precedence. |
| `not_returned` | Withdraws the report |
| Order | The newest by `at`, then by `key`, stands. It may arrive before the call. |

## Call tags

Tags attach facts to a call, such as the language chosen at the prompt. A tracking number can carry tags too.

```sh
CALL_NUMBERS='{"+15550100001":{"source":"listing","tags":{"office_advertised":"north","language":"es"}}}'
```

```json
{ "type": "call", "key": "CA1", "at": 1795460000000, "direction": "inbound", "from": "+15550100041", "to": "+15550100001", "duration": 140, "tags": { "language": "es" } }
```

A call's tags are copied to its outcome. A number's tags go on the visit recorded for a call filed under that number; a call linked to a visitor uses the visitor's own visit instead. The report [breaks down](report.md#breakdowns) by either.

### Listing numbers

A map, business listing, directory or printed page loads no script. Give each its own number in `CALL_NUMBERS`, outside the pool. Its calls are filed under that listing unless a tap links them to a visitor:

```sh
CALL_NUMBERS='{
  "+15550100104": { "source": "listing", "medium": "map", "campaign": "Map listing, River", "tags": { "office_advertised": "river" } },
  "+15550100106": { "source": "listing", "medium": "map", "campaign": "Map listing, North", "tags": { "office_advertised": "north" } }
}'
```

## Calls view

Open `/review#/calls`. The view is read-only and covers the days you pick, in the server's time zone.

| Section | Shows |
| --- | --- |
| **Missed calls** | Oldest first: age, time, credited source, wait, number of attempts, and a link to the caller. A missed call is listed in the period it began in, however long it stays open. |
| **Call results** | Answered, missed, voicemail, waiting, unknown, and how many missed callers were returned or called again |
| **By hour and weekday** | The measure you pick, with the number in every cell |
| **Call attribution** | Calls matched to a visitor, attributed by phone number, or unmatched, and how many have no result |

Callers are stored as a hash of their number, so the view shows an ID. To find the number, look up the call's time in your phone system.

## Limitations

| Area | Detail |
| --- | --- |
| Channel numbers | Without a [pool](#number-pools), two visitors who tap a number within the tap window (three minutes by default, see [Busy numbers](#busy-numbers)) cannot be told apart, and a call dialed by hand is filed under the number's channel. |
| Forged taps | A program can send taps. With `CALL_NUMBERS` set, the server keeps taps on tracking numbers only. It trusts three browsers per network in ten minutes, and links one caller per visitor. A forged tap can still make a call `ambiguous`. |
| One caller per visitor | The rule is permanent. Each hidden call is its own caller, so a visitor linked to one is skipped for the next. |
| Saved pool numbers | A call after the grace period is not linked to the visitor who saved the number, and one during another visitor's lease is linked to that visitor in error, unless the caller dialed that number before, when it was not that visitor's, or is tied to somebody already and the lease has ended, or the number was shown to that visitor within the grace and they did not tap it. More numbers mean longer rests and fewer errors. |
| Copied pages | A saved or printed page keeps showing a pool number. |
| Pool numbers | People behind one address, such as an office, share the three-browser limit. Carriers may label a number that many strangers are called back from. |
| Tap window | Thirty seconds are allowed for clock differences. `CALL_TAP_SECONDS`, or `phones.tapSeconds` in the library, changes the three minutes. See [Busy numbers](#busy-numbers). |
| Conversions | A counted call goes to an ad platform only when the `call` step in `STAGES` has an action. The caller's hashed number is sent as a match key. |
| Returns by number | A caller reached on a different number leaves the missed call open, unless you [report the return](#reported-returns). |
| Older calls | A call recorded before calls were stored has no state, and a result for it finds no call. Its outcome stays counted. |
| Retention | `forget` deletes a caller's calls and results. `account-graph prune` deletes results whose call did not arrive, and keeps calls. |
| Verification | Twilio's statuses and callback behavior were read from its documentation in November 2026; the console's field names were not. The signature check matches the example on Twilio's webhook security page. No real Twilio request has been received. |
