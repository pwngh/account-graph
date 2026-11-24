# account-graph

Find out which ad brought each client, and who called and was never rung back, even when one person is a visitor, two phone numbers and a name in your files.

It runs beside your site, your phone system and your own records. Each tells it what it saw; it works out which of those are one person, says why, and shows the result on a screen your people can check.

## See it run

```sh
git clone https://github.com/pwngh/account-graph && cd account-graph
npm ci && npm run firm
```

That starts a made-up firm with two months of history: a database, the server, a site in two languages, and a page that plays ten scenes. You need Node 22.18 or later, and Docker for the database (without it, everything is kept in memory). Nothing needs a key, and Ctrl-C deletes it all. [The demo](docs/demo.md) has a 90-second script.

| Who is waiting | One person, from the ad to what they paid |
| --- | --- |
| ![The board: missed calls first, then people by step](https://raw.githubusercontent.com/pwngh/account-graph/screenshots/p26-board.png) | ![One person's timeline](https://raw.githubusercontent.com/pwngh/account-graph/screenshots/p26-journey.png) |
| **What each campaign cost and brought in** | **What needs someone** |
| ![Channels, broken down by the office that served](https://raw.githubusercontent.com/pwngh/account-graph/screenshots/p26-channels.png) | ![Health: a quiet feed and what else needs someone](https://raw.githubusercontent.com/pwngh/account-graph/screenshots/p26-health.png) |

Everything in those pictures is made up.

## What it answers

| You ask | Where | What you get |
| --- | --- | --- |
| Who rang and was never rung back? | Board, Calls | Missed calls, oldest first, with the ad each is credited to, where there is one. When your phone system reports who answered, a person who hung up in the queue is a miss and not a lead. |
| Which ads bring clients, and not only clicks? | Channels | Each campaign's cost beside its calls, inquiries, clients and what they were worth, by office and language. Days with no recorded cost are marked, and never read as zero. |
| What happened with this person? | Journey | One timeline across every visit, number and record that is them, each line with why. |
| Are these two one person? | Accounts, Decide | What they share and how much it counts. Your people join them or keep them apart, and either can be taken back. |
| Is everything still arriving? | Health | Quiet feeds, failed jobs, refused conversions, and whether the record of decisions is whole. |

> **It does not act for you.** It dials nobody, assigns nobody, and writes to no client. It sends the conversions you told it to send to the ad platforms you set up, and alerts and cluster changes to webhooks of your own.

## How the pieces fit

```mermaid
flowchart LR
  B[Browser on your site] -- "collect.js: device id, ad click, page events" --> S[Graph server]
  T[Phone provider] -- "calls" --> S
  A[Your backend] -- "observe, transfer, convert" --> S
  R[Reviewer] -- "/review" --> S
  S --> G[(PostgreSQL)]
  S -- "outbox" --> P[Google, Meta, Microsoft, TikTok]
```

The browser never names an account. It only says "this device, arriving from this ad click". Your backend names the account at sign-in, with whatever it saw: the device cookie, an email, a machine id. The server joins the two when the evidence is strong enough, and the outbox tells each ad platform which click earned the conversion.

## Put it on your site

Start the server and its database, telling it which site may report to it and giving it secrets of your own:

```sh
export GRAPH_TOKEN=…             # your backend sends the same one
ORIGINS=https://www.example.org REVIEW_TOKENS='{"dana":"…"}' LINK_SECRET=… docker compose up --build
```

Each secret is a long random string, such as `openssl rand -hex 32` prints. A site that is not in `ORIGINS` is refused. [Running the server](docs/operations.md) covers the rest. Then add one line to every page:

```html
<script type="module" src="https://graph.example.org/collect.js"></script>
```

When someone signs in or signs up, your backend says so with what it knows:

```sh
curl -X POST https://graph.example.org/identify \
  -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"subject":"account:42","event":"signup","device":"9f3c…","email":"pat@example.org"}'
```

The server normalizes and hashes the email, as it does a phone and a postal address. The subject and the device id are kept as they are. The `device` is the `ag_device` cookie the script set, which your backend reads from the request, and the answer lists every subject whose cluster just changed.

### A site to try it with

```sh
docker compose up --build        # the server on :8080, and its database
node examples/site.ts            # in a second terminal: an example site on :3000
```

1. Open <http://localhost:3000/?gclid=demo-click&utm_id=20111> and sign up with any email.
2. The page answers: *The graph server credits the ad click demo-click at 98% confidence.*
3. Open <http://localhost:8080/review>, enter the token `change-me-review-token`, and open the account. It is joined to the visitor who clicked the ad. **Channels** shows the sign-up under its campaign.

On the site, *See an email* opens a link that names its contact, *Our other site* carries you to a second host name as the same visitor, and *Who does the graph think this browser is?* shows the result. If port 8080 is taken, start with `GRAPH_PORT=8090 docker compose up --build` and `GRAPH_URL=http://localhost:8090 node examples/site.ts`.

## Where to read next

**To run it**

- [Running the server](docs/operations.md): the start command, Docker, the script tag, tokens, every variable.
- [Setting up the providers](docs/providers.md): where to get keys for Fingerprint, MaxMind, Google, Meta, Microsoft and TikTok.
- [The HTTP routes](docs/http.md): every route, which token opens it, and what it answers.
- [What each campaign cost and brought in](docs/report.md): the three things the report needs, and how to read it.
- [Page events and phone calls](docs/calls.md): what the script tag reports from a page, and how a call finds its visitor.
- [Links that name a person](docs/links.md): signed links for email and text, and one visitor across several sites.
- [Telling the server who someone is](docs/identify.md): one call with plain facts, forms that post elsewhere, and what is filtered out.

**To understand it**

- [How it decides](docs/deciding.md): the score, the weights and what they rest on, how links become clusters, and when to change a setting.
- [What is kept about people](docs/privacy.md): what is hashed, what is sent, what `forget` and `prune` delete, and what consent covers.
- [Presets](docs/presets.md): a policy for contacts entered by staff, and what to do about shared phones.

**To build on it**

- [Using it as a library](docs/library.md): the same graph as functions in your own Node program, with the memory or PostgreSQL store.
- [CHANGELOG.md](CHANGELOG.md): what the first release contains.

## For engineers

The graph is subjects, identifiers, and the sightings that tie them. Everything else is worked out from that record, so it can be rebuilt, and a bad identifier or a wrong join can be taken out again.

| Word | Meaning |
| --- | --- |
| Subject | Anything with an identity: `account:42`, `visitor:9f3c`. |
| Identifier | Something a subject was seen with, written `kind:value`: `device:9f3c`, `email:…`, `ip:203.0.113.9`. |
| Sighting | One time a subject was seen with an identifier. Sightings are the record; everything else is worked out from them. |
| Link | Two subjects that share identifiers, with a score from 0 to 1 and the reasons for it. |
| Cluster | The subjects the graph treats as one person. |
| Touch | An arrival from an ad click or a campaign. |
| Outcome | Something a person did that you count: an inquiry, a sign-up, a sale. |
| Cost | What an ad platform charged for one campaign on one day. |
| Decision | A reviewer's call: join these two, keep these two apart, stop linking through this identifier. |

Two subjects that share an identifier get evidence from it: a weight for its kind, thinned by how many share it and faded by the time between. Evidence combines as `1 − Π(1 − evidence)`. By default a pair at 0.9 may join and one at 0.5 is related. Clusters come after: a separation, or one weak link between two groups, can keep a strong pair apart. [How it decides](docs/deciding.md) has the model and what it leaves out.

### Who is who

- **Scored links with reasons.** Every link says which shared identifiers produced it and how much each counted.
- **Clusters that can split.** Clusters are derived from the record, so a bad identifier can be ignored and a person can be forgotten, and the clusters come apart correctly.
- **No chain merges.** One weak link can add an account to a group but cannot join two groups on its own.
- **Reviewer decisions.** Join two subjects, keep two apart, or mute an identifier. Each decision is recorded with who and why, and sealed so the record cannot be quietly edited.
- **A queue of pairs to decide.** Related and not joined, side by side with what they share, one key each to join, keep apart or skip. Every decision can be taken back, and what was decided teaches `fit` the weights.
- **Names that only confirm.** Under a preset for contacts staff type in, a name with a zip code or a date of birth confirms a shared phone. It never ties anyone by itself.
- **One call to say who someone is.** Send an email, phone, address and device as they are. The server hashes the first three and keeps the device id. With an address service set up it checks the address, and without one it does not use it; with a line check it counts a throwaway phone number for less.
- **Links that name a person.** A signed link in an email or text ties the browser that opens it to the person it was sent to, and a visitor stays one visitor across your sites.
- **Money flows.** Trades and transfers between accounts are reported with how the two are tied by identity, and value that goes round in a circle is found, so collusion shows up.

### Calls

- **Page events and phone calls.** The script tag reports taps and marked clicks, and a call that follows a tap is tied to the visitor who tapped, so calls land under the ad click that produced them.
- **Calls that were really answered.** A queue hang-up is not an answer. Your phone system reports how each call went, and a call can be held, uncounted and unsent, until it does. Each missed call says whether it was returned, and after how long, from the calls themselves or from your own system, and a Calls view lists the ones still open.
- **A number for each visitor.** An optional pool shows each visitor from an ad a number of their own, so a call they dial by hand is still tied to their click.
- **A board of people by step.** Missed calls nobody returned first, then everyone at the furthest step they reached, with who is new today and who has waited too long.
- **What followed a call.** Who went on to reach a step, by how the call went and whether a miss was returned, with the clock set so people already signing up do not count for it.

### Ads, steps and money

- **Attribution with confidence.** A conversion lists every touch that could have led to it and credits one only when the chain of links is strong.
- **A report of cost against outcomes.** Campaign costs are read from Google Ads and Meta, or posted, and set beside the inquiries, sign-ups and sales each campaign's visitors produced. A cost per outcome counts only days whose cost is known, and is withheld when too few are. People are counted beside outcomes, and recent days are marked as still filling. Every value an outcome has had is kept, so what was expected stands beside what was collected.
- **Broken down your way.** By the office an ad was for, the office that served, language, hour or weekday, with what was not recorded always shown. Costs are never split by guesswork.
- **Steps with a value.** Name your steps once (inquiry 5, call 10, client 200) and every outcome, page event and call takes its value and its ad platform action from its step.
- **An outbox for conversions.** Outcomes are recorded once, sent in batches to each ad platform, retried with backoff, and never sent by two workers at once. Failed ones can be listed and retried.
- **One person's timeline.** From the ad click to the last value, across every subject that is them, each entry with why it is this person.

### Running it

- **Real integrations.** Fingerprint, the operating system's machine id, MaxMind, Twilio, Smarty, the Google tag's cookies, the cost reports of Google Ads and Meta, and the conversion APIs of Google, Meta, Microsoft, and TikTok.
- **Alerts.** A conversion that fails for good, an outbox that cannot run, or costs that cannot be read are posted to a Slack-style webhook. So is a feed that has gone quiet, and a missed caller from an ad whom nobody has rung back. An alert that does not arrive is kept until it does.
- **Your own staff left out.** Visits from your networks, or from a browser marked by a signed link, are dropped and counted.
- **Consent.** Every answer, from a browser's opt-out signal, a banner or your backend, is kept, and the one given last is honoured before anything goes to an ad platform.
- **A write queue.** Observations that arrive together are written together, many times faster on PostgreSQL.
- **Two stores, one suite.** Memory and PostgreSQL pass the same tests, including a fuzz test that checks stored clusters against a full recompute after every operation.
- **No runtime dependencies.** `pg` is needed only for the PostgreSQL store.

### Speed

Measured on an Apple M1 Max with Node 22, on synthetic data. PostgreSQL 16 ran in Docker on the same machine, with two processors and its default settings, `fsync` on. Run `DATABASE_URL=postgres://… npm run bench` for your own numbers, or leave the variable out to measure the memory store alone; a database on the machine itself answers sooner than one in Docker.

A graph of 20,000 accounts:

| Store | One at a time | In batches of 100 | Through the write queue | `links()` |
| --- | --- | --- | --- | --- |
| Memory | 28,700 observations/s | 13,800/s | 16,900/s | 0.02 ms |
| PostgreSQL | 183 observations/s | 1,900/s | 3,600/s | 2.7 ms |

PostgreSQL writes take one advisory lock, so they run one at a time; the write queue is how many callers share one write.

Large graphs, five edges to an account, `DATABASE_URL=postgres://… npm run bench -- scale 1000000 5000000 10000000`. Each number is time and the most memory the process held:

| Edges | On disk | `rebuild` | `verify` | `asOf` | An observation, `links()` |
| --- | --- | --- | --- | --- | --- |
| 1 million | 420 MB | 7 s, 159 MB | 6 s, 150 MB | 20 s, 1.4 GB | 6.6 ms, 2.3 ms |
| 5 million | 2.1 GB | 45 s, 198 MB | 40 s, 206 MB | 156 s, 3.8 GB | 8.1 ms, 2.9 ms |
| 10 million | 4.3 GB | 94 s, 291 MB | 85 s, 402 MB | out of memory | 10.7 ms, 3.7 ms |

The last column is the median of 300, one at a time. The two larger graphs were measured while tests ran on the same database, so their times are longer than they need be.

### Tools

- `examples/site.ts` is a two-page site with the script tag and a sign-up.
- `npm run firm` starts a made-up firm with everything running, and a presenter page. [The demo](docs/demo.md) has a 90-second script.
- `tools/review-demo.ts` serves the reviewer screen over made-up data.
- `tools/browser-check.ts` runs `collect`, the server, and the outbox against a real browser.
- `tools/live-check.ts` calls each provider's real endpoint, with your keys when they are set, and prints how it answered.
- `tools/replay.ts` replays an export of your own past traffic and compares attribution with what was sent.
- `tools/labels.ts` measures the graph against a CSV of pairs you have checked, and prints how often each kind was right.
- `tools/costs.ts` sends a CSV of campaign costs to a running server.
- `tools/export.ts` writes edges, flows, or cluster labels as CSV for an analytics engine.

## What has run for real

- The graph's shared suite runs on memory and on PostgreSQL 16, locally and in CI, including a fuzz test that mixes observations, reviewer decisions, deletions, and transfers, and six outbox workers at once.
- The image was built and `docker compose up` brought up the server and its database. With the example site pointed at it, a visit with an ad click followed by a sign-up was credited in Chrome, and the reviewer screen served from the container showed the account joined to its visitor. Against the same container, a signed link tied a browser to its contact, a link to the example's second host name carried the visitor across, and a call posted after a tap was tied to that visitor and valued by its step.
- The script tag ran in Chrome from a different origin than the page that loaded it.
- With `cookie: true` the device cookie was set by the server, invisible to script, and the same on the next visit.
- The reviewer screen ran in Chrome under its content policy: a cluster opened, two accounts were kept apart with a reason, the cluster split, and the decision appeared on the record.
- The channel report ran in Chrome: a sign-up on the example site, arriving with a campaign id, appeared on that campaign's line beside its cost.
- A tap on a phone link in Chrome, followed by a call posted for that number, joined the caller to the browser's visitor and counted the call under the visitor's campaign.
- A signed link opened in Chrome tied the browser to its contact and left the address bar clean. Following a link to the example under a second host name joined that host's visitor to the first.
- With the device cookie deleted, the example's sign-up form still carried the device id in a hidden field the script added, and the sign-up was credited to its ad click.
- A database made before an upgrade was brought up to date by starting the server.
- The hardware id ran on macOS and, in CI, on Linux.
- The real endpoints of Fingerprint, MaxMind, Google's token service, Google's Data Manager, Google Ads reporting, Meta's conversions and its cost reports, Microsoft Advertising, Microsoft's token service, TikTok, Twilio Lookup, and Smarty each answered an invalid key the way the code expects.
- The check of Twilio's signature reproduces the example on Twilio's own webhook security page.

## Limits

- No request has been made with real credentials. A successful Fingerprint lookup, MaxMind answer, token from Google or Microsoft, upload to any ad platform, cost report from Google Ads or Meta, Twilio line lookup, and Smarty address check are all untested. `npm run live-check` is how to run them with yours.
- No real phone call has arrived from Twilio, and no alert has been posted to a real webhook.
- Meta's browser id is sent only where the site runs Meta's pixel, with an arrival, beside a Meta click. It is not a match key by itself.
- A pool number is only right while it is that visitor's. One saved and rung much later ties to nobody, or to whoever has the number by then.
- The queue of pairs to decide looks at the subjects of the newest 10,000 sightings, not at everyone.
- The board is read from what is recorded. It does not assign work, and only people who reached a step or had a call in its period are on it.
- A journey reads at most 60 subjects of one person, and says how many it left out. How a conversion stands is kept, and when it was sent is not.
- What followed a call is a count of what came after, not an effect. The landmark removes one bias and leaves the rest.
- A day a platform sends no cost row for counts as missing, although a paused campaign looks the same.
- The report credits the newest strong touch with the whole outcome, and is worked out each time it is asked for.
- Without call results, a call is counted by its length, which a queue hang-up can reach. Platforms that cannot restate keep a conversion sent for a call that turned out missed.
- A return your own system reports is taken at its word. It is marked, and counted apart.
- A quiet feed is noticed by hours without a record, so a feed that still sends something wrong is not.
- Without a tap or the optional pool, a call can be filed under the channel configured for its number, and is tied to no visitor of the site.
- A signed link is a key: forwarded to a stranger's browser, it ties that browser to the person it names. [Links](docs/links.md) says what limits that and what does not.
- Postal addresses are checked for the United States only. A name never ties two people by itself, and only a policy that has names uses them at all.
- TikTok keys are not exercised by `npm run live-check`, because any call would record an event.
- The two Fingerprint browser loaders have not run in a browser. They need a real key or a third-party script.
- The server-set cookie has run in Chrome only. Safari's handling is the reason it exists, and it has not run there.
- The hardware id's Windows path is untested.
- Microsoft does not document how to normalize an email before hashing it; this lowercases and trims.
- The per-address limit on `/collect` is kept in each server's memory. Several servers each allow the limit.
- Subject search matches the start of an id and reads the subject table to do it.
- `asOf` cannot bring back a forgotten subject or a pruned sighting; both are gone from every past.
- A separation between two subjects cuts the weakest links between them. With several separations in one component the cuts are made one after another, which is not always the fewest possible.
- Kinds count as independent evidence unless the policy puts them in one group. The default has no groups.
- The consent kept is about advertising. It is not a record of consent to be contacted.
- Each page view adds a row to the consent history when the page reports an answer. `prune` deletes the ones that no longer stand.
- Pairs kept apart by your own systems are only as right as those systems. One person entered on both sides is split, and keeping two apart is not a conflict check.
- Flows and rings are worked out from running totals per pair, so they do not say in what order value moved. Each transfer is kept only to count it once.
- `asOf` builds the graph of that time in memory, and ran out of it at 10 million edges with Node's default limit. `rebuild` and `verify` do not.
- The memory store does not roll back a failed write.
- Not published to npm. Until it is, installing means cloning.

## License

MIT
