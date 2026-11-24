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
reviewer token off, server cookie off, fingerprint off, maxmind off, signed links off, alerts off, address checks off, phone line checks off
outbox sends to nobody (no ad platform configured)
page events taken: none (set EVENTS); calls from twilio off
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

## Behind a proxy

Set `TRUST_PROXY=true` when a proxy or load balancer you run sits in front. The server then reads each visitor's address from `x-forwarded-for`. Without it, every visit appears to come from the proxy, and the per-address limit below would count them as one sender.

With two proxies in a row, such as a CDN in front of a load balancer, set `TRUST_PROXY=2`. Each proxy adds the address it heard from to the end of that header, so the visitor's is that many from the end. Whatever comes before it was written by the sender and is ignored.

Set `COOKIE=true` to have the server keep the device id in a cookie it sets itself. Safari deletes a cookie set by script after seven days; one set by the server lasts. It only works when the server answers on the site's own domain, or on a subdomain with `COOKIE=example.org`.

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
| `/review#/channels` | What each campaign cost and brought in, over the last 30 days. |
| `/review#/channels/2026-11-01/2026-11-30` | The same, for the days named. |
| `/review#/health` | The running policy by kind, and a banner when a rebuild is due. |

Every ten seconds the screen asks one small question, whether anything was written since it last looked, and reads the view again only when the answer is yes. It does not ask while its tab is hidden, and it does not redraw while someone is typing in the view or answering a question.

## The policy

The server runs the default weights, caps and half-lives until you name something different. Name only what differs; the rest stays as it is.

```sh
POLICY='{"kinds":{"phone":{"weight":0.85,"halfLife":63072000000}}}' npm start
```

A longer one goes in a file named by `POLICY_FILE`. [How it decides](deciding.md) says what each part of a rule does. A new kind needs all four parts, and a half-life that never ends is written `"none"`.

> **A changed policy needs a rebuild.** Scores follow the new policy at once. Stored clusters stay as they were, and new writes mix the two, until someone posts to `/rebuild` with the service token.

The server stores a hash of the policy the clusters were built with. When the running one differs, the start log, `GET /stats`, `GET /verify` and the Health view say that a rebuild is due. A database from before the hash was kept says so too, because which policy built it is not known.

A setting the server cannot use stops it at start, with a line for each problem. So does a stored identifier whose kind the policy does not name, such as a kind of your own that was taken out of the setting.

## Watching it

| Route | Token | Answers |
| --- | --- | --- |
| `GET /health` | none | `{"ok":true}` once the database answers. Use it for a load balancer's check. |
| `GET /stats` | service | Visits collected, visits refused by the limit, visits from declared bots, and errors since start; what the graph holds; whether a rebuild is due; outbox jobs by state. |
| `GET /verify` | service | `{ changes, policy }`. `changes` lists the subjects whose stored cluster differs from a full recompute, and is empty when sound. It reads every edge. |

Set `ALERT_WEBHOOK` to a Slack incoming webhook, or anything that takes `{"text": "…"}`, and the server posts there when something needs a person:

| When | The message says |
| --- | --- |
| A conversion fails for good | Which transaction, which platform, and the platform's reason. Up to ten per message. |
| The outbox cannot run | Why, such as the database not answering. Nothing is being sent while this lasts. |
| Campaign costs cannot be read | Which platform and why. The report's costs go stale until it is fixed. |

Each kind is sent at most once in ten minutes. A webhook that fails is logged and never stops the work it was reporting on.

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
| `STAGES` | none | Your steps in order, as JSON, each with a `value`, `currency` and `action`. See [the report](report.md#steps-and-what-each-is-worth). |
| `LINK_SECRET` | none | Signs links that name a person, and the tokens that carry a visitor between your sites. At least 16 characters. |
| `EVENTS` | none | Names of page events to keep, separated by commas: `inquiry,phone_click`. |
| `CALL_NUMBERS` | none | Your tracking numbers and the channel of each, as JSON: `{"+15551230001":{"source":"google","campaignId":"20222"}}`. |
| `CALL_MIN_SECONDS` | `30` | A shorter call is recorded but not counted. |
| `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_URL` | none | Take Twilio's call reports at `/calls/twilio`. Set both. |
| `TWILIO_ACCOUNT_SID` | none | With `TWILIO_AUTH_TOKEN`: ask Twilio what kind of line a phone posted to `/identify` is. |
| `SMARTY_AUTH_ID`, `SMARTY_AUTH_TOKEN` | none | Check postal addresses posted to `/identify`. Set both. |
| `REPORT_TIME_ZONE` | `UTC` | The time zone `/report` reads its days in, such as `America/New_York`. Use the ad account's. |
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
