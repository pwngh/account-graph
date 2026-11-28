# Review app

The review app serves the reviewer’s pages from a Node server. Accounts, Journey, Board, Matches, Calls, Channels and Health have addresses you can open, bookmark and share with another reviewer. The server obtains the graph data over HTTP and renders the page, including its charts. Search and decision forms submit to the app. With JavaScript off you can follow links, open details, submit a form and reload to see changes.

Subject IDs occupy one URL segment. The account for `account:42` is at `/accounts/account%3A42`. An address pasted with a literal colon redirects to the same record. The IDs `.` and `..` use `;id=.` and `;id=..` in that segment so the browser can follow them.

## Development

Use Node 22.22 or later. From the repository root, install both lockfiles once and build the graph package. The app imports the checkout’s public `account-graph` entry point. Its React dependencies belong to `apps/review`.

```sh
npm ci
npm --prefix apps/review ci
npm run build
```

Start a graph server with a named reviewer in `REVIEW_TOKENS`. In a second terminal, set `REVIEW_GRAPH_URL` to the graph’s origin and run the app. Set `REVIEW_EVENTS_TOKEN` to the graph’s service token to receive live updates. See the [graph settings](operations.md#tokens).

```sh
export REVIEW_GRAPH_URL=http://127.0.0.1:8080
NODE_ENV=development npm --prefix apps/review run dev
```

Open the local address Vite prints. For a complete local installation with a fictional firm, graph, reviewer and presenter’s stage, use the [demo](demo.md).

## Docker

`docker compose up --build` starts the app beside the graph server and PostgreSQL. Open `http://localhost:3100` and sign in with a reviewer's token from `REVIEW_TOKENS`. Set `REVIEW_PORT` to publish another port. The port is published on this machine only. `REVIEW_BIND` names another address to publish it on.

The app has an image of its own, built from the repository root:

```sh
docker build -f apps/review/Dockerfile -t account-graph-review .
```

`node tools/stack-check.ts` checks a running stack as a member of staff meets it: the graph answers, the sign-in page is served, a reviewer signs in, and each page opens. CI runs it on every change.

> **The session secret in `compose.yaml` is public.** It begins with `change-me`, and the app refuses to start with it when `REVIEW_ORIGIN` names an address outside your own machine.

To serve reviewers elsewhere, put a proxy with TLS in front. Set `REVIEW_ORIGIN` to the address reviewers open, change `REVIEW_SESSION_SECRET`, set `REVIEW_TRUST_PROXY=true`, and forward to the app. Without `REVIEW_ORIGIN` the app compares a form's origin with the address the request came to, which a proxy that ends TLS changes, so sign-in is refused. Live updates are one long answer from `/events`, so the proxy must not buffer it:

```nginx
server {
  listen 443 ssl;
  server_name review.example.org;
  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location /events {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
}
```

## Production

Build from the repository root. Set a persistent, random cookie-signing secret in the server environment. Set the public origin to the exact HTTPS origin reviewers will visit. Forward requests from that origin to the Node listener, including streaming responses from `/events`. Disable proxy buffering on that route.

```sh
npm run review:build
export NODE_ENV=production
export REVIEW_ORIGIN=https://review.example.org
# Supply REVIEW_SESSION_SECRET, REVIEW_GRAPH_URL and REVIEW_EVENTS_TOKEN through the server environment.
npm --prefix apps/review start
```

| Setting | Meaning |
| --- | --- |
| `REVIEW_GRAPH_URL` | Graph server origin, default `http://127.0.0.1:8080`. The Node process must be able to reach it. |
| `REVIEW_SESSION_SECRET` | Secret for signing session IDs, at least 32 characters. Outside development the app requires it at startup. In development an omitted secret is generated for the process. |
| `REVIEW_ORIGIN` | Public origin used to check form submissions and set secure cookies. Defaults to the request origin. Set this explicitly behind a reverse proxy. |
| `REVIEW_TRUST_PROXY` | `true` when one proxy of your own stands in front, or the number of them, up to 10. The app then reads each sender's address from `x-forwarded-for`, counting that many entries from the end. Earlier entries are the sender's own words. Leave it out when the app is reached directly, or anybody could name any address. |
| `REVIEW_EVENTS_TOKEN` | Server-only graph token for the `events` call. A [named token](operations.md#tokens) whose `calls` are `{"events": true}` is enough, and is all the app should hold. Compose makes one, `review-app`, with this token. If you set `SERVICE_TOKENS` yourself, keep that entry in your list, or pages stop updating by themselves. Without it, pages open no event stream and say that live updates are off. Opening or reloading a page still reads the graph. |
| `REVIEW_RECORD_LINKS` | Where a record is in your own system, as JSON by the kind its ID begins with, such as `{"contact":"https://crm.example.org/contacts/{id}"}`. `{id}` is the rest of the ID. An account page then has a link there. Each address must be `https`. |
| `REVIEW_LEGACY_URL` | Address reviewers use to open the original screen, such as `https://graph.example.org/review`. Matches links to it, for the records its queue leaves out. Without it, Matches names the original screen without a link. The graph's own address is never shown. |
| `HOST`, `PORT` | Production listener address and port, default `127.0.0.1` and `3000`. |

`npm start` runs `server.mjs`, a small Node HTTP server around the request handler from `@react-router/node`. It serves the built assets and checks the Origin of every form post.

## Sign-in and updates

Open `/signin` and enter the token issued to your reviewer name. An address gets ten attempts in fifteen minutes, and a successful sign-in clears its count. Behind a reverse proxy every request comes from the proxy's address, so ten wrong tokens from anybody would lock out every reviewer. Set `REVIEW_TRUST_PROXY` and each sender is counted by their own address. The server checks it at `/review/api/me` and keeps it in process memory, so a restart of the app ends every session. A reviewer who then opens a page is sent to the sign-in page, which says the session has ended and what ends one, and returns them to their page once they sign in. The browser gets a signed, eight-hour session ID in an HttpOnly, SameSite=Strict cookie. The cookie is Secure except with HTTP on loopback. Sign out to revoke the session for all tabs that share it. A graph authorization failure also ends the session. The `/stage` page exists only when the firm demo starts the app. It signs a visitor in as the demo reviewer without a token, so it is never served by an app started with `npm start`. Restarting the process clears sessions. Run a single app process or route a session’s requests to the same instance.

With JavaScript, one event stream stays open as the reviewer moves between reports. One follower per process reads the graph with the events token for every open tab. It starts with the first stream and stops when the last one closes. It follows the graph cursor and checks the write count because some ordinary observations produce no public event. If the graph refuses the events token, the streams end and the page says live updates were interrupted. The reviewer stays signed in. It catches up on history at a fresh connection and asks for one refresh of the open view. A reconnect carries the browser’s last event ID. Stopping the server ends each stream without a sign-out event, and the browser reconnects to the next process. Pages and forms work after an ordinary reload if streaming is unavailable.

Ctrl K or ⌘K opens the search palette, as on the original screen: IDs found as they are typed, by email, phone, ad click or the start of an ID, with or without its kind; each view; Refresh; the IDs opened in this tab; and Open journey or Open account for the one open.

## Times

The server writes every time on the page. On the first load with JavaScript, the browser stores its time zone in the `review_zone` cookie and reads the page again, so times appear in the reviewer's zone, with its abbreviation. Before that, and with JavaScript off, times are in the report's zone, the graph's `timeZone`, or UTC if the graph cannot say. Report periods such as Board and Calls dates stay in the report's zone, as on the original screen.

## Views

| Address | Contents |
| --- | --- |
| `/accounts`, `/accounts/:subject` | Accounts overview, cluster diagram, links, record dates, evidence and reviewer actions. A link a reviewer joined has Undo join, which takes the join back without saying the two are different people. |
| `/journey/:subject` | Timeline and chart for the person. A call shown as reported returned, or as not a lead, has Take back. A call's row has a form for which record it was with, as [Recording who was on one call](calls.md#recording-who-was-on-one-call) describes. |
| `/board/:days` | Missed calls and people by their furthest step. A card in Missed calls has the same Reached them and Not a lead as Calls. A column shows fifty people, and its foot reads it on. |
| `/calls` | Missed calls, call outcomes, coverage and supporting detail. On the open missed call a reviewer records Reached them or Not a lead, signed with their name. The graph server must be one that takes these from a reviewer. |
| `/decide` | The queue of pending matches beside the open pair: the two records side by side, the evidence, what joining would do, and Join, Separate and Skip with the J, K and S keys. `/decide?pair=` opens one pair. It says when pairs among older sightings are not in the queue, and links to the original screen, whose Check older records reaches them. |
| `/channels` | What each campaign cost and brought in for a period: six totals with the change from the days before, the campaigns ranked by a measure, the table with a breakdown and a cost per chosen step, platform-reported conversions, time to convert, value changes and what followed calls. `/channels/csv` gives the table as a file. |
| `/health` | What needs someone, first. Then each feed with a card, the jobs, what waits to be sent, rejected conversions with Retry, the matching rules, the audit hash and conflicting decisions. |

Each page has its guide beside the title: a few sentences about what the page is for, each with a picture. With JavaScript off the guide opens as the list of its sentences. The guides are the existing screen's, and a test holds the two together.

The existing screen remains at `/review` on the graph server and at `/legacy` in the firm demo. It uses its own sign-in. The app links to it only at `REVIEW_LEGACY_URL`, or at `/legacy` in the demo. Opening an old `/review#/…` bookmark on the new app converts the fragment to a path when JavaScript runs. Call date ranges and links to a call on a journey keep their targets. Channels bookmarks keep their days, breakdown and steps. With scripts off the browser sends only `/review`. Use the Accounts link and navigation.

## Tests

From the root run `npm run review:test` to build both packages and run the app tests. Set `CHROME` to a Chrome executable for the stage browser suite. Set `DATABASE_URL` to a test database where the caller can create schemas for the full seeding comparison. The suite drops the schemas it creates. Without those settings the corresponding tests report a skip.
