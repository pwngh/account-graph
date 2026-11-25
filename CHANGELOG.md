# Changelog

## Unreleased (0.1.0)

### The six calls

- `record` and the Twilio text route share a concurrency test for one message, its tie and its sightings.
- `call_update` reports the current standing of a duplicate result or return.
- `call_update` accepts a signed statement of who one call concerned and keeps its ordered history.
- `journey`, callback reports and conversion credit follow the record staff named on a call.
- `forget` erases a confirmed call when the line or any named party is forgotten.

- `accountGraph({ url, token })`, `accountGraph({ databaseUrl, workers, receiptSecrets })` and `accountGraph({ memory: true })` return one interface: `record`, `decide`, `forget`, `lookup`, `report`, `events` and `close`.
- `POST /v1/<call>` takes the argument of the call and answers with its value, in process and over HTTP alike.
- `record` takes up to 100 entries of twelve types, one transaction each, and answers for each.
- Every write takes a `key` and an `at`. The same key with the same details is a `duplicate`, and with others is refused with `KEY_REUSED` and the names of the fields.
- A refusal leaves nothing behind, so its key can be sent again (`UNKNOWN_REFERENCE`, `KIND_NOT_IN_POLICY`, `CURRENCY_MISMATCH`, `PAID`, `KIND_RESERVED`).
- `record` checks a deleted key before sending its phone or address to a provider.
- `FORGOTTEN` refuses a late retry about somebody who was deleted. Receipts keep keys as hashes that only `receiptSecrets` can make.
- A fault has a `code`, `retryable` and `detail` (`isFault`, `hasCode`, `FAULT_CODES`). `TRANSPORT.INDETERMINATE` means the same key may be sent again.
- Faults are the same in process and over HTTP. A program error is `GRAPH.INTERNAL` and answers 500.
- `CONFIG.MISMATCH` stops a process whose policy or secrets differ from those of its database.
- The package exports `.`, `./edge`, `./collect`, `./hardware` and `./testing`. Only `src/bin.ts` reads the environment.

### People

- `lookup` `match` checks a caller’s own facts for conflicts with a proposed record.
- `given` now has a documented example distinguishing a recognized nickname from an exact name key.
- `apart` recognizes Catherine and Katherine, Kaitlyn and Caitlin, and Gerald and Jerry as forms of the same given names. Send the names again to add their new keys.

- `speaker` reuses the original mark when the same browser reports for the same record under another visitor ID. A muted mark stays muted.

- `record` `profile` takes a device, email, phone, address, IP, name, date of birth and identifiers of your own, then normalizes, checks and hashes them.
- Each link has a score and its evidence. A policy sets a weight, cap and half-life for each kind (`POLICY`, `POLICY_FILE`, `policy.kinds`, `policy.customKinds`).
- A link below `policy.bridge` (default 0.97) cannot join two groups by itself. `Rule.group` counts grouped kinds once, and `Rule.corroborates` marks kinds that confirm a link.
- `decide` merges, unmerges, splits, unsplits, mutes and unmutes. `seen` refuses a decision an unseen one has overtaken (`STALE`).
- `split` cuts guessed links first and breaks a merge only when the separation requires it. Existing clusters need a rebuild after upgrading.
- `unmerge` takes a pair. It is refused with `NOT_JOINED` where nobody merged the two, and `notAsAsked` names the pairs that still stand another way.
- `forget` deletes up to 50 subjects and says which of their conversions had reached an ad platform. The answer is kept with its key.
- `lookup` `match`, `find`, `caller` and `conflicts` write nothing. Answers name kinds of evidence and no identifier.
- `policy.records` `"confirmed"` makes two records one person only where a decision, a name or a date of birth confirms it. Others are related with `unconfirmed`, and in Matches. Off by default.
- `examples/intake.json` is a policy for an intake desk.
- Under `records`, one full name and date of birth shows two records, and joins them where anything else agrees. `lookup` `match` finds them by it.
- `policy.credit` is the confidence at which a visit is credited, apart from the one that joins. Off by default.
- A first name no table has is keyed whole, and letters such as đ and ø are kept, in the keys of names. Send names again to make the new keys.
- `named` and `ward` exclude placeholder names, and name comparisons keep the letters a Latin spelling would lose. Rebuild and send named profiles again with new keys after upgrading.
- `policy.apart` takes `given`, and `policy.kinds` takes every built-in kind, in the types of the library.
- `/collect` checks a personal link's recipient group for a speaker in one read.
- `record` `link` makes a signed personal link. The same entry gives the same address.
- `record` `transfer` records value moving between subjects, and `lookup` `transfers` lists counterparties and rings.

### Calls and texts

- `lookup` `caller` shows both records as possible when staff join a line to two records they keep apart.

- `record` `call` and `text`, and the Twilio webhooks, record calls and texts without their content. Two reports of one call are one call.
- `call_update` reports a result, or that a caller was reached. The newest `at` stands, whatever order they arrive in.
- A call is linked to the visitor who tapped the number or was shown it (`phones.pool`), or attributed to the channel of its number.
- `phones.pool.requireTapAfterReassignment` keeps a reassigned number from linking an untied caller to its current visitor without a tap or code. The option is off by default.
- `record` `call` takes `code`, the code of a visitor that the caller read out. It links the call to that visitor in place of a tap or a pool number, and the answer has the flag `code` or `taken`. Codes are given where `TEXT_CODES` is on.
- A `call` reported again with a `code` it did not have stands as if it had come with it.
- `data-ag-code` marks an element the script tag fills with the visitor's code, under `collect.js?text=1`.
- `report` `callbacks`, `texts`, `calls` and `after_calls` list missed calls, unanswered texts, call results and what followed calls.
- `OPEN_HOURS` limits waiting times and stale-feed checks to open hours, with `us` and `us-tx` holidays.

### Attribution and reporting

- `record` `conversion`, `payment` and `restatement` count outcomes. A refund or a write-off is an amount, and `reverse` takes one back.
- What an outcome is worth does not depend on the order things arrive in.
- `not_lead` and `lead` exclude an outcome, a call or a text from every count, and return it.
- `report` `campaigns` sets cost beside outcomes, people, value, `costPerOutcome` and `returnOnCost`, with breakdowns and platform-reported conversions.
- `report` `pipeline` lists people by step. Answers of a report are shared for up to a minute, and `asOf` says of when they are.
- `record` `cost` takes campaign costs. The newest read of a row stands. Google and Meta costs are read every six hours.
- A visit in the same cluster is credited, however weak the chain of links to it.
- Placeholder numbers and office mailboxes link nobody, under every policy. Where two are kept apart, what is tied to both as strongly goes with whoever was first seen. Rebuild after upgrading.
- Under `apart: ["birth"]`, two dates of birth also part a caller or a browser that staff joined to both. Matches shows the join that was not followed.
- `policy.apart` skips cuts between records that earlier cuts already put in different clusters.
- `policy.apart` keeps two subjects apart whose dates of birth differ, or whose first names can stand for no one name (`given`). Under `given`, one number or email given under one name confirms a link. Off by default.
- An ad click or a campaign visit in the window is credited before a call or text filed under its number.

### Conversions and consent

- Conversions go to Google, Meta, Microsoft and TikTok, with leases, backoff and retries. `report` `deliveries` lists them by state.
- `record` `consent` keeps every answer about advertising, and the newest stands. Global Privacy Control is an answer.
- `FORGET_ADS`, or `platforms: 'retract'` for one deletion, asks platforms that support it to retract conversions.

### Events

- `events` pages through everything that happened, in order. A cursor of another history is refused with `CURSOR_LOST`.
- `WEBHOOK_URL` and `WEBHOOK_SECRET` post the same events, signed, in order and at least once. `verifyWebhook` and `parseWebhook` read them.
- `ALERT_WEBHOOK` receives the events that need a person, as sentences.

### Edge and operations

- `createEdge` serves the six calls, `POST /collect`, the Twilio webhooks, the reviewer screen and `/health`.
- `POST /collect` takes every kind of browser request by its `kind`. `/event`, `/carry`, `/number` and `/text-code` still answer.
- A page event is an outcome with an id of `page:`, and no caller may use one.
- The reviewer screen reads `/review/api`. A reviewer's token opens it, reports, and decisions in their own name.
- `account-graph` runs the server. `rebuild`, `verify`, `prune`, `retry`, `stats`, `alerts test`, `staff-link` and `events new-epoch` are its commands.
- `RECEIPT_SECRETS` is required. `CHANGE_WEBHOOK` and `CHANGE_SECRET` are now `WEBHOOK_URL` and `WEBHOOK_SECRET`.
- A connection the database ends is logged, and the server keeps running.
- Crawlers, previewers, uptime checks and `STAFF_NETWORKS` are excluded. `/collect` is rate limited per address.
- Requests with invalid UTF-8, NUL characters or more than 32 levels of nesting are refused.
- `runWorkers` of `./testing` runs every worker once. `npm run firm` and `examples/six-calls.ts` run in memory.
- `record` `profile` takes `speaker`, whoever speaks for the subject. Their browser and number are related to the subject and never joined to them, and what brought them earns the credit.
- `data-ag-for-other` marks the control of a form that says it is about somebody else. The script tag then sends `ag_speaker_device` in place of `ag_device`, and `accountGraph.fields(form)` answers the same way.
- A matching rule takes `relates`, for a kind that says two subjects are two people. Clusters need a `rebuild`, because the default policy has the new kind `behalf`.
- A tap two callers could have made ties neither. On a number others are using, a tap has to be within thirty seconds of its call. A caller who is one visitor's takes another's pool number only while it is shown.
- A call to a pool number that was somebody else's less than `POOL_GRACE_MINUTES` before is its holder's only with a tap. One by somebody who dialed it when it was another's is nobody's by it. A visitor who comes back gets the number they had.

### Reviewer screen

- Accounts shows linked IDs as an interactive graph and as a table with evidence.
- Journey shows one person's events on a timeline.
- Board shows people by step, with overdue people marked.
- `Matches` checks speaker marks across both clusters when it looks at recent sightings.
- Matches compares pending pairs side by side, with a preview and undo.
- Calls lists missed calls with their history, call results and calls by hour.
- Channels compares campaigns, with breakdowns, sorting, filters and CSV export.
- Health shows issues, feeds, jobs, conversions, matching rules and the audit log.
- The graph is laid out to the shape of the screen. On a phone its height grows with the number of IDs.
- A printed page leaves out the controls and shows lists in full.
- An info icon beside a term shows its definition, and a guide is available on each view.
- A command palette opens with Ctrl+K or ⌘K. Light, dark and forced-color modes are supported.

### Upgrading

#### To the six calls

> **Every old route for services is gone.** It answers 404. Change the callers before you upgrade, or upgrade both at once.

| Before | After |
| --- | --- |
| `/identify`, `/observe` | `record` `profile`. Raw identifiers go under `facts.identifiers`. |
| `/touch` | `record` `arrival`. Click ids go under `clicks`. |
| `/costs` | `record` `cost` |
| `/convert` | `record` `conversion`. `transactionId` is `key`, `action` is `actions`. |
| `/restate`, `/not-lead` | `record` `restatement`. A refund or write-off is an amount, where `/restate` took what was left. |
| `/payment` | `record` `payment`. `kind` is `direction`: `received` or `refunded`. |
| `/call`, `/call/result`, `/call/returned` | `record` `call`, `call_update` |
| `/text` | `record` `text` |
| `/consent` | `record` `consent`, `lookup` `person` |
| `/link`, `/sent` | `record` `link`, `lookup` `journey` |
| `/transfer`, `/flows`, `/collusion`, `/rings` | `record` `transfer`, `lookup` `transfers` |
| `/join`, `/separate`, `/ignore` | `decide` `merge`, `unmerge`, `split`, `unsplit`, `mute`, `unmute` |
| `/forget` | `forget` |
| `/people`, `/attribute`, `/cluster`, `/texting` | `lookup` `person` |
| `/match`, `/call/ringing`, `/conflicts`, `/find` | `lookup` `match`, `caller`, `conflicts`, `find` |
| `/outcome`, `/conversion`, `GET /call`, `GET /text` | `lookup` `record` |
| `/report`, `/board`, `/calls/summary`, `/calls`, `/texts`, `/followed`, `/conversions` | `report` `campaigns`, `pipeline`, `calls`, `callbacks`, `texts`, `after_calls`, `deliveries` |
| `/changes` | `events` |
| `/rebuild`, `/verify`, `/prune`, `/retry`, `/stats`, `/alerts/test`, `/staff-link` | [Commands](docs/operations.md#commands) |

| Also | Detail |
| --- | --- |
| `RECEIPT_SECRETS` | Required. Make one with `openssl rand -hex 32`. |
| `CHANGE_WEBHOOK`, `CHANGE_SECRET` | Now `WEBHOOK_URL` and `WEBHOOK_SECRET`, both or neither. A server with an old name set does not start. The body is an [event envelope](docs/operations.md#webhook). |
| `COST_INTERVAL_MS`, `COST_DAYS`, `OUTBOX_INTERVAL_MS` | No longer exist. Costs are read every six hours for the last seven days, and conversions are sent every 30 seconds. |
| `at` | Every write names it, and a key of its own. A caller that stamps `at` anew on each retry gets `KEY_REUSED`. |
| Decisions | A merge is taken back by its pair with `unmerge`. There is no mark to keep. |
| The change feed | Cluster changes became events and were numbered again. Start with `"after": null`. |
| Policy | The database keeps it from now on. See [the policy](docs/operations.md#policy). |
| Pages | The old browser paths answer for one release, for pages that keep an old script. |

> **On the day you deploy, a page event can count once more.** Page events now have ids of their own, which begin with `page:`. An event a browser already sent that day has another id, so the same browser can count it a second time. The next day is as before.

#### To the current weights

> **The default weights changed.** A phone number alone now joins two subjects, relates three, and reports no link among four or more. A phone, email or `voip` value held by more than 10 subjects links none of them. A server that ran the earlier defaults starts with a notice that a rebuild is due: run `account-graph rebuild` while the servers are stopped. To keep the earlier behavior, set `POLICY='{"kinds":{"phone":{"dilution":0,"cap":25},"email":{"cap":25},"voip":{"dilution":0,"cap":25}}}'` and rebuild if the server asks for it.
