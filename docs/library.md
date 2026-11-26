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

A server has the settings as [environment variables](operations.md#environment-variables).

| Option | With | Variable | Meaning |
| --- | --- | --- | --- |
| `url`, `token` | a server | none | Its address and the service token, or a reviewer's. Redirects are not followed. |
| `databaseUrl` | PostgreSQL | `DATABASE_URL` | The database. Requires the `pg` package. |
| `workers` | required on PostgreSQL | none | Whether this process sends conversions, reads costs, looks for what is late, and posts events. |
| `receiptSecrets` | required on PostgreSQL | `RECEIPT_SECRETS` | Keys the [receipts](operations.md#receipts). 32 characters or more each. The first signs and all are tried. |
| `schema` | PostgreSQL | `GRAPH_SCHEMA` | The database schema. `account_graph` when left out. |
| `policy` | a local graph | `POLICY` | What differs from the default [policy](#policy) |
| `identifierSecret`, `linkSecret` | a local graph | `IDENTIFIER_SECRET`, `LINK_SECRET` | 32 characters or more each |
| `stages` | a local graph | `STAGES` | Your [steps](report.md#steps) |
| `leads` | a local graph | `LEADS`, `LEADS_FILE` | Sources whose webhooks the edge accepts, keyed by the name in the URL. [Mappings and example posts](leads.md) |
| `openHours`, `timeZone` | a local graph | `OPEN_HOURS`, `REPORT_TIME_ZONE` | When you are open, and the zone |
| `targets` | a local graph | `TARGETS` | Numbers you set yourself to meet. See [targets](operations.md#targets). |
| `phones` | a local graph | `CALL_*`, `POOL_*`, `RETURN_HOURS` | `numbers`, `exclude`, `minimumSeconds`, `resultsExpectedWithinMinutes`, `returnHours`, `country`, `tapSeconds`, `pool` |
| `ads` | a local graph | each platform's, `FORGET_ADS`, `OUTBOX_DELAY_MS` | `google`, `meta`, `microsoft`, `tiktok`, `retractOnForget`, `delayMs` |
| `costs` | a local graph | each platform's | `google`, `meta` |
| `checks` | a local graph | `SMARTY_*`, `TWILIO_*` | `address`, `lineType` |
| `monitor` | a local graph | `QUIET_*`, `LATE_HOURS`, `AUDIT_HEAD_HOURS` | `quietHours`, `lateHours`, `auditHours` |
| `webhook`, `alerts` | a local graph | `WEBHOOK_URL`, `WEBHOOK_SECRET`, `ALERT_WEBHOOK` | Where [events](operations.md#events) and [alerts](operations.md#alerts) are posted |
| `now` | a local graph | none | The clock, for tests |
| `fetch` | all | none | Used in place of the global one. A local graph asks ad platforms, checks and webhooks with it, for tests. |
| `timeoutMs` | all | none | How long one call may take, in milliseconds. 30,000 when left out. |

> **Say `workers` on purpose.** With `true`, a script that runs for a second reads costs and sends conversions. With `false` everywhere, nothing is ever sent.

A local graph with settings:

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

The examples below use this graph:

```ts
import { accountGraph } from 'account-graph'

const graph = accountGraph({ memory: true })
```

### Record

```ts
const { results } = await graph.record({
  entries: [
    { type: 'profile', key: 'signup-1001', at: 1795460000000, subject: 'contact:1001', createdAt: 1795300000000, event: 'signup', facts: { email: 'pat@example.org', device: '9f3c' } },
    { type: 'conversion', key: 'enroll-1001', at: 1795460000000, subject: 'contact:1001', stage: 'enrolled', value: 200, currency: 'USD' },
  ],
})

for (const result of results) {
  if (!result.ok) console.error(result.key, result.reason)
  else if (result.type === 'profile') console.log(result.value.changes)
}
```

A "no" is a value and never thrown. `changes` lists the subjects that moved, so you can hold a login or a trade before it settles.

Use `createdAt` when you know when your system created the record. Reviewers see it beside the first time the graph saw activity on that ID. To correct it, send a new profile for the same ID with a new key, a later `at` and the corrected date. Profiles that omit it leave the standing date alone. The [profile fields and ordering rules](http.md#entry-types) also apply to the library.

### Decide

```ts
const at = 1795460000000
const pairs = [{ a: 'contact:7', b: 'contact:12' }]

const { decisions } = await graph.lookup({ kind: 'person', subjects: ['contact:7', 'contact:12'], at })
const merged = await graph.decide({ key: 'ticket-88', at, by: 'dana', seen: decisions, action: 'merge', pairs })
if (!merged.ok && merged.reason === 'STALE') console.log(`${merged.by} decided about them since`)
if (merged.ok && merged.value.stands === false) console.log('the merge has been taken back')
else if (merged.ok && merged.value.notAsAsked.length > 0) console.log('a split holds them apart')
```

Take a merge back with `unmerge` of the pair:

```ts
const undone = await graph.decide({ key: 'ticket-89', at: 1795463600000, by: 'dana', action: 'unmerge', pairs: [{ a: 'contact:7', b: 'contact:12' }] })
if (!undone.ok && undone.reason === 'NOT_JOINED') for (const { a, b, because } of undone.pairs) console.log(a, b, because)
else if (undone.ok && undone.value.stands === false) console.log('the pair has been merged again')
else if (undone.ok) for (const { a, b, because } of undone.value.notAsAsked) console.log(a, b, 'are still together', because)
```

[`decide`](http.md#decide) has what each `because` means.

### Look up

```ts
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

### Report

```ts
const { asOf, value } = await graph.report({ kind: 'campaigns', window: { from: '2026-11-01', to: '2026-11-14', timeZone: 'America/Chicago' }, per: 'enrolled' })
for (const row of value.rows) console.log(row.source, row.campaignId, row.cost, row.costPerOutcome)
console.log(`as of ${new Date(asOf).toISOString()}`)
```

### Follow events

```ts
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

[Faults](http.md#faults) has every code, its status, when it is thrown, and which are retryable. This is what Node adds:

| Code | A local graph | A remote one |
| --- | --- | --- |
| `INPUT.MALFORMED`, `INPUT.TOO_LARGE` | Before anything is written, or with the entry that cannot be | Before sending, or from the server |
| `AUTH.REJECTED`, `AUTH.FORBIDDEN` | Never | From the server |
| `CONFIG.INVALID` | By `accountGraph` | By `accountGraph`, and for a 404, a 405 or a redirect, because `url` is then no server |
| `CONFIG.UNSUPPORTED` | A `link` without `linkSecret`, or `retract` where no platform can | From the server |
| `GRAPH.UNAVAILABLE` | The database is not available | Also for 429 or 503 of a proxy |
| `GRAPH.INTERNAL` | Everything else. The cause is kept as `cause`, and is not in the message. | Also for a read whose answer cannot be read |
| `TRANSPORT.INDETERMINATE` | The time ran out, or the connection was lost as a write was committed | No answer, 502 or 504, or a write whose answer cannot be read |
| `TRANSPORT.ABORTED` | Your `signal` | Your `signal` |

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
| `serviceTokens` | `SERVICE_TOKENS`, `SERVICE_TOKENS_FILE` | Named service credentials and the calls, entry types, actions or kinds each opens |
| `reviewers` | `REVIEW_TOKENS` | Each reviewer's name, with a token or a list of tokens |
| `allowPages`, `refusePages` | `ALLOW_PAGES`, `REFUSE_PAGES` | Optional page paths for the HTTP writer and the tag it serves. See [page rules](privacy.md#pages-a-site-may-record). |
| `origins` | `ORIGINS` | Sites whose pages may post |
| `trustProxy` | `TRUST_PROXY` | `true`, or how many proxies stand in front |
| `cookie` | `COOKIE` | `true`, or `{ domain }`, to keep the device id in a cookie the server sets |
| `limit` | `RATE_*` | `{ perMinute, burst }`, or `false` |
| `staffNetworks` | `STAFF_NETWORKS` | Networks whose visits are dropped |
| `events` | `EVENTS` | Page events to record |
| `twilio` | `TWILIO_*` | `{ authToken, calls?, texts? }`, each the address entered in Twilio |
| `leads` | `LEADS`, `LEADS_FILE` | Uses the local graph's lead sources when omitted. Supplying a map here replaces the graph's map for this edge. [Lead webhooks](leads.md) |
| `textCodes` | `TEXT_CODES` | Puts a code in text links, and on pages that show it to callers |
| `fingerprint`, `maxmind`, `serverRanges` | `FINGERPRINT_*`, `MAXMIND_*`, `SERVER_RANGES_FILE` | See [providers](providers.md). `serverRanges` is the text of the file. |

`cookie` is described under [device cookie](operations.md#device-cookie). Serve `/collect` from the site's own domain, or from a subdomain with `cookie: { domain: 'example.org' }`.

## Workers

With `workers: true`, a local graph sends due conversions every 30 seconds, posts events every 5 seconds, looks for what is late every 5 minutes, and reads costs every 6 hours. Several processes may have it on: each kind of work but sending takes a lease, and sending claims its own conversions.

[Providers](providers.md#what-sending-does) says what sending does. In a test, run one pass of every worker by hand:

```ts
import { accountGraph } from 'account-graph'
import { runWorkers } from 'account-graph/testing'

const graph = accountGraph({ memory: true, now: () => 1795460000000 })
await runWorkers(graph)
```

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

Left out, the policy is the one the database was built with. One that differs throws `CONFIG.MISMATCH` until [`account-graph rebuild`](operations.md#policy). [Matching](matching.md) describes each part of a rule.

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

`amount` is a whole number of the asset's smallest unit. `counterparties` has what was sent and received with each, the tie, and `imbalance`, which is 1 when value moved one way only.

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
- **Memory.** A memory graph is lost with its process, and so are its receipts. It copies all it holds before each entry, so it suits tests and small graphs.
