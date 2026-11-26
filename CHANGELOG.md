# Changelog

## Unreleased (0.1.0)

### Providers

- `account-graph.tpl` installs the browser collector through Tag Manager with form, page and event settings and stops collection when either storage consent is withdrawn.
- The tests replay Twilio’s published signature and response examples for the ad and lookup providers. A loopback receiver checks the graph’s event signature and unsigned alert.
- `live-check` runs one named check, lists the data it sends and exits unsuccessfully on missing credentials or an inconclusive result. Dummy credentials require an explicit flag.
- Meta website events can include the converting browser’s user agent with explicit advertising consent and an opt-in setting. Meta sends its token in the Authorization header and fails a batch whose receipt counts fewer events. `SYSTEM_GENERATED` is a channel.
- Microsoft conversion uploads can use the sandbox. TikTok accepts a test event code. Google cost reporting can run without a developer token.
- The CallRail example leaves the human answer unknown when a line picks up, so it no longer closes a missed call or counts where results are expected. `ANSWERED_BY=person` restores that. A call without a direction is refused.
- Twilio retries incomplete line-type lookups on the next request and ignores outbound SMS status callbacks.
- An address with a field longer than Smarty takes is not looked up. `SMARTY_LICENSE` selects a license. MaxMind accepts its sandbox, and with MaxMind keys an unknown host or service stops the start. Fingerprint checks the returned event ID and preserves missing signals. The checker requires a fresh, confident identification.
- Incomplete or malformed cost report envelopes raise errors. Meta reporting refuses pagination to a different origin.

### The six calls

- The `Authorization` header's `Bearer` scheme is read in any case and with any spaces before the token, as HTTP allows.
- `fill` also sets its fields on a form a script sends with `form.submit()`, which fires no submit event, so such inquiries keep their device and ad.
- `serviceTokens` gives each integration a credential of its own, limited to the calls, entry types, decisions and reads it lists, signing only as `system:<name>`.
- `decide` answers a key used for another action with `KEY_REUSED` naming only `action`, for every caller.
- `allowPages` and `refusePages` keep a firm's private pages out of the collector and the server on every host; only a referrer from another site passes, as origin and path. A refused entry is refused alone.
- `requireConsent` (`consent=required` on the tag) makes no identifier and sends nothing until the visitor says yes.
- `decide` `withdraw` takes one matching fact off one record. It stops joining or counting for that record, other holders keep it, and a newer profile naming it restores it.
- `textsOptedOut` keeps a STOP sent from a number while the record held it, after that number is withdrawn.
- A withdrawal changes earlier credit, people, journeys and reports, as a split does. Identity snapshots respect its time.
- `profile` refuses an `ip` fact that is not an IPv4 or IPv6 address with `INPUT.MALFORMED`. Valid addresses keep the keys they had.
- `AccountGraph.php` allows a record batch time to finish, honors the server’s retry delay across worker runs and distinguishes TLS setup failures from indeterminate timeouts.
- `AccountGraph.php` brings the six calls to PHP hosts, with stable keys, cursor paging and a transactional outbox that keeps each record's changes in order.
- `account_graph_lib` loads directly in CodeIgniter or plain PHP, accepts named settings, and exposes the same six calls and cursor paging through documented methods.
- `gform_after_submission` and `wpcf7_submit` queue inquiries with the visitor’s mapped device, preserve separate identities across WordPress sites, and count a repeated submission or mail retry once.
- `account_graph_wordpress` logs a refused or failed form job once, by reason code and without submitted values.
- `account_graph_wordpress` removes sent form receipts and their entry aliases after 30 days.
- `account_graph_outbox_lib` caps retry deadlines at 15 minutes and continues sending independent groups while a row waits. Profile screening reports which fields were dropped and why.
- `account_graph_outbox_lib` stops a pass on service faults, holds explicit dependents for refused or malformed writes, and clears the saved request after each successful send.
- `account_graph_lib.php` allows a record batch time to finish, honors the server’s retry delay across worker runs and distinguishes TLS setup failures from indeterminate timeouts.
- `account_graph_lib.php` brings the six calls to PHP hosts, with stable keys, cursor paging and a transactional outbox that keeps each record's changes in order.
- `account_graph_lib` brings the six calls to PHP 7.2+ hosts, plain or CodeIgniter (`$this->load->library('account_graph_lib', $config)`), with retries under the same key, cursor paging and Retry-After capped at 15 minutes. See [PHP](docs/php.md).
- `account_graph_outbox_lib` sends each record's changes in order from the host's own transaction; a service fault pauses the pass, a refused row waits for a person, and a sent row keeps no personal data.
- `docs/openapi.json` describes the six calls and browser collector, with checked examples for firms recording web inquiries through Zapier, Make or Power Automate.
- `account_graph` calls the graph from Python, follows event, report and journey cursors, and preserves keyed writes across retries and restarts with an optional SQLite outbox.
- `profile.createdAt` records when your system created a subject. The Accounts heading and Links table show it alongside the earliest activity the graph still holds for each record.
- `textsOptedOut` covers a STOP from any phone number the subject’s cluster has, including one only related to it under `records`. A START from inside the cluster does not undo it.
- `record` applies an inbound opt-out first supplied on a text retry at the original message time and answers `optOutAdded: true` once.
- `call_update` accepts the party statement key staff saw, or `null` if there was none. A different standing statement returns `STALE` and leaves the entry key free to retry.
- `lookup` returns the current party statement and its key for a call, even before the phone report arrives.
- `call_update` records who one call concerned, who said so and when. A statement may arrive before the call and a later statement can correct it. See the [call roles](docs/calls.md#recording-who-was-on-one-call).
- `lookup` reads a journey, person, caller or call record and its supporting details from one snapshot.
- `forget` erases a call when its original line or current owner is deleted. A call since confirmed for another record keeps its conversion and value history, and the former party’s statements and receipt fields are erased.
- `FORGOTTEN` protects erased keys before provider checks. A returning record can be named on a recorded call that started after its deletion. See [deletion](docs/privacy.md#deletion).
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

- `phone` keys exclude extension digits when recording a line or looking it up. Older keys made with extension digits need the [original records](docs/identify.md#fields) to correct them.
- `split` cuts guessed links before staff merges and restores each merge it can keep while all separations hold.
- `call_update` withdraws identity evidence for that call while its original holders still count toward shared identifiers. See the [matching rules](docs/matching.md).
- `name` keeps letters and script marks that distinguish people and recognizes missing-name and newborn labels. Equal birthdays cannot confirm two placeholders. See [confirmed records](docs/matching.md#records-that-have-to-be-confirmed).
- `given` recognizes additional spellings and short forms in the [first-name table](docs/matching.md#facts-that-keep-people-apart).
- `match` includes a proposed holder in shared counts and checks the candidate’s own facts, including a caller’s date of birth.
- `speaker` preserves a muted mark when the same browser reports under another visitor ID.
- `record` `profile` takes a device, email, phone, address, IP, name, date of birth and identifiers of your own, then normalizes, checks and hashes them.
- Each link has a score and its evidence. A policy sets a weight, cap and half-life for each kind (`POLICY`, `POLICY_FILE`, `policy.kinds`, `policy.customKinds`).
- A link below `policy.bridge` (default 0.97) cannot join two groups by itself. `Rule.group` counts grouped kinds once, and `Rule.corroborates` marks kinds that confirm a link.
- `decide` merges, unmerges, splits, unsplits, mutes and unmutes. `seen` refuses a decision an unseen one has overtaken (`STALE`).
- `decide` returns `stands` on a duplicate so callers can tell whether every requested decision still holds.
- `unmerge` takes a pair. It is refused with `NOT_JOINED` where nobody merged the two, and `notAsAsked` names the pairs that still stand another way.
- `forget` deletes up to 50 subjects and says which of their conversions had reached an ad platform. The answer is kept with its key.
- `lookup` `match`, `find`, `caller` and `conflicts` write nothing. Answers name kinds of evidence and no identifier.
- `policy.records` `"confirmed"` makes two records one person only where a decision, a name or a date of birth confirms it. Others are related with `unconfirmed`, and in Matches. Off by default.
- `examples/intake.json` is a policy for an intake desk.
- Under `records`, one full name and date of birth shows two records, and joins them where anything else agrees. `lookup` `match` finds them by it.
- `policy.credit` is the confidence at which a visit is credited, apart from the one that joins. Off by default.
- A first name no table has is keyed whole, and letters such as đ and ø are kept, in the keys of names. Send names again to make the new keys.
- `policy.apart` takes `given`, and `policy.kinds` takes every built-in kind, in the types of the library.
- `record` `link` makes a signed personal link. The same entry gives the same address.
- `record` `transfer` records value moving between subjects, and `lookup` `transfers` lists counterparties and rings.

### Calls and texts

- `call` saves a new call once when the search for a visitor leaves it unchanged and skips unused reads of the dial and the channel.
- `caller` shows both records as possible when staff linked a line to two people they keep apart.
- `phones.pool.requireTapAfterReassignment` lets an operator require a tap or code from an untied caller on a reassigned number. The option is off by default. See [number pools](docs/calls.md#number-pools).
- `call` recognizes a duplicate from before call details were kept when the line has since been excluded.
- `record` `call` and `text`, and the Twilio webhooks, record calls and texts without their content. Two reports of one call are one call.
- `call_update` reports a result, or that a caller was reached. The newest `at` stands, whatever order they arrive in.
- A call is linked to the visitor who tapped the number or was shown it (`phones.pool`), or attributed to the channel of its number.
- `record` `call` takes `code`, the code of a visitor that the caller read out. It links the call to that visitor in place of a tap or a pool number, and the answer has the flag `code` or `taken`. Codes are given where `TEXT_CODES` is on.
- A `call` reported again with a `code` it did not have stands as if it had come with it.
- `data-ag-code` marks an element the script tag fills with the visitor's code, under `collect.js?text=1`.
- `report` `callbacks`, `texts`, `calls` and `after_calls` list missed calls, unanswered texts, call results and what followed calls.
- `OPEN_HOURS` limits waiting times and stale-feed checks to open hours, with `us` and `us-tx` holidays.

### Attribution and reporting

- `report` and `lookup` read base identifier counts when their PostgreSQL snapshot contains no withdrawn call evidence.
- `report` assigns confirmed calls, callbacks and call values to their stated owner and counts that owner with explicitly merged duplicate records.
- `campaignCredit` identifies the campaign when an eligible visitor’s tap, code or pool number credits a confirmed call. The visitor’s private arrival details stay off that callback or pipeline row.
- `record` `conversion`, `payment` and `restatement` count outcomes. A refund or a write-off is an amount, and `reverse` takes one back.
- What an outcome is worth does not depend on the order things arrive in.
- `not_lead` and `lead` exclude an outcome, a call or a text from every count, and return it.
- `report` `campaigns` sets cost beside outcomes, people, value, `costPerOutcome` and `returnOnCost`, with breakdowns and platform-reported conversions.
- `report` `pipeline` lists people by step. Answers of a report are shared for up to a minute, and `asOf` says of when they are.
- `record` `cost` takes campaign costs. The newest read of a row stands. Google and Meta costs are read every six hours.
- A visit in the same cluster is credited, however weak the chain of links to it.
- Placeholder numbers and office mailboxes link nobody, under every policy. Where two are kept apart, what is tied to both as strongly goes with whoever was first seen. Rebuild after upgrading.
- Under `apart: ["birth"]`, two dates of birth also part a caller or a browser that staff joined to both. Matches shows the join that was not followed.
- `policy.apart` keeps two subjects apart whose dates of birth differ, or whose first names can stand for no one name (`given`). Under `given`, one number or email given under one name confirms a link. Off by default.
- An ad click or a campaign visit in the window is credited before a call or text filed under its number.

### Conversions and consent

- `call_update` stops new ad sends for a stated call. Adjustments to a conversion already sent use its original platform identifiers.
- Conversions go to Google, Meta, Microsoft and TikTok, with leases, backoff and retries. `report` `deliveries` lists them by state.
- `record` `consent` keeps every answer about advertising, and the newest stands. Global Privacy Control is an answer.
- `FORGET_ADS`, or `platforms: 'retract'` for one deletion, asks platforms that support it to retract conversions.

### Events

- `callback.overdue` follows the current missed call, attempts and paid arrival. Reassignment or deletion removes superseded notices before retry.
- `conversion.failed` events and queued failure alerts that rely on a corrected call are removed. A batch already posted can still arrive.
- `WEBHOOK_URL` receives a newly signed batch when a correction changes its events during signing.
- `events` pages through everything that happened, in order. A cursor of another history is refused with `CURSOR_LOST`.
- `WEBHOOK_URL` and `WEBHOOK_SECRET` post the same events, signed, in order and at least once. `verifyWebhook` and `parseWebhook` read them.
- `ALERT_WEBHOOK` receives the events that need a person, as sentences.

### Edge and operations

- `account-graph sample-joins` writes a seeded random sample of the pairs the graph joined without a reviewer as CSV, and `account-graph score-joins` reads the checked sample back as the share of right joins with its 95% Wilson interval.
- `restore-check.ts` rehearses a PostgreSQL restore into an empty database, times each step and checks stored clusters, every table's row count and the newest audit hash.
- `POST /leads/<name>` authenticates each chat, intake or payment source with its own secret and records mapped fields once per vendor ID, without keeping transcripts.
- `POST /leads/<name>` writes only to subjects under the source's own prefix and refuses a mapped subject outside it. `trustSubjects` lifts this for a sender trusted with every record.
- `LEADS` stops the server at startup when a source secret is shorter than 32 characters, has fewer than 8 different characters, or repeats another credential or any secret setting, when a name repeats, when subject prefixes overlap or begin with a built-in subject kind, or when a payment source lists call, text or page conversions.
- `POST /leads/<name>` answers 429 to a wrong signature from an address that sent 10 wrong signatures to that source within a minute, until the minute is up. A correct signature from that address is accepted.
- `LEADS` and `LEADS_FILE` set to an empty value are read as unset, as `STAGES` is.
- `POST /leads/<name>` reads a mapped time below 100,000,000,000 as epoch seconds and a larger one as milliseconds, and refuses one more than a day ahead.
- `POST /leads/<name>` accepts a signature written `sha256=<digest>`, in base64url or without padding, a `bearer` scheme in any case, and a phone sent as a JSON number.
- `updates: true` on a lead source adds the new details of a lead posted again under the same ID to its subject, keeping the conversion's first time. Without it, `POST /leads/<name>` answers 409 to an ID posted again with other details, as it does to an ID posted for another subject or payment.
- `conversions` and `maxAmount` are required on a payment lead source, which refuses a payment to a conversion outside those key prefixes, or one that takes its payments to that conversion above that amount.
- `POST /leads/<name>` answers a post with no usable fact with `NO_FACT_USED` without opening the graph, and answers errors as `{ error }` like the other routes outside `/v1`.
- `forget` leaves a tombstone of each forgotten subject, and `POST /leads/<name>` answers `FORGOTTEN` to a lead under that subject, even with a new vendor ID. `account-graph prune` keeps it, and a `record` profile under that subject removes it.
- `GET /health`, startup and the reviewer Health view give the rebuild command when stored groups need updating. Earlier name hashes need a rebuild and fresh profiles. See [upgrades](docs/operations.md#upgrades).
- `PostgreSQL` resumes interrupted upgrades and uses indexed calls to identify the sources of older callback notices.
- `/collect` checks a personal link’s recipient group for a speaker in one read.
- `createEdge` serves the six calls, `POST /collect`, the Twilio webhooks, the reviewer screen and `/health`.
- `POST /collect` takes every kind of browser request by its `kind`. `/event`, `/carry`, `/number` and `/text-code` still answer.
- A page event is an outcome with an id of `page:`, and no caller may use one.
- The reviewer screen reads `/review/api`. A reviewer's token opens it, reports, and decisions in their own name.
- `account-graph` runs the server. `rebuild`, `verify`, `prune`, `retry`, `stats`, `alerts test`, `staff-link` and `events new-epoch` are its commands.
- `RECEIPT_SECRETS` is required. `CHANGE_WEBHOOK` and `CHANGE_SECRET` are now `WEBHOOK_URL` and `WEBHOOK_SECRET`.
- A connection the database ends is logged, and the server keeps running.
- Crawlers, previewers, uptime checks and `STAFF_NETWORKS` are excluded. `/collect` is rate limited per address.
- Requests with invalid UTF-8, NUL characters or more than 32 levels of nesting are refused.
- `npm run firm` has 27 scenes: who a call was with, two staff on one call, a join kept through a separation, newborns kept apart, STOP on a retry and a detail card with a target. See the [demo](docs/demo.md).
- `npm run firm` watches all four feeds, records visits at a made-up address and names campaigns as an agency would.
- `runWorkers` of `./testing` runs every worker once. `npm run firm` and `examples/six-calls.ts` run in memory.
- `record` `profile` takes `speaker`, whoever speaks for the subject. Their browser and number are related to the subject and never joined to them, and what brought them earns the credit.
- `data-ag-for-other` marks the control of a form that says it is about somebody else. The script tag then sends `ag_speaker_device` in place of `ag_device`, and `accountGraph.fields(form)` answers the same way.
- A matching rule takes `relates`, for a kind that says two subjects are two people. Clusters need a `rebuild`, because the default policy has the new kind `behalf`.
- A tap two callers could have made ties neither. On a number others are using, a tap has to be within thirty seconds of its call. A caller who is one visitor's takes another's pool number only while it is shown.
- A call to a pool number that was somebody else's less than `POOL_GRACE_MINUTES` before is its holder's only with a tap. One by somebody who dialed it when it was another's is nobody's by it. A visitor who comes back gets the number they had.

### Reviewer screen

- Matches says when pairs among older sightings are not in its queue. "Check older records" goes through every record, a page at a time, until "Back to recent".
- A separate React Router app renders Accounts, Journey, Board and Calls on the server. It checks a reviewer token at sign-in, keeps it on the server and follows graph changes for the open page. See the [review app](docs/review-app.md).
- The review app links to the original screen only at `REVIEW_LEGACY_URL`, refuses a `REVIEW_SESSION_SECRET` shorter than 32 characters and allows ten sign-in attempts per address in fifteen minutes.
- One process follows the graph once for all open tabs. Without `REVIEW_EVENTS_TOKEN` the pages say live updates are off, and a server restart ends event streams without signing anyone out.
- Review app times are in the reviewer’s zone, stored by the browser in a cookie, and in the report’s zone until then. Long IDs are shortened in links, names and IDs are isolated for right-to-left text, and Board, Calls and the audit log regain the original screen’s Period label, date presets, Copy time and `system desk` authors.
- The firm stage serves its current scene, loading progress and last result from the server. Scenes submit as forms, and open stages receive updates over a server-sent event stream. PostgreSQL loads the sample history in a batched transaction. See the [demo](docs/demo.md).
- `undecided` pages through ranked pairs from recent sightings and can sweep every subject, including those with pruned sightings.
- Detail cards open from an icon beside a number or a row on Calls, Board, Journey and Health. Each holds what is behind it, names how it is known and leaves out what is not. See the [reviewer screen](docs/operations.md#reviewer-screen).
- A mark, a number or a dashed wait on the Journey chart shows a short card when it is pointed at or focused. The panel beside the chart has every row.
- `#/journey/ID/CALL` opens a journey at one call.
- Each kind of event has one icon, drawn the same in the timeline, its filters, the chart, the story of a missed call and the feeds. A call nobody answered has a phone with a cross.
- `TARGETS` and the library option `targets` hold the numbers a firm sets itself to meet. Both are off by default, are checked at the start, and are shown on the reviewer screen as set by you. See [targets](docs/operations.md#targets).
- `Accounts` flags groups where too many conflicting call histories leave some matches unresolved.
- `Matches` checks the speaker marks of both clusters before offering a pair. An active staff merge broken by a separation remains visible in Links.
- Accounts shows linked IDs as an interactive graph and as a table with evidence.
- Journey shows one person's events on a timeline.
- Board shows people by step, with overdue people marked. Its periods begin with Today.
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
