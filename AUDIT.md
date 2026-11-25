# API surface audit

Audited 2026-11-24 at `99e4779`, which the line numbers refer to. An earlier version of this page named `b9bba69`: the checkout moved on while it was read. The audit changed no source file. Finding 8 has been fixed since, and section 6 reviews the design. Reference: `economy-edge`, working tree on top of `60f71b3`.

## Verdict

**79 routes, 13 subpaths, 203 root exports and 80 `Graph` methods come down to six calls and `close()`.**

| Call | HTTP | Replaces |
| --- | --- | --- |
| `record` | `POST /v1/record` | 15 write routes |
| `decide` | `POST /v1/decide` | 3 decision routes |
| `forget` | `POST /v1/forget` | 1 route with two response shapes |
| `lookup` | `POST /v1/lookup` | 20 read routes |
| `report` | `POST /v1/report` | 7 report routes |
| `events` | `POST /v1/events` | 1 feed, and both outbound webhooks |

The other 32 routes leave the business surface: 23 to the HTTP edge, 9 to the command line or the review API.

| Bucket | Routes (79) | Root values (70) | Root types (133) | Subpaths (13) | `Graph` methods (80) |
| --- | --- | --- | --- | --- | --- |
| KEEP | 3 | 0 | 26 | 0 | 3 |
| MERGE | 44 | 17 | 63 | 0 | 47 |
| INTERNALIZE | 9 | 53 | 44 | 8 | 11 |
| EDGE-ISOLATE | 23 | 0 | 0 | 5 | 19 |

`.` is the fourteenth `exports` entry. It is counted as the 203 root exports.

### Decisions

D1 to D5 were approved as recommended on 2026-11-24. D5's hash is keyed (R3).

| # | Question | Recommendation, approved |
| --- | --- | --- |
| D1 | `transfer`, `flows`, `collusion` and `rings` are not in your list of workflows. Keep them? | Keep as one `record` type and one `lookup` kind. They cost no extra call. Deleting them later removes one variant of each. |
| D2 | Break cleanly, or run both surfaces for a while? | Break cleanly. `docs/library.md` says the package is unpublished on npm, and the only other code found calling it on this machine is a local test harness. A deployment elsewhere, or someone running the GitHub repository, would change this answer. |
| D3 | Custom ad platforms (`Target`) stop being public. Acceptable? | Yes. Nothing outside the repo's own four targets and tests was found using it. If you need it later, add a `./ports` subpath, as economy-edge does. |
| D4 | Store every caller key with its answer (new `receipt` table)? | Yes. Without it, 8 of the 14 writes have no key to honour. This is the largest piece of work here. |
| D5 | Refuse a retried record about somebody who was deleted? | Yes. Keep only a keyed hash of `type:key` after `forget`. Today a late retry writes the person back, except for an outcome made from a text (`Gone`, `src/texts.ts:39`). |

### Where economy-edge does not settle it

The reference is a stateless codec, so some of your Phase 3 is new design and not a copy of it.

| Point | economy-edge | Here |
| --- | --- | --- |
| Lifecycle | `compose` does no I/O, and nothing is closed (`README.md`) | A database and workers, so `close()` is new. The factory still does no I/O. |
| Local and HTTP behind one interface | Does not exist | New |
| JSON payloads | `Money.minor` is a `bigint`; `encodeMoney` makes it JSON | Amounts are already JSON numbers, and stay so |
| Timestamps | ISO 8601 strings | Epoch milliseconds stay. The rule taken is that they are explicit. |
| Custom adapters | One factory per provider, on a subpath | Plain config objects, because you asked for no wiring |
| Lost response | An `INDETERMINATE` outcome | A retryable fault. The caller's only move is the same: call again with the same key. |
| Size of root | Root also exports a rail router and guards in the working tree; the committed version does not | The committed, smaller root is the standard used |

Taken as they are: `Outcome`, `Fault` with `FAULT_CODES`, `isFault`, `hasCode`, `CallOptions`, caller-owned keys (`src/codec/idempotency.ts`), `verify` before a total `parse` with `Unrecognized`, `schemaVersion`, no environment reads, and an import-direction test (`test/arch.test.ts`).

## What is wrong today

Rows marked **run** were reproduced against the real handler on the memory store, from a script outside the repo. The others were read in the source.

| # | Finding | Evidence | Fixed by |
| --- | --- | --- | --- |
| 1 | **Library and HTTP are different products.** Hashing, checks, stages, pool numbers, call and outbox wiring live inside `createHandler`. | `convert`, `calling`, `textOptions`, `factsIn`, `find`, `profile` in `src/server.ts` | One core behind both |
| 2 | **The obvious library call silently sends nothing.** `graph.outcome` with an `action` creates no delivery. `restate`, `forget`, `pay` and `withdraw` have the same pair of versions. | run: returned `true`, 0 jobs | One `record`, one `forget` |
| 3 | **A retry is not always safe.** A repeated `/touch` counts two visits. A repeated single `/join` writes two audit entries and two marks, while the list form does not. | run: `visits = 2`, `total = 2` | Keys on every write |
| 4 | **A late retry of an older restatement wins.** 50, then 80, then 50 again leaves 50. | run | Keys, and the newest `at` stands |
| 5 | **The same id with other details is refused or ignored, by configuration.** Without an ad platform action: 200 `[]`. With one: 400. | run | `KEY_REUSED`, always |
| 6 | **Restating an unknown conversion answers 200 `[]`.** | run | `UNKNOWN_REFERENCE` |
| 7 | **A lost `/forget` answer cannot be recovered.** The retry says nothing was sent to any platform. | run: `sent` went from one row to none | Answer kept with its key |
| 8 | **Fixed. Hashed email and phone left the server** on `/convert`, `/restate`, `/payment` and `/conversion`. `/conversions` and `/retry` strip them. Service token only. | run; `shownJob`, `src/server.ts:166` | Done: all six now use `shownJob`. `Delivery` later. |
| 9 | **Program bugs look like caller mistakes.** Any `TypeError` becomes a 400 with its text. | run: `Cannot destructure property 'id' of 'object null'` | Typed faults |
| 10 | **One bad identifier refuses a whole list.** The good entry in the same list was not written either. | run | One result per entry |
| 11 | **Writes wait on the change webhook.** It is awaited on the request path, with no timeout set and no retry. | `notify`, `src/serve.ts:287`; `changing`, `src/graph.ts:963` | Events delivered by a worker |
| 12 | **Receivers cannot verify a webhook with this package.** `bodySignature` is on no export, and alerts are unsigned sentences. | `src/sign.ts:14`, `src/alerts.ts`, `src/ops.ts` | `verifyWebhook`, `parseWebhook` |
| 13 | **Times default to now** on `/identify`, `/consent`, `/call/ringing`, `/call/returned`, `/attribute` and `/link`, so a retry says something else. | `src/server.ts`, `src/graph.ts` | `at` required |
| 14 | **Decisions can have no author.** | run: audit entry without `by` | `by` required |
| 15 | **A caller can take the key of a call or text.** `POST /convert` accepts `call:CA1`, the id a call's own outcome uses. | run | `call:` and `text:` refused as conversion keys |
| 16 | **Reviewer tokens open 17 routes the reviewer screen never calls.** | `REVIEW_ROUTES` (43) against `src/review/*.js` (26) | A separate `/review/api` |

The 17 routes: `GET /search`, `/links`, `/cluster`, `/history`, `/flows`, `/collusion`, `/rings`, `/consent`, `/outcome`, `/call`, `/text`, `/texting`, `/between`, and `POST /match`, `/people`, `/conflicts`, `/call/ringing`. `tools/labels.ts` uses one of them, `/between`.

## 1. Current surface

Auth: **S** service token only. **R** service token or a reviewer's. **O** listed origin and rate limit. **T** Twilio's signature. Unless it says otherwise, a JSON body goes in, JSON comes out, and an error is `{ "error": "…" }`.

Three routes are KEEP, because nothing else says the same thing. MERGE means the workflow survives as a variant of the call shown. Nothing on your list is dropped.

### 1.1 HTTP routes

| Route | Auth | Request → response | Implemented in | Bucket | Becomes | Why |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /identify` | S | `{subject, email?, phone?, device?, ip?, address?, name?, dob?, identifiers?, at?, event?} → {changes, identifiers, notes}` | `src/server.ts:866` (server.ts identify/factsIn → graph.observe, graph.ts:1003) | **MERGE** | `record profile` | Already a superset of a single /observe. |
| `POST /observe` | S | `Observation or Observation[] → Change[]` | `src/server.ts:864` (graph.observe, graph.ts:1003) | **MERGE** | `record profile` | Second way to say who somebody is; raw identifiers move under facts.identifiers. |
| `POST /touch` | S | `Touch → 204` | `src/server.ts:882` (graph.touch, graph.ts:1134) | **MERGE** | `record arrival` | One more recorded fact. Has no id today (finding 3). |
| `POST /costs` | S | `Cost[] or {costs} → {recorded}` | `src/server.ts:1174` (graph.spend, graph.ts:1525) | **MERGE** | `record cost` | One more recorded fact. |
| `POST /convert` | S | `Outcome → Job[]` | `src/server.ts:1039` (server.ts convert → outbox.record / graph.outcome, graph.ts:1146) | **MERGE** | `record conversion` | One more recorded fact. Leaks Job rows. |
| `POST /restate` | S | `{transactionId, value, currency?, kind?} → Job[]` | `src/server.ts:1158` (outbox.restate / graph.restate, graph.ts:1211) | **MERGE** | `record restatement` | A change to a conversion. |
| `POST /not-lead` | S | `{call or transactionId, kind?, lead?} → {id, lead}` | `src/server.ts:1154` (calls.ts recordNotLead) | **MERGE** | `record restatement` | Also a change to a conversion: it stops counting. |
| `POST /payment` | S | `Payment → {duplicate, value?, jobs}` | `src/server.ts:1164` (outbox.pay / graph.pay, graph.ts:1169) | **MERGE** | `record payment` | Accumulates where a restatement replaces, so its own type, not its own call. |
| `POST /call` | S | `Call → RecordedCall` | `src/server.ts:1063` (calls.ts recordCall) | **MERGE** | `record call` | One more recorded fact. |
| `POST /call/result` | S | `{id, answered, voicemail?, waited?} → {state, counted}` | `src/server.ts:1152` (calls.ts recordCallResult) | **MERGE** | `record call_update` | /call already accepts the same result fields. |
| `POST /call/returned` | S | `{id, at?, returned?} → {followUp}` | `src/server.ts:1156` (calls.ts recordReturn) | **MERGE** | `record call_update` | The callback report: an update to a call. |
| `POST /text` | S | `Text → RecordedText` | `src/server.ts:1065` (texts.ts recordText) | **MERGE** | `record text` | One more recorded fact. |
| `POST /consent` | S | `{subject, consent, at?, source?} → 204` | `src/server.ts:904` (graph.consent, graph.ts:1817) | **MERGE** | `record consent` | One more recorded fact. |
| `POST /transfer` | S | `Flow → Transferred` | `src/server.ts:956` (graph.transfer, graph.ts:1840) | **MERGE** | `record transfer` | Costs no extra call as a type. See decision D1. |
| `POST /link` | S | `{url, subject, days?, purpose?} → {url, id}` | `src/server.ts:1041` (server.ts → sign.ts knownLink, graph.keepLink, graph.ts:1362) | **MERGE** | `record link` | Writes a record and returns a URL derived from it. |
| `POST /join` | R | `{a, b, by?, reason?, seen?, mark?} or {source, pairs} → Change[] / {moved, mark} / Recorded` | `src/server.ts:908` (graph.join / graph.joinAll, graph.ts:1635) | **MERGE** | `decide merge` | Two forms, three response shapes, one decision. |
| `POST /separate` | R | `{a, b, separated?, …} or {source, pairs} → Change[] / Recorded` | `src/server.ts:951` (graph.separate / graph.separateAll, graph.ts:1625) | **MERGE** | `decide split / unsplit` | The same decision in the other direction. |
| `POST /ignore` | R | `{identifier, ignored?, by?, reason?, seen?} → Change[]` | `src/server.ts:884` (graph.ignore, graph.ts:1607) | **MERGE** | `decide mute / unmute / unmerge` | Also doubles as the undo of a join, through a leaked mark. |
| `POST /forget` | R | `{subject or subjects, by?, reason?, seen?, ads?, retract?} → Change[] or {changes, sent}` | `src/server.ts:888` (outbox.forget / graph.forget, graph.ts:1915) | **KEEP** | `forget` | Irreversible, so it must not be one typo in a discriminant away from a merge. |
| `GET /cluster` | R | `?subject → Cluster or null` | `src/server.ts:966` (graph.cluster, graph.ts:1125) | **MERGE** | `lookup person` | A field of the person. |
| `GET /consent` | R | `?subject → ConsentAnswer[]` | `src/server.ts:1033` (graph.consentHistory, graph.ts:1836) | **MERGE** | `lookup person` | A field of the person; its history is in the journey. |
| `GET /texting` | R | `?subject → {optedOut, at} or null` | `src/server.ts:1074` (graph.texting, graph.ts:1425) | **MERGE** | `lookup person` | A field of the person. |
| `GET /attribute` | S | `?subject&at → Attribution` | `src/server.ts:998` (graph.attribute, graph.ts:1142) | **MERGE** | `lookup person` | The credited arrival is a field of the person. |
| `POST /people` | R | `{subjects} → {people}` | `src/server.ts:1169` (graph.people, graph.ts:1194) | **MERGE** | `lookup person` | Already the right shape; becomes the base of person. |
| `GET /sent` | S | `?subject → SentLink[]` | `src/server.ts:1055` (graph.linksSent, graph.ts:1376) | **MERGE** | `lookup journey` | The journey already carries link entries. |
| `GET /history` | R | `?subject → Sighting[]` | `src/server.ts:996` (graph.history, graph.ts:2025) | **MERGE** | `lookup journey` | A raw table read; the journey is the same facts in order. |
| `GET /journey` | R | `?subject&before → Journey` | `src/server.ts:968` (graph.journey, graph.ts:1943) | **MERGE** | `lookup journey` | Survives as a lookup kind. |
| `GET /flows` | R | `?subject → Counterparty[]` | `src/server.ts:958` (graph.flows, graph.ts:1859) | **MERGE** | `lookup transfers` | See decision D1. |
| `GET /collusion` | R | `?subject → Counterparty[]` | `src/server.ts:960` (graph.collusion, graph.ts:1863) | **MERGE** | `lookup transfers` | A filter over /flows. |
| `GET /rings` | R | `?subject → Ring[]` | `src/server.ts:962` (graph.rings, graph.ts:1867) | **MERGE** | `lookup transfers` | Same question, longer path. |
| `POST /match` | R | `plain facts → {candidates, notes}` | `src/server.ts:868` (server.ts factsIn → graph.match, graph.ts:1027) | **MERGE** | `lookup match` | Survives as a lookup kind. |
| `POST /find` | R | `{text} → {by, subjects}` | `src/server.ts:941` (server.ts find) | **MERGE** | `lookup find` | Survives as a lookup kind. |
| `GET /search` | R | `?q → Subject[]` | `src/server.ts:939` (graph.search, graph.ts:1748) | **MERGE** | `lookup find` | /find already falls back to it, without text in the URL. |
| `POST /call/ringing` | R | `{from?, to, at?} → Ringing` | `src/server.ts:877` (calls.ts ringing) | **MERGE** | `lookup caller` | A read. Nothing is written. |
| `POST /conflicts` | R | `{subjects} → {conflicts}` | `src/server.ts:872` (graph.conflicts, graph.ts:1051) | **MERGE** | `lookup conflicts` | Survives as a lookup kind. |
| `GET /outcome` | R | `?id → Counted + values or null` | `src/server.ts:1108` (graph.outcomeOf, graph.ts:1258) | **MERGE** | `lookup record` | Read back what you recorded, by type and key. |
| `GET /call` | R | `?id → KeptCall + state or null` | `src/server.ts:1145` (graph.keptCall, graph.ts:1300) | **MERGE** | `lookup record` | Same. |
| `GET /text` | R | `?id → KeptText + reply or null` | `src/server.ts:1067` (graph.keptText, graph.ts:1400) | **MERGE** | `lookup record` | Same. |
| `GET /conversion` | S | `?id → Job[]` | `src/server.ts:1204` (outbox.get) | **MERGE** | `lookup record` | Same. Must lose attempts, rev and due. |
| `GET /report` | R | `?from&to&tz&by&per → Report` | `src/server.ts:1181` (graph.report, graph.ts:1565) | **KEEP** | `report campaigns` | The business answer this package exists for. |
| `GET /board` | R | `?days → Board` | `src/server.ts:1121` (graph.board, graph.ts:1461) | **MERGE** | `report pipeline` | A report kind. |
| `GET /calls` | R | `?from&to&tz&after → page of missed calls` | `src/server.ts:1089` (graph.openCalls, graph.ts:1434) | **MERGE** | `report callbacks` | A report kind: who is owed a callback. |
| `GET /calls/summary` | R | `?from&to&tz → CallSummary` | `src/server.ts:1104` (graph.callSummary, graph.ts:1449) | **MERGE** | `report calls` | A report kind. |
| `GET /texts` | R | `?from&to&tz&after → page of unanswered texts` | `src/server.ts:1076` (graph.openTexts, graph.ts:1408) | **MERGE** | `report texts` | A report kind. |
| `GET /followed` | R | `?from&to&tz&step&days → Followed` | `src/server.ts:1140` (graph.followed, graph.ts:1497) | **MERGE** | `report after_calls` | A report kind. |
| `GET /conversions` | R | `?state → Job[] without keys` | `src/server.ts:1192` (outbox.list) | **MERGE** | `report deliveries` | A report kind: what did not reach a platform. |
| `GET /changes` | S | `?after&limit → ChangePage` | `src/server.ts:945` (graph.changes, graph.ts:1752) | **KEEP** | `events` | The only way a caller can follow along without missing anything. |
| `POST /retry` | R | `{transactionId, target?} → Job[]` | `src/server.ts:1198` (outbox.retry) | **INTERNALIZE** | `review API + CLI` | Outbox worker control. An operator presses it; a business backend does not. |
| `POST /rebuild` | S | `{by?, reason?} → Change[]` | `src/server.ts:1008` (graph.rebuild, graph.ts:2029) | **INTERNALIZE** | `CLI rebuild` | Administrative; blocks every other write while it runs. |
| `GET /verify` | S | `→ {changes, policy}` | `src/server.ts:1013` (graph.check, graph.ts:2109) | **INTERNALIZE** | `CLI verify` | Administrative full recompute. |
| `POST /prune` | S | `{before, by?, reason?} → {pruned}` | `src/server.ts:1019` (graph.prune, graph.ts:2042) | **INTERNALIZE** | `CLI prune` | Retention job, not a business call. |
| `GET /stats` | S | `→ process tally, counts, outbox counts` | `src/server.ts:1017` (server.ts tally, graph.counts, outbox.counts, graph.ts:1696) | **INTERNALIZE** | `CLI stats` | Process internals. |
| `POST /alerts/test` | S | `→ {delivered, error?}` | `src/server.ts:923` (ops.test) | **INTERNALIZE** | `CLI alerts test` | Setup check. |
| `POST /staff-link` | S | `{url, days?} → {url}` | `src/server.ts:1057` (sign.ts staffLink) | **INTERNALIZE** | `CLI staff-link` | Setup: marks an employee's browser. |
| `GET /links` | R | `?subject → Link[]` | `src/server.ts:964` (graph.links, graph.ts:1023) | **INTERNALIZE** | `review API subject` | Scores and identifiers are matching evidence. The subject view already has them. |
| `GET /between` | R | `?a&b → Between` | `src/server.ts:1114` (graph.between, graph.ts:1097) | **INTERNALIZE** | `CLI labels` | Only tools/labels.ts calls it. |
| `GET /me` | R | `→ {reviewer, retraction}` | `src/server.ts:916` (server.ts) | **EDGE-ISOLATE** | `/review/api/me` | Review screen only. |
| `GET /subject` | R | `?subject → everything the screen draws` | `src/server.ts:918` (server.ts profile) | **EDGE-ISOLATE** | `/review/api/subject` | Review screen only. |
| `GET /clusters` | R | `?offset → cluster list` | `src/server.ts:937` (graph.clusters, graph.ts:1704) | **EDGE-ISOLATE** | `/review/api/clusters` | Review screen only. |
| `GET /recent` | R | `→ Moved[]` | `src/server.ts:949` (graph.recent, graph.ts:1762) | **EDGE-ISOLATE** | `/review/api/recent` | Review screen only; callers use events. |
| `GET /undecided` | R | `?limit → Undecided` | `src/server.ts:1116` (graph.undecided, graph.ts:1766) | **EDGE-ISOLATE** | `/review/api/undecided` | Review queue. |
| `POST /foresee` | R | `Supposed → Foreseen` | `src/server.ts:943` (graph.foresee, graph.ts:1708) | **EDGE-ISOLATE** | `/review/api/foresee` | Preview inside the decision dialog. |
| `GET /decisions` | R | `?limit&before&author → {decisions, next, total}` | `src/server.ts:1023` (graph.decisionPage, graph.ts:2054) | **EDGE-ISOLATE** | `/review/api/decisions` | Audit view. |
| `GET /disputes` | R | `→ Verdict[]` | `src/server.ts:1035` (graph.disputes, graph.ts:2062) | **EDGE-ISOLATE** | `/review/api/disputes` | Health view. |
| `GET /audit` | R | `→ {sound, brokenAt?, head?}` | `src/server.ts:1037` (graph.audit, graph.ts:2070) | **EDGE-ISOLATE** | `/review/api/audit` | Health view; the head also goes out as an event. |
| `GET /policy` | R | `→ rules, hash, due` | `src/server.ts:1003` (graph.policy, graph.ts:2101) | **EDGE-ISOLATE** | `/review/api/policy` | Health view. |
| `GET /ops` | R | `→ feeds, jobs, alerts, pool, outbox` | `src/server.ts:920` (ops.state, graph.leasesAt, graph.ts:1354) | **EDGE-ISOLATE** | `/review/api/ops` | Health view. |
| `GET /pulse` | R | `ETag → {version} or 304` | `src/server.ts:926` (graph.version, graph.ts:1652) | **EDGE-ISOLATE** | `/review/api/pulse` | The screen's refresh heartbeat. |
| `POST /collect` | O | `{device, consent?, touch?, …} → 204` | `src/server.ts:421` (server.ts collect) | **EDGE-ISOLATE** | `POST /collect kind visit` | Browser ingestion. |
| `POST /event` | O | `{device, event, id?, number?} → 204` | `src/server.ts:345` (server.ts happened) | **EDGE-ISOLATE** | `POST /collect kind event` | Same gate, same caller as /collect. |
| `POST /carry` | O | `{device} → {token}` | `src/server.ts:771` (sign.ts signToken) | **EDGE-ISOLATE** | `POST /collect kind carry` | Same. |
| `POST /number` | O | `{device} → {number, until, lasts} or 204` | `src/server.ts:386` (server.ts number) | **EDGE-ISOLATE** | `POST /collect kind number` | Same. |
| `POST /text-code` | O | `{device} → {code} or 204` | `src/server.ts:404` (server.ts textCodeFor) | **EDGE-ISOLATE** | `POST /collect kind text_code` | Same. |
| `POST /calls/twilio` | T | `Twilio form → 204` | `src/server.ts:804` (twilio.ts twilioCall → calls.ts recordCall) | **EDGE-ISOLATE** | `POST /calls/twilio` | Provider webhook. Path stays: it is typed into Twilio's console. |
| `POST /texts/twilio` | T | `Twilio form → TwiML` | `src/server.ts:815` (twilio.ts twilioText → texts.ts recordText) | **EDGE-ISOLATE** | `POST /texts/twilio` | Same. |
| `GET /health` | none | `→ {ok}` | `src/server.ts:828` (graph.separations) | **EDGE-ISOLATE** | `GET /health` | Infrastructure probe. |
| `GET /collect.js` | none | `→ script` | `src/server.ts:834` (tag.ts browserScripts) | **EDGE-ISOLATE** | `GET /collect.js` | Script tag. |
| `GET /fingerprint.js` | none | `→ script` | `src/server.ts:834` (tag.ts browserScripts) | **EDGE-ISOLATE** | `GET /fingerprint.js` | Loaded by the script tag. |
| `GET /review` | none | `→ HTML shell` | `src/server.ts:841` (review.ts reviewPage) | **EDGE-ISOLATE** | `GET /review` | Reviewer screen. |

### 1.2 Root exports

| Exports of `.` | From | Bucket | Goes to | Why |
| --- | --- | --- | --- | --- |
| `createGraph`, `createMemoryStore`, `createOutbox`, `createMemoryOutbox`, `createBatcher`, `createAlerter`, `createOps`, `createHours` | `src/graph.ts`, `src/memory.ts`, `src/outbox.ts`, `src/batch.ts`, `src/alerts.ts`, `src/ops.ts`, `src/hours.ts` | **MERGE** | accountGraph(...) | Seven pieces a caller wires by hand today, plus a hand-built store. One factory takes their place. |
| `recordCall`, `recordCallResult`, `recordReturn`, `recordNotLead`, `recordText`, `withStage`, `knownLink` | `src/calls.ts`, `src/texts.ts`, `src/ladder.ts`, `src/sign.ts` | **MERGE** | record | Each is a write that becomes one record type. |
| `ringing` | `src/calls.ts` | **MERGE** | lookup | Becomes lookup kind caller. |
| `Outdated` | `src/graph.ts` | **MERGE** | decide / forget reason STALE | The idea survives; the class does not. In economy-edge a "no" is a value. |
| `defaultPolicy`, `policyFrom`, `policyHash`, `policyProblems` | `src/policy.ts` | **INTERNALIZE** | core/policy, set through options.policy | Policy stays configurable as plain JSON. |
| `components`, `partition`, `scorePairs` | `src/resolve.ts` | **INTERNALIZE** | core/resolve | Scoring helpers. |
| `birthKey`, `email`, `hashEmail`, `hashPhone`, `identifier`, `ip`, `nameKeys`, `normalizeEmail`, `normalizePhone`, `phone`, `phoneOfType` | `src/identifiers.ts` | **INTERNALIZE** | core/identifiers | Callers send plain facts; the graph hashes. One rule, one place. |
| `GoogleError`, `conversionEvent`, `googleClick`, `ingest`, `ingestRequest`, `googleAds` | `src/conversions.ts`, `src/targets.ts` | **INTERNALIZE** | providers/google | Platform wire format. |
| `MetaError`, `MicrosoftError`, `TikTokError`, `meta`, `metaEvent`, `microsoftAds`, `tiktok` | `src/targets.ts` | **INTERNALIZE** | providers/meta, microsoft, tiktok | Platform wire format. |
| `fit`, `measure` | `src/calibrate.ts` | **INTERNALIZE** | core/calibrate, used by tools/labels.ts | Offline tuning. |
| `brokenAt`, `seal` | `src/audit.ts` | **INTERNALIZE** | core/audit | Hash-chain internals. |
| `dayStart`, `dimension`, `fold`, `sourceOf` | `src/report.ts` | **INTERNALIZE** | core/report | Report arithmetic. |
| `callState`, `dialed`, `followUp` | `src/calls.ts` | **INTERNALIZE** | core/calls | Derived states arrive in answers. |
| `beginnings`, `codeIn`, `codeNote`, `replyTo`, `textCode`, `texted` | `src/texts.ts` | **INTERNALIZE** | core/texts | Parsing helpers. |
| `readToken`, `signToken`, `staffLink` | `src/sign.ts` | **INTERNALIZE** | edge/sign | Token primitives. |
| `ladderProblems`, `hoursProblems` | `src/ladder.ts`, `src/hours.ts` | **INTERNALIZE** | core/config | Checked when accountGraph() is constructed. |
| `Consent`, `Subject`, `Identifier`, `Level`, `Cost`, `Report`, `ReportRow`, `Journey`, `Entry`, `Person`, `Candidate`, `Conflict`, `Change`, `Cluster`, `Breakdown`, `StageCount`, `Delay`, `Reported`, `ValueChange`, `FollowUp`, `TextReply`, `SentLink`, `Tie`, `Transferred`, `Counterparty`, `Ring` (types) | `src/types.ts` | **KEEP** | public types | Kept as result types. Journey and Entry lose the fields server.ts already strips (src/server.ts:987). |
| `Call`, `CallFlag`, `CallOptions`, `CallState`, `Channel`, `RecordedCall`, `RecordedText`, `Text`, `TextFlag`, `TextOptions`, `Flow`, `NotLead`, `Loss`, `Observation`, `Outcome`, `Payment`, `Touch` (types) | `src/calls.ts`, `src/texts.ts`, `src/types.ts` | **MERGE** | RecordEntry variants | Folded into the record union and its values, or into options.phones. |
| `AttributeOptions`, `Board`, `BoardOptions`, `BoardRow`, `BoardColumn`, `BoardPlace`, `BoardStep`, `ReportOptions`, `CallCounts`, `CallSummary`, `Followed`, `FollowedGroup`, `FollowedRow`, `OpenCall`, `OpenText`, `Counted`, `OutcomeValue`, `KeptCall`, `KeptText`, `CallResult`, `ConsentAnswer`, `Attribution`, `AttributedTouch` (types) | `src/graph.ts`, `src/board.ts`, `src/callreport.ts`, `src/followed.ts`, `src/types.ts` | **MERGE** | lookup / report variants | Folded into lookup and report results. |
| `Deciding`, `Told`, `Recorded`, `Why`, `Sent`, `Decision` (types) | `src/types.ts`, `src/outbox.ts` | **MERGE** | decide / forget | Folded into DecideRequest, DecideValue and ForgetValue. |
| `ChangePage`, `NumberedChange`, `Moved` (types) | `src/types.ts` | **MERGE** | events | Folded into EventPage. |
| `GraphOptions`, `KnownLinkOptions`, `StaffLinkOptions`, `Ladder`, `Stage`, `AlertOptions`, `Hours`, `OpenHours`, `Policy`, `Rule`, `GoogleAdsOptions`, `MetaOptions`, `MicrosoftAdsOptions`, `TikTokOptions` (types) | `src/graph.ts`, `src/sign.ts`, `src/ladder.ts`, `src/alerts.ts`, `src/hours.ts`, `src/policy.ts`, `src/targets.ts` | **MERGE** | accountGraph options | Plain option fields. |
| `Graph`, `Between`, `Foreseen`, `PolicyState`, `Supposed`, `Undecided`, `Verdict`, `Link`, `Pair`, `Reason`, `Labels`, `IdentifierState`, `Sighting`, `Edge`, `Counts`, `CostRow`, `FlowEdge`, `CallTime`, `Labeled`, `Measured`, `Fitted` (types) | `src/graph.ts`, `src/types.ts`, `src/calibrate.ts` | **INTERNALIZE** | core | Row and scoring shapes. |
| `DecisionPage`, `Store`, `Tx` (types) | `src/store.ts` | **INTERNALIZE** | store | Storage internals. |
| `Item`, `Job`, `JobState`, `Outbox`, `OutboxOptions`, `OutboxStore`, `Pass`, `Target`, `Conversion`, `Destination`, `IngestRequest` (types) | `src/outbox.ts`, `src/conversions.ts` | **INTERNALIZE** | delivery | Worker internals. Target is decision D3. |
| `Batcher`, `Alerter`, `Feed`, `JobRun`, `KeptAlert`, `Ops`, `OpsOptions`, `OpsState`, `OpsStore` (types) | `src/batch.ts`, `src/alerts.ts`, `src/ops.ts` | **INTERNALIZE** | worker | Worker internals. |

`Outbox` is returned by `createOutbox`, so its 16 members are public too: `record`, `pay`, `restate`, `forget` (**MERGE** into `record` and `forget`); `get`, `list` (**MERGE** into `lookup record` and `report deliveries`); `hold`, `release`, `withdraw`, `takeBack`, `giveBack`, `run`, `start`, `retry`, `counts`, `retraction` (**INTERNALIZE**).

### 1.3 Subpath exports

| Subpath | File | Exports | Bucket | Goes to | Why |
| --- | --- | --- | --- | --- | --- |
| `./postgres` | `src/postgres.ts` | `Queryable`, `Pool`, `PostgresStore`, `createPostgresStore`, `upgrades`, `ddl` | **INTERNALIZE** | store/postgres | Reached only through databaseUrl. |
| `./server` | `src/server.ts` | `Reviewers`, `HandlerOptions`, `createHandler`, `networks`, `reviewerProblems` | **EDGE-ISOLATE** | ./edge | One edge factory in place of createHandler and its 24 options. |
| `./collect` | `src/collect.ts` | `CollectOptions`, `Collected`, `Arrival`, `deviceId`, `read`, `collect`, `EventDetail`, `event`, `watch`, `carry`, `fields`, `fill`, `withCode`, `texts`, `pool` | **EDGE-ISOLATE** | ./collect | Browser bundle. Stays its own subpath. |
| `./fingerprint` | `src/integrations/fingerprint.ts` | `FingerprintOptions`, `VerifiedFingerprint`, `FingerprintVerifier`, `createFingerprintVerifier`, `TrustOptions`, `trusted` | **INTERNALIZE** | ./edge option `fingerprint` | Provider wiring, used only by /collect. |
| `./fingerprint/browser` | `src/integrations/fingerprint-browser.ts` | `FingerprintAgentOptions`, `fingerprintEvent`, `openFingerprint` | **EDGE-ISOLATE** | ./collect | Browser code, folded into the browser bundle. |
| `./hardware` | `src/integrations/hardware.ts` | `machineId`, `hardwareId` | **EDGE-ISOLATE** | ./hardware | Runs in a desktop client, not in the backend. |
| `./maxmind` | `src/integrations/maxmind.ts` | `IpInfo`, `IpLookup`, `MaxMindOptions`, `createMaxMindLookup`, `Reader`, `createDatabaseLookup`, `shared`, `placeOf` | **INTERNALIZE** | ./edge option `maxmind` | Provider wiring, used only by /collect. |
| `./google-auth` | `src/integrations/google-auth.ts` | `ServiceAccount`, `TokenOptions`, `createGoogleTokens` | **INTERNALIZE** | ads.google option | Credential exchange. |
| `./serve` | `src/serve.ts` | `configFrom`, `Running`, `serve` | **INTERNALIZE** | bin only | Reads process.env; a program, not a library. |
| `./microsoft-auth` | `src/integrations/microsoft-auth.ts` | `MicrosoftTokenOptions`, `createMicrosoftTokens` | **INTERNALIZE** | ads.microsoft option | Credential exchange. |
| `./costs` | `src/integrations/costs.ts` | `CostSource`, `CostError`, `GoogleCostOptions`, `googleCosts`, `MetaCostOptions`, `metaCosts`, `costsFromCsv`, `parseCsv` | **INTERNALIZE** | costs option; CSV parsing in the CLI | Provider pulls. |
| `./smarty` | `src/integrations/smarty.ts` | `PostalAddress`, `VerifiedAddress`, `AddressVerifier`, `SmartyOptions`, `createAddressVerifier`, `addressIdentifier` | **INTERNALIZE** | checks.address option | Provider wiring. |
| `./twilio` | `src/integrations/twilio.ts` | `twilioSignature`, `fromTwilio`, `twilioCall`, `twilioText`, `LineType`, `LineTypeLookup`, `LookupOptions`, `createLineTypeLookup` | **EDGE-ISOLATE** | ./edge | Provider webhook codec; createLineTypeLookup becomes checks.lineType. |

### 1.4 Graph methods

Every one is public, because `createGraph` returns the whole interface.

| `Graph` methods (`src/graph.ts:128`) | Bucket | Becomes |
| --- | --- | --- |
| `observe` | **MERGE** | record profile |
| `touch` | **MERGE** | record arrival |
| `outcome` | **MERGE** | record conversion |
| `restate`, `withdraw`, `markNotLead` | **MERGE** | record restatement |
| `pay` | **MERGE** | record payment |
| `spend` | **MERGE** | record cost |
| `consent` | **MERGE** | record consent |
| `transfer` | **MERGE** | record transfer |
| `keepLink` | **MERGE** | record link |
| `keepCall`, `keepCallResult`, `keepReturn` | **MERGE** | record call / call_update |
| `keepText` | **MERGE** | record text |
| `ignore`, `separate`, `separateAll`, `join`, `joinAll` | **MERGE** | decide |
| `forget` | **KEEP** | forget |
| `cluster`, `people`, `attribute`, `texting`, `consentOf`, `consentHistory` | **MERGE** | lookup person |
| `journey`, `history`, `linksSent` | **MERGE** | lookup journey |
| `match`, `conflicts`, `search`, `clicked` | **MERGE** | lookup match, conflicts, find |
| `outcomeOf`, `values`, `keptCall`, `keptText`, `callResult`, `notLeads` | **MERGE** | lookup record |
| `flows`, `collusion`, `rings` | **MERGE** | lookup transfers |
| `report` | **KEEP** | report campaigns |
| `board`, `openCalls`, `openTexts`, `callSummary`, `followed` | **MERGE** | report (other kinds) |
| `changes` | **KEEP** | events |
| `clusters`, `recent`, `undecided`, `foresee`, `decisions`, `decisionPage`, `verdicts`, `disputes`, `audit`, `separations`, `links`, `between`, `version`, `policy` | **EDGE-ISOLATE** | review API (edge) |
| `followable`, `lease`, `leaseholder`, `leasesAt`, `linkOpened` | **EDGE-ISOLATE** | edge ingestion (pool, links, taps) |
| `holders`, `tieCall`, `callsOf`, `textsOf`, `counts`, `reviewed`, `asOf` | **INTERNALIZE** | core only |
| `rebuild`, `prune`, `verify`, `check` | **INTERNALIZE** | CLI |

### 1.5 Webhooks and callbacks

| Surface | Direction | Auth | Payload today | Delivery today | Bucket | Becomes |
| --- | --- | --- | --- | --- | --- | --- |
| `/collect`, `/event`, `/carry`, `/number`, `/text-code` | in, browsers | Origin list, rate limit | JSON as `text/plain` or JSON | — | **EDGE-ISOLATE** | `POST /collect`, by `kind` |
| `/calls/twilio`, `/texts/twilio` | in, Twilio | HMAC-SHA1 | Form fields | Twilio retries by its own rules | **EDGE-ISOLATE** | Same paths |
| Call tracking services | in, through your backend | Yours | `examples/call-tracking.ts` | Yours | — | `record call` |
| `CHANGE_WEBHOOK` | out | `x-account-graph-signature` when `CHANGE_SECRET` is set | `{ "changes": [...] }` | Once, awaited by the write | **MERGE** | `cluster.changed` |
| `ALERT_WEBHOOK` | out | None | `{ "text": "…" }` | Kept, retried every five minutes | **MERGE** | Seven other event types, and the Slack sink |
| Ad platforms | out | Each platform's | Platform format | Outbox | **INTERNALIZE** | `ads` option |
| `GraphOptions.onChange`, `OutboxOptions.onFailed` | in-process | — | `Change[]`, `Job[]` | Awaited after the write or pass | **INTERNALIZE** | `events` |

### 1.6 Environment reads

| Where | Read | Target |
| --- | --- | --- |
| `src/serve.ts:277` | `env: Env = process.env` as a default argument of an exported function | `src/bin.ts`, which is not exported |
| `src/serve.ts:50` | `configFrom`, exported on `./serve` | `src/bin.ts` |
| `src/integrations/hardware.ts:27` | `process.env.SystemRoot` | An optional argument, with `C:\Windows` as its default |

Nothing else under `src/` reads `process.env`. `examples/` and `tools/` do, and are programs. `docs/library.md` shows it in samples only.

### 1.7 Examples and tools

| Files | Uses today | After |
| --- | --- | --- |
| `examples/site.ts`, `examples/call-tracking.ts`, `tools/costs.ts` | Hand-written `fetch` | `accountGraph({ url, token })` |
| `examples/firm.ts`, `demo.ts` | `createGraph`, `createOutbox`, `createHandler`, `recordCall`, relative imports | `accountGraph` and `./edge`; stay in the repo |
| `bench.ts`, `tools/replay.ts`, `tools/labels.ts`, `tools/review-demo.ts`, `tools/browser-check.ts`, `tools/live-check.ts` | Internals through `../src` | Unchanged. They are repo tools, not callers. |
| `tools/export.ts` | Raw SQL over the tables | Becomes `account-graph export` |

## 2. Consolidation: before and after

### 2.1 By workflow

| Workflow | Before | After |
| --- | --- | --- |
| Account and profile updates | `/identify`, `/observe` | `record` `profile` |
| Ad arrivals | `/touch` | `record` `arrival` |
| Campaign costs | `/costs` | `record` `cost` |
| Conversions | `/convert` | `record` `conversion` |
| Restatements, refunds, not a lead | `/restate`, `/not-lead` | `record` `restatement` |
| Payments | `/payment` | `record` `payment` |
| Calls | `/call`, `/call/result` | `record` `call`, `call_update` |
| Callbacks | `/call/returned`, `/calls` | `record` `call_update`, `report` `callbacks` |
| Texts | `/text`, `/texts` | `record` `text`, `report` `texts` |
| Links to one person | `/link`, `/sent` | `record` `link`, `lookup` `journey` |
| Merges and splits | `/join`, `/separate`, `/ignore` | `decide` |
| Lookups | 20 routes | `lookup`, 8 kinds |
| Reports | `/report`, `/board`, `/calls`, `/calls/summary`, `/texts`, `/followed`, `/conversions` | `report`, 7 kinds |
| Consent | `/consent` both ways | `record` `consent`, `lookup` `person` |
| Deletion | `/forget`, two response shapes by flag | `forget`, one shape |
| Outbound webhooks and alerts | `CHANGE_WEBHOOK`, `ALERT_WEBHOOK`, `/changes` | `events` and one signed webhook, with a Slack sink |

### 2.2 What each merge changes

| Merge | What a caller notices |
| --- | --- |
| `/identify` + `/observe` | Raw identifiers go under `facts.identifiers`. A list is refused entry by entry. |
| `/restate` + `/not-lead` | One `change`, by `kind`. `at` orders them. A refund or write-off is an amount, where `/restate` takes what is left. |
| `/call/result` + `/call/returned` | One `change`, by `kind`. Either may still come before the call. |
| `/join` + `/separate` + `/ignore` | `merge`, `unmerge`, `split`, `unsplit`, `mute`, `unmute`. The join mark is found by the server and no longer returned. What did not come out as asked is in `notAsAsked`. Muting takes a fact. |
| `GET` reads to `POST` | Ids, phones and emails stay out of access logs, as `/find` already does. Browser caching is not lost: every answer is `no-store` today. |
| Change webhook + alerts | One envelope. `alerts.url` still receives `{ "text": "…" }`, so a Slack address keeps working. |

### 2.3 Deleted from the public surface

- **Command line only:** `account-graph rebuild`, `verify`, `prune`, `stats`, `retry`, `alerts test`, `staff-link`, `events new-epoch`, `export`, `labels`.
- **Review API only** (`/review/api/*`, reviewer token): `me`, `subject`, `clusters`, `recent`, `undecided`, `foresee`, `decisions`, `disputes`, `audit`, `policy`, `ops`, `pulse`, `retry`. The screen's other 13 calls use the six calls, and a reviewer's token opens only what the screen needs of them.
- **Gone:** `asOf` (no route, and no caller found outside tests and `bench.ts`), and the string form of `action`.

### 2.4 Keys: what exists and what must be built

A key is unique within its `type`, across the whole database and not per caller. Two systems that write here must prefix their own. Conversion keys may not begin with `call:`, `text:` or `page:`, because the graph's own outcomes use them.

| Entry | Key today | `KEY_REUSED` compares | Not compared |
| --- | --- | --- | --- |
| `conversion` | `transactionId` | subject, `at`, stage, value, currency, actions, email, phone, tags | What a stage fills in: settings change |
| `call` | Provider's id | direction, `to`, and `from` where both say it | `at`, duration, tags, result. A second reporter often knows more (R7). |
| `text` | Provider's id | direction, `from`, `to` | `at`: Twilio sends none, so it is the time of arrival (R7) |
| `payment`, `transfer` | Id | Everything | — |
| `cost` | None; rows by `(day, source, campaign_id)` | Everything | — |
| `link` | Random | subject, URL, expiry, purpose | — |
| `profile`, `arrival`, `restatement`, `call_update`, `consent`, `decide`, `forget` | None | Everything but `reason` text | — |

**Digest.** `HMAC-SHA256(receipt secret, canonical JSON of the compared fields)`.

| Step | Rule |
| --- | --- |
| 1 | Drop absent fields. Sort object keys. Write numbers one way (RFC 8785). |
| 2 | Normalize: `normalizeEmail`, phones to digits with a leading `+` kept, currency to upper case. No default country, because that is a setting. |
| 3 | Order what has no order: identifiers sorted and unique, a pair as `a < b`, pairs and cost rows sorted. |
| 4 | Keep `digest_version`. A digest of another version is not compared: the key counts as a duplicate and never as reused. |

The normalized form exists in memory only. The HMAC is needed as well as the normalizing: a plain hash of a phone can be found by trying them all.

```sql
create table receipt (
  type           text     not null,
  key_mac        bytea    not null,  -- HMAC-SHA256(secret, type || 0x00 || key). The key itself is never kept here.
  secret_id      text     not null,
  digest         bytea,              -- null once forgotten
  digest_version smallint,
  ref_type       text,               -- what a payment, restatement or call_update is about
  ref_mac        bytea,
  sent           jsonb,              -- forget only. Names no person.
  at             bigint   not null,
  recorded_at    bigint   not null,
  forgotten_at   bigint,
  primary key (type, key_mac)
);
create index receipt_ref on receipt (ref_type, ref_mac) where ref_mac is not null;
create table receipt_subject (
  type text not null, key_mac bytea not null, subject text not null,
  primary key (type, key_mac, subject),
  foreign key (type, key_mac) references receipt on delete cascade
);
create index receipt_subject_subject on receipt_subject (subject);
```

| Rule | Why |
| --- | --- |
| No answers are kept, apart from `sent`. A duplicate is answered from the graph as it stands. | An answer names other people's ids and holds signed links (R4). |
| A refusal leaves no receipt. | `UNKNOWN_REFERENCE` can be put right, and then the same key must work (R5). |
| Everything an entry writes, its receipt, jobs and events, is one transaction under the write lock. | Today a call is five or six transactions and a conversion's jobs are another (R1). |
| The receipt is read after the lock is taken. | Two identical calls at once both said `duplicate: false` today (R2). |
| `receiptSecrets` is its own setting. The first signs, and each is tried. | `identifierSecret` is optional, and changing it makes every key new (R3). |
| A process whose secrets do not cover every `secret_id` stored refuses to start: `CONFIG.MISMATCH`. | A dropped secret would forget every tombstone in silence. |

**`forget`**, in the deletion's own transaction:

1. Find every receipt of the subjects in `receipt_subject`, and every receipt whose `ref` is one of those.
2. Find the ids of their rows in `outcome`, `call`, `message`, `payment`, `transfer` and `sent_link`, read before `removeSubject` deletes them. These cover what was written before there were receipts.
3. For each: set `forgotten_at`, clear `digest`, `sent` and `ref`, delete its `receipt_subject` rows. Insert one where there was none.
4. Write the `forget` receipt with `sent`, at `pending` where a retraction will be asked for. The retraction comes after, and updates it.

A tombstone is then `type`, a keyed hash, and two times. The same `subject` may be written again with new keys.

## 3. Target contract

### 3.1 One entry point

```ts
import { accountGraph, hasCode, FAULT_CODES } from 'account-graph'

// Over HTTP.
const graph = accountGraph({ url: 'https://graph.example.org', token })

// In process, on PostgreSQL. Same type, same answers.
const graph = accountGraph({ databaseUrl, workers: true, receiptSecrets: [receiptSecret], identifierSecret, ads: { google }, webhook: { url, secret } })

// In process, in memory: tests, demo.ts, examples/firm.ts.
const graph = accountGraph({ memory: true })

const { results } = await graph.record({
  entries: [
    { type: 'profile', key: 'signup-1001', at, subject: 'contact:1001', facts: { email, phone, device } },
    { type: 'conversion', key: 'enroll-1001', at, subject: 'contact:1001', stage: 'enrolled', value: 200, currency: 'USD' },
  ],
})
for (const result of results) if (!result.ok) deadLetter(result.key, result.reason)

const { decisions } = await graph.lookup({ kind: 'person', subjects: ['contact:1', 'contact:2'], at })
const merged = await graph.decide({ key: 'ticket-88', at, by: 'dana', seen: decisions, action: 'merge', pairs: [{ a: 'contact:1', b: 'contact:2' }] })
if (!merged.ok && merged.reason === 'STALE') reload(merged.decision)

try {
  const { asOf, value } = await graph.report({ kind: 'campaigns', window: { from: '2026-11-01', to: '2026-11-14', timeZone: 'America/Chicago' } })
} catch (error) {
  if (hasCode(error, FAULT_CODES.TRANSPORT.INDETERMINATE)) retryLater()
  else throw error
}

await graph.close()
```

| Rule | Detail |
| --- | --- |
| No I/O in the factory | The first call connects and migrates. `migrate` is already safe from many processes (`src/postgres.ts:25`). |
| `pg` and `node:*` load on first local call | So the remote client runs anywhere `fetch` does. |
| Exactly one of `url`, `databaseUrl`, `memory` | Two do not compile. |
| `workers` is said | On by default, a script that runs for a second pulls costs. Off by default, nothing is ever sent. Costs, checks and webhook delivery each take a lease row, so many processes do each once. |
| Two database pools | One write connection per process, queued in the process, and a pool for reads (R15). Both pools, and every client while it is out, have an `error` listener (R14). |
| The database knows its settings | The policy, and an HMAC of a constant under `identifierSecret` and `linkSecret`, are kept. A process that differs gets `CONFIG.MISMATCH` on its first call (R16). |
| One boundary | A local call is validated by the same code and goes through the same JSON as a remote one. The answer is a fresh value (R18). |
| `close()` | New calls throw `GRAPH.CLOSED`. Accepted ones have 30 seconds. Then workers stop and connections close. |

The edge is separate, and needs a local instance:

```ts
import { createEdge } from 'account-graph/edge'

const edge = createEdge(graph, { token, reviewers, origins, twilio, fingerprint, maxmind, pool, events, cookie, trustProxy, limit, staffNetworks })
createServer(edge).listen(8080) // /v1/*, /collect, /collect.js, /calls/twilio, /texts/twilio, /review, /health
```

It reaches the core through a module-private `WeakMap` keyed by the instance. A remote instance throws `CONFIG.UNSUPPORTED`. `account-graph/testing` has `runWorkers(graph)`, one pass of every worker, because `examples/firm.ts` runs its outbox by hand.

### 3.2 HTTP

One rule: **`POST /v1/<call>`, the request is the argument, and the 200 body is the resolved value.** The route table is generated from the six names, so the two cannot drift.

| Call | Service token | Reviewer token |
| --- | --- | --- |
| `record`, `events` | Yes | 403 |
| `decide`, `forget` | Any `by` | Own name only |
| `lookup` | All kinds | `journey`, `find` |
| `report` | All kinds | All kinds |

```http
POST /v1/record
authorization: Bearer …
x-request-id: 7f1c

{ "entries": [{ "type": "restatement", "key": "refund-7", "at": 1795460000000,
                "of": { "type": "conversion", "key": "enroll-1001" },
                "change": { "kind": "refund", "amount": 80 } }] }
```

```json
{ "results": [{ "type": "restatement", "key": "refund-7", "ok": true,
    "value": { "duplicate": false, "stands": true, "counts": true, "value": 120,
               "deliveries": [{ "conversion": "enroll-1001", "platform": "google", "state": "pending", "note": "restated" }] } }] }
```

A domain "no" is 200, with `ok: false`:

```json
{ "results": [{ "type": "restatement", "key": "refund-8", "ok": false, "reason": "UNKNOWN_REFERENCE",
                "of": { "type": "conversion", "key": "nope" } }] }
```

A fault is not 200, and the client throws the same `Fault` the local instance would:

```json
{ "fault": { "code": "INPUT.MALFORMED", "message": "entries[0].at must be an integer in epoch milliseconds", "retryable": false, "detail": { "path": "entries[0].at" } } }
```

| Code | Status | Retryable | Local | Remote |
| --- | --- | --- | --- | --- |
| `INPUT.MALFORMED` | 400 | no | Validator, before anything | The same validator, before sending. `NaN`, `Infinity`, `bigint`, a `Date` or a lone surrogate never reach JSON. |
| `INPUT.TOO_LARGE` | 413 | no | Over 100 entries, or 1 MB as JSON | The same, before sending |
| `AUTH.REJECTED`, `AUTH.FORBIDDEN` | 401, 403 | no | Never: there is no token | From the server |
| `CONFIG.INVALID` | — | no | The factory | The factory; also a 404 or a redirect, which is a wrong `url`. Redirects are not followed: a POST would become a GET. |
| `CONFIG.MISMATCH` | 503 | no | Settings differ from the database's | From the server |
| `CONFIG.UNSUPPORTED` | 422 | no | A link with no `linkSecret`; `retract` where no platform can | From the server |
| `GRAPH.UNAVAILABLE` | 503 | yes | `ECONNREFUSED` and the like, SQLSTATE `08*`, `53*`, `57P*`, `40001`, `40P01`, `55P03`, before commit | From the server; also 429 and 503 from a proxy |
| `GRAPH.INTERNAL` | 500 | no | Everything else, a `TypeError` included. The cause is kept, the message is not. | From the server; also a 200 that is not JSON, on a read |
| `GRAPH.CLOSED` | — | no | After `close()` | After `close()` |
| `TRANSPORT.INDETERMINATE` | 504 | yes | The connection was lost during `commit`, or `timeoutMs` ran out after it began | No answer, `timeoutMs`, 502, 504, or a 200 to a write that cannot be read |
| `TRANSPORT.ABORTED` | — | no | Your `signal`. Effects unknown until you look. | The same |

**Batches.** At most 100 entries. They run one at a time, in order, one transaction each, and the lock is let go between them.

| Phase | Under the lock? | Detail |
| --- | --- | --- |
| Address and line checks | No | Before the first entry, at most 8 at once, 3 seconds each. One that fails is a note, as today. |
| Each entry | Yes | Its receipt, rows, jobs and events. |
| Deadline | — | Entries not begun when `timeoutMs` is nearly out answer `NOT_ATTEMPTED`. |

Put a `profile` before its `conversion`. The other way round, a worker may send the conversion in between, without the click (6.1).

If a fault ends a `record` part way, the entries before it stand. Send the whole list again: they answer `duplicate: true`.

**Order in time.** For `correct`, `not_lead`, `lead`, `call_update`, `consent` and a cost row, the newest by `at`, then by `key`, stands. One that arrives late is kept, changes nothing, and answers `stands: false`. Nothing is refused for being late.

**What a conversion is worth**, worked out from what is kept, so arrival order does not matter:

| If it has | Worth |
| --- | --- |
| A payment | Received less refunded payments, never below zero. Restatements of value say `PAID` and are ignored. |
| No payment | The newest `correct`, or else its first value, less every refund and write-off not reversed, never below zero |

### 3.3 Outbound webhook

```http
POST <webhook.url>
content-type: application/json
x-account-graph-signature: t=1795460000500,v1=<hex HMAC-SHA256 of "<t>.<body>">

{ "schemaVersion": 1, "cursor": "k3f9.4182", "more": false, "events": [
  { "schemaVersion": 1, "seq": 4181, "type": "cluster.changed", "at": 1795460000000,
    "data": { "subject": "account:42", "from": "account:42", "to": "account:17" } },
  { "schemaVersion": 1, "seq": 4182, "type": "callback.overdue", "at": 1795460000400,
    "data": { "call": "CA1", "subject": "caller:96f2", "missedAt": 1795373600000, "attempts": 1,
              "source": "google", "campaign": "Search: North", "campaignId": "20111" } }] }
```

```sql
create table event_head (one boolean primary key default true check (one), seq bigint not null, epoch text not null);
create table event (seq bigint primary key, type text not null, at bigint not null, data jsonb not null, subject text, said_once text unique);
create index event_subject on event (subject);
create table event_delivery (sink text primary key, seq bigint not null, lease_until bigint not null, due bigint not null, attempts int not null);

-- The last statement of a write that already holds the advisory lock.
-- $1 is a JSON array of events. One whose `said_once` is there already is left out of it before this.
with numbered as (update event_head set seq = seq + jsonb_array_length($1::jsonb) returning seq)
insert into event (seq, type, at, data, subject, said_once)
select numbered.seq - jsonb_array_length($1::jsonb) + e.nth, e.v->>'type', (e.v->>'at')::bigint, e.v->'data', e.v->>'subject', e.v->>'saidOnce'
from numbered, jsonb_array_elements($1::jsonb) with ordinality as e (v, nth);
```

| Rule | Detail |
| --- | --- |
| `seq` comes from a row, not a sequence | The row lock holds until commit, so no higher number is visible before a lower one, even from a writer that forgot the advisory lock. A rollback gives its number back. Tested (R12). |
| Alerts take the advisory lock | Today they are inserted outside it. Emitting is the last statement, so the two locks are always taken in one order. |
| `cursor` is `epoch.seq` | `account-graph events new-epoch` is run after a restore. A cursor of another epoch, or above `seq`, or older than what is kept, answers `CURSOR_LOST`: read everything again (R13). |
| Same body as `events` | One shape to parse. `events` is the truth, and the webhook says to look. |
| At least once, in order, one poster | A worker takes the `event_delivery` lease. At most 100 events and 10 seconds a post. |
| A receiver that keeps refusing | Retried for 24 hours with the outbox's backoff, said once at `alerts.url`, then skipped. `events` still has them. |
| Signed always | The signature format is today's. `webhook.secret` is required. |
| Deletion | `forget` deletes a subject's events, so `seq` has holes. A hole is not a loss. |

| Event | Replaces |
| --- | --- |
| `cluster.changed` | Change webhook, `GET /changes` |
| `conversion.failed` | "conversions rejected" alert, `onFailed` |
| `delivery.paused` | "outbox failed" alert |
| `delivery.late` | `LATE_HOURS` alert |
| `costs.failed` | "reading campaign costs failed" alert |
| `feed.quiet` | `QUIET_*` alerts |
| `callback.overdue` | `RETURN_HOURS` alert |
| `audit.head` | `AUDIT_HEAD_HOURS` message |

```ts
const raw = { headers: request.headers, body: rawBody }
if (!(await verifyWebhook(raw, { secret, now: Date.now(), maxAgeMs: 300_000 }))) return reject()
for (const event of parseWebhook(raw)) if (event.type === 'callback.overdue') page(event.data.call)
```

### 3.4 Signatures

Type-checked under `strict` and `exactOptionalPropertyTypes`. The calls in 3.1 compile, and eleven misuses do not: two stores at once, a missing `workers` or secret, a misspelled policy kind or field, a bad opening-hours span, a missing `at`, and a refund given as a value.

`unknown` is left in three places, as in economy-edge: the raw value of an unrecognized event, `Fault.detail`, and the argument of `isFault` and `hasCode`. Types not declared here are today's: `Change`, `Conflict`, `Consent`, `FollowUp`, `Level`, `Report`, `Ring`, `TextReply` and `Tie` from `src/types.ts`, `CallSummary` from `src/callreport.ts`, `Followed` from `src/followed.ts`.

```ts
// ── The interface. Local and remote implement exactly this. ──────────────────
export interface AccountGraph {
  record(request: RecordRequest, options?: CallOptions): Promise<RecordResponse>
  decide(request: DecideRequest, options?: CallOptions): Promise<Decided<DecideValue, DecideRefusal>>
  forget(request: ForgetRequest, options?: CallOptions): Promise<Decided<ForgetValue, ForgetRefusal>>
  lookup<Q extends LookupRequest>(request: Q, options?: CallOptions): Promise<LookupValue[Q['kind']]>
  report<Q extends ReportRequest>(request: Q, options?: CallOptions): Promise<{ readonly asOf: At; readonly value: ReportValue[Q['kind']] }>
  events(request: EventsRequest, options?: CallOptions): Promise<Outcome<EventPage, 'CURSOR_LOST'>>
  /** Refuses new calls, waits up to 30 seconds for those accepted, stops workers, closes connections. Safe to call twice. */
  close(): Promise<void>
}

/** Exactly economy-edge's src/ports/options.ts. `correlationId` travels as `x-request-id`. */
export interface CallOptions {
  readonly signal?: AbortSignal
  readonly correlationId?: string
}

/** Exactly economy-edge's src/canonical/outcome.ts. A domain "no" is a value. */
export type Outcome<T, E = string> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: E }
/** An Outcome whose "no" carries what that reason needs. */
export type Decided<T, R extends { readonly reason: string }> = { readonly ok: true; readonly value: T } | ({ readonly ok: false } & R)

/** Epoch milliseconds, an integer. Always given by the caller. Never defaulted. */
export type At = number

// ── record ───────────────────────────────────────────────────────────────────
export interface RecordRequest {
  /** 1 to 100. One at a time, in order, one transaction each. A later entry sees what an earlier one committed, and one refusal undoes nothing. */
  readonly entries: readonly RecordEntry[]
}

/** `key` is yours, 1 to 200 characters, and unique within its `type`. The graph never mints one. A `conversion` key may not begin with `call:`, `text:` or `page:`. */
interface Keyed<T extends string> {
  readonly type: T
  readonly key: string
  readonly at: At
}

export type RecordEntry =
  | ProfileEntry | ArrivalEntry | CostEntry | ConversionEntry | RestatementEntry | PaymentEntry
  | CallEntry | CallUpdateEntry | TextEntry | ConsentEntry | LinkEntry | TransferEntry

export interface ProfileEntry extends Keyed<'profile'> {
  readonly subject: string
  readonly facts: Facts
  readonly event?: string
}

/** Plain facts. The graph normalizes, checks and hashes them. At least one. */
export interface Facts {
  readonly email?: string
  readonly phone?: string
  readonly device?: string
  readonly ip?: string
  readonly address?: { readonly street: string; readonly street2?: string; readonly secondary?: string; readonly city?: string; readonly state?: string; readonly zipcode?: string }
  readonly name?: { readonly first: string; readonly last: string }
  readonly dob?: string
  /** Already `kind:value`: `hardware:…`, `passkey:…`, `payment:…`. Kinds the graph writes itself are refused: see KIND_RESERVED. */
  readonly identifiers?: readonly string[]
}

export interface ArrivalEntry extends Keyed<'arrival'> {
  readonly subject: string
  readonly source?: string
  readonly medium?: string
  readonly campaign?: string
  readonly campaignId?: string
  readonly adGroupId?: string
  readonly adId?: string
  readonly term?: string
  readonly content?: string
  readonly landing?: string
  readonly referrer?: string
  readonly clicks?: Partial<Record<'gclid' | 'gbraid' | 'wbraid' | 'fbclid' | 'fbp' | 'msclkid' | 'ttclid', string>>
  readonly custom?: Readonly<Record<string, string>>
}

/** `at` is when the platform was read. Per row, the newest `at` stands. No subject. */
export interface CostEntry extends Keyed<'cost'> {
  readonly rows: readonly {
    readonly day: string
    readonly source: string
    readonly amount: number
    readonly currency: string
    readonly campaignId?: string
    readonly campaign?: string
    readonly clicks?: number
    readonly impressions?: number
    readonly conversions?: number
    readonly conversionValue?: number
  }[]
}

/** `key` is the transaction id. */
export interface ConversionEntry extends Keyed<'conversion'> {
  readonly subject: string
  readonly stage: string
  readonly value?: number
  readonly currency?: string
  /** What it counts as on each platform. Left out, the stage's own. */
  readonly actions?: Readonly<Record<string, string>>
  readonly channel?: 'WEB' | 'APP' | 'IN_STORE' | 'PHONE' | 'MESSAGE' | 'OTHER'
  readonly email?: string
  readonly phone?: string
  readonly consent?: Consent
  readonly tags?: Readonly<Record<string, string>>
}

export interface RestatementEntry extends Keyed<'restatement'> {
  readonly of: { readonly type: 'conversion' | 'call' | 'text'; readonly key: string }
  readonly change:
    /** What it is worth. The newest by (`at`, `key`) stands. */
    | { readonly kind: 'correct'; readonly value: number; readonly currency?: string }
    /** How much was lost, not what is left, so the order they arrive in does not matter. */
    | { readonly kind: 'refund' | 'write_off'; readonly amount: number; readonly currency?: string }
    /** Takes back one earlier refund or write-off, by its key. */
    | { readonly kind: 'reverse'; readonly restatement: string }
    | { readonly kind: 'not_lead'; readonly why: 'spam' | 'other' }
    | { readonly kind: 'lead' }
}

/** May come before its conversion. Once there is one, the conversion is worth what was paid, and restatements of value are refused with PAID. */
export interface PaymentEntry extends Keyed<'payment'> {
  readonly conversion: string
  readonly direction: 'received' | 'refunded'
  readonly amount: number
  readonly currency?: string
}

export interface CallEntry extends Keyed<'call'> {
  readonly direction: 'inbound' | 'outbound'
  readonly from?: string
  readonly to: string
  readonly duration?: number
  readonly result?: CallResult
  readonly tags?: Readonly<Record<string, string>>
}

export interface CallResult {
  readonly answered: boolean
  readonly voicemail?: boolean
  readonly waited?: number
}

/** May come before its call. `at` is when it was said. The newest by (`at`, `key`) stands, whatever order they arrive in. */
export interface CallUpdateEntry extends Keyed<'call_update'> {
  readonly call: string
  readonly change: { readonly kind: 'result'; readonly result: CallResult } | { readonly kind: 'returned'; /** When they were reached, which is not when it was said. */ readonly reachedAt: At } | { readonly kind: 'not_returned' }
}

export interface TextEntry extends Keyed<'text'> {
  readonly direction: 'inbound' | 'outbound'
  readonly from: string
  readonly to: string
  /** Read for a code and for STOP. Never kept. */
  readonly text?: string
  readonly code?: string
  readonly tags?: Readonly<Record<string, string>>
}

export interface ConsentEntry extends Keyed<'consent'> {
  readonly subject: string
  readonly consent: Consent
  readonly source?: string
}

/** The same entry always gives the same URL. */
export interface LinkEntry extends Keyed<'link'> {
  readonly subject: string
  readonly url: string
  readonly expires: At
  readonly purpose?: string
}

export interface TransferEntry extends Keyed<'transfer'> {
  readonly from: string
  readonly to: string
  readonly amount: number
  readonly asset?: string
}

/** One per entry, in order. */
export interface RecordResponse {
  readonly results: readonly RecordResult[]
}
export type RecordResult = { [T in keyof RecordValue]: { readonly type: T; readonly key: string } & Decided<RecordValue[T] & Told, RecordRefusal> }[keyof RecordValue]
/** `duplicate`: the key was recorded before, and the rest says how it stands now. `stands`: false when something newer already does. */
interface Told {
  readonly duplicate: boolean
  readonly stands: boolean
}

export interface RecordValue {
  profile: { readonly changes: readonly Change[]; readonly notes: Readonly<Record<string, string>> }
  arrival: { readonly subject: string }
  cost: { readonly written: number; readonly older: number }
  conversion: { readonly value: number; readonly currency: string; readonly deliveries: readonly Delivery[] }
  restatement: { readonly counts: boolean; readonly value: number | null; readonly deliveries: readonly Delivery[] }
  payment: { readonly value: number | null; readonly deliveries: readonly Delivery[] }
  call: CallValue
  call_update: { readonly state: CallState; readonly counted: boolean; readonly followUp: FollowUp | null }
  text: { readonly subject: string; readonly flags: readonly string[]; readonly counted: boolean; readonly visitor?: string }
  consent: Readonly<Consent>
  link: { readonly url: string }
  transfer: { readonly relation: Level | 'none'; readonly score: number }
}
export interface CallValue {
  readonly subject: string
  readonly state: CallState
  readonly counted: boolean
  readonly flags: readonly string[]
  readonly visitor?: string
}
export type CallState = 'answered' | 'missed' | 'voicemail' | 'waiting' | 'unknown'

/** What a caller may know of an outbox job. No keys, attempts, rev or due. */
export interface Delivery {
  readonly conversion: string
  readonly platform: string
  readonly state: 'held' | 'pending' | 'sent' | 'skipped' | 'failed'
  readonly note?: string
}

/** None of these is kept with the key: put right what was wrong and send the same key again. */
export type RecordRefusal =
  /** The key was used for something else. `fields` names what differs, never its value. */
  | { readonly reason: 'KEY_REUSED'; readonly fields: readonly string[] }
  | { readonly reason: 'UNKNOWN_REFERENCE'; readonly of: { readonly type: 'conversion' | 'call' | 'text' | 'restatement'; readonly key: string } }
  | { readonly reason: 'KIND_NOT_IN_POLICY'; readonly kind: string }
  | { readonly reason: 'KIND_RESERVED'; readonly kind: string }
  | { readonly reason: 'CURRENCY_MISMATCH'; readonly expected: string }
  /** It has payments, so it is worth what was paid. */
  | { readonly reason: 'PAID' }
  /** The key, or what it is about, belongs to somebody who was deleted. */
  | { readonly reason: 'FORGOTTEN' }
  /** The deadline came first. Nothing was tried. */
  | { readonly reason: 'NOT_ATTEMPTED' }

// ── decide ───────────────────────────────────────────────────────────────────
interface Deciding {
  readonly key: string
  readonly at: At
  /** Required. With a reviewer's token it must be that reviewer. `system:…` needs the service token. */
  readonly by: string
  readonly reason?: string
  /** `decisions` from the lookup you decided by. A later decision about the same subjects refuses yours. Not an event `seq`. */
  readonly seen?: number
}
export type DecideRequest = Deciding &
  (
    | { readonly action: 'merge' | 'unmerge' | 'split' | 'unsplit'; /** 1 to 1,000, all or none. */ readonly pairs: readonly { readonly a: string; readonly b: string; readonly reason?: string }[] }
    | { readonly action: 'mute' | 'unmute'; readonly fact: { readonly email: string } | { readonly phone: string } | { readonly ip: string } | { readonly identifier: string } }
  )
export interface DecideValue {
  readonly duplicate: boolean
  readonly changes: readonly Change[]
  readonly recorded: number
  readonly already: number
  /** Pairs not as asked afterwards: a merge a split holds apart, or an unmerge that other evidence still joins. Use `split` to keep those apart. */
  readonly notAsAsked: readonly { readonly a: string; readonly b: string; readonly because: 'split' | 'evidence' | 'other_merges' }[]
}
export type DecideRefusal =
  /** A newer decision names them. `decision` is its number. */
  | { readonly reason: 'STALE'; readonly decision: number; readonly by: string | null; readonly at: At }
  | { readonly reason: 'KEY_REUSED'; readonly fields: readonly string[] }
  | { readonly reason: 'KIND_NOT_IN_POLICY'; readonly kind: string }
  /** `unmerge` only, and then none of the pairs is. `evidence`: joined by what they share, so there is no merge to take back. */
  | { readonly reason: 'NOT_JOINED'; readonly pairs: readonly { readonly a: string; readonly b: string; readonly because: 'apart' | 'evidence' | 'other_merges' }[] }
  | { readonly reason: 'FORGOTTEN' }

// ── forget ───────────────────────────────────────────────────────────────────
export interface ForgetRequest {
  readonly key: string
  readonly at: At
  readonly by: string
  readonly reason?: string
  readonly seen?: number
  /** 1 to 50, named one by one. All or none. */
  readonly subjects: readonly string[]
  /** `retract` also asks every platform that has a way to take its conversions back. */
  readonly platforms: 'report' | 'retract'
}
export interface ForgetValue {
  readonly duplicate: boolean
  readonly changes: readonly Change[]
  /** What had reached a platform. Kept with the key, so a lost answer can be asked for again. `pending`: a retraction is being asked for. */
  readonly sent: readonly { readonly conversion: string; readonly platform: string; readonly action: string; readonly at: At; readonly state: 'pending' | 'accepted' | 'rejected' | 'not_requested'; readonly note?: string }[]
}
export type ForgetRefusal = { readonly reason: 'STALE'; readonly decision: number; readonly by: string | null; readonly at: At } | { readonly reason: 'KEY_REUSED'; readonly fields: readonly string[] }

// ── lookup ───────────────────────────────────────────────────────────────────
export type LookupRequest =
  | { readonly kind: 'person'; /** 1 to 100. */ readonly subjects: readonly string[]; readonly at: At }
  | { readonly kind: 'journey'; readonly subject: string; readonly before?: number }
  | { readonly kind: 'find'; readonly text: string }
  | { readonly kind: 'match'; readonly facts: Facts; readonly at: At }
  | { readonly kind: 'caller'; readonly from?: string; readonly to: string; readonly at: At }
  | { readonly kind: 'conflicts'; /** 1 to 50. */ readonly subjects: readonly string[] }
  | { readonly kind: 'record'; readonly type: 'conversion' | 'call' | 'text'; readonly key: string; readonly at: At }
  | { readonly kind: 'transfers'; readonly subject: string; readonly tiedOnly?: boolean }

export interface LookupValue {
  /** `decisions` is the newest decision, read in the same snapshot. Pass it as `seen`. */
  person: { readonly decisions: number; readonly people: readonly Person[] }
  journey: { readonly subjects: Readonly<Record<string, Tie>>; readonly entries: readonly JourneyEntry[]; readonly next: number | null; readonly more: number }
  find: { readonly by: 'email' | 'phone' | 'click' | 'subject'; readonly subjects: readonly string[] }
  match: { readonly candidates: readonly Match[]; readonly notes: Readonly<Record<string, string>> }
  caller: { readonly subject: string | null; readonly area: string | null; readonly known: boolean; readonly people: readonly Match[]; readonly visitor: string | null; readonly waiting: boolean; readonly arrival: Arrival | null }
  conflicts: { readonly conflicts: readonly Conflict[] }
  record: RecordView | null
  transfers: { readonly counterparties: readonly Tied[]; readonly rings: readonly Ring[] }
}
/** Why is said by kind. No identifier leaves the graph, because most are hashes of an email or a phone. */
export interface Match {
  readonly subject: string
  readonly members: readonly string[]
  readonly score: number
  readonly level: Level
  readonly kinds: readonly string[]
  readonly conflict?: 'birth'
}
export interface Tied {
  readonly subject: string
  readonly asset: string
  readonly relation: Level | 'none'
  readonly score: number
  readonly kinds: readonly string[]
  readonly sent: number
  readonly received: number
  readonly count: number
  readonly imbalance: number
  readonly first: At
  readonly last: At
}
export type JourneyEntry = { readonly at: At; readonly subject: string } & (
  | { readonly kind: 'visit'; readonly arrival: Arrival }
  | { readonly kind: 'sighting'; readonly event: string; readonly kinds: readonly string[] }
  | { readonly kind: 'call'; readonly call: string; readonly direction: 'inbound' | 'outbound'; readonly state: CallState; readonly followUp: FollowUp | null; readonly notLead: 'spam' | 'other' | null }
  | { readonly kind: 'text'; readonly text: string; readonly direction: 'inbound' | 'outbound'; readonly reply: TextReply | null; readonly notLead: 'spam' | 'other' | null }
  | { readonly kind: 'link'; readonly link: string; readonly purpose: string | null; readonly opened: At | null; readonly openings: number }
  | { readonly kind: 'conversion'; readonly conversion: string; readonly stage: string; readonly value: number; readonly currency: string; readonly deliveries: readonly Delivery[]; readonly notLead: 'spam' | 'other' | null }
  | { readonly kind: 'value'; readonly conversion: string; readonly from: number; readonly to: number; readonly why: 'correct' | 'refund' | 'write_off' | 'reverse' | 'payment' }
  | { readonly kind: 'consent'; readonly consent: Readonly<Consent>; readonly source: string | null }
  | { readonly kind: 'decision'; readonly decision: number; readonly action: string; readonly by: string | null; readonly reason: string | null }
)
export interface Person {
  readonly subject: string
  readonly known: boolean
  readonly members: readonly string[]
  readonly oversized: boolean
  readonly arrival: Arrival | null
  readonly consent: Consent | null
  readonly textsOptedOut: boolean
}
export interface Arrival {
  readonly at: At
  readonly source: string
  readonly campaign: string | null
  readonly campaignId: string | null
  readonly landing: string | null
  readonly confidence: number
  readonly how: Tie['how']
}
export type RecordView =
  | { readonly type: 'conversion'; readonly subject: string; readonly at: At; readonly stage: string; readonly values: readonly { readonly value: number; readonly currency: string; readonly at: At; readonly kind?: 'refund' | 'write_off' }[]; readonly notLead: 'spam' | 'other' | null; readonly deliveries: readonly Delivery[] }
  | { readonly type: 'call'; readonly subject: string; readonly at: At; readonly direction: 'inbound' | 'outbound'; readonly state: CallState; readonly followUp: FollowUp | null; readonly notLead: 'spam' | 'other' | null }
  | { readonly type: 'text'; readonly subject: string; readonly at: At; readonly direction: 'inbound' | 'outbound'; readonly flags: readonly string[]; readonly reply: TextReply | null; readonly notLead: 'spam' | 'other' | null }

// ── report ───────────────────────────────────────────────────────────────────
/** Days, `YYYY-MM-DD`, in a named zone. The same shape as economy-edge's Window, with its zone said. An `at` within a minute of now is answered from the shared answer, whose moment is `asOf`. */
export interface Window {
  readonly from: string
  readonly to: string
  readonly timeZone: string
}
export type ReportRequest =
  | { readonly kind: 'campaigns'; readonly window: Window; readonly by?: string; readonly per?: string }
  | { readonly kind: 'pipeline'; readonly at: At; readonly days: number }
  | { readonly kind: 'calls'; readonly window: Window; readonly at: At }
  | { readonly kind: 'callbacks'; readonly window: Window; readonly at: At; readonly after?: string }
  | { readonly kind: 'texts'; readonly window: Window; readonly at: At; readonly after?: string }
  | { readonly kind: 'after_calls'; readonly window: Window; readonly at: At; readonly step: string; readonly days: number }
  | { readonly kind: 'deliveries'; readonly state: Delivery['state'] }

export interface ReportValue {
  campaigns: Report & { readonly timeZone: string; readonly steps: readonly string[] }
  pipeline: { readonly at: At; readonly day: string; readonly from: string; readonly unplaced: number; readonly columns: readonly PipelineColumn[] }
  calls: CallSummary
  callbacks: Page<{ readonly call: string; readonly subject: string; readonly at: At; readonly state: CallState; readonly attempts: number; readonly arrival: Arrival | null }>
  texts: Page<{ readonly text: string; readonly subject: string; readonly at: At; readonly unanswered: number; readonly arrival: Arrival | null }>
  after_calls: Followed
  deliveries: { readonly deliveries: readonly Delivery[] }
}
export interface PipelineColumn {
  /** Null for missed and not returned. */
  readonly step: string | null
  readonly wait: number | null
  readonly people: number
  readonly fresh: number
  readonly late: number | null
  readonly done: number | null
  readonly rows: readonly PipelineRow[]
}
export interface PipelineRow {
  readonly subject: string
  readonly at: At
  readonly late: boolean
  readonly step: string | null
  readonly value: number | null
  readonly currency: string | null
  readonly language: string | null
  readonly call: { readonly state: CallState; readonly direction: 'inbound' | 'outbound' } | null
  readonly arrival: Arrival | null
}
export interface Page<T> {
  readonly rows: readonly T[]
  readonly next: string | null
}

// ── events ───────────────────────────────────────────────────────────────────
export interface EventsRequest {
  /** `cursor` of the last page you acted on. Null to start. Opaque: it names this database's history as well as a place in it. */
  readonly after: string | null
  /** 1 to 1,000. */
  readonly limit: number
}
export interface EventPage {
  readonly schemaVersion: 1
  readonly events: readonly (GraphEvent | UnrecognizedEvent)[]
  readonly cursor: string
  readonly more: boolean
}
interface Event<T extends string, D> {
  readonly schemaVersion: 1
  readonly seq: number
  readonly type: T
  readonly at: At
  readonly data: D
}
/** From a newer server. Keep it, and move on. */
export interface UnrecognizedEvent {
  readonly schemaVersion: 1
  readonly seq: number
  readonly type: 'Unrecognized'
  readonly raw: unknown
}
export type GraphEvent =
  | Event<'cluster.changed', { readonly subject: string; readonly from: string | null; readonly to: string | null }>
  | Event<'conversion.failed', { readonly conversion: string; readonly platform: string; readonly note: string }>
  | Event<'delivery.paused', { readonly reason: string }>
  | Event<'delivery.late', { readonly oldestDue: At }>
  | Event<'costs.failed', { readonly source: string; readonly reason: string }>
  | Event<'feed.quiet', { readonly feed: 'touches' | 'calls' | 'results' | 'costs'; readonly last: At | null; readonly hours: number }>
  | Event<'callback.overdue', { readonly call: string; readonly subject: string; readonly missedAt: At; readonly attempts: number; readonly source: string; readonly campaign: string | null; readonly campaignId: string | null }>
  | Event<'audit.head', { readonly seq: number; readonly hash: string; readonly sound: boolean; readonly brokenAt: number | null }>

// ── webhooks ─────────────────────────────────────────────────────────────────
export interface RawWebhook {
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}
/** Never throws on what was sent. False: reject the request. `now` and `maxAgeMs` are yours. */
export declare function verifyWebhook(webhook: RawWebhook, options: { readonly secret: string; readonly now: At; readonly maxAgeMs: number }): Promise<boolean>
/** Pure and total. What it does not know comes back as Unrecognized, with the raw value. */
export declare function parseWebhook(webhook: RawWebhook): readonly (GraphEvent | UnrecognizedEvent)[]

// ── faults ───────────────────────────────────────────────────────────────────
export interface Fault extends Error {
  readonly code: FaultCode
  readonly retryable: boolean
  readonly detail: Readonly<Record<string, unknown>>
}
export declare const FAULT_CODES: {
  readonly INPUT: { readonly MALFORMED: 'INPUT.MALFORMED'; readonly TOO_LARGE: 'INPUT.TOO_LARGE' }
  readonly AUTH: { readonly REJECTED: 'AUTH.REJECTED'; readonly FORBIDDEN: 'AUTH.FORBIDDEN' }
  readonly CONFIG: { readonly INVALID: 'CONFIG.INVALID'; readonly MISMATCH: 'CONFIG.MISMATCH'; readonly UNSUPPORTED: 'CONFIG.UNSUPPORTED' }
  readonly GRAPH: { readonly UNAVAILABLE: 'GRAPH.UNAVAILABLE'; readonly INTERNAL: 'GRAPH.INTERNAL'; readonly CLOSED: 'GRAPH.CLOSED' }
  readonly TRANSPORT: { readonly INDETERMINATE: 'TRANSPORT.INDETERMINATE'; readonly ABORTED: 'TRANSPORT.ABORTED' }
}
type Leaf<T> = T[keyof T]
export type FaultCode = Leaf<{ [N in keyof typeof FAULT_CODES]: Leaf<(typeof FAULT_CODES)[N]> }>
export declare function isFault(error: unknown): error is Fault
export declare function hasCode(error: unknown, code: FaultCode): error is Fault

// ── the factory ──────────────────────────────────────────────────────────────
/** Synchronous, and does no I/O. Throws CONFIG.INVALID naming everything wrong at once. */
export declare function accountGraph(options: RemoteOptions | LocalOptions): AccountGraph

interface Common {
  /** How long one call may take, waiting for the write lock included. Defaults to 30,000. */
  readonly timeoutMs?: number
}
export interface RemoteOptions extends Common {
  readonly url: string
  readonly token: string
  readonly fetch?: typeof fetch
  readonly databaseUrl?: never
  readonly memory?: never
}
/** One of two places to keep it. Everything else is the same. */
export type LocalOptions = LocalSettings & (InPostgres | InMemory)
interface InPostgres {
  readonly databaseUrl: string
  readonly schema?: string
  /** Whether this process sends conversions, pulls costs and delivers events. Said, not defaulted: either default is a trap. */
  readonly workers: boolean
  /** Keys the receipts. The first signs and all are tried. At least 32 characters each. One that rows still name may not be dropped. */
  readonly receiptSecrets: readonly [string, ...string[]]
  readonly memory?: never
  readonly url?: never
}
interface InMemory {
  readonly memory: true
  readonly workers?: boolean
  readonly databaseUrl?: never
  readonly url?: never
}
interface LocalSettings extends Common {
  /** Left out, the policy the database was built with. One that differs throws CONFIG.MISMATCH until `account-graph rebuild`. */
  readonly policy?: PolicyOptions
  readonly identifierSecret?: string
  readonly linkSecret?: string
  readonly timeZone?: string
  readonly openHours?: OpenHours
  readonly stages?: Readonly<Record<string, { readonly value?: number; readonly currency?: string; readonly action?: Readonly<Record<string, string>>; readonly wait?: number }>>
  readonly phones?: {
    readonly numbers?: Readonly<Record<string, { readonly source: string; readonly medium?: string; readonly campaign?: string; readonly campaignId?: string; readonly tags?: Readonly<Record<string, string>> }>>
    readonly exclude?: readonly string[]
    readonly minimumSeconds?: number
    readonly resultsExpectedWithinMinutes?: number
    readonly returnHours?: number
  }
  readonly ads?: {
    readonly google?: { readonly customerId: string; readonly loginCustomerId?: string; readonly serviceAccount: GoogleServiceAccount }
    readonly meta?: { readonly pixelId: string; readonly accessToken: string; readonly siteUrl: string; readonly testEventCode?: string }
    readonly microsoft?: { readonly clientId: string; readonly refreshToken: string; readonly developerToken: string; readonly customerId: string; readonly accountId: string; readonly clientSecret?: string }
    readonly tiktok?: { readonly pixelCode: string; readonly accessToken: string; readonly siteUrl: string }
    readonly retractOnForget?: boolean
    readonly delayMs?: number
  }
  readonly costs?: {
    readonly google?: { readonly customerId: string; readonly developerToken: string; readonly loginCustomerId?: string; readonly serviceAccount: GoogleServiceAccount; readonly conversions?: boolean }
    readonly meta?: { readonly adAccountId: string; readonly accessToken: string; readonly conversions?: string }
  }
  readonly checks?: {
    readonly address?: { readonly authId: string; readonly authToken: string }
    readonly lineType?: { readonly accountSid: string; readonly authToken: string }
  }
  readonly monitor?: { readonly quietHours?: Partial<Record<'touches' | 'calls' | 'results' | 'costs', number>>; readonly lateHours?: number; readonly auditHours?: number }
  readonly webhook?: { readonly url: string; readonly secret: string }
  /** A Slack-style `{ text }` address. The same events, written as sentences. */
  readonly alerts?: { readonly url: string }
  readonly now?: () => At
}

export interface GoogleServiceAccount {
  readonly client_email: string
  readonly private_key: string
}
type Span = `${number}:${number}-${number}:${number}`
export interface OpenHours extends Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', readonly Span[]>> {
  readonly holidays?: readonly ('us' | 'us-tx' | `${number}-${number}-${number}`)[]
  readonly timeZone?: string
}
export interface RuleOptions {
  readonly weight: number
  readonly dilution: number
  readonly cap: number
  readonly halfLife: number | 'none'
  readonly group?: string
  readonly corroborates?: true
}
export type BuiltInKind = 'review' | 'passkey' | 'email' | 'phone' | 'voip' | 'address' | 'payment' | 'device' | 'ga' | 'hardware' | 'fingerprint' | 'canvas' | 'ip' | 'link' | 'carry' | 'opened' | 'lease' | 'dial' | 'text' | 'place' | 'birth' | 'dialed'
export interface PolicyOptions {
  readonly same?: number
  readonly related?: number
  readonly bridge?: number
  readonly review?: number
  readonly apart?: readonly 'birth'[]
  /** Only what differs. A misspelled kind or field does not compile. */
  readonly kinds?: { readonly [K in BuiltInKind]?: Partial<RuleOptions> }
  /** Kinds of your own, said in full. */
  readonly customKinds?: Readonly<Record<string, RuleOptions>>
}
```

### 3.5 `package.json`

```json
{
  "bin": { "account-graph": "./dist/bin.js" },
  "imports": { "#src/*": "./src/*" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./edge": { "types": "./dist/edge/index.d.ts", "default": "./dist/edge/index.js" },
    "./collect": { "types": "./dist/edge/browser.d.ts", "default": "./dist/edge/browser.js" },
    "./hardware": { "types": "./dist/edge/hardware.d.ts", "default": "./dist/edge/hardware.js" },
    "./testing": { "types": "./dist/testing/index.d.ts", "default": "./dist/testing/index.js" },
    "./package.json": "./package.json"
  }
}
```

| Subpath | Runs in | Exports |
| --- | --- | --- |
| `.` | Your backend | Values: `accountGraph`, `verifyWebhook`, `parseWebhook`, `isFault`, `hasCode`, `FAULT_CODES`. Types: the contract. |
| `./edge` | The server | `createEdge`, `EdgeOptions` |
| `./collect` | Browsers | Today's, with the two fingerprint helpers |
| `./hardware` | Desktop clients | `hardwareId` (`machineId` goes inside) |
| `./testing` | Tests and demos | `runWorkers`. economy-edge has the same subpath. |

Root values go from 70 to 6. `exports` already blocks any path not listed, so today's leak is what is listed, not deep imports.

### 3.6 Layout that keeps it so

| Ring | Holds | May import |
| --- | --- | --- |
| `contract/` | Types, `Outcome`, faults, validator, canonical JSON, webhook codec | `contract` |
| `core/` | Graph, policy, resolve, calls, texts, report, and what `createHandler` does with facts today | `contract`, `core` |
| `store/` | Postgres, memory | `core`, `contract` |
| `providers/` | Ad platforms, Smarty, MaxMind, Twilio, Fingerprint | `core`, `contract` |
| `client/` | Local and remote `accountGraph` | all above |
| `edge/`, `testing/` | `/v1`, browsers, Twilio webhooks, review; `runWorkers` | all above |
| `bin.ts` | Environment, command line | all |

Three tests hold it, the first modelled on economy-edge's `test/arch.test.ts`:

1. Every import points inward, and `process.env` appears only in `src/bin.ts`.
2. One contract suite runs the same cases, faults included, in memory, on PostgreSQL and through HTTP, and compares the answers.
3. One type file holds the calls that must compile and those that must not.

## 4. Order of work

Each step lands alone and keeps the tests passing. Baseline: 261 pass and 1 skipped in memory, 416 pass on PostgreSQL 16.

**All steps are done**, on the branch `feat/six-calls`. Section 7 has what was built and where it differs from this page.

| Step | Change | Done when | Risk |
| --- | --- | --- | --- |
| 0a | Listen for `error` on the pool and on each client while it is out (R14) | A test ends an idle and a busy connection, and the server answers after | Low. Live bug: the server exits. |
| 0b | Key page events as `page:…`, and refuse `call:`, `text:` and `page:` from callers (R8) | The probe in R8 records the backend's conversion | Low. Live bug. Old rows keep their keys. Deploy: a page event already counted that day can count once more. |
| 1 | `Fault`, `Outcome`, `Decided`, the validator and canonical JSON. Only a `Fault` is a 400; any other error is a 500. | The contract suite's error table passes for what exists | **Medium, was Low.** There are 148 `throw new TypeError` in `src/` and 98 lines of tests that name `TypeError`. Missing one turns a 400 into a 500. |
| 2 | Strip `keys` from four routes (finding 8) | Done | Done |
| 3 | Move `convert`, `calling`, `textOptions`, `factsIn`, `find` out of `src/server.ts` into `core/` | No test changes, and `arch.test.ts` passes for `core/` | Medium. No behaviour change, much code. |
| 4a | One transaction per entry: `recordCall`, `recordText`, `convert`, `pay` and `restate` on `Tx`; `Tx.addJob`; checks before the lock (R1, R6, R6a) | A fault injected at every statement leaves all or nothing. `forget` at every pause leaves no trace. | **High, was not listed.** Step 4 is not possible without it. |
| 4b | Values and results worked out from kept entries: restatements, call updates, not-a-lead, cost rows (R9, R10) | Every order of every set of up to five entries gives one answer | High. Migrates `outcome_value`, `call_result`, `not_lead`, `cost`. |
| 4c | `receipt`, `receipt_subject`, digest, tombstones, settings kept in the database (R2–R5, R7, R16) | Property test: key order, casing and list order never give `KEY_REUSED`; a changed field always does. A dump after `forget` holds no key, subject or digest. | High |
| 5 | `event_head`, `event`, `event_delivery`; alerts under the lock; copy `change` in id order (R12, R13) | 12 writers, one of them without the lock, rollbacks and a poller: none missed | High. Cursors of `GET /changes` are lost: start again. |
| 6a | `unmerge`, `NOT_JOINED`, `notAsAsked`, a new `unjoin` decision (R11) | **First**, the eight traces in R11 as a test on both stores | Medium. The review screen and `verdictsOf` must know `unjoin`. |
| 6b | `accountGraph` remote, PostgreSQL and memory; two pools; deadlines; `/v1`; shared report answers (R15, R17, R18) | The contract suite on all three | Medium |
| 7 | `/review/api`, `createEdge`, `POST /collect` by `kind` | The review browser test passes | Medium. `./collect` and the server must ship together. A cached script lives five minutes (`src/tag.ts`), so keep the old browser paths for one release. |
| 8 | `bin.ts` commands, delete old routes and exports, rewrite `docs/http.md` and `docs/library.md`, `.github/nuclei/urls.txt` | No old route answers | Low |

## 5. Not verified

- Written before anything was built. Section 7 has what was verified since.
- Findings in section 1 marked **run** used the memory store. Section 6 used both, and says which.
- Section 6's timings are from one laptop and a database with a few thousand rows. They compare shapes and predict nothing about yours.
- What a receipt costs each write was not measured. It adds a read and two inserts. Step 4a takes a call from five or six commits to one, which should more than pay for it.
- Copying `change` into `event` was not timed on a large table.
- Callers were searched for on this machine only.

## 6. Red-Team Design Review & Fixes

Run 2026-11-24 against the code at `99e4779` with finding 8 fixed, on the memory store and on a throwaway PostgreSQL 16.14. Scripts were kept outside the repo. No source file was changed.

**The design as first written would have lost data.** 30 flaws were found. Seven are in the server today: R2, R6a, R8, R14, R15, R18 over HTTP, and trace 8 of R11. R8 and R14 should not wait for this work. Sections 2.4, 3 and 4 above already contain every fix.

### 6.1 Where the review brief was right, and where it was not

| Claim in the brief | Finding |
| --- | --- |
| Key order and casing give a false `KEY_REUSED` | **Right.** 2.4 did not define the digest. |
| Digest before salted hashing | **Half right.** Normalize first, yes. But an unkeyed digest of a phone can be searched, so it must be an HMAC. |
| Tombstone every receipt of the subject | **Right**, and not enough: payments, restatements and call updates name no subject, and older rows have no receipt. |
| Key tombstones with `identifierSecret` | **Wrong secret.** It is optional, and its own comment says changing it makes every key new (`src/server.ts:132`). One rotation would undo every tombstone. A separate `receiptSecrets` list is used. |
| A conversion after its profile may miss the click | **Not so.** Credit is worked out when a conversion is sent or reported, not when it is recorded. Run: profile first, credited. Conversion first is only wrong if a worker runs in between. |
| Cap batches at 100 | **Right.** See R6. |
| `+` is a transitive suffix | **Wrong.** It is only added when some subject already holds the name (`src/graph.ts:1643`). It means nothing about who is joined. |
| `unmerge` needs `NOT_JOINED` | **Right.** |
| A poller can skip a number | **Right for alerts, not for today's change feed.** `change` rows are numbered under the write lock, and none of 80 was missed. Alerts are written outside it. Putting both in one table would have opened the gap. |
| "Without touching the core engine" | **Wrong.** Steps 4a and 4b rewrite how calls, texts, conversions and values are written. Section 4 now says so. |

### 6.2 Receipts and idempotency

| # | Scenario | Section | Evidence | Fix |
| --- | --- | --- | --- | --- |
| R1 | **A retry is told "duplicate" and the delivery never exists.** The outcome commits, the process dies, its job was never added. Today a retry adds it. With a receipt in the first transaction, the retry stops there for good. | 2.4 "written in the same transaction" | Memory: after a failed add, outcome kept and 0 jobs; retry made 1. PostgreSQL: a call is 5 transactions, or 6 with a channel; jobs go through the pool, outside all of them. | One transaction per entry, with `Tx.addJob`. Step 4a. |
| R2 | **Two identical requests at once both write.** | 2.4 | PostgreSQL: two calls with one id both answered `duplicate: false` and left four sightings. Two equal arrivals left two rows. | Read the receipt after taking the lock |
| R3 | **Rotating a secret brings the deleted back.** | D5, 2.4 | Read: `identifierSecret` comment | `receiptSecrets`, tried in turn; refuse to start without one that rows name |
| R4 | **`forget` leaves the person in other people's receipts.** A kept answer lists the subjects that moved, and a link's answer is a token that names its person. | 2.4 `answer` | Read: `Change` names `from` and `to` | Keep no answers. Duplicates are answered from the graph. |
| R5 | **A refusal is final.** `UNKNOWN_REFERENCE` kept with its key would refuse the same key after the conversion arrives. | 2.4 | By design | Refusals leave no receipt |
| R7 | **False `KEY_REUSED` on ordinary calls and texts.** Twilio's text webhook has no time, so a retry has another `at`. A backend and Twilio both report one call, with different details. | 2.4, 3.4 | Read: `twilioText(fields, now())`. Memory: a second, fuller report of a call is accepted today. | Compare by type: the table in 2.4 |
| R8 | **A browser can take a backend's key. Live today.** Page events are keyed `event:device:id`, and the browser chooses `device` and `id`. | 2.4 | Memory, over HTTP: `POST /event` from a page recorded `signup:1001:1` at value 0. The backend's `/convert` of that id for 250 answered 200 and was ignored. Needs `signup` in `EVENTS`, no value on that step, and a key that can be guessed. | `page:` prefix, refused from callers. Step 0b. |

`forget` during a record is the same family:

| # | Scenario | Section | Evidence | Fix |
| --- | --- | --- | --- | --- |
| R6a | **`forget` between two steps of a call brings the caller back.** Live today. | D5 | Memory: forgotten in the `hold` step, then the cluster, the call and its outcome all existed again | Step 4a. The tombstone is read in the same transaction as the write. |

### 6.3 Batches and the lock

Time for one visit, sent every 10 ms, while a batch ran (PostgreSQL, milliseconds):

| Batch | p50 | p95 | Worst |
| --- | --- | --- | --- |
| None | 2 | 5 | 6 |
| 100, one transaction each | 2 | 4 | 6 |
| 100 in one transaction | 2 | 8 | 16 |
| 500 in one transaction | 3 | 67 | 74 |
| 500, one transaction each | 3 | 61 | 93 |

| # | Scenario | Section | Evidence | Fix |
| --- | --- | --- | --- | --- |
| R6 | **500 entries hold up visits and Twilio.** Address and line checks would also run one after another: each may take ten seconds (`AbortSignal.timeout(10_000)` in `src/integrations/twilio.ts`), so a batch outlives its own request. | 3.4 "1 to 500" | The table above | At most 100. Checks before the lock, 8 at once, 3 seconds each. A deadline, then `NOT_ATTEMPTED`. |
| R15 | **Writers waiting for the lock hold every connection.** Reads, `/health` among them, then wait for a write they have nothing to do with. Live today. | 3.1 | PostgreSQL: 12 writers behind a held lock and a pool of 10. A read of one cluster took 1,511 ms of the 1,500 ms the lock was held. | One write connection per process, queued in the process, and a pool for reads |
| R17 | **A local caller waits for ever behind `rebuild`.** The remote one has `timeoutMs`. | 3.4 | PostgreSQL: `lock_timeout` ends the wait with `55P03` | `timeoutMs` on both, set as `lock_timeout` |

### 6.4 Order and state

| # | Scenario | Section | Evidence | Fix |
| --- | --- | --- | --- | --- |
| R9 | **Money depends on arrival.** Refund to 50 then write off to 30 keeps both. The other way, the refund is refused. Pay 40, correct to 70, pay 10 is worth 50. Pay 40, pay 10, correct to 70 is worth 70. `SUPERSEDED` would have made it worse, by dropping a late refund. | 3.4 `RestatementEntry` | Memory | Losses are amounts. Payments win. Worth is worked out from what is kept. `SUPERSEDED` is gone. |
| R10 | **Two clocks in one field.** `returned` used `at` for when the caller was reached, and `not_returned` for when it was said. Results were last to arrive: answered, then a late "not answered", uncounts the call and leaves `waited: 9` beside voicemail. | 3.4 `CallUpdateEntry` | Memory | `reachedAt`. `at` is when it was said. Newest `(at, key)` stands, and a result counts whole. |
| R10a | **Equal `at` has no order.** | 3.4 | By design | `key` breaks the tie, by bytes |
| R11 | **`unmerge` was not defined.** The traces are below. | 5 | Memory | The rule below |
| R19 | **`seen` pointed at the wrong numbers.** 3.4 said "the newest event". `STALE` compares decision numbers, and a decision that moves nobody makes no event. Every check would have been wrong. | 3.4 `Deciding` | Read: `current`, `newestNaming` | `lookup person` gives `decisions`, read in the same snapshot |

**Traces of taking a join back**, with today's marks:

| # | Set up | Mute the mark of a, b | Meaning |
| --- | --- | --- | --- |
| 1 | a+b joined, a stranger holds `review:join-1` | Mark is `review:join-1+`. a and b part. | The suffix is only a free name |
| 2 | a+b, then b+c | a alone, b+c together | c stays with b |
| 3 | a+b, b+c, a+c | All three still together | Needs `notAsAsked`, `other_merges` |
| 4 | a+b joined twice | Still together until both marks are muted | All shared marks must go |
| 5 | a and b share a hardware id, never joined | There is no mark | `NOT_JOINED`, `evidence` |
| 6 | The same, and joined | Still together | `notAsAsked`, `evidence` |
| 7 | a+b merged over a standing split | Recorded, not together | `notAsAsked`, `split` |
| 8 | A caller writes `review:mine` on three subjects | All three join, with no decision logged | **Live today.** `KIND_RESERVED` |

**The rule.** Under the lock, for each pair, take the unmuted `review:join-…` identifiers both hold. That is how `standing` already finds them (`src/graph.ts`), and it needs no decision number. With none on any pair, refuse all: `NOT_JOINED`. Otherwise mute every one, and write one `unjoin` decision about the pair. Then compare clusters and fill `notAsAsked`. `unjoin` is new because today's entry is an `ignore` of a mark: the record still says the last decision about the pair was a join.

Reserved kinds, refused in `facts.identifiers`: `review`, `link`, `carry`, `opened`, `lease`, `dial`, `text`, `place`, `birth`, `dialed`.

**Before the parent:** a payment, a call update and `not_lead` are kept and wait, as today. A value restatement is refused with `UNKNOWN_REFERENCE`, leaves no receipt, and works later with the same key. Kept instead, a mistyped id would never be noticed (finding 6).

### 6.5 PostgreSQL

| # | Scenario | Section | Evidence | Fix |
| --- | --- | --- | --- | --- |
| R12 | **A poller skips an event for good.** A holds number 1 and has not committed. B commits 2. The poller keeps 2 and never sees 1. | 3.3 | PostgreSQL, both ways: an identity column without the lock, and an alert beside a cluster change inside it. Each lost one row. | A counter row. 120 writers, half of them without the advisory lock, 18 rolled back, with a poller: 102 committed, 102 read, 0 missed, no holes. |
| R13 | **A restored backup rewinds `seq`.** A reader at 900 asks a database that is at 700. It gets nothing until 900, then 901, and never learns of 701 to 900. | 3.3 | By design | `cursor` is `epoch.seq`, a new epoch after a restore, `CURSOR_LOST` |
| R14 | **The server exits when PostgreSQL drops a connection. Live today.** | 3.1 | PostgreSQL: `serve()` with an idle connection ended by the database exits with code 1. No `error` listener exists in `src/`, and `compose.yaml` sets no restart. A listener on the pool alone still crashes for a client that is out. | Listen on both. Tested: both cases survive. Step 0a. |
| R16 | **Two processes, two policies, one database.** A local instance with the default policy writes clusters beside a server with its own. | 3.1 | Memory: the second joined two people the first would not, and the state became `mixed` | Keep the policy and secret marks in the database; `CONFIG.MISMATCH` |

### 6.6 Local and remote

| # | Scenario | Section | Evidence | Fix |
| --- | --- | --- | --- | --- |
| R18 | **The same call, two answers.** `value: NaN` is refused locally. Over HTTP, JSON makes it `null`, and it is **recorded as 0**. `Infinity` the same. A `bigint` is a raw `TypeError` in the client. With the database down, local throws a raw `ECONNREFUSED` `Error`. | 3.2 | Memory and PostgreSQL | One validator and one JSON boundary on both sides. The fault table in 3.2 names each SQLSTATE and proxy status. |
| R18a | **`databaseUrl` was required.** `demo.ts` and `examples/firm.ts` could not run. | 3.4 | Types | `{ memory: true }`, and `runWorkers` in `./testing` |
| R18b | **Type holes.** `policy`, `openHours`, `BoardColumn<unknown>`, `serviceAccount`, refusal `detail`. `url` with `databaseUrl` compiled. | 3.4 | Types | All strict. The eleven misuses no longer compile. |
| R18c | **A newer server breaks an older client's types.** `parseWebhook` had `Unrecognized` and `events` did not. | 3.4 | Types | `UnrecognizedEvent` in `EventPage` |

### 6.7 Also found

| # | Scenario | Section | Evidence | Fix |
| --- | --- | --- | --- | --- |
| R20 | **Lookups give out hashed emails and phones.** `match`, `caller`, `journey` and `transfers` reused types with `Reason.identifier`. That is finding 8 again, by another door. | 3.4 | Memory: `match` answered with `device:1001` in its reasons | `Match`, `Tied` and `JourneyEntry` say `kinds`. `mute` takes a fact. |
| R21 | **Every report is worked out anew.** Shared answers are keyed by the request. A required `at` of now is new each time, so a screen left open runs a fresh report at every look. | 3.4 `ReportRequest` | Read: `remembered` in `src/server.ts` | `at` within a minute of now shares one answer. `asOf` says of when, in place of the `age` header. |
| R22 | **`forget` with `retract` cannot be one transaction.** The platform is asked after the deletion. A crash between leaves an answer nobody has. | 2.4 | Read: `forget` in `src/outbox.ts` | `sent` is kept as `pending` in the deletion's transaction, then updated. After a crash it stays `pending`: the hashes needed to ask again are gone. |
| R23 | **One refusing receiver stops every event behind it.** | 3.3 | By design | 24 hours, said once, then skipped. `events` still has them. |
| R24 | **A redirect turns `POST` into `GET`.** | 3.2 | `fetch` standard, for 301 and 302 | `redirect: 'error'`, `CONFIG.INVALID` |
| R25 | **`workers: true` by default runs cost pulls in a script that lives a second.** | 3.1 | Read: `serve` starts them at once | `workers` must be said; a lease per job |

### 6.8 What remains open

| Point | State |
| --- | --- |
| Receipts grow without end | A receipt is needed for as long as a caller may retry. Proposed: `account-graph prune` takes receipts over a year old and keeps tombstones. Yours to decide before 4c. |
| A caller that stamps `at` anew on each retry | Gets `KEY_REUSED`, by design. It should be the first line of the migration notes. |
| `forget` of one subject of a person | Deletes that subject only, as today. Another subject's record of the same call stays. |
| Retraction interrupted by a crash | Reported as `pending` and cannot be finished (R22) |

## 7. As built

Built on `feat/six-calls`, from `main` at `34d21bd`. Where this section and sections 2 to 4 differ, this one is right.

### 7.1 Where it differs

| Point | Design | Built | Why |
| --- | --- | --- | --- |
| Phones in a digest | No default country | `phones.country`, and the country is part of `digest_version` | Found by a test: Twilio's `+1555…` and a backend's ten digits were two callers. With another country, digests are not compared, so nothing is refused for it. |
| `receipt.key_mac` | `bytea` | `text`, in hex | The same on both stores |
| `digest` | One hash | One for each field | `KEY_REUSED` names the fields |
| Things said of a value, a call or a lead | Four tables changed | One `said` table, and the old ones worked out from it | One rule for order in one place |
| `event.said_once` | A column | `event_once`, with its subject | Forgetting somebody forgets that they were spoken of, though their event is gone |
| Remote client without Node | Lazy imports | A `node` condition in `exports`. Elsewhere `.` is `dist/remote.js`. | The factory is synchronous, and names everything wrong at once |
| Reviewer screen | 13 routes of its own, the rest from the six calls | 27 routes under `/review/api` | The screen draws identifiers and scores, which the calls no longer give out |
| `Arrival` | — | Has `custom` | The office an ad was for was lost otherwise |
| `Person` | — | Has `possible` | `/attribute` could tell a weak arrival from none |
| `lookup caller`, `waiting` | `boolean` | `{ calls, texts }` | Nothing is lost |
| `LocalOptions` | — | Has `fetch`, `phones.country`, `tapSeconds` and `pool` | Tests and demos, and what the edge and the graph must agree on |
| Connection pools | Two | One. Writes of a process wait in the process. | `main` had fixed R15 already (pull request 150) |
| `account-graph export` | A command | `tools/export.ts`, as before | It reads tables, and is a tool of the repository |
| A profile with no usable fact | A fault | `NO_FACT_USED`, with the notes | Found while the docs were written: an address with no address service looked recorded |
| `at` of a decision or deletion | When it was decided | Compared, and kept with the key. The record and `STALE` have the server's time. | The record is sealed in the order it is written |
| Receipts, pruned | Left to you | Kept a year by `account-graph prune`. Tombstones stay. | The proposal in 6.8 |

### 7.2 What was verified

| What | How |
| --- | --- |
| One transaction an entry | Eight kinds of entry, cut off at every step they take, on both stores: nothing is left, and done again all of it is |
| Order | Every order of up to five things said of a value, a call, a lead, a cost and a consent gives one answer, on both stores |
| Keys | Every kind of entry, sent again, written another way, changed in each field that counts, and three at once |
| `forget` | Every key of a person is refused afterwards, those from before there were receipts too. What is left in the table was read and holds no key, subject or digest. |
| Events | Twelve writers, writes that fail, and a reader: none missed, no number skipped |
| `unmerge` | The eight traces of R11, and two more |
| Local and remote | One script in memory, on PostgreSQL and over HTTP. Every answer and every fault is compared. |
| Types | `test/contract.types.ts`: what must compile, and eleven that must not |
| Rings, names and paths | `test/arch.test.ts`. The built package was installed, and each path that is not listed was refused. |
| Speed | 146 calls a second one by one, against 128 for the six transactions before, on one laptop. A visit beside a list of 100 calls: 7 ms at the median, 26 at most. |

### 7.3 What was not

- Nothing here has run against a live Google, Meta, Microsoft, TikTok, Twilio, Smarty or MaxMind account.
- No database with real data was upgraded. The upgrades were run on empty databases and on the old ones the tests make.
- `record` and the crash of a process were tested by failing every statement, not by killing processes.
- The old functions behind `graph.restate`, `recordNotLead`, `asOf` and the like are still in `core/`. Nothing the package shows calls them. The tests do, through `test/harness.ts`.
- In memory, an entry copies the store before it writes, to undo it. That is for tests and demos, and slow with much in it.
