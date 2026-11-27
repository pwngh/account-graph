# Calls and texts

The script tag reports what a visitor does on a page. A phone call that follows a tap on your number is linked to the visitor who tapped, and credited to the ad click that brought them. A [text](#text-messages) from your site is tied to its visit by a code or a tap.

```html
<a href="tel:+12025550101">Call us</a>
<button data-ag-event="brochure">Request a brochure</button>
```

```sh
EVENTS=brochure,phone_click \
CALL_NUMBERS='{"+12025550101":{"source":"google","campaignId":"20222"}}' \
npm start
```

In a rehearsal, intercept the tap so it never opens the dialer. Record a synthetic call on loopback. The curl examples read the authorization header from the private file described in [First record](getting-started.md#first-record).

```bash
curl -q --noproxy 127.0.0.1 -X POST http://127.0.0.1:8080/v1/record -H "@${GRAPH_AUTH_HEADER_FILE:?}" -d '{ "entries": [
  { "type": "call", "key": "CA1", "at": 1795460000000, "direction": "inbound", "from": "+12025550141", "to": "+12025550101", "duration": 140 }] }'
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

## Recording who was on one call

Two people can use the same line. When staff know who an individual call concerned, send a `call_update` for its provider ID. For example, someone at the desk took a call from a parent about their child.

<!-- schema RecordRequest -->
```json
{ "entries": [{ "type": "call_update", "key": "desk-017", "at": 1795460200000, "call": "C17",
  "change": { "kind": "party", "role": "representative", "subject": "record:child", "by": "intake" } }] }
```

| Role | What staff learned | Who sees the call |
| --- | --- | --- |
| `self` | Staff spoke to the named record's person. | That record. |
| `representative` | Someone spoke for the named record's person. | That record. |
| `excluded` | Staff know the call did not concern the named record. | It stays under its call ID until someone identifies the person. |
| `unknown` | Staff take back the earlier identification. Omit `subject`. | It stays under its call ID. |

The newest statement wins, by `at` and then by key in byte order. It can arrive before the call. Use a new key for a correction. Results and reported returns have their own order. The call lookup keeps the statements and who made each one. After a deletion, a new statement can name the returning record once it has a fresh observation, such as a profile, and the call is on file with a start time after the deletion. A staff merge alone cannot establish a return. For an earlier or missing call the statement receives `FORGOTTEN`. A refused new key can be retried after the call arrives.

For a staff desk, read the statement when the editor opens and keep its key until the reviewer saves. This also works before the phone report arrives.

```ts
const shown = await graph.lookup({ kind: 'party', call: 'C17' })
const { results } = await graph.record({ entries: [{
  type: 'call_update', key: 'desk-018', call: 'C17', at: 1795460300000,
  change: { kind: 'party', role: 'self', subject: 'record:17', by: 'intake', seen: shown?.key ?? null },
}] })
```

If the entry returns `STALE`, show the current statement and let the reviewer decide whether to retry the edit. Its entry key is still available. Taking back an identification with `role: "unknown"` creates a statement, so the next editor sends that statement's key. While its receipt is kept, a retry of an accepted entry answers `duplicate: true` and reports whether it still stands. Deletion takes precedence and can return `FORGOTTEN`.

Forgetting a former party removes their statements. A call since confirmed for another record stays with that record, along with its outcome and value. Forgetting the original line of a recorded call still deletes it. If the phone report has yet to arrive, the current party statement determines whether the pending call stays.

After a recorded call has a party statement, a later phone report or a competing tap leaves its details intact. Staff can still update its result, return or party. The call also loses the channel visit supplied by its tracking number. Visits from other calls at the same instant keep their sources.

The call, its outcome and its value history belong to the exact record staff named, even when another record shares its cluster. Its callback is closed by a return for the same record. Reports credit the newest qualifying arrival on that record or on the visitor tied to this particular call by its tap, code or pool number. A valid code reported later can supply that visitor or replace an earlier tap for the same call. A visitor grouped with another named record cannot supply that credit. An unassigned call earns no person's ad credit. When only the private call tie connects the visitor and the record, the callback and pipeline rows give the campaign and leave the arrival empty. The visitor's arrival appears in the record's journey only if the graph links them independently. Grouping a visitor with another record or muting the call tie revises cached campaign reports and removes callback notices that depended on that credit. The next call on the line needs its own confirmation. A call without a statement follows the usual rules.

A party statement stops new ad conversions for this call. A platform that already received the conversion can still receive a corrected value, a refund or a withdrawal where it supports these. Those adjustments use only the matching details sent for the original conversion. A representative's number and consent belong to the representative. Each batch and each single-job retry checks the current job as it starts the request. If a correction or deletion changes the graph while a worker is finding credit, the worker checks credit and consent again for the affected batch before sending. A request already in flight can still reach the platform.

## Page events

A page reports events without the service token, in one of three ways.

| On the page | Reported as |
| --- | --- |
| A link whose address starts with `tel:` | `phone_click`, with the number |
| A link whose address starts with `sms:` | `text_click`, with the number. See [text messages](#text-messages). |
| Any element with `data-ag-event="name"` | `name`, when clicked, or on a form when submitted |
| `accountGraph.event('name', { id })` from your own script | `name` |

The server keeps the names listed in `EVENTS` and answers 400 to any other. Each event is an outcome of the step with its name. A step in `STAGES` adds its value and the ad platforms it names. See [Steps](report.md#steps).

An event counts once a day per browser, as a conversion whose key begins with `page:`. To count each occurrence, such as each form submission, pass an id in `data-ag-id` or the `id` argument. The id is ignored for a step with a value or an action in `STAGES`.

> **Page events can be forged.** Anyone can send one from a browser. A step in both `EVENTS` and `STAGES` lets a browser create a conversion of that value, once a day per browser, limited per address. Keep such steps small, such as an inquiry, and record sales from your backend as a `conversion`.

## Phone calls

The server processes a reported call in four steps.

1. **Caller.** The caller becomes a subject carrying their phone number. An account that later gives the same number is linked to the call.
2. **Visitor.** If exactly one visitor tapped the number within the tap window before the call, and no other caller could have made the same tap, the two are linked at 0.92, which joins them. The tap window is three minutes by default, and thirty seconds on a [busy number](#busy-numbers). For a [pool](#number-pools) number, the visitor it was shown to takes precedence over a tap. A [code](#a-code-read-out) the caller gave takes precedence over both.
3. **Channel.** A call without a visitor is filed under the channel `CALL_NUMBERS` gives the number, with the medium `call`.
4. **Outcome.** A call of 30 seconds or more counts as an outcome of the step `call`. Where [results are expected](#call-results), a person must also have answered.

Each visitor is linked to one caller. Visitors already linked to another caller, or separated from this caller by a reviewer, are skipped.

`key` is the provider's id. Recording it again answers `"duplicate": true`. A result in the second report counts by its `at`, as a [result](#call-results) reported by itself would. A [code](#a-code-read-out) the call did not have yet counts too. The rest is ignored. See [idempotency](http.md#idempotency).

A retry of a call recorded before call details were kept still answers `duplicate` if its line was later excluded.

| Flag | Meaning | Effect |
| --- | --- | --- |
| `blocked` | The caller hid their number, or the carrier sent a placeholder for "anonymous" | The phone number links to no one. A tap can still link the call to a visitor. |
| `toll_free` | The caller's number is toll-free: a switchboard or a machine | The number is excluded from linking |
| `short` | The call ended before `CALL_MIN_SECONDS` | Recorded without being counted |
| `repeat` | This number has called before | None |
| `pool` | The number dialed was shown to one visitor | The call is linked to that visitor |
| `code` | The caller's code names one visitor | The call is linked to that visitor |
| `taken` | It names a visitor already linked to another caller or sender, or separated from this caller | The call is linked to no visitor, whoever tapped |
| `left_out` | The other number is in `CALL_EXCLUDE`: your own people, or a test phone | The call is not recorded |
| `ambiguous` | More than one visitor tapped the number just before, or another caller could have made the same tap | Filed under the number's channel |

### A code read out

A caller who sees a code on the page can read it to whoever answers. It says which visit the call came from, whatever number they dialed, for as long as the code is good.

```html
<p>Calling us? Your code is <b data-ag-code></b></p>
<script type="module" src="https://graph.example.org/collect.js?text=1"></script>
```

Set `TEXT_CODES=true` on the server, or `textCodes` in the library. Without it no page is given a code, and a `code` you send names nobody. The code is the one [text links](#text-messages) carry. The script puts it in every element marked `data-ag-code`, and leaves them as you wrote them for a visitor who is given none. To hide the sentence then, use `p:has([data-ag-code]:empty) { display: none }`.

<!-- schema RecordEntry -->
```json
{ "type": "call", "key": "CA1", "at": 1795460000000, "direction": "inbound", "from": "+12025550141", "to": "+12025550101", "duration": 140, "code": "K7Q2MX" }
```

| Rule | Detail |
| --- | --- |
| Who it names | The one visitor it was given to, for 30 days, in capital or small letters. The call is linked to them at 0.95. |
| A tap or a pool number | Not used where a code names somebody, even if that visitor is `taken`. Such a call is no rival for another's tap. |
| One caller per visitor | As for a tap and for a text |
| A code that names nobody | Wrong, too old, or given to two. The call is recorded as if it had none, with neither flag. |
| Hidden numbers | A code links them too. |
| A call you placed | Its code is not used. |
| Kept | The code is not stored with the call, and is in no answer. |

Staff often type the code after the phone system has reported the call. Send the same `call` again with the `code`, and no `call_update`. The call then stands as if the first report had it. What it was linked to by a tap or a pool number is undone, and the caller's visit to the number's channel is taken back. Four things depend on when it arrives, because they were decided before it did:

| Already decided | Stays |
| --- | --- |
| A conversion sent with the guessed visit | As sent |
| A call of somebody else that this one's guess left `ambiguous` | Without a visitor: [a tie is never added late](#busy-numbers). |
| The code's visitor was linked to another caller meanwhile | Theirs. This call is `taken`. |
| A reviewer restored this call's tie | The reviewer's word. The code is not used. |

The first code that names somebody stands. Codes are not kept, so a second one that differs cannot be compared with the first, and is ignored.

> **Have staff type it, not a phone menu.** A code is six of 30 letters and digits, so a guess hits one of 10,000 codes in use about once in 70,000 tries. Six digits from a keypad would hit one in every hundred, and a menu can be dialed by a program. A menu that takes speech can send what it heard. Do not let callers try codes without limit there either.

### While the phone rings

The `caller` [lookup](http.md#lookup) says who is calling, for the screen of whoever picks up. Nothing is written, so record the call as usual when it ends.

```http
POST /v1/lookup

{ "kind": "caller", "from": "+12025550141", "to": "+12025550101", "at": 1795460000000 }
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

When staff join a line to two records they have kept apart, both are `related` possibilities while it rings. Each keeps its own evidence and score.

### Busy numbers

A call is linked to a tap by time, so on a number that rings often, some calls follow a stranger's tap by chance. Four rules keep those ties few:

| Rule | Effect |
| --- | --- |
| A busy number has a shorter window | Where somebody else called or tapped the number in the last twenty minutes, a tap has to be within thirty seconds of its call. |
| A tap two callers could have made is neither's | A call from somebody else within a minute after the tap unties the first, in whichever order the two are reported. Both are `ambiguous`. A conversion already sent for an undone tie is not taken back. |
| A tie is undone and never added late | A call reported late can untie calls around it, and gives none of them a visitor it did not have. |
| A caller's own visitor is theirs | A tap by the visitor a caller is tied to already counts in the whole window, however busy the number is. |

```sh
CALL_TAP_SECONDS=180
```

`CALL_TAP_SECONDS`, or `phones.tapSeconds` in the library, changes the three minutes. Thirty seconds are allowed for clock differences.

A shorter window loses callers who took longer to dial. A number that is always busy needs a [pool](#number-pools). No window tells apart two callers who tap and call together.

Choose it from your own calls. Count the ties at each length, then move every tap by several amounts, such as a day and a week, to times as busy on the same number, and count again. The second counts estimate the ties made by chance.

The Twilio adapter estimates when a call began from the callback timestamp, or the receipt time, minus connected seconds. Ring time and delivery delay can move a missed call outside the tap window. See [Twilio status callbacks](https://www.twilio.com/docs/voice/twiml#statuscallback-request-parameters).

### Twilio

Replay the public Twilio signature with `node --test test/provider-fixtures.test.ts`. This runs locally and needs no account. A live callback also exercises the number's routing and the public receiver. Twilio's legacy test credentials do not generate these callbacks. See [Signed example](https://github.com/twilio/twilio-go#validating-requests) and [Test credentials](https://www.twilio.com/docs/iam/test-credentials).

1. For voice on a dedicated configurable number, open **Active Numbers**, select the number, and under **Voice** set **Call status changes** to your public HTTPS `/calls/twilio` route. Choose POST and save. Leave the voice instructions URL in place. On the shared trial, **Inbound** under **Try out Voice** offers scenarios. A final status callback there is **not verified**. Skip the voice check if this setting is absent. See [Number settings](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource) and [Trial voice](https://www.twilio.com/docs/usage/trials/try-out-voice).
2. For incoming SMS on a dedicated SMS-capable number, under **Messaging** set **A message comes in** to **Webhook** with your HTTPS `/texts/twilio` route, choose POST and save. On the shared trial, open **Try out SMS**, then **Inbound**, then **Auto-Reply settings**, and choose **Custom**. The trial sender must use their verified handset. If you already have an SMS responder, have it record incoming texts. See [Incoming messages](https://www.twilio.com/docs/messaging/guides/webhook-request) and [Trial SMS](https://www.twilio.com/docs/usage/trials/try-out-sms).
3. The owner supplies the account's **Auth Token** privately and the external URLs exactly as configured. The receiver verifies the default form signature in `X-Twilio-Signature` with that token. A separate shared-key signing configuration needs a different verifier. See [Webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security) and [Shared-key settings](https://www.twilio.com/docs/usage/webhooks/webhook-shared-keys).

```sh
TWILIO_AUTH_TOKEN=…
TWILIO_WEBHOOK_URL=https://graph.example.org/calls/twilio        # exactly as entered in Twilio
TWILIO_TEXT_WEBHOOK_URL=https://graph.example.org/texts/twilio   # for texts, the same
```

The signature covers that address, so the two must match to the character. A request that fails the check gets 403.

An incoming text receives HTTP 200 with empty TwiML, `<Response/>`, so the graph sends no reply. Delivery reports for outbound texts are ignored. Have the sending system record its own texts with `"direction": "outbound"`. A final voice callback receives HTTP 204. After testing, restore the QA number's prior settings. See [Messaging status callbacks](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status).

| Reported by Twilio | Recorded as |
| --- | --- |
| `busy`, `no-answer`, `failed`, `canceled` | Not answered |
| `completed` | Result unknown: the call may have reached a person, a menu or voicemail |
| An outbound call | Skipped, because a forwarded call looks the same. Record outbound calls from your backend. |

> **Do not point an `action` address at this server.** The response to `<Dial action>`, `<Record action>` and similar tells Twilio what the call does next. Handle those in your own application, and record the result as a `call_update` from there. Status callbacks expect no instructions and get none.

### PostgreSQL write counts

The [call write test](../test/call-write.test.ts) counts SQL for a new 60-second inbound call with no previous sightings, taps, party statements, channel or provider lookups. A signed Twilio `completed` callback and a `record` entry each take 51 statements in 50 trips.

### Other providers

Record each call from your backend, with these fields:

| Field | Meaning |
| --- | --- |
| `key` | The provider's own id for the call, so a report sent twice counts once |
| `from` | Inbound: the caller's number. Leave it out where the caller hid it. Outbound: yours. |
| `to` | Inbound: the number the visitor saw and dialed, not the one it was forwarded to, because a tap is matched on it. Outbound: the customer's number. |
| `at` | When the call began, in epoch milliseconds. Convert a time with a zone. |
| `duration` | How long it lasted, in seconds. Check its unit. |
| `result` | `{ answered, voicemail?, waited? }`. `answered: true` only where a person, and not a menu or a machine, is known to have answered. `answered: false` for a known miss, with `voicemail: true` where it went there. Leave `result` out when unknown, and report the [result](#call-results) later. |
| `direction` | `inbound`, or `outbound` for a call you placed |
| `code` | The [code](#a-code-read-out) the caller read out, when they did |

### A call tracking service

A service that swaps the numbers on your pages can stay. Keep its script, and have your backend record each of its finished calls. Taps are matched only if the script changes the `tel:` address of the link as well as the text, and `phone_click` is in `EVENTS`.

```text
visitor taps the number it put there ──▶ POST /collect, kind event: that number, when
the service's webhook ──▶ your backend ──▶ record a call { key, from, to, at, duration, … }
```

For CallRail, first run `node --test test/provider-fixtures.test.ts test/call-tracking.test.ts`. A signed made-up post exercises the receiver's verifier and call mapping offline. CallRail's own sample payload, key and signature can be tried the same way. Fixture tests for taps and call mapping need no number-swapping script. On a QA site using CallRail's own script, disable form capture unless it is part of the test. See [Signature and sample](https://apidocs.callrail.com/#validating-payloads) and [Form capture](https://apidocs.callrail.com/#form-capture).

1. Run [the forwarder](../examples/call-tracking.ts) with `node examples/call-tracking.ts`. Give it a private `SPOOL` directory, the graph's `GRAPH_URL` and `GRAPH_TOKEN`, and the QA company's webhook `SIGNING_KEY` through its private process settings. The key is on that company's Webhooks configuration page. Forward only HTTPS `POST /calls` to the forwarder, on port 3001 by default. See [CallRail signing](https://apidocs.callrail.com/#validating-payloads).
2. In the QA company's **Integrations**, open **Webhooks**, enter the receiver's URL under **Post-call** for inbound calls and save. **Outbound post-call** is a separate subscription. Only enable the direction under test. CallRail can deliver an inbound report up to 20 minutes after hangup and does not retry failed deliveries. See [Console setup](https://support.callrail.com/hc/en-us/articles/5711246459149-Webhooks) and [Timing and delivery](https://apidocs.callrail.com/#post-call-webhook).
3. The receiver checks the `Signature` header against the exact request bytes before parsing. A bad signature gets 401. A valid call is spooled before the 204 response and forwarded under `callrail-<id>` so a repeat is counted once. Compare direction, dialed number, zoned start and duration with your call log. Review any refused files privately and remove the test webhook afterward. See [Post-call fields](https://apidocs.callrail.com/#post-call-webhook).

CallRail can report `answered: true` for a phone menu or answering system. The forwarder maps an explicit voicemail or miss and leaves a bare positive answer unknown in either direction. So an answered call no longer closes a missed one or counts under `CALL_RESULTS=expected` until staff report it. Where only people answer these numbers, start the forwarder with `ANSWERED_BY=person`. An outbound attempt alone cannot close an earlier missed call. Have staff report a confirmed conversation with a [call result](#call-results), and set `CALL_RESULTS=expected` to hold inbound outcomes until that confirmation. See [CallRail answer definition](https://support.callrail.com/hc/en-us/articles/5712132142605-Unanswered-calls-report).

> **List its numbers or none.** With `CALL_NUMBERS` set, a tap on a number that is neither in it nor in the pool leaves no note to match a call by. Add each number the service shows, or leave `CALL_NUMBERS` unset.

## Number pools

A number pool shows each visitor a number of their own for a while, so a call dialed by hand can be linked without a tap. The graph leases numbers already in its list. To receive actual calls, provision each line separately with your phone provider and configure its call routing and callbacks. For a local test, use fictional numbers, intercept taps and replay call records. See [Twilio number configuration](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource).

```sh
POOL_NUMBERS=+12025550101,+12025550102,+12025550103
```

Mark the numbers to replace on your pages, and add `pool=1` to the script tag:

```html
<a href="tel:+12025550100" data-ag-pool>Call (202) 555-0100</a>
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

Set `POOL_REQUIRE_TAP_AFTER_REASSIGNMENT=true` or `phones.pool.requireTapAfterReassignment: true` if callers may save the number. When the lease history shows an earlier holder, a caller with no tie to a visitor needs a tap or a code to identify their visit, however long the number rested. This applies when the call rings and when it is recorded. Renewals by the same visitor still count as one holder. Pruning removes expired leases from this history. The option is off by default.

A number is held by one visitor at a time, across all servers. One network gets numbers for three browsers in ten minutes. [Privacy](privacy.md#deletion) says what `forget` and `prune` do with leases, calls and results.

The page's own number also stays for staff, declared bots, visitors who opted out of advertising, and those without a visit in the last 90 days.

> **Size the pool.** Count the visitors with an ad click who come within `POOL_MINUTES` and `POOL_GRACE_MINUTES` together, at your busiest hours. That is enough for each number to rest for its grace, because whoever had it may still dial it. With fewer, a call to a number that did not rest needs a tap to be anyone's, and the exhausted count says how often there was none to show. Report calls to them as for any other number.

## Call results

A result says whether a person spoke to the caller. It is true, false or unknown, independent of call length. Report it from your backend, before or after the call itself:

```bash
curl -q --noproxy 127.0.0.1 -X POST http://127.0.0.1:8080/v1/record -H "@${GRAPH_AUTH_HEADER_FILE:?}" -d '{ "entries": [
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

With `CALL_RESULTS=expected`, a call is held until its result arrives. Until then, it is left out of outcomes and conversions.

```text
call reported ──▶ waiting ──▶ result: answered ──▶ counted, and sent
                         ├──▶ result: not answered ──▶ missed or voicemail
                         └──▶ no result in 30 minutes ──▶ unknown, still not counted
                                                    (a later result settles it)
```

`CALL_RESULT_WAIT` sets the 30 minutes, counted from the end of the call. Set `CALL_RESULTS` only if a system posts results. Otherwise, every call stays unknown and uncounted.

Without the setting, a call is counted by its length when it is reported. If a later result says it was missed, it leaves the report as an outcome, and its conversion changes too.

| Conversion | When the call turns out missed |
| --- | --- |
| Not yet sent | Held, and not sent |
| Sent to a platform that can restate (Google) | Its value becomes 0. The platform may still count it as a conversion. |
| Sent to any other platform (Meta, Microsoft, TikTok) | It stays, and the job's note says so |

## Callbacks

Report the calls you place as well, and each missed call shows whether it was returned.

```bash
curl -q --noproxy 127.0.0.1 -X POST http://127.0.0.1:8080/v1/record -H "@${GRAPH_AUTH_HEADER_FILE:?}" -d '{ "entries": [
  { "type": "call", "key": "CB1", "at": 1795463600000, "direction": "outbound", "from": "+13125550101", "to": "+13125550141", "duration": 80, "result": { "answered": true } }] }'
curl -q --noproxy 127.0.0.1 -X POST http://127.0.0.1:8080/v1/lookup -H "@${GRAPH_AUTH_HEADER_FILE:?}" -d '{ "kind": "record", "type": "call", "key": "CA2", "at": 1795463700000 }'
```

```json
{ "type": "call", "subject": "caller:5b1e…", "at": 1795460000000, "direction": "inbound", "state": "missed", "followUp": { "state": "returned", "by": "CB1", "delay": 3600000, "attempts": 0 }, "notLead": null }
```

The `callbacks` [report](http.md#report) lists the missed calls nobody has returned, oldest first.

Correcting an earlier call leaves a later callback alert and its event in place when the later miss, callback attempts and paid visit are independent. If the corrected or erased call had closed an earlier wait, that earlier miss can become due again. Its new alert replaces the later wait's notice.

| State of a missed call | Meaning |
| --- | --- |
| `open` | The caller has not been reached since. `attempts` counts the calls you placed without a known answer. |
| `returned` | You called and the same number answered. `delay` is the time from the missed call, in milliseconds. |
| `called again` | The caller called again and got through |
| `hidden` | The caller hid their number, so a callback is not possible. A [reported return](#reported-returns) makes it `returned`. |

For an outbound call, `from` is your number and `to` is theirs, kept as its hash. Outbound calls are excluded from outcomes, and record no identifier about the person called.

Calls after the missed one decide its state, whatever order they are reported in. One answered call closes earlier misses assigned to the same subject. For a call staff identified, that subject is its stated record.

### Reported returns

Report a caller reached another way, such as by text, in person or from an unreported line:

```bash
curl -q --noproxy 127.0.0.1 -X POST http://127.0.0.1:8080/v1/record -H "@${GRAPH_AUTH_HEADER_FILE:?}" -d '{ "entries": [
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
| `by` | Optional. Who says so. A reviewer's token may record a return or its withdrawal signed with the reviewer's own name. |
| Order | The newest by `at`, then by `key`, stands. It may arrive before the call. |
| Checks | None. A report is applied as received. |

## Call tags

Tags attach facts to a call, such as the language chosen at the prompt. A tracking number can carry tags too.

```sh
CALL_NUMBERS='{"+13125550101":{"source":"listing","tags":{"office_advertised":"north","language":"es"}}}'
```

<!-- schema RecordEntry -->
```json
{ "type": "call", "key": "CA1", "at": 1795460000000, "direction": "inbound", "from": "+13125550141", "to": "+13125550101", "duration": 140, "tags": { "language": "es" } }
```

A call's tags are copied to its outcome. A number's tags go on the visit recorded for a call filed under that number. A call linked to a visitor uses the visitor's own visit instead. The report [breaks down](report.md#breakdowns) by either.

### Listing numbers

A map, business listing, directory or printed page loads no script. Give each its own number in `CALL_NUMBERS`, outside the pool. Its calls are filed under that listing unless a tap links them to a visitor:

```sh
CALL_NUMBERS='{
  "+12025550104": { "source": "listing", "medium": "map", "campaign": "Map listing, River", "tags": { "office_advertised": "river" } },
  "+12025550106": { "source": "listing", "medium": "map", "campaign": "Map listing, North", "tags": { "office_advertised": "north" } }
}'
```

## Text messages

A text reported through both `record` and the Twilio route uses the same message ID as its key. If the reports arrive together, the graph writes the message, its tie and each sighting once.

A text from your site arrives with a code that says which visit it came from. The graph ties the text to that visit and its ad, lists the texts nobody has answered, and keeps nothing that was said.

```html
<script type="module" src="https://graph.example.org/collect.js?text=1"></script>
<a href="sms:+12025550101?body=I%20need%20a%20lawyer.">Text us</a>
```

```text
tap ──▶ I need a lawyer. Ref K7Q2MX ──▶ your number ──▶ record a text ──▶ the visit, and its ad
```

Set `TEXT_CODES=true` on the server. The script asks for this browser's code and adds it to the message as the link is followed. Without an answer, the link works as you wrote it.

A browser keeps its code for a week and is then given another. A code names its browser for 30 days after it was last given, in capital or small letters.

### Recording a text

Report each text as it arrives or is sent.

```bash
curl -q --noproxy 127.0.0.1 -X POST http://127.0.0.1:8080/v1/record -H "@${GRAPH_AUTH_HEADER_FILE:?}" -d '{ "entries": [
  { "type": "text", "key": "SM1", "at": 1795460000000, "direction": "inbound", "from": "+12025550141", "to": "+12025550101", "text": "I need a lawyer. Ref K7Q2MX" }] }'
```

```json
{ "results": [{ "type": "text", "key": "SM1", "ok": true, "value": { "duplicate": false, "stands": true, "subject": "caller:96f2c503…", "flags": ["first", "code"], "counted": true, "visitor": "visitor:fb919054…" } }] }
```

`counted` says the text is an outcome of the step `text`. Report a text again with the same provider ID as its `key` until it is answered. An accepted retry answers `duplicate: true`. If it first supplies an opt-out for an inbound text, it also answers `optOutAdded: true`, adds `opt_out` to the flags and withdraws any outcome for the text. The message keeps its original time, so a later START on a different message still stands. An opt-in on a retry changes nothing. A retry keeps any channel touch or visitor link recorded with the original message. An opt-out still counts for an existing message if its sender has since been added to the exclusion list.

1. **Sender.** The sender is the same subject as a caller from that number, so their calls, their texts and a contact with that number are tied.
2. **Visitor.** The code links the text to the one visitor it was given to, at 0.95. Without a code, the one visitor who tapped your text link within the [tap window](#busy-numbers) is linked, at 0.92. Either joins the two.
3. **Lead.** The first text of a conversation is an outcome of the step `text`. A conversation ends after 30 days of silence. It is the same whatever order texts are reported in. One that arrives late can take back a lead counted from a later text. Add `text` to `STAGES` to give it a value and a column on the Board.
4. **Channel.** A text without a visitor is filed under the channel `CALL_NUMBERS` gives its number, with the medium `text`.

> **What a text says is never stored.** It is read for the code and for a word such as STOP, and dropped. To keep it from reaching the server at all, read the code yourself and send `code` in place of `text`.

| Flag | Meaning |
| --- | --- |
| `first` | It begins a conversation, and is counted |
| `code` | The code named the visitor |
| `taken` | It named a visitor already tied to another caller or sender, so the two are not tied |
| `tap` | The visitor tapped the text link just before |
| `ambiguous` | More than one visitor tapped it just before, so none is tied |
| `opt_out`, `opt_in` | It was STOP or START, or a word that means the same. It is no lead. |
| `toll_free` | The sender's number is toll-free, and is excluded from linking |
| `left_out` | From or to a number in `CALL_EXCLUDE`, or from a number that is no phone's. It is not kept. |

### Unanswered texts

The `texts` [report](http.md#report) lists the oldest unanswered text of each sender, oldest first.

```http
POST /v1/report

{ "kind": "texts", "window": { "from": "2026-11-01", "to": "2026-11-30", "timeZone": "America/Chicago" }, "at": 1795460000000 }
```

```json
{ "asOf": 1795460000000, "value": { "rows": [{ "text": "SM1", "subject": "caller:96f2c503…", "at": 1795460000000, "unanswered": 2, "arrival": { "at": 1795459900000, "source": "google", "campaign": null, "campaignId": "30111", "landing": "https://example.org/help", "custom": {}, "confidence": 0.95, "how": "cluster" } }], "next": null } }
```

`unanswered` counts what they have sent since anyone replied. A text from you, or a call with them that someone answered, replies to every text before it, whatever order they are reported in.

The `record` lookup of a text, and the journey of its sender, say what became of it under `reply`:

| `state` | Meaning |
| --- | --- |
| `open` | Nobody has replied |
| `replied` | `by` is the text or call that did, `how` says which, and `delay` is the time it took, in milliseconds |
| `stopped` | The sender asked for no more texts before anyone replied |

Mark a sender as [no lead](report.md#not-a-lead) with a `restatement` of the text. Their texts then wait for nobody.

### Asking for no more texts

The `person` [lookup](http.md#lookup) answers `"textsOptedOut": true` when the last such word from anyone in the subject's cluster, or from a phone number that somebody in it has, was an opt-out word. The opt-out words are STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE and OPTOUT, and in Spanish ALTO, PARE, PARAR, DETENER, CANCELAR, BAJA, SALIR, TERMINAR and FIN. It answers `false` after START or UNSTOP, or when nobody has said either. A STOP is seen on everybody whose record has that number, whether or not the policy joins them to it. Within one cluster the last word stands, whichever of its numbers it came from. A START takes back nothing said from a number outside the cluster. The word counts only as the whole text. No fluent speaker has read the Spanish words, so have one read them before you rely on them.

It is kept apart from [consent](privacy.md), which is about advertising. Your own system sends the texts, so it must check its own list as well.

A form's consent to texts belongs there too: the wording shown, when, and by whom it was given. Nothing here stores it or decides who may be sent a text. Do not use a `consent` entry for it, because a no there stops advertising conversions.

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
| Forged taps | A program can send taps. With `CALL_NUMBERS` set, the server keeps taps on tracking numbers only. It trusts three browsers per network in ten minutes, and links one caller per visitor. A forged tap can still make a call `ambiguous`. |
| One caller per visitor | The rule is permanent. Each hidden call is its own caller, so a visitor linked to one is skipped for the next. |
| Calls counted by length | Without [call results](#call-results), a call is counted by its length, which time in a queue can reach. |
| Saved pool numbers | By default a call after the grace period is not linked to the visitor who saved the number, and one during another visitor's lease is linked to that visitor in error, unless the caller dialed that number before, when it was not that visitor's, or is tied to somebody already and the lease has ended, or the number was shown to that visitor within the grace and they did not tap it. `POOL_REQUIRE_TAP_AFTER_REASSIGNMENT` keeps an untied caller from being linked by the reassigned number alone. |
| Copied pages | A saved or printed page keeps showing a pool number. |
| Pool numbers | People behind one address, such as an office, share the three-browser limit. Carriers may label a number that many strangers are called back from. |
| Conversions | A counted call goes to an ad platform only when the `call` step in `STAGES` has an action. The caller's hashed number is sent as a match key. |
| Returns by number | A caller reached on a different number leaves the missed call open, unless you [report the return](#reported-returns). |
| Older calls | A call recorded before calls were stored has no state, and a result for it finds no call. Its outcome stays counted. |
| Codes read out | Whoever reads out a code is tied to the browser it was shown in, whoever's it is. Misheard letters name no code, or by chance somebody else's. |
| Deleted codes | Someone who deletes the code from the message is tied by their tap, or not at all. |
| Forwarded texts | Whoever sends a message with the code is tied to the browser it was given to. One visitor is tied to one sender. |
| Computers | A code opened on one device and sent from another ties the two, which is usually right. |
| Opt-out words | Only a message that is one of the words above is read as one. A sentence that asks to stop is not. |
| Pictures and groups | A picture is recorded as a text. Group messages are not told apart. |
| Delivery of texts | Whether a text you sent was delivered is not read. A text you report as sent counts as a reply. |
| Twilio's time | Twilio sends no time with an incoming text, so it is the time the report arrived. |
| Verification | Local tests reproduce the published Twilio and CallRail signatures and reject altered inputs. Real voice and SMS delivery, proxy configuration and phone routing still require a dedicated account and a controlled line. See [Fixture sources](../test/fixtures/providers/README.md). |
