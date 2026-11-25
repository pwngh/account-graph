# Library

Call account-graph from a Node program, with the store you choose. Every server feature is a function.

## Installation

Run the TypeScript source from a checkout with Node 22.18 or later. The package is unpublished on npm.

```sh
npm install
npm test
DATABASE_URL=postgres://localhost/yourdb npm test
npm run build   # writes dist/, which the package's entry points use
```

CI scans every commit for keys and tokens. To run the same scan before each local commit, install [gitleaks](https://github.com/gitleaks/gitleaks) and enable the hook:

```sh
git config core.hooksPath .githooks
```

## Usage

Record what each account was seen with on any event. `observe` returns the cluster changes the event caused, so you can hold a login or trade before it settles.

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

Pass `onChange` to `createGraph` for a callback, after each write commits, with the subjects that changed cluster.

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

Use this in a desktop client, on Node or in Electron's main process. It hashes the operating system's machine id with a constant of your app, so the raw id stays on the machine.

```ts
import { hardwareId } from 'account-graph/hardware'

let hardware = await hardwareId('my-game-client') // 'hardware:9c1f…'
// Send it with the login. The server observes it on the account.
```

| Platform | Source |
| --- | --- |
| macOS | `IOPlatformUUID` |
| Windows | `MachineGuid` |
| Linux | `/etc/machine-id` |

### Fingerprint

The browser receives an event id. The server confirms it with Fingerprint and reads the visitor id there, so a page cannot claim another person's fingerprint.

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

A tampered browser, a bad bot, or an event older than five minutes gives no fingerprint. `openFingerprint` returns the unconfirmed open-source FingerprintJS id, recorded as the weaker `canvas` kind.

### MaxMind

MaxMind classifies each address. A VPN, proxy, data center, phone carrier, campus or office address is recorded and then ignored, so it links no subjects.

```ts
import { createMaxMindLookup } from 'account-graph/maxmind'

let ipInfo = createMaxMindLookup({ accountId: 123456, licenseKey: process.env.MAXMIND_KEY })
```

`createDatabaseLookup` does the same from local MaxMind databases opened with the `maxmind` package.

### Server

`createHandler` combines these integrations. `/collect` takes browser visits from your sites, and `/review` serves the reviewer screen. Other routes take calls from your services with a bearer token.

```ts
import { createServer } from 'node:http'
import { createHandler } from 'account-graph/server'

createServer(
  createHandler(graph, {
    token: process.env.GRAPH_TOKEN,
    reviewers: { dana: process.env.DANA_TOKEN! },
    origins: ['https://example.org', 'https://example.com'],
    fingerprint,
    ipInfo,
  }),
).listen(8080)
```

With `cookie: true`, `/collect` keeps the device id in a cookie the server sets. Safari deletes a script-set cookie after seven days. A server-set cookie lasts, and page script can neither read nor change it.

Serve `/collect` from the site's own domain, or from a subdomain with `cookie: { domain: 'example.org' }`.

### Reviewer screen

The handler serves a screen at `/review`. It lists the largest clusters, shows each subject's links and the reasons, draws the links, and shows money moved and every sighting. Run `npm run review` to try it with made-up data.

A reviewer can separate two accounts, join two, stop linking through an identifier, or delete a subject (`forget`). Each action takes a reason, stored in the audit log.

| Property | Behavior |
| --- | --- |
| Page | One file without outside assets, data or secrets. The browser runs only the script it shipped with and contacts only its own server. |
| Token | The reviewer enters it. The page keeps it for that browser tab. |
| `reviewers` | One token per reviewer. Decisions are signed with the reviewer's name. The token cannot record observations, transfers or conversions. |
| Lists | Loads 50 clusters at a time, suggests subjects as you type, and lists the newest cluster changes. |

### Consent

A browser that sends the Global Privacy Control signal is still recorded, because fraud checks do not depend on advertising consent. Its ad click and analytics id are dropped, and no data about it goes to an ad platform.

```ts
collect({ endpoint, consent: { adUserData: true, adPersonalization: false } }) // the banner's answer
await graph.consent('contact:1001', { adUserData: true, adPersonalization: true }, { at, source: 'form' }) // or from your server
```

### Google tag and Google Ads

`collect` reads the click id from the URL: `gclid`, `gbraid`, `wbraid`, and the Meta, Microsoft and TikTok ids. It falls back to the Google tag's `_gcl_aw` cookie, reads the Analytics client id from `_ga`, and keeps its own first-party device id in the `ag_device` cookie. With a visit it sends Meta's browser id from `_fbp`, when Meta's pixel has set one.

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

Record the outcome in the outbox, which sends it to each ad platform.

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

| Platform | Match data |
| --- | --- |
| Google | One click id: `gclid`, else `gbraid`, else `wbraid` |
| Meta | `fbc`, built from `fbclid` and the click time, with `fbp` where the site runs Meta's pixel |
| Microsoft | `msclkid` |
| TikTok | `ttclid` |

Each platform also gets the email and phone hashed the way it matches them, as a fallback when the click id is lost. Google and Meta hash a Gmail address and a phone number differently, so keys are stored per platform.

## The outbox

`record` stores an outcome and returns at once. The email and phone are hashed before storage. Recording the same `transactionId` again is a no-op, and recording it with different details is refused.

`run` sends what is due. For each job it asks the graph for the click at that moment, so evidence that arrived after the outcome still counts.

| Event | Result |
| --- | --- |
| The platform accepts the request | `sent`, with its request id, the click and its confidence |
| Rate limit, outage, bad credential, network error | Stays `pending`. Retried after 30 seconds, doubling to an hour, shortened by up to half |
| Still failing after 8 tries | `failed`, with the last error |
| The platform rejects a request for one bad event | Each event is sent alone, and only the bad one is `failed` |
| Without a trusted click, email or phone | Stays `pending` with the note `no_match_key`, and is looked at again in case the person is tied to a click. `skipped` seven days after it happened (`patience`) |
| The person, or the browser that clicked, refused ad measurement, including after an outcome that said yes | `skipped`: `consent_denied` |
| The outcome is older than the platform accepts: 7 days for Meta, 90 for Microsoft | `skipped`: `too_old` |
| A click below 0.9 confidence that is not in the person's cluster, with an email or phone | Sent with the email or phone alone |

A worker claims a job by moving its due time one minute ahead. If the worker dies, the job comes due again for another. On PostgreSQL the claim locks its rows, so any number of workers can call `run` at once.

Delivery is at least once. A job sent twice after a crash carries the same `transactionId`. Meta keeps the first copy, and Google treats the second as a restatement of the same value.

`restate` changes an outcome's value after a refund or correction and sends it again. Google overwrites the value it holds.

```ts
await outbox.restate('enroll-1001', 120)
```

`delay` holds a new outcome before its first send. `graph.forget` deletes a subject's jobs along with everything else about it. `outbox.forget` does the same and reports what had [reached a platform](privacy.md#data-at-ad-platforms).

### Steps and alerts

`withStage` fills an outcome's value, currency and action from a list of your steps. `onFailed` receives the jobs that failed permanently, and `createAlerter` posts them to a webhook.

```ts
import { createAlerter, createOutbox, withStage } from 'account-graph'

const steps = { inquiry: { value: 5, action: { google: '111' } }, client: { value: 200, action: { google: '333' } } }
const alert = createAlerter({ url: process.env.ALERT_WEBHOOK })
const outbox = createOutbox(graph, store.outbox, { targets, onFailed: (jobs) => alert('conversions', `${jobs.length} conversions failed`) })

await outbox.record(withStage(steps, { transactionId: 'client-1001', subject: 'account:42', at: Date.now(), stage: 'client' }))
```

### Failed conversions

`list` shows the jobs in one state with each reason. `retry` requeues a transaction's failed and skipped jobs.

```ts
await outbox.list('failed')      // [{ transactionId, target, note: 'Google refused the request with 400: …', … }]
await outbox.retry('enroll-1001')
```

## Campaign report

`outcome` counts something a subject did, `spend` records campaign costs, and `report` compares the two per campaign.

```ts
import { googleCosts } from 'account-graph/costs'

await graph.outcome({ transactionId: 'enroll-1001', subject: 'account:42', at: Date.now(), stage: 'enrolled', value: 200, currency: 'USD' })
await graph.spend(await googleCosts({ customerId, developerToken, accessToken })('2026-11-01', '2026-11-14'))

const { rows, total } = await graph.report({ from: '2026-11-01', to: '2026-11-14', timeZone: 'America/New_York' })
// rows[0]: { source: 'google', campaignId: '20111', campaign: 'Search: garden tools', cost: 873.6, visits: 9,
//            stages: { enrolled: { count: 3, value: 600 } }, outcomes: 3, value: 600, … }
```

`outbox.record` calls `outcome`, so an outcome sent to an ad platform is counted once. `restate` changes the value in both places. See [the report](report.md) for its inputs and columns.

## Phone calls

`recordCall` records a call from any telephone provider. It links the call to the one visitor who tapped the number shortly before, or files it under the number's channel.

```ts
import { recordCall } from 'account-graph'

const call = await recordCall(graph, { id: 'CA1', from: '+15558675309', to: '+15551230001', at: Date.now(), duration: 140 }, {
  numbers: { '+15551230001': { source: 'google', campaignId: '20222' } },
})
// { subject: 'caller:96f2…', flags: [], counted: true, visitor: 'visitor:fb91…', duplicate: false }
```

See [Page events and phone calls](calls.md) for the flags and for checking Twilio's reports.

## Signed links

`knownLink` makes a URL that names the recipient. The server, given the same secret as `linkSecret`, links the browser that opens it to that person.

```ts
import { knownLink } from 'account-graph'

const url = knownLink('https://example.org/offer', 'contact:42', { secret: process.env.LINK_SECRET })
```

See [Signed links](links.md) for link strength and carrying a visitor between sites.

## Write queue

PostgreSQL writes run one at a time. `createBatcher` queues observations that arrive during a write and sends them together in the next. `observe` with a list writes all of it or none: one identifier of a kind the policy lacks refuses the list, where `createBatcher` refuses only the observation that has it.

```ts
import { createBatcher } from 'account-graph'

let queue = createBatcher(graph)
await queue.observe({ subject: 'account:1', identifiers: ['email:…'], at: Date.now() })
```

An idle system writes at once, without a timer. A bad observation fails alone.

## Journey

`journey` returns everything recorded about a person, in order, across their subjects.

```ts
let { entries, subjects } = await graph.journey('contact:42')
// entries: { at, subject, kind: 'visit' | 'sighting' | 'call' | 'outcome' | 'value' | 'consent' | 'decision', … }
// subjects[subject]: { how: 'self' | 'cluster' | 'linked', score, via, kinds }
```

The person is the subject's cluster, plus any subject linked strongly enough that its visits would be credited. A subject separated from any of them is excluded. `ties` gives the reason and score for each subject. An outcome's conversions are held in the outbox, and `GET /journey` adds them.

## Reviewer decisions

```ts
await graph.ignore('email:…', true, { by: 'dana', reason: 'front desk mailbox' })
await graph.separate('account:7', 'account:9', true, { by: 'dana', reason: 'siblings' })
await graph.join('account:1', 'account:2', { by: 'dana', reason: 'same caller' })
```

| Decision | Behavior |
| --- | --- |
| `separate` | Holds whatever the two share later. Withdraw it with `false`. It can be recorded before either account exists. |
| `join` | The strongest link. A separation still wins: joining an account to one side of a separated pair pulls it away from the other. |
| `ignore` | Stops linking through an identifier. |

A join leaves a mark on both subjects, `review:join-` and its decision number. `ignore` the mark to take the join back. The audit log keeps both decisions, and `reviewed()` stops counting the pair.

| Query | Returns |
| --- | --- |
| `undecided()` | Pairs that are related but unjoined, and joins that two dates of birth left out, strongest first. Reads subjects of the newest 10,000 sightings. |
| `clusters()` | The largest clusters, the starting point for review. |
| `search('account:4')` | Subjects by the start of their id. |
| `recent()` | The newest cluster changes. |
| `changes({ after })` | Every cluster change after a number, oldest first, with the number to pass next. |

On the benchmark's 124,000 edges in PostgreSQL, `undecided()` took 0.13 seconds, against 0.33 to score every pair. Only the latter grows with the graph.

### Audit log

Every `ignore`, `separate`, `join`, `forget` and `rebuild` is appended to the audit log. Each entry carries a hash of itself and the one before, so editing or deleting an entry breaks every later hash.

```ts
await graph.decisions() // [{ seq: 1, at, action: 'ignore', about: ['email:…'], by: 'dana', reason, hash }, …]
await graph.audit()     // { sound: true }
```

### Past state

`asOf` rebuilds the graph in memory as it stood at a time, from the sightings recorded and decisions made up to then. It uses the recording time, so an event that arrived late is absent from earlier states.

```ts
let then = await graph.asOf(Date.parse('2026-06-01'))
await then.cluster('account:7')
```

### Log retention

Every observation adds rows to the sighting log. `prune` deletes rows recorded before a time and logs a decision. Links and clusters stay the same, because each edge keeps its first and last sighting and its count.

```ts
await graph.prune(Date.now() - 180 * 24 * 60 * 60 * 1000, { by: 'ops', reason: '180 day retention' })
```

`history`, `consentHistory` and `asOf` lose what was deleted. Advertising answers are deleted too, except each subject's current one.

## Money flows

Flows record who pays whom. Collusion is value moving between accounts that are the same person or linked to one another.

```ts
let tie = await graph.transfer({ id: 'trade-81', from: 'account:2', to: 'account:1', amount: 250_000, at: Date.now(), asset: 'gold' })
// tie.relation: 'same' | 'related' | 'none', with the score and reasons. Hold the trade on anything but 'none'.

await graph.flows('account:1')     // every counterparty: sent, received, count, imbalance, and the tie
await graph.collusion('account:1') // only those tied by identity, with three or more flows
```

`id` is yours, one per flow. Repeating a flow with the same details, `at` included, adds no record and answers `duplicate: true`, so retries are safe. The same id with other details is refused.

`amount` is a whole number of the asset's smallest unit. `imbalance` is 1 when value moved one way only.

`rings` finds value that left a subject and returned through others: A paid B, B paid C, C paid A.

```ts
await graph.rings('account:1')
// [{ subjects: ['account:1', 'account:2', 'account:3'], asset: 'gold', amount: 700, tied: 1 }]
```

A ring's `amount` is the least that moved on any step, and so the most that could have gone all the way round. `tied` counts the others in the subject's cluster. Rings of up to four subjects are found by default. Pass a second argument for longer ones.

## Fitting the weights

`measure` reports how often each kind was right on pairs that shared only that kind. `fit` sets every weight at once from pairs checked by hand, using the graph's scoring formula. A kind that mostly appears beside a stronger one is credited only with its own accuracy.

```ts
import { fit } from 'account-graph'

// Every pair a reviewer joined or separated, with what the two share.
let checkedPairs = await graph.reviewed()
let { policy, kinds, loss, calibration } = fit(checkedPairs, defaultPolicy)
// kinds.fingerprint: { before: 0.97, after: 0.94, pairs: 812 }
let graph = createGraph(store, policy)
await graph.rebuild()
```

## Limitations

- **Hardware id.** The client reports it, so a modified client can send a false value.
- **Restatement.** Google has no way to retract a conversion. Meta, Microsoft and TikTok cannot restate one.
