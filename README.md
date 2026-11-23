# account-graph

Links accounts, leads, and anonymous visitors that share identifiers, and traces a conversion back to the ad click that started it.

## Features

- **Scored links with reasons.** Every link says which shared identifiers produced it and how much each counted.
- **Clusters that can split.** Clusters are derived from the record, so a bad identifier can be ignored and a person can be forgotten, and the clusters come apart correctly.
- **No chain merges.** One weak link can add an account to a group but cannot join two groups on its own.
- **Reviewer decisions.** Join two subjects, keep two apart, or mute an identifier. Each decision is recorded with who and why, and sealed so the record cannot be quietly edited.
- **Money flows.** Trades and transfers between accounts are reported with how the two are tied by identity, so collusion shows up.
- **Attribution with confidence.** A conversion lists every touch that could have led to it and credits one only when the chain of links is strong.
- **Real integrations.** Fingerprint, the operating system's machine id, MaxMind, the Google tag's cookies, Google's Data Manager API, and Meta's Conversions API.
- **An outbox for conversions.** Outcomes are recorded once, sent in batches to each ad platform, retried with backoff, and never sent by two workers at once.
- **Consent.** A browser's opt-out signal and a banner's answer are stored and honoured before anything goes to an ad platform.
- **A write queue.** Observations that arrive together are written together, four times faster on PostgreSQL.
- **Two stores, one suite.** Memory and PostgreSQL pass the same tests, including a fuzz test that checks stored clusters against a full recompute after every operation.
- **No runtime dependencies.** `pg` is needed only for the PostgreSQL store.

## Installation

Not published yet. From a checkout, Node 22.18 or later runs the TypeScript source directly.

```sh
npm install
npm test
DATABASE_URL=postgres://localhost/yourdb npm test
npm run build   # writes dist/, which the package's doors point at
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
    origins: ['https://example.org', 'https://example.com'],
    fingerprint,
    ipInfo,
  }),
).listen(8080)
```

### The reviewer screen

The same handler serves a screen for the people who review accounts, at `/review`. It lists the largest clusters, shows who a subject is tied to and why, draws the ties, and shows money moved and every sighting. From it a reviewer can keep two accounts apart, join two, stop linking through an identifier, or forget a subject, each with a reason that goes on the record.

The page is one file with no outside assets. It holds no data and no secret: the reviewer types the access token, and the browser may run only the script the page shipped with and talk only to the server it came from. The token is the same one your services use, and the page keeps it for that browser tab, so give it only to people you would let use every route. Try it over made-up data with `npm run review`.

With `cookie: true`, `/collect` keeps the device id in a cookie the server sets. Safari deletes a cookie set by script after seven days; one set by the server lasts, and script cannot read or change it. It needs `/collect` to be served from the site's own domain, or a subdomain with `cookie: { domain: 'example.org' }`.

### Consent

A browser that sends the Global Privacy Control signal is still seen, because fraud checks do not depend on advertising consent. Its ad click and analytics id are not kept, and nothing about it goes to an ad platform.

```ts
collect({ endpoint, consent: { adUserData: true, adPersonalization: false } }) // the banner's answer
await graph.consent('contact:1001', { adUserData: true, adPersonalization: true }) // or from your server
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
import { createOutbox, googleAds, ingest, meta } from 'account-graph'
import { createGoogleTokens } from 'account-graph/google-auth'

let token = createGoogleTokens(JSON.parse(serviceAccountKeyFile))
let outbox = createOutbox(graph, store.outbox, {
  targets: [
    googleAds({ customerId: '123-456-7890', send: async (request) => ingest(request, await token()) }),
    meta({ pixelId: '555', accessToken: process.env.META_TOKEN, url: 'https://example.org/' }),
  ],
})

await outbox.record({
  transactionId: 'enroll-1001',
  subject: 'contact:1001',
  at: Date.now(),
  action: { google: '987654321', meta: 'Lead' }, // a conversion action id, an event name
  value: 200,
  email: form.email,
})

let stop = outbox.start(30_000) // send what is due, every 30 seconds
```

Google gets one click id per conversion: `gclid`, else `gbraid`, else `wbraid`. Meta gets `fbc`, built from the `fbclid` and the time of the click. Each gets the email and phone hashed the way it matches them, as a second key for when the click id was lost. The two hash a Gmail address and a phone number differently, so each platform's keys are stored separately.

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
| The person, or the browser that clicked, refused ad measurement | `skipped`: `consent_denied` |
| The outcome is over seven days old and bound for Meta | `skipped`: `too_old` |
| A click below 0.9 confidence, but an email or phone | Sent with the email or phone alone |

A worker takes a job by pushing its due time one minute ahead. If the worker dies, the job comes due again and another worker takes it. On PostgreSQL the claim locks its rows, so any number of workers can call `run` at once.

Delivery is at least once. A job sent twice after a crash carries the same `transactionId`. Meta keeps the first copy; Google reads the second as a restatement of the same value, which changes nothing.

`restate` changes an outcome's value after a refund or a correction and sends it again. Google overwrites the value it holds. Google has no way to retract a conversion, and Meta cannot restate one.

```ts
await outbox.restate('enroll-1001', 120)
```

`delay` holds a new outcome before its first send. `forget` deletes a subject's jobs along with everything else about it.

## The write queue

PostgreSQL writes run one at a time. `createBatcher` puts a queue in front: while one write is in flight, arrivals wait and go together in the next.

```ts
import { createBatcher } from 'account-graph'

let queue = createBatcher(graph)
await queue.observe({ subject: 'account:1', identifiers: ['email:…'], at: Date.now() })
```

A quiet system writes at once; nothing waits on a timer. One bad observation fails alone.

## How it decides

A subject is anything with an identity: `account:42`, `visitor:9f3c`. An identifier is `kind:value`. The graph is the set of subject-identifier edges, each with a first and last sighting.

Two subjects that share an identifier get evidence from it:

```
evidence = weight × (2 / subjects sharing it) ^ dilution × 0.5 ^ (gap / halfLife)
```

`gap` is the time between the two subjects' sightings of it, and zero when they overlap. An identifier shared by more subjects than its `cap` gives no evidence. Evidence from several identifiers combines as `1 − Π(1 − evidence)`. At 0.9 the pair joins one cluster; at 0.5 it is reported as related.

Scores depend only on stored data, never on the current time or on arrival order.

| Kind | Weight | Cap | Half-life | What it is |
| --- | --- | --- | --- | --- |
| `review` | 1.00 | 100 | none | A reviewer joined these by hand |
| `passkey` | 0.99 | 5 | none | A passkey's credential id, after your server verified the sign-in |
| `email` | 0.99 | 25 | none | Stored as the SHA-256 Google also accepts |
| `device` | 0.98 | 10 | none | First-party cookie or install id |
| `payment` | 0.97 | 10 | none | Card or bank token |
| `fingerprint` | 0.97 | 20 | 720 days | Vendor visitor id the server confirmed |
| `hardware` | 0.95 | 10 | none | Hashed machine id from your client |
| `phone` | 0.90 | 25 | none | |
| `ga` | 0.90 | 10 | none | Google Analytics client id |
| `canvas` | 0.50 | 20 | 45 days | Browser hash nothing confirmed |
| `ip` | 0.30 | 10 | 14 days | IPv6 is kept as its /64 |

### From links to clusters

Every subject reachable over `same` links forms a component. A cluster is what is left of a component after three cuts, in this order.

1. **A pair a reviewer separated is never linked.**
2. **If the two are still connected through others, the weakest set of links between them is cut.** Evidence adds up along the way, so two weak links outweigh one.
3. **One link below 0.97 cannot be the only thing joining two groups.** It may add a single account to a group. Two groups of two or more need a strong link or a second, separate link. The weakest such link is cut first, then the next.

So a chain of four accounts, each sharing one machine with the next, becomes two pairs. Give the outer two a shared phone and it becomes one cluster, because the groups are now tied twice.

A cluster with more than 50 members is flagged `oversized`. A cluster that big is more often one bad identifier than one person.

## Reviewer decisions

```ts
await graph.ignore('email:…', true, { by: 'dana', reason: 'front desk mailbox' })
await graph.separate('account:7', 'account:9', true, { by: 'dana', reason: 'siblings' })
await graph.join('account:1', 'account:2', { by: 'dana', reason: 'same caller' })
```

A separation holds whatever the two share later, and can be withdrawn with `false`. It may be recorded before either account exists. A join is the strongest tie there is, but a separation still wins: joining an account to one side of a separated pair pulls it away from the other.

`clusters()` lists the largest clusters, which is where a reviewer should look first.

Every `ignore`, `separate`, `join`, `forget`, and `rebuild` is appended to a record of decisions. Each entry carries a hash of itself and the entry before, so editing or deleting one breaks every hash after it.

```ts
await graph.decisions() // [{ seq: 1, at, action: 'ignore', about: ['email:…'], by: 'dana', reason, hash }, …]
await graph.audit()     // { sound: true }
```

`asOf` rebuilds the graph as it stood at a time, in memory, from the sightings and decisions up to then.

```ts
let then = await graph.asOf(Date.parse('2026-06-01'))
await then.cluster('account:7')
```

Pass `onChange` to `createGraph` to be told, after each write commits, which subjects changed cluster.

## Money flows

Identity says who is who. Flows say who pays whom. Collusion is the two together: value moving between accounts that are the same person or tied to them.

```ts
let tie = await graph.transfer({ from: 'account:2', to: 'account:1', amount: 250_000, at: Date.now(), asset: 'gold' })
// tie.relation: 'same' | 'related' | 'none', with the score and reasons. Hold the trade on anything but 'none'.

await graph.flows('account:1')     // every counterparty: sent, received, count, imbalance, and the tie
await graph.collusion('account:1') // only those tied by identity, with three or more flows
```

`amount` is a whole number of the asset's smallest unit. `imbalance` is 1 when value only ever moved one way.

## Fitting the weights

`measure` reports how often each kind was right on pairs that shared only that kind. `fit` goes further: it sets every weight at once from pairs checked by hand, using the same formula the graph scores with, so a kind that mostly appears beside a stronger one is not credited with the stronger one's accuracy.

```ts
import { fit } from 'account-graph'

let { policy, kinds, loss, calibration } = fit(checkedPairs, defaultPolicy)
// kinds.fingerprint: { before: 0.97, after: 0.94, pairs: 812 }
let graph = createGraph(store, policy)
await graph.rebuild()
```

## What the weights rest on

The fingerprint, canvas, and address rows are set from how these identifiers behave in production, measured where the person behind each visit was known.

| Identifier | Values that only ever belonged to one person | Same person on the next sighting, by days since the last |
| --- | --- | --- |
| Vendor fingerprint | 98% | 98% up to 30 days, 95% at 31–90, 86% past 90 |
| Home-made canvas and user-agent hash | 53% | about 55% up to 7 days, 23% at 31–90, 7% past 90 |
| IP address | 46% | 89% next day, 73% in a week, 37% in a month, 5% past 90 |

Three things follow, and the defaults encode each.

- **A vendor fingerprint is strong and slow to fade.** It can join two subjects on its own.
- **A home-made hash is a coin flip.** Phones of one model share it. It can relate two subjects, never join them. Attribution that rests on it alone is wrong about half the time.
- **A few identifiers are shared by crowds.** A handful of fingerprints, each shared by more than twenty people, can produce most of the same-fingerprint pairs, and under 2% of those pairs are one person. Without a cap, those few values would merge hundreds of strangers.

An address shared by exactly two people points at the same one about 42% of the time, and by three to five people about 9%. That is why its evidence thins with the square of how many share it.

The other rows are priors. `measure` and `fit` compute the real values from pairs you have confirmed by hand.

## Speed

On an M-series laptop, with a 20,000-account synthetic workload:

| Store | One at a time | Through the write queue | `links()` |
| --- | --- | --- | --- |
| Memory | 33,000 observations/s | 17,000/s | 0.02 ms |
| PostgreSQL 16, local, fsync on | 930 observations/s | 4,200/s | 0.42 ms |

PostgreSQL writes take one advisory lock, so they run one at a time; the write queue is how many callers share one write. Run `npm run bench` for your own numbers.

## Tools

- `tools/review-demo.ts` serves the reviewer screen over made-up data.
- `tools/browser-check.ts` runs `collect`, the server, and the outbox against a real browser.
- `tools/live-check.ts` calls each vendor's real endpoint with an invalid key and prints how it answered.
- `tools/replay.ts` replays an export of your own past traffic and compares attribution with what was sent.
- `tools/export.ts` writes edges, flows, or cluster labels as CSV for an analytics engine.

## What has run for real

- Every test runs on memory and on PostgreSQL 16: 107 tests, including a fuzz test that mixes observations, reviewer decisions, deletions, and transfers, and six outbox workers at once.
- `collect` ran in Chrome against the server and PostgreSQL: it read the click id and tags from the URL, the enrollment was credited and sent through the outbox, and with `cookie: true` the device cookie was set by the server, invisible to script, and the same on the next visit.
- The reviewer screen ran in Chrome under its content policy: a cluster opened, two accounts were kept apart with a reason, the cluster split, and the decision appeared on the record.
- The hardware id ran on macOS and, in CI, on Linux.
- The real endpoints of Fingerprint, MaxMind, Google's token service, Google's Data Manager, and Meta's Conversions API each answered an invalid key the way its documentation says.

## Limits

- No request has been made with real credentials, so a successful Fingerprint lookup, MaxMind answer, Google token, Google upload, and Meta upload are untested.
- The two Fingerprint browser loaders have not run in a browser. They need a real key or a third-party script.
- The hardware id's Windows path is untested.
- `asOf` counts each sighting from its own time, not from when it was recorded, and a forgotten subject is gone from every past.
- A separation between two subjects cuts the weakest links between them. With several separations in one component the cuts are made one after another, which is not always the fewest possible.
- Flows are kept as running totals per pair, not as a ledger.
- `rebuild`, `verify`, and `asOf` load every edge into memory.
- The memory store does not roll back a failed write.

## License

MIT
