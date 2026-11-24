# Operations

One command upgrades the database, serves the HTTP API and the reviewer screen, and sends queued conversions.

```sh
DATABASE_URL=postgres://localhost/graph \
GRAPH_TOKEN=a-long-random-string \
ORIGINS=https://example.org \
npm start
```

```text
database upgraded: tables, sighting record time
listening on 0.0.0.0:8080
collect accepts https://example.org
reviewers none, server cookie off, fingerprint off, maxmind off, signed links off, staff networks off, opening hours off, alerts off, address checks off, phone line checks off
outbox sends to none (no ad platform configured)
page events: none (set EVENTS); calls from twilio off; call results not expected; number pool off
cost sources: none (POST /costs)
policy b1a4d46bae50 (default)
```

The lines after `collect accepts` list the enabled features. Each provider turns on when its variables are set. [Providers](providers.md) covers where to get the keys.

## Docker

`docker compose up --build` starts the server and PostgreSQL on port 8080.

```sh
GRAPH_TOKEN=a-long-random-string REVIEW_TOKENS='{"dana":"another-one"}' ORIGINS=https://example.org docker compose up --build
```

Compose also reads a `.env` file in the same directory. Run `cp .env.example .env` and fill it in. Set `GRAPH_PORT` to publish a different port.

Compose passes the variables in [Environment variables](#environment-variables) through to the server, except `GRAPH_SCHEMA`, `HOST`, `PORT` and `POLICY_FILE`. It sets `DATABASE_URL` itself.

> **Use the compose file for evaluation.** It has a local volume, a fixed database password, the example site's features and a placeholder `LINK_SECRET`. Replace these before production use. Values in `compose.yaml` that start with `change-me` are public, and the server refuses to start with one when `ORIGINS` contains a site outside your own machine.

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

Set `COOKIE=true` to have the server set the cookie instead. Safari deletes a cookie set by script after seven days; a cookie set by the server lasts. This works when the server answers on the site's own domain, or on a subdomain with `COOKIE=example.org`.

### Multiple sites

Browsers keep cookies per domain, so each domain assigns its own device id. A person who visits two of your sites counts as two visitors until something links them: the [`domains` option](links.md), a confirmed fingerprint, or the same account signing in on both.

## Tokens

`GRAPH_TOKEN`, the service token, opens every route. Send it from your own services, and keep it out of browsers. `REVIEW_TOKENS` gives each reviewer a name and a token for the routes of the reviewer screen. Make every token long and random, for example with `openssl rand -hex 32`.

```sh
REVIEW_TOKENS='{"dana":"…","lee":"…"}'
```

The audit log signs each decision with the name its token belongs to. Issue one token per person, because the signature identifies the token used.

To replace a token, list both, `{"dana":["new","old"]}`, and restart. Remove the old token once it is out of use. Removing a name ends that person's access; their decisions stay in the audit log.

`/collect`, `/event`, `/carry`, `/collect.js`, `/review` and `/health` are among the [routes without a token](http.md#routes-without-a-token). `/review` serves a page whose data requires one.

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

> **A changed policy needs a rebuild.** Scores follow the new policy at once. Stored clusters keep the old policy, and new writes mix the two, until you post to `/rebuild` with the service token.

The server stores a hash of the policy that built the clusters. When the running policy differs, the start log, `GET /stats`, `GET /verify` and the Health view report that a rebuild is due. They report the same for a database created before the hash was stored.

Startup fails with one line per problem when a setting is invalid. It also fails when the policy omits the kind of a stored identifier.

## Consent

The server stores every answer about advertising with its time and source. The answer given most recently applies, whatever order answers arrive in.

| Origin of the answer | Stored source |
| --- | --- |
| The browser's Global Privacy Control signal | `browser signal` |
| The banner's answer, passed by the page | `banner` |
| Your backend, with `POST /consent` | The source you name |
| An answer stored before consent history existed | `before history`, with no time |

Every page view reports the browser signal again. A signal that says no overrides an earlier banner yes from the first visit that carries it. A visit that carries both counts as the signal.

`forget` deletes a subject's answers and records that deletion in the audit log. `prune` deletes old answers except the one that applies. [Privacy](privacy.md#consent) covers the effect of each answer.

## Audit log

Each decision is hashed together with the one before it. `GET /audit` verifies the chain and reports the first altered entry.

```sh
curl -s https://graph.example.org/audit -H "authorization: Bearer $REVIEWER_TOKEN" | tee -a /somewhere/else/heads.log
```

```json
{ "sound": true, "head": { "seq": 418, "hash": "9c1f…" } }
```

The chain detects an edit to part of the log. Anyone able to rewrite the whole table could rebuild it, so copy the newest hash daily to a place they cannot write.

Copy it from the Health view, or set `AUDIT_HEAD_HOURS=24` to post it to `ALERT_WEBHOOK` once a day. To check an old copy, fetch that entry with `GET /decisions?before=419&limit=1` and compare its hash.

## Backups

All data lives in one PostgreSQL schema, `account_graph` or the value of `GRAPH_SCHEMA`. Schedule your own backups.

```sh
pg_dump --format=custom --schema=account_graph "$DATABASE_URL" > graph.dump
pg_restore --clean --if-exists --dbname="$DATABASE_URL" graph.dump   # with the server stopped
curl https://graph.example.org/verify -H "authorization: Bearer $GRAPH_TOKEN"   # then, with it running
```

| Topic | Guidance |
| --- | --- |
| Restore tests | Restore a dump elsewhere before you need one. |
| Audit hash | Store the newest hash apart from the dumps. After a restore, `/audit` verifies the chain, and the stored hash confirms it is the same log. |
| Deleted people | Older dumps still contain them. Keep dumps only as long as you need them, and run `forget` again after a restore. |
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

Two settings exclude your own staff from the data. Both are off by default, and `GET /stats` counts the excluded requests as `staff`.

```sh
STAFF_NETWORKS=192.0.2.10,198.51.100.0/24   # addresses and ranges your offices browse from
```

For browsers outside those networks, create a staff link and send it to the person:

```sh
curl -X POST https://graph.example.org/staff-link -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"url":"https://example.org/team","days":90}'
```

Opening the link sets a first-party cookie named `ag_staff`. The server then drops page views and page events from that browser on that site. The mark ends after the given days, or when the browser opens any page with `?ag_staff=off`.

The mark is signed with `LINK_SECRET`. The server records a visit with any other mark as usual.

| Limit | Detail |
| --- | --- |
| Proxies | Set `TRUST_PROXY`. Otherwise every visit has the proxy's address, and all visits are dropped if that address is in a staff network. |
| Sites | The cookie covers one site. Open the link on each of yours. |
| Duration | The days count from the link's creation. Some browsers delete a script-set cookie sooner: Safari after seven days without a visit. Open the link again. |
| HTTPS | The link must lead to an `https` address, because the cookie is marked `Secure`. `localhost` is the exception. |
| Sharing | Anyone who opens the link is marked. A published link hides real visitors until it expires. A new `LINK_SECRET` ends every mark and every other link. |
| Earlier visits | Visits from before the mark stay recorded. Run `forget` on the browser's `visitor:` subject to delete them. |
| Phone calls | Calls have no browser and stay recorded. |

## Rate limit

Each address may post a burst of 60 requests and 120 a minute to `/collect`, `/event`, `/carry` and `/number` combined. Beyond that the server answers 429 with a `retry-after` header.

The limit protects the graph from a single sender, because a script can claim any origin. Set `RATE_LIMIT=off` only when a system in front already limits requests.

## Upgrades

Start the new version. At startup the server applies every pending database change, in order, in one transaction.

Each change has a number and runs once. When several servers start together, one applies the changes and the others wait. `upgrades()` in `account-graph/postgres` lists them.

> **The default weights changed.** A phone number alone now joins two subjects, relates three, and reports no link among four or more. A phone, email or `voip` value held by more than 10 subjects links none of them. A server that ran the earlier defaults starts with a notice that a rebuild is due: post to `/rebuild` while writes are paused. To keep the earlier behavior, set `POLICY='{"kinds":{"phone":{"dilution":0,"cap":25},"email":{"cap":25},"voip":{"dilution":0,"cap":25}}}'`.

## Monitoring

| Route | Token | Answers |
| --- | --- | --- |
| `GET /health` | none | `{"ok":true}` once the database answers. Use it for load balancer checks. |
| `GET /stats` | service | Since start: requests collected, rate limited, from declared bots, and from staff, plus errors, pool numbers assigned and pool exhaustions. Also the graph's contents, whether a rebuild is due, and outbox jobs by state. |
| `GET /ops` | review | Feeds and the time of each one's last record, job runs, undelivered alerts, pool usage, and outbox jobs by state. |
| `GET /verify` | service | `{ changes, policy }`. `changes` lists the subjects whose stored cluster differs from a full recompute, and is empty when they agree. It reads every edge. |

## Alerts

Set `ALERT_WEBHOOK` to a Slack incoming webhook, or any URL that accepts `{"text": "…"}`. The server posts there when an event needs attention:

| Event | Message content | Frequency |
| --- | --- | --- |
| A platform rejects a conversion, or its retries run out | Transaction, platform and reason, up to ten per message | At most once in ten minutes |
| The outbox cannot run, so conversions are paused | The reason, such as a database outage | At most once in ten minutes |
| Campaign costs cannot be read, so the report's costs become stale | Platform and reason | At most once in ten minutes per platform |
| A feed is stale | Feed and time of its last record | Once per stale period |
| Conversions are `LATE_HOURS` overdue | Due time of the oldest | Once a day while it lasts |
| A missed caller from a paid visit has waited `RETURN_HOURS` | Campaign, time, and number of callback attempts | Once per wait |

The server logs and stores an alert that fails to deliver, retries it every five minutes, and shows it on the Health view. The work it reports on continues. Without a webhook, alerts are stored and shown there.

Send a test alert:

```sh
curl -X POST https://graph.example.org/alerts/test -H "authorization: Bearer $GRAPH_TOKEN"
```

```json
{ "delivered": true }
```

### Stale feeds

Set how many hours without a record raise an alert. All four settings are off by default.

| Feed | Setting | Records counted |
| --- | --- | --- |
| Visits | `QUIET_TOUCHES_HOURS` | Any touch |
| Calls | `QUIET_CALLS_HOURS` | Any inbound or outbound call |
| Call results | `QUIET_RESULTS_HOURS` | Any result |
| Campaign costs | `QUIET_COSTS_HOURS` | Any cost row |

The check uses the time the server stored the record. Choose hours longer than your slowest night or weekend.

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
  "holidays": ["2026-12-25", "2027-01-01"]
}'
```

| Counted in open hours | Counted in clock hours |
| --- | --- |
| `RETURN_HOURS`, for alerts and the board | `LATE_HOURS`, because conversions are sent at any hour |
| `QUIET_CALLS_HOURS` and `QUIET_RESULTS_HOURS` | `QUIET_TOUCHES_HOURS` and `QUIET_COSTS_HOURS`, because visits and costs arrive at any hour |
| The `wait` of a step, on the board | Everything in the report, and callback times |

> **Set them together.** With `OPEN_HOURS` set, `RETURN_HOURS=24` is three working days of eight hours, and `8` is one.

A day left out is closed. A span such as `18:00-02:00` runs past midnight and belongs to the day it starts on, so a holiday on that day closes all of it. Hours use `REPORT_TIME_ZONE`, or `"timeZone"` beside the days.

The call summary reports the calls that began while you were closed, and their outcomes, under `closed`.

### Jobs

The Health view and `GET /ops` list the background jobs: the outbox, each cost import, the audit hash post, and the alert checks. Each shows its last start, success and failure. A run that started and never finished is shown for a month.

### Change webhook

Set `CHANGE_WEBHOOK` to a URL. The server posts `{"changes": [...]}` there each time a cluster changes. Each change names a subject, the cluster it left, and the cluster it joined.

Each post is sent once. Use it to learn at once that something changed, and read the [change feed](#change-feed) for what did.

With `CHANGE_SECRET`, each post carries `x-account-graph-signature: t=<ms>,v1=<hex>`. `v1` is the HMAC-SHA256 of `<t>.<body>` under the secret. Check it over the body as received, and refuse an old `t`.

### Change feed

`GET /changes` answers every cluster change in order, so a system of yours can follow along without missing one.

```sh
curl "https://graph.example.org/changes?after=4180" -H "authorization: Bearer $GRAPH_TOKEN"
```

```json
{ "changes": [{ "seq": 4181, "at": 1795460000000, "subject": "account:42", "from": "account:42", "to": "account:17" }], "next": 4181, "more": false }
```

1. Start with `after=now` and keep `next`, or with `after=0` to read everything kept.
2. Read with the number you kept, act on the changes, then keep the new `next`.
3. Read again at once while `more` is true.

If you stop between acting and keeping `next`, the same changes come again, so act on them in a way that can be repeated. `limit` is 500 unless you set it, and at most 1,000.

> **A deletion takes its changes with it.** A subject you delete with `/forget` is gone from the feed. Delete your own copy when you ask for the deletion.

## Shutdown

On `SIGTERM` or `SIGINT` the server stops taking requests, finishes the writes in progress, and closes its database connections. If a conversion's send is interrupted, the next start sends it again. The ad platforms keep the first copy.

## Environment variables

A partially set group stops the server at startup, with a message naming the missing variables.

### Server

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL address. |
| `GRAPH_TOKEN` | required | Service token. |
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
| `IDENTIFIER_SECRET` | none | Keys the hashes of names sent to `/identify`. At least 32 characters. Changing it changes every key. |
| `REPORT_TIME_ZONE` | `UTC` | Time zone for the days of `/report` and the call routes, such as `America/New_York`. Use the ad account's. |

### Outcomes and calls

| Variable | Default | Description |
| --- | --- | --- |
| `STAGES` | none | Your steps in order, as JSON, each with a `value`, `currency`, `action` and `wait`. See [the report](report.md#steps). |
| `EVENTS` | none | Page events to record, separated by commas: `inquiry,phone_click`. |
| `CALL_NUMBERS` | none | Tracking numbers and the channel of each, as JSON: `{"+15551230001":{"source":"google","campaignId":"20222"}}`. Each may carry `tags`. |
| `CALL_EXCLUDE` | none | Staff and test phone numbers, separated by commas. Calls from or to them are not recorded. |
| `CALL_MIN_SECONDS` | `30` | Shorter calls are recorded but not counted. |
| `CALL_TAP_SECONDS` | `180` | How long before a call a tap on its number may be, at most 3600. See [busy numbers](calls.md#busy-numbers). |
| `CALL_RESULTS` | none | `expected` holds each call until a system reports whether it was answered. See [calls](calls.md#call-results). |
| `CALL_RESULT_WAIT` | `30` | Minutes before a call without a result becomes unknown. |
| `POOL_NUMBERS` | none | Numbers shown to one visitor at a time, separated by commas. Off by default. |
| `POOL_MINUTES` | `15` | Minutes a visitor keeps a number after their page last requested it. |
| `POOL_GRACE_MINUTES` | `120` | Minutes after that in which a call still counts as theirs, if the number has not been reassigned. |
| `OPEN_HOURS` | none | Opening hours, as JSON. See [opening hours](#opening-hours). |

### Outbox and alerts

| Variable | Default | Description |
| --- | --- | --- |
| `OUTBOX_INTERVAL_MS` | `30000` | Interval between sends of due conversions. |
| `OUTBOX_DELAY_MS` | `0` | Delay before the first send of a new outcome. |
| `FORGET_ADS` | none | `true` asks ad platforms that support it to retract conversions when a person is [deleted](privacy.md#data-at-ad-platforms). |
| `CHANGE_WEBHOOK` | none | URL that receives cluster changes. |
| `CHANGE_SECRET` | none | Signs each post to `CHANGE_WEBHOOK`. |
| `ALERT_WEBHOOK` | none | URL that receives alerts, as `{"text": "…"}`. |
| `AUDIT_HEAD_HOURS` | `0` | Posts the newest audit hash to `ALERT_WEBHOOK` at startup and at this interval, at least one hour. Requires `ALERT_WEBHOOK`. `0` disables it. |
| `QUIET_TOUCHES_HOURS`, `QUIET_CALLS_HOURS`, `QUIET_RESULTS_HOURS`, `QUIET_COSTS_HOURS` | `0` | Hours before a feed is [stale](#stale-feeds). `0` disables the check. |
| `LATE_HOURS` | `6` | Hours past its due time before a queued conversion raises an alert. `0` disables it. |
| `RETURN_HOURS` | `24` | Hours before a missed caller from a paid visit raises an alert, and before the board marks any missed caller overdue. `0` disables both. |

### Providers

| Variable | Default | Description |
| --- | --- | --- |
| `FINGERPRINT_SECRET`, `FINGERPRINT_REGION` | none, `us` | Confirms Fingerprint events. |
| `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY` | none | Classifies addresses with MaxMind. Set both. |
| `MAXMIND_SERVICE`, `MAXMIND_HOST` | `insights`, `geoip.maxmind.com` | MaxMind service and host. |
| `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_URL` | none | Accepts Twilio's call reports at `/calls/twilio`. Set both. |
| `TWILIO_ACCOUNT_SID` | none | With `TWILIO_AUTH_TOKEN`: looks up the line type of phones posted to `/identify`. |
| `SMARTY_AUTH_ID`, `SMARTY_AUTH_TOKEN` | none | Checks postal addresses posted to `/identify`. Set both. |
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
| `COST_INTERVAL_MS`, `COST_DAYS` | six hours, `7` | Interval between cost imports, and the days each one reads. |

## Limitations

- Consent covers what may be sent to ad platforms. It is neither a record of consent to be called, texted or written to, nor a legal record.
