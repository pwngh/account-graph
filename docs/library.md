# Library

Call account-graph from a Node program. `accountGraph` gives six calls and `close`, the same whether the graph is on a server, on PostgreSQL in this process, or in memory.

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

## Three ways to open it

```ts
import { accountGraph } from 'account-graph'

// A server you run, over HTTP.
const remote = accountGraph({ url: 'https://graph.example.org', token: process.env.GRAPH_TOKEN! })

// In this process, on PostgreSQL.
const local = accountGraph({
  databaseUrl: process.env.DATABASE_URL!,
  workers: true,
  receiptSecrets: [process.env.RECEIPT_SECRET!],
})

// In this process, in memory: tests and trials.
const memory = accountGraph({ memory: true })
```

Exactly one of `url`, `databaseUrl` and `memory` is given. Two of them do not compile. The three answer alike: a local call is checked by the same code and goes through the same JSON as a remote one, and each answer is a value of its own.

Where there is no Node, the package has the remote graph only. A local one throws `CONFIG.UNSUPPORTED`.

`accountGraph` does no I/O. It throws `CONFIG.INVALID` with everything that is wrong at once. The first call connects to the database and upgrades it. A database that was away is tried again by the next call.

| Option | With | Meaning |
| --- | --- | --- |
| `url`, `token` | a server | Its address and the service token, or a reviewer's. Redirects are not followed. |
| `fetch` | a server | Used in place of the global one. |
| `databaseUrl` | PostgreSQL | The database. Requires the `pg` package. |
| `workers` | required on PostgreSQL | Whether this process sends conversions, reads costs, looks for what is late, and posts events. |
| `receiptSecrets` | required on PostgreSQL | Keys the [receipts](operations.md#receipts). 32 characters or more each. The first signs and all are tried. |
| `schema` | PostgreSQL | The database schema. `account_graph` when left out. |
| `timeoutMs` | all | How long one call may take, in milliseconds. 30,000 when left out. |

> **Say `workers` on purpose.** With `true`, a script that runs for a second reads costs and sends conversions. With `false` everywhere, nothing is ever sent.

### Settings

A local graph takes these too. A server has them as [environment variables](operations.md#environment-variables).

| Option | Variable | Holds |
| --- | --- | --- |
| `policy` | `POLICY` | What differs from the default [policy](#policy) |
| `identifierSecret`, `linkSecret` | `IDENTIFIER_SECRET`, `LINK_SECRET` | 32 characters or more each |
| `stages` | `STAGES` | Your [steps](report.md#steps) |
| `openHours`, `timeZone` | `OPEN_HOURS`, `REPORT_TIME_ZONE` | When you are open, and the zone |
| `phones` | `CALL_*`, `POOL_*`, `RETURN_HOURS` | `numbers`, `exclude`, `minimumSeconds`, `resultsExpectedWithinMinutes`, `returnHours`, `country`, `tapSeconds`, `pool` |
| `ads` | each platform's, `FORGET_ADS`, `OUTBOX_DELAY_MS` | `google`, `meta`, `microsoft`, `tiktok`, `retractOnForget`, `delayMs` |
| `costs` | each platform's | `google`, `meta` |
| `checks` | `SMARTY_*`, `TWILIO_*` | `address`, `lineType` |
| `monitor` | `QUIET_*`, `LATE_HOURS`, `AUDIT_HEAD_HOURS` | `quietHours`, `lateHours`, `auditHours` |
| `webhook`, `alerts` | `WEBHOOK_URL`, `WEBHOOK_SECRET`, `ALERT_WEBHOOK` | Where [events](operations.md#events) and [alerts](operations.md#alerts) are posted |
| `now` | none | The clock, for tests |
| `fetch` | none | Asks ad platforms, checks and webhooks in place of the global one, for tests |

```ts
import { accountGraph } from 'account-graph'

const graph = accountGraph({
  databaseUrl: process.env.DATABASE_URL!,
  workers: true,
  receiptSecrets: [process.env.RECEIPT_SECRET!],
  linkSecret: process.env.LINK_SECRET!,
  timeZone: 'America/Chicago',
  stages: { inquiry: { value: 5, currency: 'USD' }, client: { value: 200, currency: 'USD', action: { meta: 'Lead' }, wait: 48 } },
  phones: { numbers: { '+15551230001': { source: 'google', campaignId: '20222' } }, resultsExpectedWithinMinutes: 30 },
  ads: { meta: { pixelId: '555', accessToken: process.env.META_ACCESS_TOKEN!, siteUrl: 'https://example.org/' } },
  openHours: { mon: ['09:00-17:00'], tue: ['09:00-17:00'], holidays: ['us'] },
})
```

## The calls

| Call | Resolves to |
| --- | --- |
| `record({ entries })` | `{ results }`, one per entry, in order |
| `decide({ key, at, by, action, … })` | `{ ok: true, value }` or `{ ok: false, reason, … }` |
| `forget({ key, at, by, subjects, platforms })` | `{ ok: true, value }` or `{ ok: false, reason, … }` |
| `lookup({ kind, … })` | What the kind answers |
| `report({ kind, … })` | `{ asOf, value }` |
| `events({ after, limit })` | `{ ok: true, value }` or `{ ok: false, reason: 'CURSOR_LOST' }` |
| `close()` | Nothing |

The [HTTP API](http.md) has every field, refusal and rule. The types are exported from `account-graph`.

Every write takes a `key` and an `at` of yours. Keep both with what you record, so a retry is the same call.

### Record

```ts
import { accountGraph } from 'account-graph'

const graph = accountGraph({ memory: true })

const { results } = await graph.record({
  entries: [
    { type: 'profile', key: 'signup-1001', at: 1795460000000, subject: 'contact:1001', event: 'signup', facts: { email: 'pat@example.org', device: '9f3c' } },
    { type: 'conversion', key: 'enroll-1001', at: 1795460000000, subject: 'contact:1001', stage: 'enrolled', value: 200, currency: 'USD' },
  ],
})

for (const result of results) {
  if (!result.ok) console.error(result.key, result.reason)
  else if (result.type === 'profile') console.log(result.value.changes)
}
```

A "no" is a value and never thrown. `changes` lists the subjects that moved, so you can hold a login or a trade before it settles.

### Refund and write off

A refund or a write-off is an amount. It does not say what is left, so the order they arrive in does not matter.

```ts
import { accountGraph } from 'account-graph'

const graph = accountGraph({ memory: true })
const of = { type: 'conversion', key: 'enroll-1001' } as const

await graph.record({
  entries: [
    { type: 'conversion', key: 'enroll-1001', at: 1795460000000, subject: 'contact:1001', stage: 'enrolled', value: 200, currency: 'USD' },
    { type: 'restatement', key: 'refund-7', at: 1795463600000, of, change: { kind: 'refund', amount: 80 } }, // worth 120
    { type: 'restatement', key: 'undo-7', at: 1795467200000, of, change: { kind: 'reverse', restatement: 'refund-7' } }, // worth 200
  ],
})
```

### Decide

```ts
import { accountGraph } from 'account-graph'

const graph = accountGraph({ memory: true })
const at = 1795460000000
const pairs = [{ a: 'contact:7', b: 'contact:12' }]

const { decisions } = await graph.lookup({ kind: 'person', subjects: ['contact:7', 'contact:12'], at })
const merged = await graph.decide({ key: 'ticket-88', at, by: 'dana', seen: decisions, action: 'merge', pairs })
if (!merged.ok && merged.reason === 'STALE') console.log(`${merged.by} decided about them since`)
if (merged.ok && merged.value.notAsAsked.length > 0) console.log('a split holds them apart')
```

Take a merge back with `unmerge` of the pair:

```ts
import { accountGraph } from 'account-graph'

const graph = accountGraph({ memory: true })

const undone = await graph.decide({ key: 'ticket-89', at: 1795463600000, by: 'dana', action: 'unmerge', pairs: [{ a: 'contact:7', b: 'contact:12' }] })
if (!undone.ok && undone.reason === 'NOT_JOINED') for (const { a, b, because } of undone.pairs) console.log(a, b, because)
else if (undone.ok) for (const { a, b, because } of undone.value.notAsAsked) console.log(a, b, 'are still together', because)
```

`NOT_JOINED` says nobody merged the pair, so there is nothing to take back. `because` is `apart` where they are not together, `evidence` where what they share joins them, and `other_merges` where merges with others do. `notAsAsked` lists pairs that stay together after it. `split` keeps those apart.

### Look up

```ts
import { accountGraph } from 'account-graph'

const graph = accountGraph({ memory: true })
const at = 1795460000000

// What brought them.
const { people } = await graph.lookup({ kind: 'person', subjects: ['contact:1001'], at })
const arrival = people[0]?.arrival // what can be credited, or null
const possible = people[0]?.possible // the strongest arrival, where none can be

// Who a new intake may be, before it is saved.
const { candidates } = await graph.lookup({ kind: 'match', facts: { phone: '(555) 010-0007' }, at })

// Everything recorded about one person.
const { entries, next } = await graph.lookup({ kind: 'journey', subject: 'contact:1001' })
```

The person of a journey is the subject's cluster, plus any subject linked strongly enough that its visits would be credited. A subject split from any of them is left out. `subjects` gives the reason and score for each.

### Report

```ts
import { accountGraph } from 'account-graph'

const graph = accountGraph({ memory: true })

const { asOf, value } = await graph.report({ kind: 'campaigns', window: { from: '2026-11-01', to: '2026-11-14', timeZone: 'America/Chicago' }, per: 'enrolled' })
for (const row of value.rows) console.log(row.source, row.campaignId, row.cost, row.costPerOutcome)
console.log(`as of ${new Date(asOf).toISOString()}`)
```

### Follow events

```ts
import { accountGraph } from 'account-graph'

const graph = accountGraph({ memory: true })

let after: string | null = null // read from where you keep it
for (;;) {
  const page = await graph.events({ after, limit: 500 })
  if (!page.ok) {
    after = null // CURSOR_LOST: read everything again
    continue
  }
  for (const event of page.value.events) {
    if (event.type === 'cluster.changed') console.log(event.data.subject, event.data.to)
  }
  after = page.value.cursor // keep it once the events are acted on
  if (!page.value.more) break
}
```

An event from a newer server has the type `Unrecognized` and the raw value. Keep it and move on. [Operations](operations.md#events) has the rules of following along.

## Faults

What is not a "no" of the domain is thrown as a `Fault`: an `Error` with a `code`, `retryable` and `detail`. Tell it by its code, never by its message.

```ts
import { FAULT_CODES, accountGraph, hasCode, isFault } from 'account-graph'
import type { RecordRequest } from 'account-graph'

const graph = accountGraph({ url: 'https://graph.example.org', token: process.env.GRAPH_TOKEN! })

async function send(request: RecordRequest) {
  try {
    return await graph.record(request)
  } catch (error) {
    // It may have been written. The same request with the same keys is safe.
    if (hasCode(error, FAULT_CODES.TRANSPORT.INDETERMINATE)) return graph.record(request)
    if (isFault(error) && error.retryable) console.warn(`try again later: ${error.code}`)
    throw error
  }
}
```

| Code | Thrown by a local graph | Thrown by a remote one |
| --- | --- | --- |
| `INPUT.MALFORMED`, `INPUT.TOO_LARGE` | Before anything is written, or with the entry that cannot be | Before sending, or from the server |
| `AUTH.REJECTED`, `AUTH.FORBIDDEN` | Never | From the server |
| `CONFIG.INVALID` | By `accountGraph` | By `accountGraph`, and for a 404, a 405 or a redirect, because `url` is then no server |
| `CONFIG.MISMATCH` | When the [settings differ](operations.md#settings-that-must-match) from the database's | From the server |
| `CONFIG.UNSUPPORTED` | A `link` without `linkSecret`, or `retract` where no platform can | From the server |
| `GRAPH.UNAVAILABLE` | The database is not available | From the server, and for 429 or 503 of a proxy |
| `GRAPH.INTERNAL` | Everything else. The cause is kept as `cause`, and is not in the message. | From the server, and for a read whose answer cannot be read |
| `GRAPH.CLOSED` | After `close` | After `close` |
| `TRANSPORT.INDETERMINATE` | The time ran out, or the connection was lost as a write was committed | No answer, 502 or 504, or a write whose answer cannot be read |
| `TRANSPORT.ABORTED` | Your `signal` | Your `signal` |

[Faults](http.md#faults) has the status of each, and which are retryable.

Each call takes `{ signal, correlationId }` as a second argument. `signal` aborts it. `correlationId` is sent to a server as `x-request-id`.

## Close

`close` refuses new calls with `GRAPH.CLOSED`, waits up to 30 seconds for those it accepted, stops the workers and closes the connections. It is safe to call twice.

## Server

`createEdge` serves a local graph over HTTP: the six calls at `/v1`, browsers, Twilio, the reviewer screen and `/health`.

```ts
import { createServer } from 'node:http'
import { accountGraph } from 'account-graph'
import { createEdge } from 'account-graph/edge'

const graph = accountGraph({ databaseUrl: process.env.DATABASE_URL!, workers: true, receiptSecrets: [process.env.RECEIPT_SECRET!] })

const edge = createEdge(graph, {
  token: process.env.GRAPH_TOKEN!,
  reviewers: { dana: process.env.DANA_TOKEN! },
  origins: ['https://example.org', 'https://example.com'],
})
const server = createServer(edge).listen(8080)

async function stop() {
  server.close()
  await edge.drain() // writes the visits that wait to be written
  await graph.close()
}
```

`createEdge` needs a local graph. A remote one throws `CONFIG.UNSUPPORTED`.

| Option | Variable | Meaning |
| --- | --- | --- |
| `token` | `GRAPH_TOKEN` | The service token |
| `reviewers` | `REVIEW_TOKENS` | Each reviewer's name, with a token or a list of tokens |
| `origins` | `ORIGINS` | Sites whose pages may post |
| `trustProxy` | `TRUST_PROXY` | `true`, or how many proxies stand in front |
| `cookie` | `COOKIE` | `true`, or `{ domain }`, to keep the device id in a cookie the server sets |
| `limit` | `RATE_*` | `{ perMinute, burst }`, or `false` |
| `staffNetworks` | `STAFF_NETWORKS` | Networks whose visits are dropped |
| `events` | `EVENTS` | Page events to record |
| `twilio` | `TWILIO_*` | `{ authToken, calls?, texts? }`, each the address entered in Twilio |
| `textCodes` | `TEXT_CODES` | Puts a code in text links |
| `fingerprint`, `maxmind`, `serverRanges` | `FINGERPRINT_*`, `MAXMIND_*`, `SERVER_RANGES_FILE` | See [providers](providers.md). `serverRanges` is the text of the file. |

With `cookie: true`, `/collect` keeps the device id in a cookie the server sets. Safari deletes a script-set cookie after seven days. A server-set cookie lasts, and page script can neither read nor change it. Serve `/collect` from the site's own domain, or from a subdomain with `cookie: { domain: 'example.org' }`.

## Workers

With `workers: true`, a local graph sends due conversions every 30 seconds, posts events every 5 seconds, looks for what is late every 5 minutes, and reads costs every 6 hours. Several processes may have it on: each kind of work but sending takes a lease, and sending claims its own conversions.

In a test, run one pass of every worker by hand:

```ts
import { accountGraph } from 'account-graph'
import { runWorkers } from 'account-graph/testing'

const graph = accountGraph({ memory: true, now: () => 1795460000000 })
await runWorkers(graph)
```

### What sending does

| Event | Result |
| --- | --- |
| The platform accepts the request | `sent` |
| Rate limit, outage, bad credential, network error | Stays `pending`. Retried after 30 seconds, doubling to an hour, shortened by up to half |
| Still failing after 8 tries | `failed`, with the last error |
| The platform rejects a request for one bad event | Each event is sent alone, and only the bad one is `failed` |
| Without a trusted click, email or phone | Stays `pending` with the note `no_match_key`, and is looked at again in case the person is tied to a click. `skipped` seven days after it happened |
| The person, or the browser that clicked, refused ad measurement, including after an outcome that said yes | `skipped`: `consent_denied` |
| The outcome is older than the platform accepts: 7 days for Meta, 90 for Microsoft | `skipped`: `too_old` |
| A click below 0.9 confidence that is not in the person's cluster, with an email or phone | Sent with the email or phone alone |

The click is worked out when a conversion is sent, so evidence that arrived after the conversion still counts. Each platform gets its own click id, and the email and phone hashed the way it matches them.

| Platform | Match data |
| --- | --- |
| Google | One click id: `gclid`, else `gbraid`, else `wbraid` |
| Meta | `fbc`, built from `fbclid` and the click time, with `fbp` where the site runs Meta's pixel |
| Microsoft | `msclkid` |
| TikTok | `ttclid` |

Delivery is at least once. A conversion sent twice after a crash carries the same key. Meta keeps the first copy, and Google treats the second as a restatement of the same value. A worth that changes is sent again to Google, which overwrites the value it holds.

## Webhook

A server posts [events](operations.md#webhook) to your address. Check each post before you read it.

```ts
import { parseWebhook, verifyWebhook } from 'account-graph'

export async function receive(request: Request): Promise<Response> {
  const webhook = { headers: Object.fromEntries(request.headers), body: await request.text() }
  if (!(await verifyWebhook(webhook, { secret: process.env.WEBHOOK_SECRET!, now: Date.now(), maxAgeMs: 300_000 }))) return new Response(null, { status: 401 })
  for (const event of parseWebhook(webhook)) {
    if (event.type === 'callback.overdue') console.log(event.data.call, event.data.attempts)
  }
  return new Response(null, { status: 204 })
}
```

`body` is the text as received. Neither function throws on what was sent. `parseWebhook` gives what it does not know as `Unrecognized`, with the raw value.

## Policy

Name only what differs from the default. A misspelled kind or field does not compile. A kind of your own goes in `customKinds`, with its weight, dilution, cap and half-life.

```ts
import { accountGraph } from 'account-graph'

const graph = accountGraph({
  memory: true,
  policy: {
    kinds: { phone: { weight: 0.85, halfLife: 63_072_000_000 } },
    customKinds: { badge: { weight: 0.95, dilution: 1, cap: 5, halfLife: 'none' } },
  },
})
```

Left out, the policy is the one the database was built with. One that differs throws `CONFIG.MISMATCH` until [`account-graph rebuild`](operations.md#policy). [Matching](deciding.md) describes each part of a rule.

## Money flows

A `transfer` records who pays whom. Collusion is value moving between accounts that are the same person or linked to one another.

```ts
import { accountGraph } from 'account-graph'

const graph = accountGraph({ memory: true })

const { results } = await graph.record({
  entries: [{ type: 'transfer', key: 'trade-81', at: 1795460000000, from: 'account:2', to: 'account:1', amount: 250_000, asset: 'gold' }],
})
const [trade] = results
// Hold the trade on anything but 'none'.
if (trade?.ok && trade.type === 'transfer') console.log(trade.value.relation, trade.value.score)

const { counterparties, rings } = await graph.lookup({ kind: 'transfers', subject: 'account:1', tiedOnly: true })
```

`amount` is a whole number of the asset's smallest unit. `counterparties` has what was sent and received with each, the tie, and `imbalance`, which is 1 when value moved one way only. With `tiedOnly`, it keeps those tied by identity with three or more transfers.

A ring is value that left a subject and returned through others: A paid B, B paid C, C paid A. Its `amount` is the least that moved on any step, and so the most that could have gone all the way round. `tied` counts the others in the subject's cluster. Rings of up to four subjects are found. Flows and rings use running totals for each pair, without the order of transfers.

## Browser and desktop

The [script tag](operations.md#script-tag) is the short way to report visits. A bundled page can call the same code:

```ts
import { collect, event } from 'account-graph/collect'

const options = { endpoint: 'https://graph.example.org/collect', consent: { adUserData: true, adPersonalization: false } }
await collect(options)
await event(options, 'inquiry')
```

`collect` reads the click id from the URL: `gclid`, `gbraid`, `wbraid`, and the Meta, Microsoft and TikTok ids. It falls back to the Google tag's `_gcl_aw` cookie, reads the Analytics client id from `_ga`, and keeps its own first-party device id in the `ag_device` cookie. With a visit it sends Meta's browser id from `_fbp`, when Meta's pixel has set one.

When someone signs up, your server reads `ag_device` from the request and sends it as `facts.device` of a `profile`.

A desktop client, on Node or in Electron's main process, can send a hardware id. It hashes the operating system's machine id with a constant of your app, so the raw id stays on the machine.

```ts
import { hardwareId } from 'account-graph/hardware'

const hardware = await hardwareId('my-game-client') // 'hardware:9c1f…'
// Send it with the login. Your server records it in facts.identifiers.
```

| Platform | Source |
| --- | --- |
| macOS | `IOPlatformUUID` |
| Windows | `MachineGuid` |
| Linux | `/etc/machine-id` |

## Limitations

- **Hardware id.** The client reports it, so a modified client can send a false value.
- **Windows.** The Windows hardware id is untested.
- **Restatement.** Google has no way to retract a conversion. Meta, Microsoft and TikTok cannot restate one.
- **Memory.** A memory graph is lost with its process, and so are its receipts. It copies all it holds before each entry, so it suits tests and small graphs.
