# Running the server

One command starts everything: it brings the database up to date, serves the routes, and sends what the outbox holds.

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
reviewer token off, server cookie off, fingerprint off, maxmind off, signed links off, staff networks off, alerts off, address checks off, phone line checks off
outbox sends to nobody (no ad platform configured)
page events taken: none (set EVENTS); calls from twilio off; call results not expected
costs are read from nobody (post them to /costs)
```

The last five lines say what is switched on. Each provider turns on when its variables are set; [providers.md](providers.md) says where to get them.

## With Docker

`docker compose up --build` starts the server and a PostgreSQL beside it, on port 8080.

```sh
GRAPH_TOKEN=a-long-random-string REVIEW_TOKEN=another-one ORIGINS=https://example.org docker compose up --build
```

Set `GRAPH_PORT` to publish it on another port. Every variable in the table at the end of this page is passed through to the server when you set it, the same way as the three above.

The compose file is for trying it out: it keeps the database in a local volume, uses a fixed database password, and switches on what the example site shows, with a placeholder `LINK_SECRET`. Set your own before anything real touches it.

## The script tag

Each site adds one line. The script reports every page view to the server it was loaded from, so it needs no configuration.

```html
<script type="module" src="https://graph.example.org/collect.js"></script>
```

```text
page ──▶ collect.js ──▶ POST /collect ──▶ graph
          (reads the click id, the campaign and ad ids, the device id)
```

The site's address must be in `ORIGINS`, or `/collect` answers 403. A site with a content security policy must allow the server's address under `script-src` and `connect-src`.

Options ride on the script's address:

| Address | What it adds |
| --- | --- |
| `collect.js?fingerprint=PUBLIC_KEY` | Confirms each visitor with Fingerprint. Add `&region=eu` or `&region=ap` outside the US, and `&endpoints=…` for your own subdomain. |
| `collect.js?canvas=open` | Adds the open-source FingerprintJS id, recorded as the weaker `canvas` kind. |
| `collect.js?params=mailing,placement` | Keeps address parameters of your own with each arrival. |
| `collect.js?domains=shop.example,help.example` | Carries the visitor along links to your other sites. Needs `LINK_SECRET`. |
| `collect.js?forms=all` | Adds the device id and landing page to every form as it is submitted. Without it, only forms marked `data-ag-fields`. |

The same script reports taps on phone links and clicks on elements marked `data-ag-event`, once the server is told which names to keep with `EVENTS`. [Page events and phone calls](calls.md) has the details.

To pass a consent banner's answer, set `window.accountGraphConsent = { adUserData: true, adPersonalization: false }` before the tag.

The script keeps the visitor's device id in a cookie named `ag_device`, marked `Secure`. Browsers only keep such a cookie on a site served over HTTPS; `localhost` is the exception.

### Several sites

Each site's domain gets its own device id, because a browser keeps cookies per domain. A person who visits two of your sites is two visitors until something ties them.

Three things can: the script tag's `domains` option, which carries a visitor along the links between your sites; a confirmed fingerprint; or the same account signing in on both. [Links](links.md) covers the first.

## Tokens

`GRAPH_TOKEN` opens every route. Your own services send it; nothing in a browser should hold it.

`REVIEW_TOKEN` is for the people who review accounts. It opens the reviewer screen's routes and nothing your services write through. Make both long and random, for example with `openssl rand -hex 32`.

> **`/collect`, `/event`, `/carry`, `/collect.js`, `/review` and `/health` need no token.** `/review` is only a page; nothing it shows arrives without one.

## Consent

Every answer about advertising is kept, with when it was given and where. The newest by when it was given stands, so an answer that arrives late does not undo a later one.

| Where an answer comes from | Its source |
| --- | --- |
| The browser's Global Privacy Control signal | `browser signal` |
| The banner's answer, passed by the page | `banner` |
| Your backend, with `POST /consent` | what you name |
| An answer kept before there was a history | `before history`, with no time known |

Every page view reports again what the browser says. So where a banner once said yes and the browser's signal now says no, the signal stands from the first visit that carries it. A visit that carries both counts as the signal.

> **This covers advertising only.** It says what may be sent to ad platforms. It is not a record of consent to be called, texted or written to, and it is not a legal record of anything.

`forget` deletes a subject's answers, and that deletion is itself on the record of decisions. `prune` deletes old answers but never the one that stands.

## The record of decisions

Each decision is sealed to the one before it, and `GET /audit` checks the whole chain. The chain shows that part of it was not edited. Someone who can rewrite the whole table could still rebuild it, so keep the newest hash where they cannot write.

```sh
curl -s https://graph.example.org/audit -H "authorization: Bearer $REVIEW_TOKEN" | tee -a /somewhere/else/heads.log
```

```json
{ "sound": true, "head": { "seq": 418, "hash": "9c1f…" } }
```

Copy it daily. The Health view has a Copy button, and `AUDIT_HEAD_HOURS=24` posts the line to `ALERT_WEBHOOK` once a day. To check an old copy, find that entry with `GET /decisions?before=419&limit=1` and compare its hash.

## Behind a proxy

Set `TRUST_PROXY=true` when a proxy or load balancer you run sits in front. The server then reads each visitor's address from `x-forwarded-for`. Without it, every visit appears to come from the proxy, and the per-address limit below would count them as one sender.

With two proxies in a row, such as a CDN in front of a load balancer, set `TRUST_PROXY=2`. Each proxy adds the address it heard from to the end of that header, so the visitor's is that many from the end. Whatever comes before it was written by the sender and is ignored.

Set `COOKIE=true` to have the server keep the device id in a cookie it sets itself. Safari deletes a cookie set by script after seven days; one set by the server lasts. It only works when the server answers on the site's own domain, or on a subdomain with `COOKIE=example.org`.

## Visits by your own staff

People who work for you open the same pages your clients do, and their visits can be a large share of what is recorded. Two settings drop them. Both are off until set, and both are counted as `staff` in `GET /stats`.

```sh
STAFF_NETWORKS=192.0.2.10,198.51.100.0/24   # addresses and ranges your offices browse from
```

A browser that moves around is marked by opening a link. Ask the server for one, and send it to the person:

```sh
curl -X POST https://graph.example.org/staff-link -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"url":"https://example.org/team","days":90}'
```

Opening it on your site leaves a first-party cookie named `ag_staff`. From then on the visits and page events of that browser on that site are dropped, until the days are over or someone opens any page with `?ag_staff=off`.

> **A browser cannot mark itself.** The mark is signed with `LINK_SECRET`, and a visit that carries any other is recorded like everyone's.

| Limit | Detail |
| --- | --- |
| Behind a proxy | Set `TRUST_PROXY`, or every visit comes from the proxy's address. If that address is in a staff network, every visit is dropped. |
| One site at a time | A cookie belongs to a site. Open the link on each of yours. |
| How long a mark lasts | The days count from when the link was made. The cookie is set by script, and some browsers drop such a cookie sooner: Safari after seven days without a visit. Open the link again. |
| HTTPS only | The link must lead to an `https` address, because the cookie is marked `Secure`. `localhost` is the exception. |
| A staff link is a key | Anyone who opens it is marked. Published by mistake, it hides real visitors until it expires. A new `LINK_SECRET` ends every mark, and every other link. |
| Earlier visits | What a browser did before it was marked is still recorded. `forget` its `visitor:` subject to remove it. |
| Phone calls | Not covered. A call has no browser. |

## Limits on visits

Each address may post 60 visits at once and 120 a minute to `/collect`. Past that it gets 429 with a `retry-after` header.

The origin check only stops browsers. A script can claim any origin, so the per-address limit is what keeps one sender from flooding the graph. Set `RATE_LIMIT=off` only when something in front already limits.

## Upgrading

Start the new version. On start the server applies every database change the database has not had, in order, inside one transaction.

Each change has a number and runs once. Several servers may start at the same moment; one applies the changes and the others wait. `upgrades()` in `account-graph/postgres` is the list.

> **The default weights changed.** A phone number alone now joins two subjects, relates three, and reports no link among four or more, and a phone, email or `voip` value held by more than 10 subjects links nothing. A server that ran the earlier defaults starts with the notice that a rebuild is due: post to `/rebuild` when no one is writing. To keep the earlier behaviour, set `POLICY='{"kinds":{"phone":{"dilution":0,"cap":25},"email":{"cap":25},"voip":{"dilution":0,"cap":25}}}'`.

## The reviewer screen

Open `/review` and enter a token. Each view has an address of its own, so it can be linked, reloaded and gone back to.

| Address | Shows |
| --- | --- |
| `/review#/accounts` | The largest clusters, recent changes, and decisions. |
| `/review#/accounts/account:42` | One subject: its cluster, its ties and why, its money, its sightings. |
| `/review#/journey/contact:42` | One person's timeline: arrivals, what they were seen doing, calls, steps and their values, consent and decisions, on every subject that is them. |
| `/review#/calls` | Missed calls not returned, how calls went by hour and weekday, and coverage, over the last 30 days. Takes two days like the next. |
| `/review#/channels` | What each campaign cost and brought in, over the last 30 days. |
| `/review#/channels/2026-11-01/2026-11-30` | The same, for the days named. A breakdown, a step and a number of days may follow. |
| `/review#/health` | Alerts not delivered, feeds, jobs, conversions, the record's newest hash, the running policy by kind, and a banner when a rebuild is due. |

Every ten seconds the screen asks one small question, whether anything was written since it last looked, and reads the view again only when the answer is yes. It does not ask while its tab is hidden, and it does not redraw while someone is typing in the view or answering a question.

## The policy

The server runs the default weights, caps and half-lives until you name something different. Name only what differs; the rest stays as it is.

```sh
POLICY='{"kinds":{"phone":{"weight":0.85,"halfLife":63072000000}}}' npm start
```

A longer one goes in a file named by `POLICY_FILE`. [How it decides](deciding.md) says what each part of a rule does. A new kind needs its weight, dilution, cap and half-life, and a half-life that never ends is written `"none"`. [Presets](presets.md) has a policy for contacts entered by staff.

> **A changed policy needs a rebuild.** Scores follow the new policy at once. Stored clusters stay as they were, and new writes mix the two, until someone posts to `/rebuild` with the service token.

The server stores a hash of the policy the clusters were built with. When the running one differs, the start log, `GET /stats`, `GET /verify` and the Health view say that a rebuild is due. A database from before the hash was kept says so too, because which policy built it is not known.

A setting the server cannot use stops it at start, with a line for each problem. So does a stored identifier whose kind the policy does not name, such as a kind of your own that was taken out of the setting.

## Watching it

| Route | Token | Answers |
| --- | --- | --- |
| `GET /health` | none | `{"ok":true}` once the database answers. Use it for a load balancer's check. |
| `GET /stats` | service | Visits collected, visits refused by the limit, visits from declared bots, staff visits dropped, and errors since start; what the graph holds; whether a rebuild is due; outbox jobs by state. |
| `GET /ops` | review | Feeds and when each was last heard from, how jobs ran, alerts not delivered, outbox jobs by state. |
| `GET /verify` | service | `{ changes, policy }`. `changes` lists the subjects whose stored cluster differs from a full recompute, and is empty when sound. It reads every edge. |

Set `ALERT_WEBHOOK` to a Slack incoming webhook, or anything that takes `{"text": "…"}`, and the server posts there when something needs a person:

| When | The message says |
| --- | --- |
| A conversion fails for good | Which transaction, which platform, and the platform's reason. Up to ten per message. |
| The outbox cannot run | Why, such as the database not answering. Nothing is being sent while this lasts. |
| Campaign costs cannot be read | Which platform and why. The report's costs go stale until it is fixed. |
| A feed has gone quiet | Which one, and when it was last heard from. Once for each silence. |
| A missed caller from a paid arrival has waited `RETURN_HOURS` | Where they came from, when, and how often they were rung back. Once for each wait, never repeated. |

The first three kinds are sent at most once in ten minutes each. An alert that cannot be delivered is logged, kept, shown on the Health view, and tried again every five minutes until it arrives. It never stops the work it was reporting on. With no webhook set, what would have been said is kept and shown there.

Send one to see that it arrives:

```sh
curl -X POST https://graph.example.org/alerts/test -H "authorization: Bearer $GRAPH_TOKEN"
```

```json
{ "delivered": true }
```

### Silence

A feed that breaks makes no error: calls just stop coming. Say after how many hours of nothing each one is worth a message. All four are off until set.

| Feed | Setting | What feeds it |
| --- | --- | --- |
| Arrivals | `QUIET_TOUCHES_HOURS` | Any touch written down |
| Calls | `QUIET_CALLS_HOURS` | Any call, to you or from you |
| Call results | `QUIET_RESULTS_HOURS` | Any result |
| Campaign costs | `QUIET_COSTS_HOURS` | Any cost row |

The time is when a record was written down, not the time it carries. Pick hours longer than your quietest night or weekend.

### Callers waiting

A caller who arrived from an ad, was missed, and has not been reached is told about once after `RETURN_HOURS`. Ringing again does not repeat it; being reached and missed later is a new wait. An arrival counts as paid when it carries an ad click, names its campaign by id, or has a medium such as `cpc`. Meta's click id alone is not enough, because links nobody paid for carry it too.

This needs [call results](calls.md#was-it-answered), because without one nothing says a call was missed. A miss more than two weeks overdue is left to the Calls view.

### Jobs

The Health view and `GET /ops` list what runs by itself: the outbox, each cost import, the checks behind these alerts. Each shows when it last began, succeeded and failed, and whether a run began and never finished. Such a run is shown for a month.

Set `CHANGE_WEBHOOK` to a URL and the server posts `{"changes": [...]}` there each time a cluster changes. Each change names a subject, the cluster it left, and the cluster it joined.

## Stopping

On `SIGTERM` or `SIGINT` the server stops taking requests, finishes the writes in flight, and closes its database connections. A conversion that was being sent is sent again by the next start; the ad platforms keep the first copy.

## Every variable

| Variable | Default | What it sets |
| --- | --- | --- |
| `DATABASE_URL` | required | The PostgreSQL address. |
| `GRAPH_TOKEN` | required | The service token. |
| `REVIEW_TOKEN` | none | The reviewers' token. Must differ from `GRAPH_TOKEN`. |
| `ORIGINS` | none | Site addresses that may post visits, separated by commas. |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Where to listen. |
| `GRAPH_SCHEMA` | `account_graph` | The database schema to keep tables in. |
| `TRUST_PROXY` | `false` | `true`, or how many proxies stand in front: read visitor addresses from `x-forwarded-for`. |
| `COOKIE` | `false` | `true`, or a domain, to keep the device id in a server-set cookie. |
| `RATE_PER_MINUTE`, `RATE_BURST` | `120`, `60` | The per-address limit on `/collect`. |
| `RATE_LIMIT` | on | `off` removes that limit. |
| `OUTBOX_INTERVAL_MS` | `30000` | How often to send what is due. |
| `OUTBOX_DELAY_MS` | `0` | How long to hold a new outcome before its first send. |
| `CHANGE_WEBHOOK` | none | A URL to post cluster changes to. |
| `ALERT_WEBHOOK` | none | A URL to post failures to, as `{"text": "…"}`. |
| `POLICY`, `POLICY_FILE` | the default policy | What differs from it, as JSON or as a file of JSON. Set one at most. |
| `AUDIT_HEAD_HOURS` | `0` | Post the newest decision's hash to `ALERT_WEBHOOK` at start and every so many hours, at least one. `0` is never. |
| `STAFF_NETWORKS` | none | Addresses and ranges whose visits are dropped, separated by commas: `192.0.2.10,198.51.100.0/24`. |
| `QUIET_TOUCHES_HOURS`, `QUIET_CALLS_HOURS`, `QUIET_RESULTS_HOURS`, `QUIET_COSTS_HOURS` | `0` | Hours of silence before a feed is said to be quiet. `0` is not watched. |
| `RETURN_HOURS` | `24` | Hours before a missed caller from a paid arrival is said to be waiting. `0` is never. |
| `STAGES` | none | Your steps in order, as JSON, each with a `value`, `currency` and `action`. See [the report](report.md#steps-and-what-each-is-worth). |
| `LINK_SECRET` | none | Signs links that name a person, and the tokens that carry a visitor between your sites. At least 16 characters. |
| `EVENTS` | none | Names of page events to keep, separated by commas: `inquiry,phone_click`. |
| `CALL_NUMBERS` | none | Your tracking numbers and the channel of each, as JSON: `{"+15551230001":{"source":"google","campaignId":"20222"}}`. Each may carry `tags`. |
| `CALL_MIN_SECONDS` | `30` | A shorter call is recorded but not counted. |
| `CALL_RESULTS` | none | `expected` to hold each call until something reports whether a person answered. See [calls](calls.md#was-it-answered). |
| `CALL_RESULT_WAIT` | `30` | Minutes before a call with no result reads as unknown. |
| `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_URL` | none | Take Twilio's call reports at `/calls/twilio`. Set both. |
| `TWILIO_ACCOUNT_SID` | none | With `TWILIO_AUTH_TOKEN`: ask Twilio what kind of line a phone posted to `/identify` is. |
| `SMARTY_AUTH_ID`, `SMARTY_AUTH_TOKEN` | none | Check postal addresses posted to `/identify`. Set both. |
| `REPORT_TIME_ZONE` | `UTC` | The time zone `/report` and the call routes read their days in, such as `America/New_York`. Use the ad account's. |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | none | Read campaign costs from Google Ads. Needs the two Google variables below. |
| `META_AD_ACCOUNT_ID`, `META_ADS_TOKEN` | none | Read campaign costs from Meta. Set both. |
| `COST_INTERVAL_MS`, `COST_DAYS` | six hours, `7` | How often to read costs, and how many days back each time. |
| `FINGERPRINT_SECRET`, `FINGERPRINT_REGION` | none, `us` | Confirm Fingerprint events. |
| `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY` | none | Classify addresses with MaxMind. Set both. |
| `MAXMIND_SERVICE`, `MAXMIND_HOST` | `insights`, `geoip.maxmind.com` | Which MaxMind service to ask. |
| `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_SERVICE_ACCOUNT_FILE` | none | Send conversions to Google Ads. Set both. |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | none | The manager account, when the service account belongs to one. |
| `META_PIXEL_ID`, `META_ACCESS_TOKEN`, `META_SITE_URL` | none | Send conversions to Meta. Set all three. |
| `META_TEST_EVENT_CODE` | none | Route Meta events to its test tool. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_REFRESH_TOKEN`, `MICROSOFT_DEVELOPER_TOKEN`, `MICROSOFT_CUSTOMER_ID`, `MICROSOFT_ACCOUNT_ID` | none | Send conversions to Microsoft Advertising. Set all five. |
| `MICROSOFT_CLIENT_SECRET` | none | Only for a web app registration. |

A group that is half set stops the server at start, with a message naming what is missing.
