# The HTTP routes

The server answers over plain HTTP with JSON. Your own services call it with a token; browsers reach only the few routes that need none.

```sh
curl -X POST https://graph.example.org/observe \
  -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"subject":"account:42","identifiers":["device:9f3c"],"at":1795460000000,"event":"login"}'
```

```json
[{ "subject": "account:42", "from": "account:42", "to": "account:17" }]
```

That answer says the login joined `account:42` to the cluster of `account:17`. An empty list means no cluster changed.

## Tokens

A token goes in the `authorization` header as `Bearer …`. There are two.

- **Service**, `GRAPH_TOKEN`: opens every route. For your own backend.
- **Review**, `REVIEW_TOKEN`: opens what the reviewer screen needs. For people.

> **A wrong or missing token gets 401. The review token on a service-only route gets 403.**

## No token

| Route | What it does |
| --- | --- |
| `POST /collect` | Records one browser visit. Only from an origin in `ORIGINS`, and limited per address. Answers 204. |
| `GET /collect.js` | The script tag that posts to `/collect`. |
| `GET /fingerprint.js` | Fingerprint helpers the script loads when asked to. |
| `GET /review` | The reviewer screen. A page only; its data needs a token. |
| `GET /health` | `{"ok":true}` once the database answers. |

## Review or service token

| Route | What it does |
| --- | --- |
| `GET /subject?subject=` | Everything about one subject: cluster, ties, separations, flows, rings, newest sightings. |
| `GET /cluster?subject=` | The cluster a subject is in: `{ id, members, oversized }`, or `null`. |
| `GET /links?subject=` | Every subject tied to this one, with score and reasons. |
| `GET /history?subject=` | Every sighting of the subject, oldest first. |
| `GET /clusters?offset=` | The largest clusters, 50 at a time. |
| `GET /search?q=` | Subjects whose id starts with the text. |
| `GET /recent` | The newest cluster changes. |
| `GET /flows?subject=` | Everyone the subject exchanged value with, and the identity tie to each. |
| `GET /collusion?subject=` | The counterparties tied by identity, with three or more flows. |
| `GET /rings?subject=` | Value that left the subject and came back through others. |
| `GET /decisions` | The record of reviewer decisions, oldest first. |
| `GET /audit` | Whether that record is whole: `{ sound }`, with `brokenAt` when it is not. |
| `POST /separate` | `{ a, b, separated?, by?, reason? }`. Keeps two subjects apart, or with `separated: false` allows them again. |
| `POST /join` | `{ a, b, by?, reason? }`. Records that two subjects are one person. |
| `POST /ignore` | `{ identifier, ignored?, by?, reason? }`. Stops linking through one identifier, or resumes. |
| `POST /forget` | `{ subject, by?, reason? }`. Deletes a subject and everything recorded about it. |

The four `POST` routes answer with the subjects whose cluster moved.

## Service token only

| Route | What it does |
| --- | --- |
| `POST /observe` | One observation, or a list: `{ subject, identifiers, at, event? }`. Answers with the cluster changes. |
| `POST /touch` | A marketing touch: `{ subject, at, gclid?, source?, medium?, campaign?, … }`. |
| `POST /consent` | `{ subject, consent: { adUserData, adPersonalization } }`. |
| `GET /attribute?subject=&at=` | The touches that led to a conversion by this subject, and the one credited. |
| `POST /transfer` | `{ from, to, amount, at, asset? }`. Records value moving, and answers with the identity tie between the two. |
| `POST /convert` | An outcome for the outbox: `{ transactionId, subject, at, action, value?, email?, phone? }`. |
| `POST /restate` | `{ transactionId, value, currency? }`. Changes a sent conversion's value. |
| `GET /conversion?id=` | The jobs of one transaction, one per ad platform. |
| `GET /conversions?state=` | Jobs in one state: `pending`, `sent`, `skipped`, or `failed`. |
| `POST /retry` | `{ transactionId }`. Puts its failed and skipped jobs back in line. |
| `POST /prune` | `{ before, by?, reason? }`. Deletes sightings written down before a time. |
| `GET /stats` | Counts since start, what the graph holds, and outbox jobs by state. |
| `GET /verify` | The subjects whose stored cluster differs from a full recompute. |

The five outbox routes answer 404 when no ad platform is configured.

## Errors

| Status | When |
| --- | --- |
| 400 | The body is not JSON, or a field is missing or malformed. The answer is `{ "error": "…" }`. |
| 401, 403 | The token is wrong, or does not open the route. |
| 403 on `/collect` | The request's origin is not in `ORIGINS`. |
| 404 | No such route. |
| 413 | The body is over 1 MB. |
| 429 on `/collect` | Too many visits from one address. `retry-after` says when to try again. |
| 500 | Something failed on the server. The cause is in its log, not in the answer. |
