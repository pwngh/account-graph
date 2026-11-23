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
reviewer token off, server cookie off, fingerprint off, maxmind off
outbox sends to nobody (no ad platform configured)
```

The last three lines say what is switched on. Each provider turns on when its variables are set; [providers.md](providers.md) says where to get them.

## With Docker

`docker compose up --build` starts the server and a PostgreSQL beside it, on port 8080.

```sh
GRAPH_TOKEN=a-long-random-string REVIEW_TOKEN=another-one ORIGINS=https://example.org docker compose up --build
```

Set `GRAPH_PORT` to publish it on another port. The compose file is for trying it out: it keeps the database in a local volume and uses a fixed database password.

## The script tag

Each site adds one line. The script reports every page view to the server it was loaded from, so it needs no configuration.

```html
<script type="module" src="https://graph.example.org/collect.js"></script>
```

```text
page ──▶ collect.js ──▶ POST /collect ──▶ graph
          (reads the click id, the campaign tags, the device id)
```

The site's address must be in `ORIGINS`, or `/collect` answers 403. A site with a content security policy must allow the server's address under `script-src` and `connect-src`.

Options ride on the script's address:

| Address | What it adds |
| --- | --- |
| `collect.js?fingerprint=PUBLIC_KEY` | Confirms each visitor with Fingerprint. Add `&region=eu` or `&region=ap` outside the US, and `&endpoints=…` for your own subdomain. |
| `collect.js?canvas=open` | Adds the open-source FingerprintJS id, recorded as the weaker `canvas` kind. |

To pass a consent banner's answer, set `window.accountGraphConsent = { adUserData: true, adPersonalization: false }` before the tag.

The script keeps the visitor's device id in a cookie named `ag_device`, marked `Secure`. Browsers only keep such a cookie on a site served over HTTPS; `localhost` is the exception.

### Several sites

Each site's domain gets its own device id, because a browser keeps cookies per domain. A person who visits two of your sites is two visitors until something ties them: a confirmed fingerprint, the same email at sign-in, or the same account signing in on both. That is what the graph is for, and it is why adding Fingerprint matters most when you run several domains.

## Tokens

`GRAPH_TOKEN` opens every route. Your own services send it; nothing in a browser should hold it.

`REVIEW_TOKEN` is for the people who review accounts. It opens the reviewer screen's routes and nothing your services write through. Make both long and random, for example with `openssl rand -hex 32`.

> **`/collect`, `/collect.js`, `/review` and `/health` need no token.** `/review` is only a page; nothing it shows arrives without one.

## Behind a proxy

Set `TRUST_PROXY=true` when a proxy or load balancer you run sits in front. The server then reads each visitor's address from `x-forwarded-for`. Without it, every visit appears to come from the proxy, and the per-address limit below would count them as one sender.

Set `COOKIE=true` to have the server keep the device id in a cookie it sets itself. Safari deletes a cookie set by script after seven days; one set by the server lasts. It only works when the server answers on the site's own domain, or on a subdomain with `COOKIE=example.org`.

## Limits on visits

Each address may post 60 visits at once and 120 a minute to `/collect`. Past that it gets 429 with a `retry-after` header.

The origin check only stops browsers. A script can claim any origin, so the per-address limit is what keeps one sender from flooding the graph. Set `RATE_LIMIT=off` only when something in front already limits.

## Upgrading

Start the new version. On start the server applies every database change the database has not had, in order, inside one transaction.

Each change has a number and runs once. Several servers may start at the same moment; one applies the changes and the others wait. `upgrades()` in `account-graph/postgres` is the list.

## Watching it

| Route | Token | Answers |
| --- | --- | --- |
| `GET /health` | none | `{"ok":true}` once the database answers. Use it for a load balancer's check. |
| `GET /stats` | service | Visits collected, visits refused by the limit, and errors since start; what the graph holds; outbox jobs by state. |
| `GET /verify` | service | The subjects whose stored cluster differs from a full recompute. Empty when sound. It reads every edge. |

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
| `TRUST_PROXY` | `false` | Read visitor addresses from `x-forwarded-for`. |
| `COOKIE` | `false` | `true`, or a domain, to keep the device id in a server-set cookie. |
| `RATE_PER_MINUTE`, `RATE_BURST` | `120`, `60` | The per-address limit on `/collect`. |
| `RATE_LIMIT` | on | `off` removes that limit. |
| `OUTBOX_INTERVAL_MS` | `30000` | How often to send what is due. |
| `OUTBOX_DELAY_MS` | `0` | How long to hold a new outcome before its first send. |
| `CHANGE_WEBHOOK` | none | A URL to post cluster changes to. |
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
