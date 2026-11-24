# Using it as a library

The server is one way to run the graph. Everything it does is a function you can call from your own Node program, with the store you choose.

## Installing

Not published to npm yet. From a checkout, Node 22.18 or later runs the TypeScript source directly.

```sh
npm install
npm test
DATABASE_URL=postgres://localhost/yourdb npm test
npm run build   # writes dist/, which the package's entry points use
```

## Usage

```ts
import { createGraph, createMemoryStore, ip } from 'account-graph'

let graph = createGraph(createMemoryStore())

// Record what each account was seen with, on any event.
await graph.observe({
  subject: 'account:1',
  identifiers: ['hardware:9c1f…', ip('203.0.113.20')],
  at: Date.now(),
  event: 'login',
})
let changes = await graph.observe({
  subject: 'account:2',
  identifiers: ['hardware:9c1f…'],
  at: Date.now(),
  event: 'trade',
})
// changes: [{ subject: 'account:2', from: 'account:2', to: 'account:1' }]

await graph.links('account:2')
// [{ subject: 'account:1', level: 'same', score: 0.95, reasons: [{ identifier: 'hardware:9c1f…', evidence: 0.95, … }] }]
```

`observe` returns the cluster changes that one event caused, so a login or trade can be held before it settles.

### PostgreSQL

```ts
import pg from 'pg'
import { createGraph } from 'account-graph'
import { createPostgresStore } from 'account-graph/postgres'

let store = createPostgresStore(new pg.Pool({ connectionString: process.env.DATABASE_URL }))
await store.migrate()
let graph = createGraph(store)
```

## Integrations

### Hardware id

In a desktop client, on Node or in Electron's main process. Reads the operating system's machine id and hashes it with a constant of your app, so the raw id never leaves the machine.

```ts
import { hardwareId } from 'account-graph/hardware'

let hardware = await hardwareId('my-game-client') // 'hardware:9c1f…'
// Send it with the login. The server observes it on the account.
```

It reads `IOPlatformUUID` on macOS, `MachineGuid` on Windows, and `/etc/machine-id` on Linux. The client reports it, so a modified client can lie.

### Fingerprint

The browser gets an event id. The server confirms it with Fingerprint and reads the visitor id there, so a page cannot claim someone else's fingerprint.

```ts
// Browser
import { collect } from 'account-graph/collect'
import { fingerprintEvent } from 'account-graph/fingerprint/browser'

collect({
  endpoint: 'https://graph.example.org/collect',
  fingerprintEvent: fingerprintEvent({ apiKey: 'PUBLIC_KEY' }),
})
```

```ts
// Server
import { createFingerprintVerifier } from 'account-graph/fingerprint'

let fingerprint = createFingerprintVerifier({ secretKey: process.env.FINGERPRINT_SECRET })
```

A tampered browser, a bad bot, or an event older than five minutes gives no fingerprint. `openFingerprint` returns the open-source FingerprintJS id instead; nothing confirms it, so it is recorded as the weaker `canvas` kind.

### MaxMind

Classifies each address. A VPN, proxy, data center, phone carrier, campus, or office address is recorded and then ignored, so it links nobody.

```ts
import { createMaxMindLookup } from 'account-graph/maxmind'

let ipInfo = createMaxMindLookup({ accountId: 123456, licenseKey: process.env.MAXMIND_KEY })
```

`createDatabaseLookup` does the same from local MaxMind databases opened with the `maxmind` package.

### The server

`createHandler` puts these together. `/collect` takes browser visits from your sites, `/review` serves the reviewer screen, and the other routes take your own services' calls with a bearer token.

```ts
import { createServer } from 'node:http'
import { createHandler } from 'account-graph/server'

createServer(
  createHandler(graph, {
    token: process.env.GRAPH_TOKEN,
    reviewToken: process.env.REVIEW_TOKEN,
    origins: ['https://example.org', 'https://example.com'],
    fingerprint,
    ipInfo,
  }),
).listen(8080)
```

### The reviewer screen

The same handler serves a screen for the people who review accounts, at `/review`. It lists the largest clusters, shows who a subject is tied to and why, draws the ties, and shows money moved and every sighting. From it a reviewer can keep two accounts apart, join two, stop linking through an identifier, or forget a subject, each with a reason that goes on the record.

The page is one file with no outside assets. It holds no data and no secret: the reviewer types the access token, and the browser may run only the script the page shipped with and talk only to the server it came from. Give reviewers their own token with `reviewToken`. It opens what the screen needs and nothing your services write through, so a reviewer cannot record observations, transfers, or conversions. The page keeps the token for that browser tab. Try it over made-up data with `npm run review`.

The screen loads 50 clusters at a time, suggests subjects as you type, and lists the newest cluster changes.

With `cookie: true`, `/collect` keeps the device id in a cookie the server sets. Safari deletes a cookie set by script after seven days; one set by the server lasts, and script cannot read or change it. It needs `/collect` to be served from the site's own domain, or a subdomain with `cookie: { domain: 'example.org' }`.

### Consent

A browser that sends the Global Privacy Control signal is still seen, because fraud checks do not depend on advertising consent. Its ad click and analytics id are not kept, and nothing about it goes to an ad platform.

```ts
collect({ endpoint, consent: { adUserData: true, adPersonalization: false } }) // the banner's answer
await graph.consent('contact:1001', { adUserData: true, adPersonalization: true }, { at, source: 'form' }) // or from your server
```

### Google tag and Google Ads

`collect` reads the click id from the URL (`gclid`, `gbraid`, `wbraid`, and Meta's and Microsoft's), falls back to the Google tag's `_gcl_aw` cookie, and reads the Analytics client id from `_ga`. It keeps its own first-party device id in the `ag_device` cookie.

When someone enrolls, your server reads `ag_device` from the request and observes the new contact with it.

```ts
await graph.observe({
  subject: 'contact:1001',
  identifiers: [`device:${cookies.ag_device}`, email(form.email)],
  at: Date.now(),
  event: 'enroll',
})

let attribution = await graph.attribute('contact:1001', { at: Date.now() })
// attribution.reason: 'credited' | 'low_confidence' | 'no_touch'
```

Then record the outcome in the outbox, which sends it to each ad platform.

```ts
import { createOutbox, googleAds, ingest, meta, microsoftAds, tiktok } from 'account-graph'
import { createGoogleTokens } from 'account-graph/google-auth'

let token = createGoogleTokens(JSON.parse(serviceAccountKeyFile))
let outbox = createOutbox(graph, store.outbox, {
  targets: [
    googleAds({ customerId: '123-456-7890', send: async (request) => ingest(request, await token()) }),
    meta({ pixelId: '555', accessToken: process.env.META_TOKEN, url: 'https://example.org/' }),
    microsoftAds({ accessToken: microsoftToken, developerToken, customerId: '11', customerAccountId: '22' }),
    tiktok({ pixelCode: 'C4…', accessToken: process.env.TIKTOK_TOKEN, url: 'https://example.org/' }),
  ],
})

await outbox.record({
  transactionId: 'enroll-1001',
  subject: 'contact:1001',
  at: Date.now(),
  // What the outcome counts as on each platform: an action id, an event name, a goal name, an event name.
  action: { google: '987654321', meta: 'Lead', microsoft: 'Enrolled', tiktok: 'CompleteRegistration' },
  value: 200,
  email: form.email,
})

let stop = outbox.start(30_000) // send what is due, every 30 seconds
```

Google gets one click id per conversion: `gclid`, else `gbraid`, else `wbraid`. Meta gets `fbc`, built from the `fbclid` and the time of the click. Microsoft gets the `msclkid`, and TikTok the `ttclid`. Each gets the email and phone hashed the way it matches them, as a second key for when the click id was lost. The two hash a Gmail address and a phone number differently, so each platform's keys are stored separately.

## The outbox

`record` stores an outcome and returns at once. The email and phone are hashed before they are stored. Recording the same `transactionId` again does nothing; recording it with different details is refused.

`run` sends what is due. For each job it asks the graph for the click at that moment, so evidence that arrived after the outcome still counts.

| What happens | Result |
| --- | --- |
| The platform accepts the request | `sent`, with its request id, the click, and its confidence |
| Rate limit, outage, bad credential, network error | Stays `pending`; tried again in 30 seconds, doubling to an hour |
| Still failing after 8 tries | `failed`, with the last error |
| The platform rejects a request for one bad event | Each event is sent alone; only the bad one is `failed` |
| No trusted click and no email or phone | `skipped`: `no_match_key` |
| The person, or the browser that clicked, refused ad measurement, or has since the outcome that said yes | `skipped`: `consent_denied` |
| The outcome is older than the platform accepts: 7 days for Meta, 90 for Microsoft | `skipped`: `too_old` |
| A click below 0.9 confidence, but an email or phone | Sent with the email or phone alone |

A worker takes a job by pushing its due time one minute ahead. If the worker dies, the job comes due again and another worker takes it. On PostgreSQL the claim locks its rows, so any number of workers can call `run` at once.

Delivery is at least once. A job sent twice after a crash carries the same `transactionId`. Meta keeps the first copy; Google reads the second as a restatement of the same value, which changes nothing.

`restate` changes an outcome's value after a refund or a correction and sends it again. Google overwrites the value it holds. Google has no way to retract a conversion, and Meta, Microsoft and TikTok cannot restate one.

```ts
await outbox.restate('enroll-1001', 120)
```

`delay` holds a new outcome before its first send. `forget` deletes a subject's jobs along with everything else about it.

### Steps and alerts

`withStage` fills an outcome's value, currency and action from a list of your steps. `onFailed` hears the jobs that failed for good, and `createAlerter` posts them where people will see.

```ts
import { createAlerter, createOutbox, withStage } from 'account-graph'

const steps = { inquiry: { value: 5, action: { google: '111' } }, client: { value: 200, action: { google: '333' } } }
const alert = createAlerter({ url: process.env.ALERT_WEBHOOK })
const outbox = createOutbox(graph, store.outbox, { targets, onFailed: (jobs) => alert('conversions', `${jobs.length} conversions failed`) })

await outbox.record(withStage(steps, { transactionId: 'client-1001', subject: 'account:42', at: Date.now(), stage: 'client' }))
```

### When a conversion fails

`list` shows the jobs in one state with the reason on each. `retry` puts a transaction's failed and skipped jobs back in line once you have fixed what stopped them.

```ts
await outbox.list('failed')      // [{ transactionId, target, note: 'Google refused the request with 400: …', … }]
await outbox.retry('enroll-1001')
```

## The report

`outcome` counts something a subject did. `spend` records what campaigns cost. `report` sets one beside the other, per campaign.

```ts
import { googleCosts } from 'account-graph/costs'

await graph.outcome({ transactionId: 'enroll-1001', subject: 'account:42', at: Date.now(), stage: 'enrolled', value: 200, currency: 'USD' })
await graph.spend(await googleCosts({ customerId, developerToken, accessToken })('2026-11-01', '2026-11-14'))

const { rows, total } = await graph.report({ from: '2026-11-01', to: '2026-11-14', timeZone: 'America/New_York' })
// rows[0]: { source: 'google', campaignId: '20111', campaign: 'Search: garden tools', cost: 873.6, visits: 9,
//            stages: { enrolled: { count: 3, value: 600 } }, outcomes: 3, value: 600, … }
```

`outbox.record` calls `outcome` for you, so an outcome sent to an ad platform is counted once here too. `restate` changes the value in both places. [The report](report.md) says what feeds it and how to read it.

## Phone calls

`recordCall` records a call from any telephone provider. It ties the call to the one visitor who tapped the number just before, or files it under the number's channel.

```ts
import { recordCall } from 'account-graph'

const call = await recordCall(graph, { id: 'CA1', from: '+15558675309', to: '+15551230001', at: Date.now(), duration: 140 }, {
  numbers: { '+15551230001': { source: 'google', campaignId: '20222' } },
})
// { subject: 'caller:96f2…', flags: [], counted: true, visitor: 'visitor:fb91…', duplicate: false }
```

[Page events and phone calls](calls.md) says what each flag means and how Twilio's own reports are checked.

## Signed links

`knownLink` makes an address that names the person it is sent to. The server, given the same secret as `linkSecret`, ties the browser that opens it to that person.

```ts
import { knownLink } from 'account-graph'

const url = knownLink('https://example.org/offer', 'contact:42', { secret: process.env.LINK_SECRET })
```

[Links that name a person](links.md) covers what the tie is worth and how a visitor is carried between sites.

## The write queue

PostgreSQL writes run one at a time. `createBatcher` puts a queue in front: while one write is in flight, arrivals wait and go together in the next.

```ts
import { createBatcher } from 'account-graph'

let queue = createBatcher(graph)
await queue.observe({ subject: 'account:1', identifiers: ['email:…'], at: Date.now() })
```

A quiet system writes at once; nothing waits on a timer. One bad observation fails alone.

## Reviewer decisions

```ts
await graph.ignore('email:…', true, { by: 'dana', reason: 'front desk mailbox' })
await graph.separate('account:7', 'account:9', true, { by: 'dana', reason: 'siblings' })
await graph.join('account:1', 'account:2', { by: 'dana', reason: 'same caller' })
```

A separation holds whatever the two share later, and can be withdrawn with `false`. It may be recorded before either account exists. A join is the strongest tie there is, but a separation still wins: joining an account to one side of a separated pair pulls it away from the other.

`clusters()` lists the largest clusters, which is where a reviewer should look first. `search('account:4')` finds subjects by the start of their id, and `recent()` lists the newest cluster changes.

Every `ignore`, `separate`, `join`, `forget`, and `rebuild` is appended to a record of decisions. Each entry carries a hash of itself and the entry before, so editing or deleting one breaks every hash after it.

```ts
await graph.decisions() // [{ seq: 1, at, action: 'ignore', about: ['email:…'], by: 'dana', reason, hash }, …]
await graph.audit()     // { sound: true }
```

`asOf` rebuilds the graph as it stood at a time, in memory, from the sightings written down and the decisions made up to then. It goes by when each sighting was recorded, not when it happened, so an event that arrived late is not part of a past it had not reached yet.

```ts
let then = await graph.asOf(Date.parse('2026-06-01'))
await then.cluster('account:7')
```

Pass `onChange` to `createGraph` to be told, after each write commits, which subjects changed cluster.

### Keeping the log small

Every observation adds rows to the sighting log. `prune` deletes the ones written down before a time. Links and clusters do not change, because each edge keeps its first and last sighting and its count; only `history`, `consentHistory` and `asOf` lose what was deleted. Answers about advertising go too, except the one that stands for each subject. Pruning is itself recorded as a decision.

```ts
await graph.prune(Date.now() - 180 * 24 * 60 * 60 * 1000, { by: 'ops', reason: '180 day retention' })
```

## Money flows

Identity says who is who. Flows say who pays whom. Collusion is the two together: value moving between accounts that are the same person or tied to them.

```ts
let tie = await graph.transfer({ id: 'trade-81', from: 'account:2', to: 'account:1', amount: 250_000, at: Date.now(), asset: 'gold' })
// tie.relation: 'same' | 'related' | 'none', with the score and reasons. Hold the trade on anything but 'none'.

await graph.flows('account:1')     // every counterparty: sent, received, count, imbalance, and the tie
await graph.collusion('account:1') // only those tied by identity, with three or more flows
```

`id` is yours, one per flow. A flow sent again with the same details adds nothing and answers `duplicate: true`, so a request that timed out is safe to repeat as it was, `at` included. The same id with other details is refused.

`amount` is a whole number of the asset's smallest unit. `imbalance` is 1 when value only ever moved one way.

`rings` finds value that left a subject and came back through others: A paid B, B paid C, C paid A. A per-pair report cannot show that, because no single pair looks wrong.

```ts
await graph.rings('account:1')
// [{ subjects: ['account:1', 'account:2', 'account:3'], asset: 'gold', amount: 700, tied: 1 }]
```

`amount` is the least that moved along any step, so it is the most that could have gone all the way round. `tied` counts how many of the others share the subject's cluster. Rings of up to four subjects are found by default; pass a second argument for longer ones.

## Fitting the weights

`measure` reports how often each kind was right on pairs that shared only that kind. `fit` goes further: it sets every weight at once from pairs checked by hand, using the same formula the graph scores with, so a kind that mostly appears beside a stronger one is not credited with the stronger one's accuracy.

```ts
import { fit } from 'account-graph'

// Every pair a reviewer joined or kept apart, with what the two share.
let checkedPairs = await graph.reviewed()
let { policy, kinds, loss, calibration } = fit(checkedPairs, defaultPolicy)
// kinds.fingerprint: { before: 0.97, after: 0.94, pairs: 812 }
let graph = createGraph(store, policy)
await graph.rebuild()
```
