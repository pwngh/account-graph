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

Compose also reads a `.env` file in the same directory. Use `.env.example` for synthetic local settings. For a credentialed run, inject secrets privately into the selected process. Keep them out of the checkout, shell history and command arguments. Container administrators can inspect the environment. Set `GRAPH_PORT` to publish a different port.

Compose passes the variables in [Environment variables](#environment-variables) through to the server, except `GRAPH_SCHEMA`, `HOST`, `PORT`, `POLICY_FILE`, `CALL_NUMBERS_FILE`, `LEADS_FILE`, `SERVICE_TOKENS_FILE` and `SERVER_RANGES_FILE`. It sets `DATABASE_URL` itself. Compose passes the Google key file path but does not mount the file. Supply a separate read-only secret mount and use its path inside the container. A shell running the checker does not read Compose's .env.

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
| `account-graph sends pause checking a wrong tie` | [Stops sends](#stopping-sends) to ad platforms in every process, with a reason |
| `account-graph sends resume` | Lets sends go again on the next pass. `account-graph sends` says whether they are paused. |
| `account-graph sample-joins --size 300 --seed 2026-11` | Writes a random sample of the graph's own joins as CSV, for [checking by hand](#checking-joins-by-hand) |
| `account-graph score-joins checked.csv` | Scores a checked sample. Needs no database. |

Each command reads the server's environment variables, upgrades the database as a server does, and ends. The workers stay off.

```sh
account-graph verify
```

<!-- schema cli -->
```json
{ "changes": [], "policy": { "hash": "d852bb513c02…", "builtWith": "d852bb513c02…", "due": false } }
```

`changes` lists the subjects whose stored cluster differs from a full recompute, and is empty when they agree.

With compose, run `docker compose exec graph node dist/bin.js verify`.

## Script tag

Sites with a Tag Manager web container can install the [browser tag template](gtm.md).

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
| `collect.js?fingerprint=PUBLIC_KEY` | Loads the Fingerprint agent and requests an identification. Enable it only after the intended device owner has agreed. Match the server region. Add `&region=eu` or `&region=ap` outside the US, and `&endpoints=…` for a configured identification proxy. The loader still contacts the public CDN. |
| `collect.js?canvas=open` | Adds the open-source FingerprintJS id, recorded as the weaker `canvas` kind. |
| `collect.js?params=mailing,placement` | Stores your own address parameters with each visit. |
| `collect.js?domains=shop.example,help.example` | Carries the visitor along links to your other sites. Requires `LINK_SECRET`. |
| `collect.js?pool=1` | Shows each visitor a separate phone number in elements marked `data-ag-pool`. Requires `POOL_NUMBERS`. See [number pools](calls.md#number-pools). |
| `collect.js?text=1` | Puts the visitor's code in text links and in elements marked `data-ag-code`. Requires `TEXT_CODES`. See [text messages](calls.md#text-messages) and [a code read out](calls.md#a-code-read-out). |
| `collect.js?forms=all` | Adds the device id and landing page to every form that posts, on submit. By default, only to forms marked `data-ag-fields`. |
| `collect.js?events=phone_click,inquiry` | Sends only the listed page events. An empty value suppresses page events. Visits and form fields work independently. |

The script also reports taps on phone links and clicks on elements marked `data-ag-event`. List the event names to accept in `EVENTS`. See [calls and texts](calls.md).

A firm with keyed file addresses should set `ALLOW_PAGES` to the public pages. The server passes its page lists to the tag. A banner that obtains consent before making identifiers can use `collect.js?consent=required`. See [Page and consent settings](privacy.md#pages-a-site-may-record).

To pass the answer from a consent banner, set `window.accountGraphConsent = { adUserData: true, adPersonalization: false }` before the tag.

### Device cookie

The script stores the visitor's device id in a cookie named `ag_device`, marked `Secure`. The cookie requires HTTPS, except on `localhost`.

Set `COOKIE=true` to have the server set the cookie instead. Safari deletes a cookie set by script after seven days. A cookie set by the server lasts, and page script can neither read nor change it. This works when the server answers on the site's own domain, or on a subdomain with `COOKIE=example.org`. The server-set cookie is untested in Safari.

### Multiple sites

Browsers keep cookies per domain, so each domain assigns its own device id. A person who visits two of your sites counts as two visitors until something links them: the [`domains` option](identify.md#cross-site-visitors), a confirmed fingerprint, or the same account signing in on both.

## Tokens

`GRAPH_TOKEN`, the service token, opens the six calls. Send it from your own services, and keep it out of browsers. `REVIEW_TOKENS` gives each reviewer a name and a token for the reviewer screen, and for [some of the calls](http.md#tokens). Make every token long and random, for example with `openssl rand -hex 32`.

```sh
REVIEW_TOKENS='{"dana":"…","lee":"…"}'
```

The audit log signs each decision with the name its token belongs to. Issue one token per person, because the signature identifies the token used.

To replace a token, list both, `{"dana":["new","old"]}`, and restart. Remove the old token once it is out of use. Removing a name ends that person's access. Their decisions stay in the audit log.

[Routes for browsers](http.md#routes-for-browsers), `/collect.js`, `/review` and `/health` need no token. `/review` serves a page whose data requires one.

### Named service tokens

Give each integration its own token in `serviceTokens` when calling `createEdge`. The command line reads the same JSON list from `SERVICE_TOKENS` or a private file named by `SERVICE_TOKENS_FILE`. Supply one of the two variables. For example, the file for a service that imports profiles and reads campaign reports would contain the following list.

<!-- schema config -->
```json
[{"name":"intake","token":"replace-with-a-random-secret","calls":{"record":["profile"],"report":["campaigns"]}}]
```

Omit a call to close it. Use an array of entry types for `record`, actions for `decide`, and kinds for `lookup` or `report`. An empty array accepts none. Use `true` for every kind of a listed call or to grant `forget` or `events`. An empty `calls` object grants nothing. Names must be unique across people and services. Every credential must be nonempty and unique, including the main token and reviewers' replacement tokens. Restart the process after updating the list.

## Reviewer screen

Open `/review` and enter a token. Each view has its own address, so you can link to it, reload it and go back to it.

| Address | View | Shows |
| --- | --- | --- |
| `/review#/accounts` | Accounts | The largest clusters, recent changes, and decisions. |
| `/review#/accounts/account:42` | Accounts | The subject, its cluster, links and their reasons, transfers, and sightings. The heading and Links table show "First seen here" and "Created in your system" for your records when known. Hover over a time for the exact timestamp. |
| `/review#/journey/contact:42` | Journey | One person's timeline across all their subjects: visits, page activity, calls, steps and their values, consent, and decisions. A call's id may follow, to bring that call into view. |
| `/review#/board/90` | Board | People by the furthest step they reached. Unreturned missed calls come first. |
| `/review#/decide` | Matches | Related pairs in different clusters, one at a time, to join or separate. Keys: J, K, S to skip, U to undo. |
| `/review#/calls` | Calls | Unreturned missed calls, call outcomes by hour and weekday, and coverage, over the last 30 days. Accepts two days in the address, as Channels does. |
| `/review#/channels` | Channels | The cost and results of each campaign over the last 30 days. |
| `/review#/channels/2026-11-01/2026-11-30` | Channels | The same for the given days. A breakdown, a step and a number of days may follow. |
| `/review#/health` | Health | Undelivered alerts, feeds, jobs, conversions, the newest audit hash, and the running policy by kind. A banner appears when a rebuild is due. |

A ring with three lines opens a detail card. It holds what is behind the number or row it stands beside: the counts, when and how something is known, the arithmetic, how to read it, and links. A card is made when it is opened, from what the page holds and the routes a reviewer already has, and is made again when the page is read again. What it fetched is kept for up to a minute, and dropped when the screen sees new writes or makes one. While the screen is paused, as below, a card can be as old as the view under it. What is not known is left out. Escape, Close or a press outside it closes it.

| View | Cards |
| --- | --- |
| Calls | The five numbers, and each call after its state |
| Board | The four numbers, and each person or text beside its age |
| Journey | Each call after its state. A mark, a number or a dashed wait on the chart shows a short card when it is pointed at or focused, and opens beside the chart when pressed. |
| Health | Each feed. One that is not monitored names the setting that would watch it. |

The screen checks for new writes every ten seconds and reloads the view when there are some. It pauses while its tab is hidden, and while someone types in the view or answers a prompt.

The reviewer endpoint `GET /review/api/undecided` returns up to 50 pairs by default. Set `limit` from 1 to 500. Pairs involving a subject from the newest 10,000 sightings come first by score, with ties ordered by the two subject ids. The `window` gives the number of sightings examined, the earliest recording time in epoch milliseconds (`oldest`, or null for an empty history), and whether older sightings were left out (`older`). Pass `next` back as `cursor` while `more` is true to see the rest of this queue.

Matches on the reviewer screen says when older sightings were left out, and its "Check older records" goes through every record this way, a page of 100 records at a time.

Start with `?full=true` to review all subjects, including those whose sighting history has been pruned. Each request reads up to 100 subjects in id order and offers each pair under its first subject. Within that subject, pairs are ordered by the other id. The window names the first and last subjects examined. An empty page can still have a next cursor. In both modes, `seen` counts subjects examined and `total` counts qualifying pairs in this window. Each request starts a fresh read, so decisions made between pages take effect. A new or changed pair behind the cursor can be found on the next sweep.

## Checking joins by hand

A sample of joins, checked by a person each month, gives the share of joins that were right. Nothing else measures wrong joins on your own records.

1. Write the sample. It holds pairs of records in one cluster that a `same` link joins directly. Pairs a reviewer joined are left out, since a join by hand does not test the matching.

   ```sh
   account-graph sample-joins --size 300 --seed 2026-11 > joins.csv
   ```

   The columns are `a`, `b`, `score`, `reasons` and an empty `same`. `reasons` lists the identifiers that joined the pair. The same seed on the same graph gives the same pairs, so a sample can be written again. The seed defaults to the current month, and the size to 300.

2. For each row, look up both records in your own system and write `yes` or `no` in `same`. Leave a row empty when you cannot tell. Empty rows are counted apart and left out of the share.

3. Score it.

   ```sh
   account-graph score-joins joins.csv
   ```

   <!-- schema cli -->
   ```json
   { "checked": 300, "same": 285, "different": 15, "unanswered": 0, "share": 0.95, "low": 0.919, "high": 0.969 }
   ```

   `share` is the share of checked rows that were one person. `low` and `high` are its 95% Wilson interval. With 300 rows checked, the interval is about 5 points wide.

For each `no`, keep the two records apart in the [reviewer screen](#reviewer-screen), so the decision and its reason are recorded.

## Policy

The server runs the default weights, caps and half-lives. `POLICY` overrides only the values it names.

```sh
POLICY='{"kinds":{"phone":{"weight":0.85,"halfLife":63072000000}}}' npm start
```

For a longer policy, set `POLICY_FILE` to the path of a JSON file. [Matching](matching.md) describes each part of a rule, and [Presets](matching.md#presets) has a policy for contacts entered by staff. A new kind needs its weight, dilution, cap and half-life. Write `"none"` for an unlimited half-life.

> **A changed policy needs a rebuild.** The database keeps the policy it was built with. A server started with another one stops with `The policy differs from the one this database was built with. Run account-graph rebuild.`

1. Stop the servers.
2. Run `account-graph rebuild` with the new policy set. It blocks other writes while it runs.
3. Start the servers with the same policy.

Without `POLICY` and `POLICY_FILE`, the server takes the policy the database keeps. Removing the variable does not bring the default back. Set `POLICY='{}'` and rebuild for that.

A database from before the policy was kept takes the one that is set, where its clusters were built with it, and the default where none is set. Startup, `GET /health` and the reviewer Health view say "Groups are due a rebuild. Run account-graph rebuild." The service keeps answering. A successful rebuild clears the warning.

Startup fails with one line per problem when a setting is invalid. It also fails when the policy omits the kind of a stored identifier.

## Audit log

Each decision is hashed together with the one before it. The Health view verifies the chain and reports the first altered entry. So does the route it reads:

```sh
curl -s https://graph.example.org/review/api/audit --header @/private/graph/reviewer-header | tee -a /somewhere/else/heads.log
```

<!-- schema reviewer -->
```json
{ "sound": true, "head": { "seq": 418, "hash": "9c1f…" } }
```

The header file above is an owner-readable file containing the complete Authorization header.

The chain detects an edit to part of the log. Anyone able to rewrite the whole table could rebuild it, so copy the newest hash daily to a place they cannot write.

Copy it from the Health view, or set `AUDIT_HEAD_HOURS=24` to post it to `ALERT_WEBHOOK` once a day, with an `audit.head` [event](#events). To check an old copy, fetch that entry with `GET /review/api/decisions?before=419&limit=1` and compare its hash.

## Backups

All data lives in one PostgreSQL schema, `account_graph` or the value of `GRAPH_SCHEMA`. Schedule your own backups.

```sh
pg_dump --format=custom --schema=account_graph "$DATABASE_URL" > graph.dump
```

Rehearse from a checkout with `pg_dump` and `pg_restore` on the path, no newer than the target server. A newer `pg_restore` sets parameters an older server does not know, so the check refuses it. Where several versions are installed, set `PG_BIN` to the folder of the right ones, such as `/usr/lib/postgresql/16/bin`.

```sh
node tools/restore-check.ts
```

1. Set `DATABASE_URL` to the source using a role with read access. Set `NEW_DATABASE_URL` to a new, empty database reserved for this run. Keep other connections that can create objects or write data off the target.
2. Supply the source's `GRAPH_SCHEMA`, `RECEIPT_SECRETS` and matching graph settings, including policy, identifier and link secrets where configured. Keep provider workers off throughout the rehearsal.
3. Run the command. It counts every graph table and reads the newest audit hash from the same snapshot that it dumps. It restores the archive into the target and runs the graph's own `verify` there.
4. Check the exit status. Success requires matching table names, row counts and audit head, zero cluster changes, and a current policy. Save the timings alongside your recovery-time objective. Compare the audit head with your independent copy from the same point in history. Treat the temporary database as a copy of the original data.

A successful rehearsal looks like this. Times, table count and hash here are illustrative. The tool prints the full hash, or `none` for an empty audit log.

```text
check empty target: 9 ms
source counts and audit hash: 74 ms
pg_dump: 380 ms
recheck empty target: 7 ms
pg_restore: 510 ms
verify: 0 cluster changes, policy current
verify: 183 ms
compare counts and audit hash: 68 ms
51 table counts match, newest audit hash: 9c1f…
```

For an actual recovery from a saved archive, restore into a fresh database and verify it with the same server settings. Set the command's database URL explicitly before changing the event history.

```sh
pg_restore --no-owner --single-transaction --exit-on-error --dbname="$NEW_DATABASE_URL" graph.dump
DATABASE_URL="$NEW_DATABASE_URL" account-graph verify
DATABASE_URL="$NEW_DATABASE_URL" account-graph events new-epoch
```

From a source checkout, run the same commands with Node.

```sh
DATABASE_URL="$NEW_DATABASE_URL" node src/bin.ts verify
DATABASE_URL="$NEW_DATABASE_URL" node src/bin.ts events new-epoch
```

`events new-epoch` changes the restored event history's identifier. Existing events stay available. A follower with a cursor from before the restore gets `{"ok":false,"reason":"CURSOR_LOST"}` and resumes from `after: null`. This prevents a follower whose cursor was ahead of the backup from missing subsequent events. Run it on the recovered database before reconnecting followers. Reapply erasures and reconcile outgoing conversions before starting workers.

A dump cut short restores nothing. The server upgrades an older dump when it starts.

| Topic | Guidance |
| --- | --- |
| Restore tests | Restore a dump elsewhere before you need one. |
| Over a database in use | Restore beside it instead. `--clean` keeps any table newer than the dump, with its rows. Without `--no-owner`, another role gets an error for each table. |
| Audit hash | Store the newest hash apart from the dumps. After a restore, the Health view verifies the chain, and the stored hash confirms it is the same log. |
| Secrets | A dump holds receipts and keyed hashes. Keep `RECEIPT_SECRETS`, `IDENTIFIER_SECRET` and `LINK_SECRET` as long as the dump, and apart from it. |
| Deleted people | Older dumps still contain them. Keep dumps only as long as you need them, and run `forget` again after a restore, with new keys. |
| Conversions | Conversions sent since the dump may be sent again with the same id. Reconcile with the provider before restarting workers. Meta deduplication depends on the event name, ID and timing. Google value changes require the original transaction, destination and action. A zero value can leave the count. See [Meta deduplication](https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events/) and [Google adjustments](https://developers.google.com/data-manager/api/devguides/events/google-ads/conversion-adjustments). |

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
| Duration | The 90 days count from the link's creation. Some browsers delete a script-set cookie sooner. Safari deletes it after seven days without a visit. Open the link again. |
| HTTPS | The link must lead to an `https` address, because the cookie is marked `Secure`. `localhost` is the exception. |
| Sharing | Anyone who opens the link is marked. A published link hides real visitors until it expires. A new `LINK_SECRET` ends every mark and every other link. |
| Earlier visits | Visits from before the mark stay recorded. Run `forget` on the browser's `visitor:` subject to delete them. |
| Phone calls | Calls have no browser and stay recorded. |

## Rate limit

Each address may post a burst of 60 requests and 120 a minute to `/collect`. Beyond that the server answers 429 with a `retry-after` header.

The limit protects the graph from a single sender, because a script can claim any origin. Set `RATE_LIMIT=off` only when a system in front already limits requests. Each server process counts for itself.

Each configured lead source has its own limit of 60 authenticated posts per minute per server process. Set `perMinute` on the source to change it. Lead webhooks use this limit even when the browser limit is off. After 10 posts with a missing or wrong signature from one address to one source within a minute, further posts from that address with a missing or wrong signature get 429 from that source until the minute is up. A post with the right signature is never held up by them, since a relay pool or a proxy can share one address among many senders. It counts toward the source's own limit. The address is read through `TRUST_PROXY` as for `/collect`.

## Upgrades

Start the new version. At startup the server applies pending database changes in order. Completed changes stay committed if the process stops. Upgrades 29 and 30 commit together because a confirmed call and its old channel visit must agree about who can see it. Upgrade 31 commits its new columns before filling them. Starting the server again repeats any unfinished phase.

Each change has a number and runs once. When several servers start together, one applies the changes and the others wait. A direct PostgreSQL store read that needs a missing column or table reports the first pending upgrade. Call `store.migrate()` before retrying. What a caller must change is in the [changelog](../CHANGELOG.md#upgrading).

Upgrade 36 creates an empty table for standing creation dates. First-seen times are read from existing records, so the upgrade needs no backfill. Older servers can keep writing profiles without dates, pruning and forgetting subjects during the rollout. Send profiles with `createdAt` to an upgraded server.

Upgrade 37 takes the same write lock as a running server before changing the edge or sighting table. An older writer can finish its observation before the upgrade locks either table. The upgrade adds nullable columns for profile ordering and creates empty tables for withdrawals and their matching evidence. It requires no backfill. If the upgrade stops before committing, restart it. Older servers can keep recording while a withdrawal is in force. Send profiles that restore facts to an upgraded server, and use that version for historical snapshots, rebuild and verification. See [withdrawing a matching fact](matching.md#withdrawing-a-matching-fact).

Upgrade 38 creates empty tables for STOPs kept after a group changes and for pruned profile dates of withdrawn numbers. Existing text and sighting rows can be read in place. A STOP previously lost solely through a group split on version 37 can only be recovered if the earlier association is still known. During a rolling upgrade an older server can answer `textsOptedOut: false` for a record whose STOP the upgraded server keeps. Route opt-out lookups to an upgraded server first, then send withdrawals there. Older servers can still record, prune and forget.

## Settings that must match

Processes that share a database must agree on these. The database keeps the policy, and a keyed mark of each secret. A process that differs stops at startup, or gets the fault `CONFIG.MISMATCH` on its first call.

| Setting | A process that differs | To change it |
| --- | --- | --- |
| `POLICY`, `POLICY_FILE` | Is refused. One without any takes the database's. | Stop the servers, run `account-graph rebuild` with the new one, start them with it |
| `IDENTIFIER_SECRET`, `LINK_SECRET` | Is refused. One without it is let in, and makes none of its keys. | The same. New keys match none of the old ones, which cannot be made again, and links already sent become ordinary links. |
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
| Of a key whose person was deleted | Permanently, as a tombstone of a type, a keyed hash and times. A late retry then brings nobody back. |
| Of a deleted subject | Permanently, as a tombstone, until your own services `record` a profile under that subject. Until then a [lead webhook](leads.md) cannot file under it. |

> **Keep an old secret while receipts made with it are kept.** A server without it does not start. Tombstones stay, so a secret under which anybody was deleted is kept permanently.

After its receipt is pruned, a key is new again. A conversion, call, text, payment or transfer that is still on record stays one. A profile, an arrival or a consent answer is written a second time.

## Monitoring

| Where | Answers |
| --- | --- |
| `GET /health` | `{"ok":true}` once the database answers. Needs no token. Use it for load balancer checks. |
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

A callback notice keeps track of its missed calls, outgoing attempts, number-channel visits and the identity links that earned its credit. Assigning one of those calls to another record or forgetting it removes the notice and its kept event. After a correction changes a component, a notice that used an identity link keeps its event if the same route still credits the same arrival. A later check can issue a corrected notice for a miss that is still open. A message already received outside the graph stays with its recipient.

PostgreSQL upgrade 31 reads calls, their former lines and their named parties once into a temporary list indexed by owner, direction and time. Each old event finds its named call by primary key, its possible misses and attempts by that index, and a qualifying visit by subject and time. Alerts share one summary per notice and one per owner. The backfill holds the graph write lock and pauses changes to the alert and event tables. Ordinary reads can continue after the new columns commit. The temporary lists disappear when the backfill finishes or rolls back.

PostgreSQL upgrade 31 checks old callback events by the owner and times they contain. Only misses and attempts reported by the time the notice was queued can have supplied it. An attempt also has to fall between the missed call and the notice. Assigning a later attempt to another record can change that record's pending callback. An independent earlier notice on the former line stays. An old event that may have counted another record's call is removed. Older notices could draw credit through links that have since disappeared. After a correction to an inbound call, an old notice keeps its campaign where the call's confirmed record or a paid arrival on the exact subject accounts for it. Where old alerts for one owner cannot be told apart, their possible source calls are kept together for later corrections.

Retire older servers and workers before enabling call confirmations. Upgrade 34 refuses an older server's raw report for a call that staff already assigned, including a statement made before the first report. Retry the report on an upgraded server. Before serving or starting workers, startup repairs earlier reports whose stored owner disagrees with the statement, in batches of 50. A blocked call may still have the right owner. Its dated completed-call note also shows that an old writer reported it again. It applies the standing statement to the call, its matching evidence, value history, pending deliveries and callbacks. It drops the overwritten visitor and tags. The original time, duration and dialed number cannot be recovered from an overwritten report.

Upgrade 35 rechecks statements about previously deleted records even if an older server already completed its repair. Startup checks each old statement against the receipt and sighting times before it serves requests. A confirmed call can stay with a returning record while an earlier statement about that same call is erased. See [Call statement privacy](privacy.md).

If the corrected call was already forgotten, an old receipt can be all that survives. A call and a party update erased together can still be recognised after receipt pruning. For older receipts that could also describe an ordinary result or return, the upgrade looks for a saved revision from a party correction. Where both are present it removes older notices whose missed call, attempts or campaign can no longer be accounted for. A matching notice for another miss can stay, even on the same line.

### Webhook

Set `WEBHOOK_URL` and `WEBHOOK_SECRET`. The server posts new events there within seconds, in order, at most 100 to a post. On a fresh database the worker initializes its cursor on its first pass. Produce test events after that pass.

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
| Signature | Over the body as received, under `WEBHOOK_SECRET`. Refuse an old `t`. Use the original bytes, a local clock and a maximum age in milliseconds. Deduplicate by event sequence within each cursor history before applying effects. The library has [`verifyWebhook` and `parseWebhook`](library.md#webhook). |
| Answer | Any 2xx within ten seconds. Redirects are not followed. |
| Delivery | At least once, in order, by one process at a time. If an event is erased or redacted while a batch is being signed, the sender signs the current batch before posting. |
| Refused | Tried again after 30 seconds, doubling to an hour, for a day. Then the events of that post are passed over, and an alert says so. The `events` call still has them. |

## Alerts

Set `ALERT_WEBHOOK` to a private receiver, such as a Slack incoming webhook, that accepts `{"text": "…"}`. This POST is unsigned. The URL can itself be a secret. It can receive transaction IDs, campaign details and error text. Configure the final receiver URL directly. The alert client can follow redirects. Use a loopback receiver with synthetic data for an offline test. What is in this table is kept as an [event](#events) too.

| Event | Message content | Frequency |
| --- | --- | --- |
| A platform rejects a conversion, or its retries run out | Transaction, platform and reason, up to ten per message | At most once in ten minutes |
| The outbox cannot run, so conversions are paused | The reason, such as a database outage | At most once in ten minutes |
| Sends are paused with `account-graph sends pause` | The reason given | Each time |
| Campaign costs cannot be read, so the report's costs become stale | Platform and reason | At most once in ten minutes per platform |
| A feed is stale | Feed and time of its last record | Once per stale period |
| Conversions are `LATE_HOURS` overdue | Due time of the oldest | Once a day while it lasts |
| A missed caller from a paid visit has waited `RETURN_HOURS` | Campaign, time, and number of callback attempts | Once per wait |

The server logs and stores an alert that fails to deliver, retries it every five minutes, and shows it on the Health view. The work it reports on continues. Without a webhook, alerts are stored and shown there. Delivery to a live alert webhook is untested.

The following CLI command sends a fixed test message to the configured receiver and reports the immediate delivery result. A failure is kept for a later worker pass. Regular failed alerts and their retries can be exercised against a local sink.

```sh
account-graph alerts test
```

<!-- schema cli -->
```json
{ "delivered": true }
```

### Stopping sends

When a tie looks wrong, or a platform is being sent the wrong thing, stop every send at once.

```sh
account-graph sends pause checking a wrong tie
```

The stop is kept in the database, so every process holds to it, and a restart keeps it. Conversions are still recorded, and their jobs wait as they were. No retry is used up while sends are stopped. Time still counts: the `LATE_HOURS` alert counts the wait, and an outcome waiting for a click, email or phone still has seven days from when it happened. Deletions asked for when someone is forgotten still go. `account-graph sends resume` lets the jobs go on the next pass. With [`OUTBOX_DELAY_MS`](#outcomes-and-calls) set, a tie undone while sends are stopped is not sent.

Set `PAUSE_AFTER_FAILURES` to put the stop on by itself once that many conversions fail for good within an hour. Every process adds to one count, kept in the database. The count starts again an hour after its first failure, and when sends resume. The stop posts its own alert and a `delivery.paused` event.

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

The server checks the call's owner, missed status and paid arrival in the same write that queues its alert and event. Changing the owner or forgetting the call clears the waiting alert. Each sender checks the waiting message again right before posting it. A send that has already passed that check can still arrive.

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

### Targets

A target is a number you set yourself to meet. The reviewer screen shows it beside what was reached, as set by you, and says whether it is met. It changes no count, color or alert. Without `TARGETS` none is shown.

```sh
TARGETS='{"answered":0.9,"returned":0.8,"callbackHours":2}'
```

| Target | Meaning | Shown beside |
| --- | --- | --- |
| `answered` | The share of inbound calls a person should answer, above 0 and up to 1 | Answered, on Calls |
| `returned` | Of the missed callers who could be called back, the share that should be [returned](calls.md#callbacks), above 0 and up to 1. Callers whose call is `hidden` or `called again` are not counted. | Returned, on Calls |
| `callbackHours` | Hours by the clock a missed caller may wait | Awaiting callback, on Calls |
| `costPerOutcome` | What an outcome may cost, in the currency of your costs | Not shown yet |
| `roas` | What should come back of each unit spent | Not shown yet |

Each is optional, and a name or value that is not one of these stops the server at startup. The library takes the same object as `targets`.

### Jobs

The ordinary server starts workers. The outbox can deliver older pending jobs on startup. Use a fresh database and empty stage actions for an offline run. A delay postpones new jobs and `retry` can requeue old ones. For a single credentialed probe, the named checker runs without starting a graph or a worker.

Each cost worker requests seven UTC days ago through today, inclusively, every six hours. The one-day check only reads the report. Compare dates in the ad account's reporting time zone, currency and conversion definition before reconciling spend.

The Health view lists the background jobs: the outbox, each cost import, the audit hash post, and the alert checks. Each shows its last start, success and failure. A run that started and never finished is shown for a month.

## Shutdown

On `SIGTERM` or `SIGINT` the server stops taking requests, finishes the writes in progress, and closes its database connections. If a conversion's send is interrupted, the next start sends it again. Check the receiving platform's deduplication rules and reconcile ambiguous deliveries.

## Environment variables

A partially set group stops the server at startup, with a message naming the missing variables.

### Server

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL address. |
| `GRAPH_TOKEN` | required | Service token. |
| `RECEIPT_SECRETS` | required | Keys the [receipts](#receipts). Separated by commas, at least 32 characters each. The first signs, and all are tried. |
| `SERVICE_TOKENS`, `SERVICE_TOKENS_FILE` | none | Named service credentials and their allowed calls, supplied as a JSON list or a path to that list. |
| `REVIEW_TOKENS` | none | Reviewers, as JSON: each name with its token or a list of tokens. Each token must be unique and differ from `GRAPH_TOKEN`. |
| `ALLOW_PAGES`, `REFUSE_PAGES` | unset | Comma-separated literal page paths or subtrees ending in `/*`. A refusal takes precedence. |
| `ORIGINS` | none | Site addresses that may post visits, separated by commas. |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listening port and address. |
| `GRAPH_SCHEMA` | `account_graph` | Database schema that holds the tables. |
| `TRUST_PROXY` | `false` | `true`, or the number of proxies in front. The server then reads visitor addresses from `x-forwarded-for`. |
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
| `LEADS`, `LEADS_FILE` | none | Named lead webhook sources as a JSON object or a path to a private file containing that object. Set at most one. Empty is the same as unset. See [Mappings and setup](leads.md). |
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
| `POOL_REQUIRE_TAP_AFTER_REASSIGNMENT` | `false` | With `true`, a caller with no tie to a visitor needs a tap or a code once different visitors have held the number. |
| `OPEN_HOURS` | none | Opening hours, as JSON. See [opening hours](#opening-hours). |
| `TARGETS` | none | The numbers you set yourself to meet, as JSON. See [targets](#targets). |

### Outbox, webhook and alerts

| Variable | Default | Description |
| --- | --- | --- |
| `PAUSE_AFTER_FAILURES` | `0` | Conversions that fail for good within an hour before [sends stop](#stopping-sends) by themselves. `0` never stops them. |
| `OUTBOX_DELAY_MS` | `0` | Delay before the first send of a new outcome. The click is chosen when it is sent, so a tie a reviewer undoes during the delay never reaches the platform. |
| `FORGET_ADS` | none | `true` requests the supported adjustment when a person is [deleted](privacy.md#data-at-ad-platforms). Google can reduce value to zero while the count remains. |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | none | URL that receives [events](#webhook), and the secret that signs each post. Set both. |
| `ALERT_WEBHOOK` | none | URL that receives alerts, as `{"text": "…"}`. |
| `AUDIT_HEAD_HOURS` | `0` | Posts the newest audit hash to `ALERT_WEBHOOK` at this interval, at least one hour. Requires `ALERT_WEBHOOK`. `0` disables it. |
| `QUIET_TOUCHES_HOURS`, `QUIET_CALLS_HOURS`, `QUIET_RESULTS_HOURS`, `QUIET_COSTS_HOURS` | `0` | Hours before a feed is [stale](#stale-feeds). `0` disables the check. |
| `LATE_HOURS` | `6` | Hours past its due time before a queued conversion raises an alert. `0` disables it. |
| `RETURN_HOURS` | `24` | Hours before a missed caller from a paid visit raises an alert, and before the board marks any missed caller overdue. `0` disables both. |

### Providers

| Variable | Default | Description |
| --- | --- | --- |
| `FINGERPRINT_SECRET`, `FINGERPRINT_REGION` | none, `us` | Reads Fingerprint events. Regions are `us`, `eu` and `ap`. Choose the same region on the browser. |
| `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY` | none | Classifies addresses with MaxMind. Set both. |
| `SERVER_RANGES_FILE` | none | A file with the address ranges of data centers, written as `192.0.2.0/24` or `2001:db8::/32` in any text: what [AWS](https://ip-ranges.amazonaws.com/ip-ranges.json) and [Google Cloud](https://www.gstatic.com/ipranges/cloud.json) publish, one after the other. An address in them is recorded and is no evidence. Read when the server starts, so fetch it again now and then. |
| `MAXMIND_SERVICE`, `MAXMIND_HOST` | `insights`, `geoip.maxmind.com` | Use `country`, `city` or `insights`. Use `geolite.info` for the appropriate GeoLite service, or `sandbox.maxmind.com` with its own eligible account, key and published inputs. Other hosts are refused. See [Sandbox](https://dev.maxmind.com/geoip/docs/web-services/sandbox-environment/). |
| `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_URL` | none | Accepts Twilio's call reports at `/calls/twilio`. Set both. |
| `TEXT_CODES` | off | `true` gives each browser a code for your [text links](calls.md#text-messages) and for [callers to read out](calls.md#a-code-read-out). |
| `TWILIO_TEXT_WEBHOOK_URL` | none | With `TWILIO_AUTH_TOKEN`, accepts Twilio's incoming texts at `/texts/twilio`. |
| `TWILIO_ACCOUNT_SID` | none | With `TWILIO_AUTH_TOKEN`, looks up the line type of phones in a `profile`, a `call` or a `text`. |
| `SMARTY_AUTH_ID`, `SMARTY_AUTH_TOKEN` | none | Checks postal addresses in a `profile`. Set both. |
| `SMARTY_LICENSE` | none | If multiple subscriptions cover US Street, set the license value from the account's Subscriptions page to choose which allowance is used. See [License selection](https://www.smarty.com/docs/account/license-selection). |
| `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_SERVICE_ACCOUNT_FILE` | none | Sends conversions to Google Ads. Set both. |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | none | The manager account, when the service account belongs to one. |
| `META_PIXEL_ID`, `META_ACCESS_TOKEN`, `META_SITE_URL` | none | Sends conversions to Meta. Set all three. |
| `META_CLIENT_USER_AGENT` | `false` | With `true`, keep the converting browser's real user agent in the Meta website job only with explicit ad-user-data consent. Pending jobs can keep it for retry. Holding, withdrawal, successful delivery, a skip or terminal failure clears it. |
| `META_TEST_EVENT_CODE` | none | Adds the dataset's Test Events code. These events may still affect targeting and measurement. See [Meta Test Events](https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api). |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_REFRESH_TOKEN`, `MICROSOFT_DEVELOPER_TOKEN`, `MICROSOFT_CUSTOMER_ID`, `MICROSOFT_ACCOUNT_ID` | none | Sends conversions to Microsoft Advertising. Set all five. |
| `MICROSOFT_SANDBOX` | `false` | Set `true` to direct Microsoft conversion uploads and adjustments to the sandbox. Use its own account and goal. |
| `MICROSOFT_CLIENT_SECRET` | none | Required only for a web app registration. |
| `TIKTOK_PIXEL_CODE`, `TIKTOK_ACCESS_TOKEN`, `TIKTOK_SITE_URL` | none | Sends conversions to TikTok. Set all three. |
| `TIKTOK_TEST_EVENT_CODE` | none | Includes the QA pixel's test event code in TikTok uploads. |
| `GOOGLE_ADS_COSTS` | off unless legacy token set | Set `true` to read Google Ads costs with the customer and service-account file. This pair also configures the Google conversion target in the server. Set `false` to disable the cost worker. |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | none | Optional for existing configurations. Google retired developer tokens on September 9, 2026. See [Google Ads access](https://developers.google.com/google-ads/api/docs/api-policy/developer-token). |
| `META_AD_ACCOUNT_ID`, `META_ADS_TOKEN` | none | Reads campaign costs from Meta. Set both. |
| `GOOGLE_ADS_CONVERSIONS` | none | `true` also reads Google's conversion count for each campaign. |
| `META_ADS_CONVERSIONS` | none | The action to read from Meta with its costs, such as `offsite_conversion.fb_pixel_lead`. |

The checker uses its own process environment. `FINGERPRINT_EVENT_ID`, `GOOGLE_ADS_CONVERSION_ACTION_ID` and `TWILIO_LOOKUP_NUMBER` identify the single authorized input for those checks. Run `npm run live-check -- --list` to print the complete send list offline.

## Performance

Measured on an Apple M1 Max with Node 22 and synthetic data. PostgreSQL 16 ran in Docker on the same machine with two processors and default settings, including `fsync`. Run `DATABASE_URL=postgres://… npm run bench` to measure your own hardware, or omit the variable to measure the memory store.

20,000 accounts:

| Store | One at a time | In batches of 100 | Through the write queue | Reading one subject's links |
| --- | --- | --- | --- | --- |
| Memory | 28,700 observations/s | 13,800/s | 16,900/s | 0.02 ms |
| PostgreSQL | 183 observations/s | 1,900/s | 3,600/s | 2.7 ms |

PostgreSQL writes are serialized by an advisory lock. The write queue combines the visits that browsers report at one time into one transaction.

Before regrouping, the stores check whether a stated call supplied an edge to these subjects or one of their identifiers. Other groups use their current edges alone. PostgreSQL makes the check in the same round trip as the edge read.

The figures are of observations written by the engine. An entry of `record` is a transaction of its own and also writes a receipt, which these figures leave out.

Large graphs, five edges per account, with `DATABASE_URL=postgres://… npm run bench -- scale 1000000 5000000 10000000`. Cells show time and peak memory:

| Edges | On disk | `rebuild` | `verify` | Observation, one subject's links |
| --- | --- | --- | --- | --- |
| 1 million | 420 MB | 7 s, 159 MB | 6 s, 150 MB | 6.6 ms, 2.3 ms |
| 5 million | 2.1 GB | 45 s, 198 MB | 40 s, 206 MB | 8.1 ms, 2.9 ms |
| 10 million | 4.3 GB | 94 s, 291 MB | 85 s, 402 MB | 10.7 ms, 3.7 ms |

The last column is the median of 300 sequential runs. Other tests used the database during the two larger runs, so those times are upper estimates.

## What was tried

- The shared test suite runs on the memory store and PostgreSQL 16, locally and in CI. It includes a fuzz test of observations, decisions, deletions and transfers, and six concurrent outbox workers.
- The Docker image, the example site, ad click attribution, signed links, cross-site visitors and tap-to-call matching were exercised end to end in Chrome.
- The reviewer screen and the `HttpOnly` device cookie were exercised in Chrome under their production headers.
- A database created before an upgrade was upgraded by starting the server.
- The hardware id was exercised on macOS and Linux.
