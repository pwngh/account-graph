# Changelog

## Unreleased (0.1.0)

### The six calls

- `accountGraph({ url, token })`, `accountGraph({ databaseUrl, workers, receiptSecrets })` and `accountGraph({ memory: true })` return one interface: `record`, `decide`, `forget`, `lookup`, `report`, `events` and `close`.
- `POST /v1/<call>` takes the argument of the call and answers with its value, in process and over HTTP alike.
- `record` takes up to 100 entries of twelve types, one transaction each, and answers for each.
- Every write takes a `key` and an `at`. The same key with the same details is a `duplicate`, and with others is refused with `KEY_REUSED` and the names of the fields.
- A refusal leaves nothing behind, so its key can be sent again (`UNKNOWN_REFERENCE`, `KIND_NOT_IN_POLICY`, `CURRENCY_MISMATCH`, `PAID`, `KIND_RESERVED`).
- `FORGOTTEN` refuses a late retry about somebody who was deleted. Receipts keep keys as hashes that only `receiptSecrets` can make.
- A fault has a `code`, `retryable` and `detail` (`isFault`, `hasCode`, `FAULT_CODES`). `TRANSPORT.INDETERMINATE` means the same key may be sent again.
- Faults are the same in process and over HTTP. A program error is `GRAPH.INTERNAL` and answers 500.
- `CONFIG.MISMATCH` stops a process whose policy or secrets differ from those of its database.
- The package exports `.`, `./edge`, `./collect`, `./hardware` and `./testing`. Only `src/bin.ts` reads the environment.

### People

- `record` `profile` takes a device, email, phone, address, IP, name, date of birth and identifiers of your own, then normalizes, checks and hashes them.
- Each link has a score and its evidence. A policy sets a weight, cap and half-life for each kind (`POLICY`, `POLICY_FILE`, `policy.kinds`, `policy.customKinds`).
- A link below `policy.bridge` (default 0.97) cannot join two groups by itself. `Rule.group` counts grouped kinds once, and `Rule.corroborates` marks kinds that confirm a link.
- `policy.apart` keeps two subjects apart whose dates of birth differ. Off by default.
- `decide` merges, unmerges, splits, unsplits, mutes and unmutes. `seen` refuses a decision an unseen one has overtaken (`STALE`).
- `unmerge` takes a pair. It is refused with `NOT_JOINED` where nobody merged the two, and `notAsAsked` names the pairs that still stand another way.
- `forget` deletes up to 50 subjects and says which of their conversions had reached an ad platform. The answer is kept with its key.
- `lookup` `match`, `find`, `caller` and `conflicts` write nothing. Answers name kinds of evidence and no identifier.
- `record` `link` makes a signed personal link. The same entry gives the same address.
- `record` `transfer` records value moving between subjects, and `lookup` `transfers` lists counterparties and rings.

### Calls and texts

- `record` `call` and `text`, and the Twilio webhooks, record calls and texts without their content. Two reports of one call are one call.
- `call_update` reports a result, or that a caller was reached. The newest `at` stands, whatever order they arrive in.
- A call is linked to the visitor who tapped the number or was shown it (`phones.pool`), or attributed to the channel of its number.
- `report` `callbacks`, `texts`, `calls` and `after_calls` list missed calls, unanswered texts, call results and what followed calls.
- `OPEN_HOURS` limits waiting times and stale-feed checks to open hours, with `us` and `us-tx` holidays.

### Attribution and reporting

- `record` `conversion`, `payment` and `restatement` count outcomes. A refund or a write-off is an amount, and `reverse` takes one back.
- What an outcome is worth does not depend on the order things arrive in.
- `not_lead` and `lead` exclude an outcome, a call or a text from every count, and return it.
- `report` `campaigns` sets cost beside outcomes, people, value, `costPerOutcome` and `returnOnCost`, with breakdowns and platform-reported conversions.
- `report` `pipeline` lists people by step. Answers of a report are shared for up to a minute, and `asOf` says of when they are.
- `record` `cost` takes campaign costs. The newest read of a row stands. Google and Meta costs are read every six hours.
- A visit in the same cluster is credited, however weak the chain of links to it. An ad click in the window is credited before the number called.

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
- `runWorkers` of `./testing` runs every worker once. `npm run firm` and `demo.ts` run in memory.

### Reviewer screen

- Accounts shows linked IDs as an interactive graph and as a table with evidence.
- Journey shows one person's events on a timeline.
- Board shows people by step, with overdue people marked.
- Matches compares pending pairs side by side, with a preview and undo.
- Calls lists missed calls with their history, call results and calls by hour.
- Channels compares campaigns, with breakdowns, sorting, filters and CSV export.
- Health shows issues, feeds, jobs, conversions, matching rules and the audit log.
- The graph is laid out to the shape of the screen. On a phone its height grows with the number of IDs.
- A printed page leaves out the controls and shows lists in full.
- An info icon beside a term shows its definition, and a guide is available on each view.
- A command palette opens with Ctrl+K or ⌘K. Light, dark and forced-color modes are supported.
