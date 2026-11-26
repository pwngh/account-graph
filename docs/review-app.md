# Review app

The review app serves the reviewer’s pages from a Node server. Accounts, Journey, Board and Calls have addresses you can open, bookmark and share with another reviewer. The server obtains the graph data over HTTP and renders the page, including its charts. Search and decision forms submit to the app. With JavaScript off you can follow links, open details, submit a form and reload to see changes.

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
| `REVIEW_SESSION_SECRET` | Secret for signing session IDs. Outside development the app requires it at startup. In development an omitted secret is generated for the process. |
| `REVIEW_ORIGIN` | Public origin used to check form submissions and set secure cookies. Defaults to the request origin. Set this explicitly behind a reverse proxy. |
| `REVIEW_EVENTS_TOKEN` | Server-only graph service token for the `events` call. Without it, pages open no event stream and say that live updates are off. Opening or reloading a page still reads the graph. |
| `HOST`, `PORT` | Production listener address and port, default `127.0.0.1` and `3000`. |

## Sign-in and updates

Open `/signin` and enter the token issued to your reviewer name. The server checks it at `/review/api/me` and keeps it in process memory. The browser gets a signed, eight-hour session ID in an HttpOnly, SameSite=Strict cookie. The cookie is Secure except with HTTP on loopback. Sign out to revoke the session for all tabs that share it. A graph authorization failure also ends the session. Restarting the process clears sessions. Run a single app process or route a session’s requests to the same instance.

With JavaScript, one event stream stays open as the reviewer moves between reports. One follower per process reads the graph with the events token for every open tab. It starts with the first stream and stops when the last one closes. It follows the graph cursor and checks the write count because some ordinary observations produce no public event. If the graph refuses the events token, the streams end and the page says live updates were interrupted. The reviewer stays signed in. It catches up on history at a fresh connection and asks for one refresh of the open view. A reconnect carries the browser’s last event ID. Stopping the server ends each stream without a sign-out event, and the browser reconnects to the next process. Pages and forms work after an ordinary reload if streaming is unavailable.

## Views

| Address | Contents |
| --- | --- |
| `/accounts`, `/accounts/:subject` | Accounts overview, cluster diagram, links, record dates, evidence and reviewer actions. |
| `/journey/:subject` | Timeline and chart for the person. |
| `/board/:days` | Missed calls and people by their furthest step. |
| `/calls` | Missed calls, call outcomes, coverage and supporting detail. |
| `/decide` | Pending matches with Join and Separate forms. The original screen has the full review queue and keyboard controls. |
| `/channels` | Campaign attribution table. The original screen has the full channel breakdown and date controls. |
| `/health` | Feed status. The original screen has jobs, alerts, conversions, the audit chain and policy details. |

The existing screen remains at `/review` on the graph server and at `/legacy` in the firm demo. It uses its own sign-in. Opening an old `/review#/…` bookmark on the new app converts the fragment to a path when JavaScript runs. Call date ranges and links to a call on a journey keep their targets. Filtered Channels bookmarks open the original screen with their settings. With scripts off the browser sends only `/review`. Use the Accounts link and navigation.

## Tests

From the root run `npm run review:test` to build both packages and run the app tests. Set `CHROME` to a Chrome executable for the stage browser suite. Set `DATABASE_URL` to a test database where the caller can create schemas for the full seeding comparison. The suite drops the schemas it creates. Without those settings the corresponding tests report a skip.
