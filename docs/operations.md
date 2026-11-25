# Operations

One command upgrades the database, serves the six calls, browsers, Twilio and the reviewer screen, and runs the workers.

```sh
DATABASE_URL=postgres://localhost/graph \
GRAPH_TOKEN=a-long-random-string \
RECEIPT_SECRETS=another-one-of-32-characters-or-more \
ORIGINS=https://example.org \
npm start
```

```text
database upgraded: tables, sighting record time, …
listening on 0.0.0.0:8080
collect accepts https://example.org
reviewers none, server cookie off, fingerprint off, maxmind off, server ranges off, signed links off, staff networks off, opening hours off, webhook off, alerts off, address checks off, phone line checks off
outbox sends to none (no ad platform configured)
page events: none (set EVENTS); calls from twilio off; texts from twilio off; text codes off; number pool off
cost sources: none (record cost)
policy d852bb513c02 (default)
```

The lines after `collect accepts` list the enabled features. Each provider turns on when its variables are set. [Providers](providers.md) covers where to get the keys.

## Docker

`docker compose up --build` starts the server and PostgreSQL on port 8080.

```sh
GRAPH_TOKEN=a-long-random-string REVIEW_TOKENS='{"dana":"another-one"}' RECEIPT_SECRETS=… ORIGINS=https://example.org docker compose up --build
```

Compose also reads a `.env` file in the same directory. Run `cp .env.example .env` and fill it in. Set `GRAPH_PORT` to publish a different port.

Compose passes the variables in [Environment variables](#environment-variables) through to the server, except `GRAPH_SCHEMA`, `HOST`, `PORT`, `POLICY_FILE`, `CALL_NUMBERS_FILE` and `SERVER_RANGES_FILE`. It sets `DATABASE_URL` itself.

> **Use the compose file for evaluation.** It has a local volume, a fixed database password, the example site's features and placeholders for `LINK_SECRET` and `RECEIPT_SECRETS`. Replace these before production use. Values in `compose.yaml` that start with `change-me` are public, and the server refuses to start with one when `ORIGINS` contains a site outside your own machine.

## Commands

`account-graph` without a command is the server. From a checkout, `node src/bin.ts` is the same program, and `npm start` runs it. In the image, it is `node dist/bin.js`.

| Command | Does |
| --- | --- |
| `account-graph` | Serves, and runs the workers |
| `account-graph rebuild` | Takes the policy that is set, and works every cluster out again |
| `account-graph verify` | Compares the stored clusters with a full recompute. Reads every edge. |
| `account-graph prune --before 2026-05-01` | Deletes old sightings, events and [receipts](#receipts). [Privacy](privacy.md#deletion) has the full list. |
| `account-graph retry client-1001 google` | Queues a conversion's failed and skipped deliveries again, for one platform or all |
| `account-graph stats` | Counts what the graph holds, and deliveries by state |
| `account-graph alerts test` | Posts a test alert |
| `account-graph staff-link https://example.org/team` | Makes an address that marks a browser as [staff](#staff-traffic) |
| `account-graph events new-epoch` | Begins a new history of events, after a [restore](#backups) |

Each command reads the server's environment variables, upgrades the database as a server does, and ends. The workers stay off.

```sh
account-graph verify
```

```json
{ "changes": [], "policy": { "hash": "d852bb513c02…", "builtWith": "d852bb513c02…", "due": false } }
```

With compose, run `docker compose exec graph node dist/bin.js verify`.

## Script tag

Add one line to each page of your site. The script reports every page view to the server it was loaded from.

```html
<script type="module" src="https://graph.example.org/collect.js"></script>
```

```text
page ──▶ collect.js ──▶ POST /collect ──▶ graph
          (reads the click id, the campaign and ad ids, the device id)
```

List the site in `ORIGINS`, or `/collect` answers 403. A site with a content security policy must allow the server's address under `script-src` and `connect-src`. Set options in the script's address:

| Address | Effect |
| --- | --- |
| `collect.js?fingerprint=PUBLIC_KEY` | Confirms each visitor with Fingerprint. Add `&region=eu` or `&region=ap` outside the US, and `&endpoints=…` for your own subdomain. |
| `collect.js?canvas=open` | Adds the open-source FingerprintJS id, recorded as the weaker `canvas` kind. |
| `collect.js?params=mailing,placement` | Stores your own address parameters with each visit. |
| `collect.js?domains=shop.example,help.example` | Carries the visitor along links to your other sites. Requires `LINK_SECRET`. |
| `collect.js?pool=1` | Shows each visitor a separate phone number in elements marked `data-ag-pool`. Requires `POOL_NUMBERS`. See [number pools](calls.md#number-pools). |
| `collect.js?forms=all` | Adds the device id and landing page to every form that posts, on submit. By default, only to forms marked `data-ag-fields`. |

The script also reports taps on phone links and clicks on elements marked `data-ag-event`. List the event names to accept in `EVENTS`. See [page events and phone calls](calls.md).

To pass the answer from a consent banner, set `window.accountGraphConsent = { adUserData: true, adPersonalization: false }` before the tag.

### Device cookie

The script stores the visitor's device id in a cookie named `ag_device`, marked `Secure`. The cookie requires HTTPS, except on `localhost`.

Set `COOKIE=true` to have the server set the cookie instead. Safari deletes a cookie set by script after seven days; a cookie set by the server lasts. This works when the server answers on the site's own domain, or on a subdomain with `COOKIE=example.org`. The server-set cookie is untested in Safari.

### Multiple sites

Browsers keep cookies per domain, so each domain assigns its own device id. A person who visits two of your sites counts as two visitors until something links them: the [`domains` option](links.md), a confirmed fingerprint, or the same account signing in on both.

## Tokens

`GRAPH_TOKEN`, the service token, opens the six calls. Send it from your own services, and keep it out of browsers. `REVIEW_TOKENS` gives each reviewer a name and a token for the reviewer screen, and for [some of the calls](http.md#tokens). Make every token long and random, for example with `openssl rand -hex 32`.

```sh
REVIEW_TOKENS='{"dana":"…","lee":"…"}'
```

The audit log signs each decision with the name its token belongs to. Issue one token per person, because the signature identifies the token used.

To replace a token, list both, `{"dana":["new","old"]}`, and restart. Remove the old token once it is out of use. Removing a name ends that person's access; their decisions stay in the audit log.

[Routes for browsers](http.md#routes-for-browsers), `/collect.js`, `/review` and `/health` need no token. `/review` serves a page whose data requires one.

## Reviewer screen

Open `/review` and enter a token. Each view has its own address, so you can link to it, reload it and go back to it.

| Address | View | Shows |
| --- | --- | --- |
| `/review#/accounts` | Accounts | The largest clusters, recent changes, and decisions. |
| `/review#/accounts/account:42` | Accounts | One subject: its cluster, its links and their reasons, transfers, and sightings. |
| `/review#/journey/contact:42` | Journey | One person's timeline across all their subjects: visits, page activity, calls, steps and their values, consent, and decisions. |
| `/review#/board/90` | Board | People by the furthest step they reached. Unreturned missed calls come first. |
| `/review#/decide` | Matches | Related pairs in different clusters, one at a time, to join or separate. Keys: J, K, S to skip, U to undo. |
| `/review#/calls` | Calls | Unreturned missed calls, call outcomes by hour and weekday, and coverage, over the last 30 days. Accepts two days in the address, as Channels does. |
| `/review#/channels` | Channels | The cost and results of each campaign over the last 30 days. |
| `/review#/channels/2026-11-01/2026-11-30` | Channels | The same for the given days. A breakdown, a step and a number of days may follow. |
| `/review#/health` | Health | Undelivered alerts, feeds, jobs, conversions, the newest audit hash, and the running policy by kind. A banner appears when a rebuild is due. |

The screen checks for new writes every ten seconds and reloads the view when there are some. It pauses while its tab is hidden, and while someone types in the view or answers a prompt.

## Policy

The server runs the default weights, caps and half-lives. `POLICY` overrides only the values it names.

```sh
POLICY='{"kinds":{"phone":{"weight":0.85,"halfLife":63072000000}}}' npm start
```

For a longer policy, set `POLICY_FILE` to the path of a JSON file. [Matching](deciding.md) describes each part of a rule, and [Presets](presets.md) has a policy for contacts entered by staff. A new kind needs its weight, dilution, cap and half-life. Write `"none"` for an unlimited half-life.

> **A changed policy needs a rebuild.** The database keeps the policy it was built with. A server started with another one stops with `The policy differs from the one this database was built with. Run account-graph rebuild.`

1. Stop the servers.
2. Run `account-graph rebuild` with the new policy set. It blocks other writes while it runs.
3. Start the servers with the same policy.

Without `POLICY` and `POLICY_FILE`, the server takes the policy the database keeps. Removing the variable does not bring the default back. Set `POLICY='{}'` and rebuild for that.

A database from before the policy was kept takes the one that is set, where its clusters were built with it, and the default where none is set. The start log, `account-graph verify` and the Health view say when a rebuild is due.

Startup fails with one line per problem when a setting is invalid. It also fails when the policy omits the kind of a stored identifier.

## Consent

The server stores every answer about advertising with its time and source. The answer given most recently applies, whatever order answers arrive in.

| Origin of the answer | Stored source |
| --- | --- |
| The browser's Global Privacy Control signal | `browser signal` |
| The banner's answer, passed by the page | `banner` |
| Your backend, with a `consent` entry | The source you name |
| An answer stored before consent history existed | `before history`, with no time |

Every page view reports the browser signal again. A signal that says no overrides an earlier banner yes from the first visit that carries it. A visit that carries both counts as the signal.

`forget` deletes a subject's answers and records that deletion in the audit log. `account-graph prune` deletes old answers except the one that applies. [Privacy](privacy.md#consent) covers the effect of each answer.

## Audit log

Each decision is hashed together with the one before it. The Health view verifies the chain and reports the first altered entry. So does the route it reads:

```sh
curl -s https://graph.example.org/review/api/audit -H "authorization: Bearer $REVIEWER_TOKEN" | tee -a /somewhere/else/heads.log
```

```json
{ "sound": true, "head": { "seq": 418, "hash": "9c1f…" } }
```

The chain detects an edit to part of the log. Anyone able to rewrite the whole table could rebuild it, so copy the newest hash daily to a place they cannot write.

Copy it from the Health view, or set `AUDIT_HEAD_HOURS=24` to post it to `ALERT_WEBHOOK` once a day, with an `audit.head` [event](#events). To check an old copy, fetch that entry with `GET /review/api/decisions?before=419&limit=1` and compare its hash.

## Backups

All data lives in one PostgreSQL schema, `account_graph` or the value of `GRAPH_SCHEMA`. Schedule your own backups.

```sh
pg_dump --format=custom --schema=account_graph "$DATABASE_URL" > graph.dump
```

Restore into a new, empty database, then start the server on it:

```sh
pg_restore --no-owner --single-transaction --exit-on-error --dbname="$NEW_DATABASE_URL" graph.dump
account-graph verify             # no changes
account-graph events new-epoch   # every cursor is lost, and must be
```

Run the commands with the new database's address, before the server starts on it.

> **A restore takes the event numbers back.** Without `events new-epoch`, a follower that is ahead of the dump misses what happens next. After it, each follower gets `CURSOR_LOST` and reads everything again.

A dump cut short restores nothing. The server upgrades an older dump when it starts.

| Topic | Guidance |
| --- | --- |
| Restore tests | Restore a dump elsewhere before you need one. |
| Over a database in use | Restore beside it instead. `--clean` keeps any table newer than the dump, with its rows. Without `--no-owner`, another role gets an error for each table. |
| Audit hash | Store the newest hash apart from the dumps. After a restore, the Health view verifies the chain, and the stored hash confirms it is the same log. |
| Secrets | A dump holds receipts and keyed hashes. Keep `RECEIPT_SECRETS`, `IDENTIFIER_SECRET` and `LINK_SECRET` as long as the dump, and apart from it. |
| Deleted people | Older dumps still contain them. Keep dumps only as long as you need them, and run `forget` again after a restore, with new keys. |
| Conversions | Conversions sent since the dump may be sent again with the same id. Meta keeps the first copy, and Google reads the second as a correction. |

## Behind a proxy

Set `TRUST_PROXY=true` when a proxy or load balancer you run sits in front. The server then reads each visitor's address from `x-forwarded-for`. Otherwise every visit appears to come from the proxy, and the rate limit treats all visitors as one sender.

For two proxies in a row, such as a CDN in front of a load balancer, set `TRUST_PROXY=2`. Each proxy appends the address it received the request from. The server counts that many entries from the end and ignores earlier ones, which the sender wrote.

The server speaks plain HTTP, so terminate HTTPS at the proxy. [Caddy](https://caddyserver.com) obtains the certificate itself:

```text
graph.example.org {
  reverse_proxy 127.0.0.1:8080
}
```

> **Expose the server only through the proxy.** Direct access bypasses HTTPS and, with `TRUST_PROXY`, lets a sender claim any address. With compose, `GRAPH_PORT=127.0.0.1:8080` publishes the port on the local machine only.

Point a name under the site, such as `graph.example.org`, at the server with an `A` or `CNAME` record, and load `collect.js` from there. A cookie set by the server then belongs to the site.

## Staff traffic

Two settings exclude your own staff from the data. Both are off by default.

```sh
STAFF_NETWORKS=192.0.2.10,198.51.100.0/24   # addresses and ranges your offices browse from
```

For browsers outside those networks, create a staff link and send it to the person:

```sh
account-graph staff-link https://example.org/team
```

Opening the link sets a first-party cookie named `ag_staff`. The server then drops page views and page events from that browser on that site. The mark ends after 90 days, or when the browser opens any page with `?ag_staff=off`.

The mark is signed with `LINK_SECRET`. The server records a visit with any other mark as usual.

| Limit | Detail |
| --- | --- |
| Proxies | Set `TRUST_PROXY`. Otherwise every visit has the proxy's address, and all visits are dropped if that address is in a staff network. |
| Sites | The cookie covers one site. Open the link on each of yours. |
| Duration | The 90 days count from the link's creation. Some browsers delete a script-set cookie sooner: Safari after seven days without a visit. Open the link again. |
| HTTPS | The link must lead to an `https` address, because the cookie is marked `Secure`. `localhost` is the exception. |
| Sharing | Anyone who opens the link is marked. A published link hides real visitors until it expires. A new `LINK_SECRET` ends every mark and every other link. |
| Earlier visits | Visits from before the mark stay recorded. Run `forget` on the browser's `visitor:` subject to delete them. |
| Phone calls | Calls have no browser and stay recorded. |

## Rate limit

Each address may post a burst of 60 requests and 120 a minute to `/collect`. Beyond that the server answers 429 with a `retry-after` header.

The limit protects the graph from a single sender, because a script can claim any origin. Set `RATE_LIMIT=off` only when a system in front already limits requests. Each server process counts for itself.

## Upgrades

Start the new version. At startup the server applies every pending database change, in order, in one transaction.

Each change has a number and runs once. When several servers start together, one applies the changes and the others wait.

### To the six calls

> **Every old route for services is gone.** It answers 404. Change the callers before you upgrade, or upgrade both at once.

| Before | After |
| --- | --- |
| `/identify`, `/observe` | `record` `profile`. Raw identifiers go under `facts.identifiers`. |
| `/touch` | `record` `arrival`. Click ids go under `clicks`. |
| `/costs` | `record` `cost` |
| `/convert` | `record` `conversion`. `transactionId` is `key`, `action` is `actions`. |
| `/restate`, `/not-lead` | `record` `restatement`. A refund or write-off is an amount, where `/restate` took what was left. |
| `/payment` | `record` `payment`. `kind` is `direction`: `received` or `refunded`. |
| `/call`, `/call/result`, `/call/returned` | `record` `call`, `call_update` |
| `/text` | `record` `text` |
| `/consent` | `record` `consent`, `lookup` `person` |
| `/link`, `/sent` | `record` `link`, `lookup` `journey` |
| `/transfer`, `/flows`, `/collusion`, `/rings` | `record` `transfer`, `lookup` `transfers` |
| `/join`, `/separate`, `/ignore` | `decide` `merge`, `unmerge`, `split`, `unsplit`, `mute`, `unmute` |
| `/forget` | `forget` |
| `/people`, `/attribute`, `/cluster`, `/texting` | `lookup` `person` |
| `/match`, `/call/ringing`, `/conflicts`, `/find` | `lookup` `match`, `caller`, `conflicts`, `find` |
| `/outcome`, `/conversion`, `GET /call`, `GET /text` | `lookup` `record` |
| `/report`, `/board`, `/calls/summary`, `/calls`, `/texts`, `/followed`, `/conversions` | `report` `campaigns`, `pipeline`, `calls`, `callbacks`, `texts`, `after_calls`, `deliveries` |
| `/changes` | `events` |
| `/rebuild`, `/verify`, `/prune`, `/retry`, `/stats`, `/alerts/test`, `/staff-link` | [Commands](#commands) |

| Also | Detail |
| --- | --- |
| `RECEIPT_SECRETS` | Required. Make one with `openssl rand -hex 32`. |
| `CHANGE_WEBHOOK`, `CHANGE_SECRET` | Now `WEBHOOK_URL` and `WEBHOOK_SECRET`, both or neither. A server with an old name set does not start. The body is an [event envelope](#webhook). |
| `COST_INTERVAL_MS`, `COST_DAYS`, `OUTBOX_INTERVAL_MS` | No longer exist. Costs are read every six hours for the last seven days, and conversions are sent every 30 seconds. |
| `at` | Every write names it, and a key of its own. A caller that stamps `at` anew on each retry gets `KEY_REUSED`. |
| Decisions | A merge is taken back by its pair with `unmerge`. There is no mark to keep. |
| The change feed | Cluster changes became events and were numbered again. Start with `"after": null`. |
| Policy | The database keeps it from now on. See [the policy](#policy). |
| Pages | The old browser paths answer for one release, for pages that keep an old script. |

> **On the day you deploy, a page event can count once more.** Page events now have ids of their own, which begin with `page:`. An event a browser already sent that day has another id, so the same browser can count it a second time. The next day is as before.

### To the current weights

> **The default weights changed.** A phone number alone now joins two subjects, relates three, and reports no link among four or more. A phone, email or `voip` value held by more than 10 subjects links none of them. A server that ran the earlier defaults starts with a notice that a rebuild is due: run `account-graph rebuild` while the servers are stopped. To keep the earlier behavior, set `POLICY='{"kinds":{"phone":{"dilution":0,"cap":25},"email":{"cap":25},"voip":{"dilution":0,"cap":25}}}'` and rebuild if the server asks for it.

## Settings that must match

Processes that share a database must agree on these. The database keeps the policy, and a keyed mark of each secret. A process that differs stops at startup, or gets the fault `CONFIG.MISMATCH` on its first call.

| Setting | A process that differs | To change it |
| --- | --- | --- |
| `POLICY`, `POLICY_FILE` | Is refused. One without any takes the database's. | Stop the servers, run `account-graph rebuild` with the new one, start them with it |
| `IDENTIFIER_SECRET`, `LINK_SECRET` | Is refused. One without it is let in, and makes none of its keys. | The same. New keys match none of the old ones, and links already sent become ordinary links. |
| `RECEIPT_SECRETS` | Is refused where it lacks a secret that a stored receipt was made with | Put the new one first and keep the old ones. See [receipts](#receipts). |

A policy that lacks the kind of a stored identifier is refused too. Nothing else is compared, so give every process the same steps, numbers and opening hours.

## Receipts

Every key a caller sends is kept as a receipt, so a retry is known. A receipt holds keyed hashes of the key and of the fields that are [compared](http.md#idempotency), the number of a secret, and two times. It holds neither the key nor what came with it.

`RECEIPT_SECRETS` keys the hashes. Separate several with commas. The first signs, and all are tried.

```sh
RECEIPT_SECRETS=the-new-one…,the-old-one…
```

| Receipt | Kept |
| --- | --- |
| Of a key | A year at least. `account-graph prune` deletes those that are older than a year and than its day. |
| Of a key whose person was deleted | For good, as a tombstone: a type, a keyed hash and times. A late retry then brings nobody back. |

> **Keep an old secret while receipts made with it are kept.** A server without it does not start. Tombstones stay, so a secret under which anybody was deleted is kept for good.

After its receipt is pruned, a key is new again. A conversion, call, text, payment or transfer that is still on record stays one. A profile, an arrival or a consent answer is written a second time.

## Monitoring

| Where | Answers |
| --- | --- |
| `GET /health` | `{"ok":true}` once the database answers. Needs no token. Use it for load balancer checks. |
| `account-graph stats` | What the graph holds, and deliveries by state |
| `account-graph verify` | `{ changes, policy }`. `changes` lists the subjects whose stored cluster differs from a full recompute, and is empty when they agree. |
| `/review#/health` | Feeds and the time of each one's last record, job runs, undelivered alerts, pool usage, deliveries by state, and whether a rebuild is due |

## Events

An event says that something happened: a cluster changed, a conversion failed, a missed caller has waited too long. [The HTTP API](http.md#events) lists them.

Read them with the `events` call, or have them posted to you. The call is the truth. The webhook is the same body, and tells you sooner.

1. Start with `"after": null`. A subject no `cluster.changed` has named is in the cluster of its own name.
2. Read with the `cursor` you kept, act on the events, then keep the new `cursor`.
3. Read again at once while `more` is true. Otherwise read again every minute or so, and whenever the webhook arrives.
4. On `CURSOR_LOST`, start again with `null`.

If you stop between acting and keeping the cursor, the same events come again, so act on them in a way that can be repeated.

| A cursor is lost when | Do |
| --- | --- |
| `account-graph events new-epoch` was run, after a [restore](#backups) | Read everything again |
| `account-graph prune` deleted events it had not reached | Read what is left, and compare your copy with `lookup` |

> **A deletion takes its events with it.** A subject you delete with `forget` is gone from the events. Delete your own copy when you ask for the deletion.

### Webhook

Set `WEBHOOK_URL` and `WEBHOOK_SECRET`. The server posts new events there within seconds, in order, at most 100 to a post. The first post begins with what happens after it was set.

```http
POST <WEBHOOK_URL>
content-type: application/json
x-account-graph-signature: t=1795460000500,v1=<hex HMAC-SHA256 of "<t>.<body>">

{ "schemaVersion": 1, "cursor": "1fc21682.4182", "more": false, "events": [
  { "schemaVersion": 1, "seq": 4181, "type": "cluster.changed", "at": 1795460000000,
    "data": { "subject": "account:42", "from": "account:42", "to": "account:17" } },
  { "schemaVersion": 1, "seq": 4182, "type": "callback.overdue", "at": 1795460000400,
    "data": { "call": "CA1", "subject": "caller:96f2…", "missedAt": 1795373600000, "attempts": 1,
              "source": "google", "campaign": "Search: North", "campaignId": "20111" } }] }
```

| Rule | Detail |
| --- | --- |
| Signature | Over the body as received, under `WEBHOOK_SECRET`. Refuse an old `t`. The library has [`verifyWebhook` and `parseWebhook`](library.md#webhook). |
| Answer | Any 2xx within ten seconds. Redirects are not followed. |
| Delivery | At least once, in order, by one process at a time |
| Refused | Tried again after 30 seconds, doubling to an hour, for a day. Then the events of that post are passed over, and an alert says so. The `events` call still has them. |

## Alerts

Set `ALERT_WEBHOOK` to a Slack incoming webhook, or any URL that accepts `{"text": "…"}`. The server posts there when something needs attention. What is in this table is kept as an [event](#events) too.

| Event | Message content | Frequency |
| --- | --- | --- |
| A platform rejects a conversion, or its retries run out | Transaction, platform and reason, up to ten per message | At most once in ten minutes |
| The outbox cannot run, so conversions are paused | The reason, such as a database outage | At most once in ten minutes |
| Campaign costs cannot be read, so the report's costs become stale | Platform and reason | At most once in ten minutes per platform |
| A feed is stale | Feed and time of its last record | Once per stale period |
| Conversions are `LATE_HOURS` overdue | Due time of the oldest | Once a day while it lasts |
| A missed caller from a paid visit has waited `RETURN_HOURS` | Campaign, time, and number of callback attempts | Once per wait |

The server logs and stores an alert that fails to deliver, retries it every five minutes, and shows it on the Health view. The work it reports on continues. Without a webhook, alerts are stored and shown there. Delivery to a live alert webhook is untested.

Send a test alert:

```sh
account-graph alerts test
```

```json
{ "delivered": true }
```

### Stale feeds

Set how many hours without a record raise an alert. All four settings are off by default.

| Feed | Setting | Records counted |
| --- | --- | --- |
| Visits | `QUIET_TOUCHES_HOURS` | Any arrival |
| Calls | `QUIET_CALLS_HOURS` | Any inbound or outbound call |
| Call results | `QUIET_RESULTS_HOURS` | Any result |
| Campaign costs | `QUIET_COSTS_HOURS` | Any cost row |

The check uses the time the server stored the record. Choose hours longer than your slowest night or weekend. A stale feed is found by the absence of records. Records that are wrong are not found.

### Missed callers

The server alerts once, after `RETURN_HOURS`, about a missed caller from a paid visit who has not been reached. Another call from the same person during the wait adds no alert. Being reached and then missed again starts a new wait.

A visit is paid when it carries an ad click id, a campaign id, or a medium such as `cpc`. Meta's click id alone is insufficient, because unpaid links also carry it.

Missed callers require [call results](calls.md#call-results). The Calls view lists missed calls more than two weeks overdue.

### Opening hours

With opening hours set, waiting times and stale call feeds count only the hours you are open.

```sh
OPEN_HOURS='{
  "mon": ["09:00-12:00", "13:00-17:00"], "tue": ["09:00-17:00"], "wed": ["09:00-17:00"],
  "thu": ["09:00-17:00"], "fri": ["09:00-17:00"],
  "holidays": ["us-tx", "2026-12-31"]
}'
```

`us` stands for the federal holidays of every year from 1986, on the day they are kept, with Juneteenth from 2021. `us-tx` adds the day after Thanksgiving and the weekdays around Christmas.

| Counted in open hours | Counted in clock hours |
| --- | --- |
| `RETURN_HOURS`, for alerts and the board | `LATE_HOURS`, because conversions are sent at any hour |
| `QUIET_CALLS_HOURS` and `QUIET_RESULTS_HOURS` | `QUIET_TOUCHES_HOURS` and `QUIET_COSTS_HOURS`, because visits and costs arrive at any hour |
| The `wait` of a step, on the board | Everything in the report, and callback times |

> **Set them together.** With `OPEN_HOURS` set, `RETURN_HOURS=24` is three working days of eight hours, and `8` is one.

A day left out is closed. A span such as `18:00-02:00` runs past midnight and belongs to the day it starts on, so a holiday on that day closes all of it. Hours use `REPORT_TIME_ZONE`, or `"timeZone"` beside the days. They are one weekly schedule and a list of closed days for the whole organization.

The call summary reports the calls that began while you were closed, and their outcomes, under `closed`.

### Jobs

The Health view lists the background jobs: the outbox, each cost import, the audit hash post, and the alert checks. Each shows its last start, success and failure. A run that started and never finished is shown for a month.

## Shutdown

On `SIGTERM` or `SIGINT` the server stops taking requests, finishes the writes in progress, and closes its database connections. If a conversion's send is interrupted, the next start sends it again. The ad platforms keep the first copy.

## Environment variables

A partially set group stops the server at startup, with a message naming the missing variables.

### Server

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL address. |
| `GRAPH_TOKEN` | required | Service token. |
| `RECEIPT_SECRETS` | required | Keys the [receipts](#receipts). Separated by commas, at least 32 characters each. The first signs, and all are tried. |
| `REVIEW_TOKENS` | none | Reviewers, as JSON: each name with its token or a list of tokens. Each token must be unique and differ from `GRAPH_TOKEN`. |
| `ORIGINS` | none | Site addresses that may post visits, separated by commas. |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listening port and address. |
| `GRAPH_SCHEMA` | `account_graph` | Database schema that holds the tables. |
| `TRUST_PROXY` | `false` | `true`, or the number of proxies in front: read visitor addresses from `x-forwarded-for`. |
| `COOKIE` | `false` | `true`, or a domain, to keep the device id in a server-set cookie. |
| `RATE_PER_MINUTE`, `RATE_BURST` | `120`, `60` | Rate limit per address. |
| `RATE_LIMIT` | on | `off` removes the rate limit. |
| `POLICY`, `POLICY_FILE` | the default policy | Overrides to the default policy, as JSON or a JSON file. Set at most one. |
| `STAFF_NETWORKS` | none | Addresses and ranges whose visits are dropped, separated by commas: `192.0.2.10,198.51.100.0/24`. |
| `LINK_SECRET` | none | Signs personal links, staff links, and the tokens that carry a visitor between your sites. At least 32 characters. |
| `IDENTIFIER_SECRET` | none | Keys the hashes of [names](identify.md#names) and dates of birth. At least 32 characters. Changing it changes every key. |
| `REPORT_TIME_ZONE` | `UTC` | Time zone of the reviewer screen's days, the Board's today, opening hours and alerts, such as `America/New_York`. Use the ad account's. A `report` call names its own zone in its `window`. |

### Outcomes and calls

| Variable | Default | Description |
| --- | --- | --- |
| `STAGES` | none | Your steps in order, as JSON, each with a `value`, `currency`, `action` and `wait`. See [the report](report.md#steps). |
| `EVENTS` | none | Page events to record, separated by commas: `inquiry,phone_click`. |
| `CALL_NUMBERS` | none | Tracking numbers and the channel of each, as JSON: `{"+15551230001":{"source":"google","campaignId":"20222"}}`. Each may carry `tags`. |
| `CALL_NUMBERS_FILE` | none | A file with the same JSON, for a long list. Set one of the two. |
| `CALL_EXCLUDE` | none | Staff and test phone numbers, separated by commas. Calls from or to them are not recorded. |
| `CALL_MIN_SECONDS` | `30` | Shorter calls are recorded but not counted. |
| `CALL_TAP_SECONDS` | `180` | How long before a call a tap on its number may be, at most 3600. See [busy numbers](calls.md#busy-numbers). |
| `CALL_RESULTS` | none | `expected` holds each call until a system reports whether it was answered. See [calls](calls.md#call-results). |
| `CALL_RESULT_WAIT` | `30` | Minutes before a call without a result becomes unknown. |
| `POOL_NUMBERS` | none | Numbers shown to one visitor at a time, separated by commas. Off by default. |
| `POOL_MINUTES` | `15` | Minutes a visitor keeps a number after their page last requested it. |
| `POOL_GRACE_MINUTES` | `120` | Minutes after that in which a call still counts as theirs, if the number has not been reassigned. |
| `OPEN_HOURS` | none | Opening hours, as JSON. See [opening hours](#opening-hours). |

### Outbox, webhook and alerts

| Variable | Default | Description |
| --- | --- | --- |
| `OUTBOX_DELAY_MS` | `0` | Delay before the first send of a new outcome. |
| `FORGET_ADS` | none | `true` asks ad platforms that support it to retract conversions when a person is [deleted](privacy.md#data-at-ad-platforms). |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | none | URL that receives [events](#webhook), and the secret that signs each post. Set both. |
| `ALERT_WEBHOOK` | none | URL that receives alerts, as `{"text": "…"}`. |
| `AUDIT_HEAD_HOURS` | `0` | Posts the newest audit hash to `ALERT_WEBHOOK` at this interval, at least one hour. Requires `ALERT_WEBHOOK`. `0` disables it. |
| `QUIET_TOUCHES_HOURS`, `QUIET_CALLS_HOURS`, `QUIET_RESULTS_HOURS`, `QUIET_COSTS_HOURS` | `0` | Hours before a feed is [stale](#stale-feeds). `0` disables the check. |
| `LATE_HOURS` | `6` | Hours past its due time before a queued conversion raises an alert. `0` disables it. |
| `RETURN_HOURS` | `24` | Hours before a missed caller from a paid visit raises an alert, and before the board marks any missed caller overdue. `0` disables both. |

### Providers

| Variable | Default | Description |
| --- | --- | --- |
| `FINGERPRINT_SECRET`, `FINGERPRINT_REGION` | none, `us` | Confirms Fingerprint events. |
| `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY` | none | Classifies addresses with MaxMind. Set both. |
| `SERVER_RANGES_FILE` | none | A file with the address ranges of data centers, written as `192.0.2.0/24` or `2001:db8::/32` in any text: what [AWS](https://ip-ranges.amazonaws.com/ip-ranges.json) and [Google Cloud](https://www.gstatic.com/ipranges/cloud.json) publish, one after the other. An address in them is recorded and is no evidence. Read when the server starts, so fetch it again now and then. |
| `MAXMIND_SERVICE`, `MAXMIND_HOST` | `insights`, `geoip.maxmind.com` | MaxMind service and host. |
| `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_URL` | none | Accepts Twilio's call reports at `/calls/twilio`. Set both. |
| `TEXT_CODES` | off | `true` gives each browser a code for your [text links](texts.md). |
| `TWILIO_TEXT_WEBHOOK_URL` | none | With `TWILIO_AUTH_TOKEN`: accepts Twilio's incoming texts at `/texts/twilio`. |
| `TWILIO_ACCOUNT_SID` | none | With `TWILIO_AUTH_TOKEN`: looks up the line type of phones in a `profile`, a `call` or a `text`. |
| `SMARTY_AUTH_ID`, `SMARTY_AUTH_TOKEN` | none | Checks postal addresses in a `profile`. Set both. |
| `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_SERVICE_ACCOUNT_FILE` | none | Sends conversions to Google Ads. Set both. |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | none | The manager account, when the service account belongs to one. |
| `META_PIXEL_ID`, `META_ACCESS_TOKEN`, `META_SITE_URL` | none | Sends conversions to Meta. Set all three. |
| `META_TEST_EVENT_CODE` | none | Routes Meta events to its test tool. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_REFRESH_TOKEN`, `MICROSOFT_DEVELOPER_TOKEN`, `MICROSOFT_CUSTOMER_ID`, `MICROSOFT_ACCOUNT_ID` | none | Sends conversions to Microsoft Advertising. Set all five. |
| `MICROSOFT_CLIENT_SECRET` | none | Required only for a web app registration. |
| `TIKTOK_PIXEL_CODE`, `TIKTOK_ACCESS_TOKEN`, `TIKTOK_SITE_URL` | none | Sends conversions to TikTok. Set all three. |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | none | Reads campaign costs from Google Ads. Requires `GOOGLE_ADS_CUSTOMER_ID` and `GOOGLE_SERVICE_ACCOUNT_FILE`. |
| `META_AD_ACCOUNT_ID`, `META_ADS_TOKEN` | none | Reads campaign costs from Meta. Set both. |
| `GOOGLE_ADS_CONVERSIONS` | none | `true` also reads Google's conversion count for each campaign. |
| `META_ADS_CONVERSIONS` | none | The action to read from Meta with its costs, such as `offsite_conversion.fb_pixel_lead`. |

## Limitations

- Consent covers what may be sent to ad platforms. It is neither a record of consent to be called, texted or written to, nor a legal record.
