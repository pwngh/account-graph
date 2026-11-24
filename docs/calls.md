# Page events and phone calls

The script tag reports what a visitor does on a page, and a phone call that follows a tap on your number is tied to the visitor who tapped. So a call lands under the ad click that produced it.

```html
<a href="tel:+15551230001">Call us</a>
<button data-ag-event="brochure">Request a brochure</button>
```

```sh
EVENTS=brochure,phone_click \
CALL_NUMBERS='{"+15551230001":{"source":"google","campaignId":"20222"}}' \
npm start
```

Tap the number on the page, then report the call the way a phone provider would:

```sh
curl -X POST https://graph.example.org/call -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"id":"CA1","from":"+15558675309","to":"+15551230001","at":1795460000000,"duration":140}'
```

```json
{ "subject": "caller:96f2c503…", "flags": [], "counted": true, "state": "unknown", "visitor": "visitor:fb919054…", "duplicate": false }
```

`visitor` is the browser that tapped. The caller and that visitor are now one cluster, and the call is in [the report](report.md) under the visitor's campaign.

```text
visitor taps the number ──▶ POST /event ──▶ a note on the visitor: which number, when
phone provider ──▶ POST /call ──▶ caller ──▶ tied to the one visitor who tapped just before
                                        └──▶ otherwise filed under the number's own channel
```

## Page events

A page reports an event in one of three ways. None needs the service token.

| On the page | Reported as |
| --- | --- |
| A link whose address starts with `tel:` | `phone_click`, with the number |
| Any element with `data-ag-event="name"` | `name`, when clicked; on a form, when submitted |
| `accountGraph.event('name', { id })` from your own script | `name` |

The server keeps only the names listed in `EVENTS`, and refuses the rest with 400. Each kept event is an outcome of that step in the report, credited like any other.

An event counts once a day per browser. Give it an id, with `data-ag-id` or the `id` argument, to count each occurrence: one per form submission, say. An id is ignored for a step that has a value or an action in `STAGES`: those count once a day per browser, whatever the page says.

An event whose name is a step in `STAGES` takes that step's value, and is sent to the ad platforms the step names. [Steps](report.md#steps-and-what-each-is-worth) has the setting.

> **A page can be made to say anything.** Events come from browsers, so anyone can send one. A step listed in both `EVENTS` and `STAGES` lets a browser create a conversion of that value, once a day per browser, limited per address. Keep such steps small, an inquiry and not a sale, and record anything that carries real money from your backend with `POST /convert`.

## Phone calls

When a call is reported, the server does four things in order.

1. **The caller becomes a subject carrying their phone number.** An account that later gives the same number is tied to the call, and the call to the account.
2. **It looks for a tap.** If exactly one visitor tapped that number in the three minutes before the call began, the caller and the visitor are linked at 0.92, enough to join them. The call then follows the visitor's own arrival: their ad click, their campaign. One visitor is tied to one caller: a visitor already tied to a different caller is passed over, so a browser cannot collect call after call by tapping again. A visitor a reviewer has kept apart from the caller is passed over too.
   Where the number is one of a [pool](#a-number-for-each-visitor), the visitor it was shown to comes before any tap.
3. **Otherwise it uses the number.** The call is filed under the channel `CALL_NUMBERS` gives that number, with the medium `call`.
4. **A call of 30 seconds or more is counted** as an outcome of the step `call`. A shorter one is recorded and not counted. Where [results are expected](#was-it-answered), only a call a person answered is counted.

The answer carries flags for what was noticed:

| Flag | Meaning | Effect |
| --- | --- | --- |
| `blocked` | The caller hid their number, or the carrier reported one of the placeholder numbers that stand for "anonymous". | The call ties to nobody by phone. A tap can still tie it to a visitor. |
| `toll_free` | The caller's number is a toll-free line: a switchboard or a machine. | The number is not used to tie the call to anyone. |
| `short` | It ended before `CALL_MIN_SECONDS`. | Recorded, not counted. |
| `repeat` | This number has called before. | None. It is there for you to act on. |
| `pool` | The number rung was shown to one visitor, and the call is tied to them. | None beyond the tie. |
| `left_out` | The other number is in `CALL_EXCLUDE`: your own people, or a test phone. | Nothing is recorded. |
| `ambiguous` | More than one visitor tapped the number just before. | Tied to none of them; filed under the number's channel. |

Reporting the same call id again writes nothing and answers `"duplicate": true`. If the second report carries a result, the result is taken.

## A number for each visitor

Few people tap a phone link. Most read the number and dial it, and such a call is filed under the number's channel and no more. A number pool shows each visitor who arrived from somewhere a number of their own for a while, so the call is theirs without a tap. It is off until you name the numbers:

```sh
POOL_NUMBERS=+15550100101,+15550100102,+15550100103
```

Mark what may change on your pages, and add `pool=1` to the script tag:

```html
<a href="tel:+15550100100" data-ag-pool>Call (555) 010-0100</a>
<script type="module" src="https://graph.example.org/collect.js?pool=1"></script>
```

| When | What happens |
| --- | --- |
| A visitor with an arrival on record opens the page | They get the free number that has rested longest, for `POOL_MINUTES`. |
| The page stays in view | The number is kept, asked for again every five minutes. |
| The page is hidden or closed | Nobody renews it. It runs out, and the page shows its own number again. |
| Every number is taken | The page keeps its own number. `/stats` and the Health view count it as exhausted. |
| A call comes to the number | It is tied, at 0.90, to the visitor who held it when the call began. Otherwise to the last one who did, for `POOL_GRACE_MINUTES` after, if nobody has held it since. One visitor is still tied to one caller, and a visitor a reviewer keeps apart from the caller is passed over. |
| Nobody held it | A tap decides, as on any other number. |

No number is given to a visitor with no arrival in the last 90 days, to one who opted out of advertising, to your own staff, or to a declared bot. One network gets numbers for three browsers in ten minutes. No two visitors hold one number at one time, however many servers you run. `forget` removes a visitor from their turns, and keeps only that the number was held then. `prune` deletes turns that ended before its time.

> **Size it before you buy.** Count the visitors with an ad click whose visits overlap within `POOL_MINUTES` at your busiest hour. Start there, watch the exhausted count, and add numbers while it grows. Report every call to the pool's numbers to `/call` or through Twilio, as with any other number.

## Was it answered?

A phone system that picks up has not answered anyone. A caller who waits thirty seconds in a queue and hangs up looks, to the provider, like a completed call. So `answered` is true, false, or not known, and it is never worked out from how long a call lasted.

Whoever runs your phones knows. Have your backend say so, before or after the call itself is reported:

```sh
curl -X POST https://graph.example.org/call/result -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"id":"CA1","answered":true,"waited":12}'
```

```json
{ "state": "answered", "counted": true }
```

| Field | Meaning |
| --- | --- |
| `answered` | A person spoke to the caller. Required. |
| `voicemail` | The caller reached voicemail. Not together with `answered: true`. |
| `waited` | Seconds before someone answered or the caller gave up. |

Report it again and the last report stands. A call with `answered: false` is **missed**: tied to its visitor and campaign like any call, listed under **Missed calls** in the report, and never an outcome.

### Waiting for the result

With `CALL_RESULTS=expected`, a call is held until its result arrives: not counted, and not sent to any ad platform. So nothing is sent that would have to be taken back.

```text
call reported ──▶ waiting ──▶ result: answered ──▶ counted, and sent
                         ├──▶ result: not answered ──▶ missed or voicemail
                         └──▶ no result in 30 minutes ──▶ unknown, still not counted
                                                    (a later result settles it)
```

Without the setting, a call is counted by its length as it is reported. If a result then says nobody answered, the call leaves the report and reads as missed. Where it had already been sent, its value is restated to nothing on the platforms that can restate. The others keep it. Google can restate. Meta, Microsoft and TikTok cannot.

| What was sent | What happens when the call turns out missed |
| --- | --- |
| Not yet | It is held and never sent. |
| To a platform that can restate | Its value becomes 0 there. It may still be counted there as a conversion. |
| To any other platform | It stays, and the job notes that it does. |

Turn `CALL_RESULTS` on only when something posts results. Without one, every call reads as unknown and none is counted.

## Was it returned?

Report the calls you place as well, and each missed call says what became of it.

```sh
curl -X POST https://graph.example.org/call -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"id":"CB1","direction":"outbound","from":"+15550100001","to":"+15550100041","at":1795463600000,"duration":80,"answered":true}'
curl "https://graph.example.org/call?id=CA2" -H "authorization: Bearer $REVIEWER_TOKEN"
```

```json
{ "id": "CA2", "state": "missed", "followUp": { "state": "returned", "by": "CB1", "delay": 3600000, "attempts": 0 } }
```

| State of a missed call | Meaning |
| --- | --- |
| `open` | Nobody has spoken to the caller since. `attempts` is how often you rang and nothing says they answered. |
| `returned` | You rang and the same number answered. `delay` is the time from the miss, in milliseconds. |
| `tried again` | The caller rang again and got through. |
| `hidden` | The caller hid their number, so there is nothing to ring back. |

A caller may be reached some way no call shows: from a line your phone system does not report, by a text they answered, in person. Have your own system say so:

```sh
curl -X POST https://graph.example.org/call/returned -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"id":"CA1","at":1795467200000}'
```

```json
{ "followUp": { "state": "returned", "by": "CA1", "delay": 7200000, "told": true, "attempts": 1 } }
```

`at` is when they were reached, now unless you say. It closes that miss and every earlier one of the same caller, as an answered call would, and not a later one. A call that reached them sooner is what counts. `returned: false` takes it back, and the last report stands. It may come before the call it is about. `told` marks a return that rests on such a report, and the summary counts them apart, so it can be told from one a call shows.

A call before the miss says nothing about it. One later answer closes every earlier miss of that number. The answer is worked out from the calls themselves each time, so the order they are reported in does not matter.

A call you place is never an outcome and records nothing about who was rung. For an outbound call, `from` is your number and `to` is theirs. The number is kept as its hash.

## What a call was about

A call can carry facts, such as the language chosen at the prompt, and a tracking number can say what it stands for.

```sh
CALL_NUMBERS='{"+15550100001":{"source":"listing","tags":{"office_advertised":"north","language":"es"}}}'
curl -X POST https://graph.example.org/call -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"id":"CA1","from":"+15550100041","to":"+15550100001","at":1795460000000,"duration":140,"tags":{"language":"es"}}'
```

A call's tags go on to its outcome. A number's tags go on the arrival a call to it is filed under, so a call that follows a visitor's own tap takes the visitor's instead. [The report](report.md#breaking-it-down) breaks down by either.

### One number for each listing

A map listing, a directory or a printed page loads no script, so nothing can be shown to one visitor and nobody taps. Give each its own number in `CALL_NUMBERS`, and never one from the pool. Then a call to it that no tap ties to a visitor is filed under that listing:

```sh
CALL_NUMBERS='{
  "+15550100104": { "source": "listing", "medium": "map", "campaign": "Map listing, River", "tags": { "office_advertised": "river" } },
  "+15550100106": { "source": "listing", "medium": "map", "campaign": "Map listing, North", "tags": { "office_advertised": "north" } }
}'
```

## The Calls view

Open `/review#/calls`. It shows, over the days you pick and in the server's time zone:

- **Missed and not returned**, oldest first: how long ago, when, what the call is credited to, how long the caller waited, and how often you have tried. Each links to the caller.
- **How calls went**: answered, missed, voicemail, waiting, unknown, and how many of the missed were returned or tried again.
- **By hour and weekday**: pick what to count. The number is in every cell.
- **Coverage**: how many calls are tied to a visitor, filed under a channel only, or neither, and how many have no result.

> **No phone numbers.** A caller is kept as a hash of their number, so the screen shows a subject. Find the number in your phone system by the time of the call. The view is read-only.

A missed call stays in its own period: one from before the first day shown is not listed, however open it is.

### From Twilio

Twilio can report each call itself. The server checks every request against Twilio's signature, so the route needs no token.

1. In the Twilio console, open the phone number and set **Call status changes** to `https://graph.example.org/calls/twilio`, method POST.
2. Copy the account's **Auth Token** from the console's account page.

```sh
TWILIO_AUTH_TOKEN=…
TWILIO_WEBHOOK_URL=https://graph.example.org/calls/twilio   # exactly as entered in Twilio
```

The signature is made from that address, so the two must match to the character. A request that fails the check gets 403.

This callback only reports: Twilio expects no instructions in its answer, and gets none. Calls you place are not taken from Twilio, because a forwarded call looks like one: post those from your backend. A status of `busy`, `no-answer`, `failed` or `canceled` is recorded as not answered. `completed` means Twilio connected the call, to a person, a menu or voicemail, so it answers nothing.

> **Do not point an `action` address at this server.** The answer to `<Dial action>`, `<Record action>` and the like is what the call does next, so this server would take over the call. Let your own application handle those, and post the result to `/call/result` from there.

### From any other provider

Post the same facts to `/call` with the service token: the provider's id for the call, who called, the number rung, when it began in epoch milliseconds, and how many seconds it lasted. Add `answered`, `voicemail` and `waited` if you know them already.

## Limits

| Limit | Detail |
| --- | --- |
| One number per channel | Without a [pool](#a-number-for-each-visitor), a tracking number stands for one channel, so two visitors tapping within the same three minutes cannot be told apart. |
| Taps can be faked | A tap comes from a browser, so a program can send one. Three guards limit what that buys: only your tracking numbers are noted, one network is believed from three browsers in ten minutes and no more, and one visitor is tied to one caller. A fake tap at the right moment can still turn a real call `ambiguous`, which files it under the number's channel instead. |
| One caller per visitor | The rule above holds for good. A visitor tied to one hidden caller is not tied to another hidden call later, because each hidden call is a caller of its own. |
| Taps only | A visitor who reads the number and dials it by hand leaves no tap. Without a pool, that call is filed under the number's channel. |
| A pool number is remembered | People save numbers. A call weeks later, past the grace or after the number went to someone else, is not the first visitor's, and one within the turn of another visitor is wrongly that visitor's. A longer rest between turns, from more numbers, makes this rarer. |
| A pool number is for a page | Maps, business listings, print and anything else without the script need numbers of their own, in `CALL_NUMBERS`. A copy of the page made while a number is shown, such as a saved or printed one, keeps showing it. |
| A pool at its peak | When visitors outnumber numbers, the rest see the page's own number. People behind one address, such as an office, share the three browsers. Carriers may label a number that many strangers are called back from. |
| The tap window | Three minutes before the call began, with thirty seconds of allowance for clocks that disagree. `clickWindow` changes it in the library. |
| Sending calls to ad platforms | A counted call is always in the report. It is sent to an ad platform when the `call` step in `STAGES` has an action; the caller's number goes along, hashed, as a match key. |
| Returned from another line | A caller is their number. Reached on a different number, the miss stays open. |
| Calls from before | A call recorded before calls were kept has no state, and a result for it finds no call. Its outcome stays counted. |
| Retention | `forget` deletes a caller's calls and results. `prune` deletes results whose call never came, and keeps calls. |
| Not confirmed | Twilio's statuses and what its callbacks expect were read from its documentation in November 2026. The console's field names were not. The signature check was run against the example on Twilio's webhook security page and matches it. No real Twilio request has been received. |
