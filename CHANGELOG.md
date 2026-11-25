# Changelog

## Unreleased (0.1.0)

### Graph

- `createGraph(store, policy)` links subjects that share identifiers. Each link has a score and its evidence.
- `observe` returns the subjects whose cluster changed. `links`, `cluster`, `history`, `holders`, `between` and `GET /between` read the graph.
- `defaultPolicy` sets a weight, cap and half-life for each identifier kind. `phone` and `voip` use a dilution of 1, and `phone`, `email` and `voip` have a cap of 10.
- `POLICY` and `POLICY_FILE` override the default policy (`policyFrom`, `policyProblems`). `GET /policy`, `GET /stats` and Health report when a rebuild is required. `POST /rebuild` recomputes clusters.
- A link below `policy.bridge` (default 0.97) cannot join two groups of two or more subjects by itself. A group that names nobody (`Policy.unnamed`) goes back to the one named group it was cut from. Rebuild after upgrading.
- `Rule.group` counts grouped kinds once (`Reason.group`, `Reason.counted`). `Rule.corroborates` marks kinds that confirm a link. `examples/household.json` is a policy for contacts entered by staff.
- `separate`, `join` and `ignore` record decisions. `decisions` and `audit` list and verify the hash chain. `GET /audit` returns the newest entry, and `AUDIT_HEAD_HOURS` posts it to `ALERT_WEBHOOK`.
- `separate`, `join`, `ignore` and `forget` accept `seen`, and a newer decision rejects an outdated one with 409 (`Outdated`). `join` returns its mark, so a join can be undone.
- `POST /separate` and `POST /join` accept `{ source, pairs }` from a service token (`separateAll`, `joinAll`). `GET /disputes` lists conflicting system decisions.
- `match` and `POST /match` say who somebody may be before they are saved. `conflicts` and `POST /conflicts` list who of some people is kept apart. `ringing` and `POST /call/ringing` say who is calling. None of them writes.
- `foresee` and `POST /foresee` preview a decision. `undecided` and `GET /undecided` list pending matches.
- `measure` and `fit` compute weights from reviewed pairs. `reviewed` exports those pairs, and `tools/labels.ts` reads them from CSV.
- `asOf(time)` rebuilds the graph at a past time. `prune(before)` deletes older records. `forget(subject)` deletes a subject and its data.
- `transfer`, `flows`, `collusion` and `rings` report value moving between subjects. Each transfer has an `id`, and a repeat returns `duplicate: true`.
- `createMemoryStore` and `createPostgresStore` share one test suite. `verify` compares stored clusters with a full recompute, and `PostgresStore.migrate` applies numbered upgrades.
- `changes` and `GET /changes` list every cluster change in order, from a number. `CHANGE_SECRET` signs the posts to `CHANGE_WEBHOOK` (`bodySignature`).
- `rebuild`, `verify` and `asOf` read the graph in pages. `createBatcher` combines concurrent observations into one transaction.

### Identification

- `POST /identify` accepts a device, email, phone, address, IP, name and date of birth, then normalizes, checks and hashes them.
- `createAddressVerifier` checks US addresses with Smarty (`address` kind). `createLineTypeLookup` checks phone lines with Twilio (`voip` kind).
- `createFingerprintVerifier`, `hardwareId` and `createMaxMindLookup` add device and network identifiers.
- `knownLink` and `POST /link` create signed personal links (`link`, `opened` kinds). `collect.js?domains=` and `POST /carry` carry a visitor across sites (`carry` kind).
- `POST /link` takes a `purpose` and keeps the link. `GET /sent` and the journey say whether it was opened (`linksSent`).
- `collect` and `GET /collect.js` report browser visits. With `cookie: true` the server sets the device id in an `HttpOnly` cookie.
- `collect.js` adds `ag_device` and `ag_landing` to marked forms, or to all forms with `?forms=all`.
- Crawlers, previewers and uptime checks are excluded (`bots`). `STAFF_NETWORKS` and `POST /staff-link` exclude staff traffic (`staff`).
- `/collect` is rate limited per address (`HandlerOptions.limit`). `TRUST_PROXY` sets the number of proxies.
- `POST /find` searches by email, phone, ad click or id prefix.

### Calls

- `recordCall`, `POST /call` and `POST /calls/twilio` record calls. A call is linked to the visitor who tapped the number (`dial` kind), or attributed to the channel of its number.
- `CALL_NUMBERS_FILE` reads the tracking numbers from a file.
- `CALL_TAP_SECONDS` sets how long before a call a tap on its number may be.
- `POST /call/result` (`recordCallResult`) reports whether a call was answered. `CALL_RESULTS=expected` holds a call until its result arrives, up to `CALL_RESULT_WAIT` minutes.
- `direction: "outbound"` records calls you place. `followUp` and `GET /call` report callbacks, and `POST /call/returned` (`recordReturn`) accepts returns reported by another system.
- `recordText`, `POST /text` and `POST /texts/twilio` record texts without what they say. `TEXT_CODES` and `collect.js?text=1` put a code in text links (`text` kind), `GET /texts` lists the unanswered, and `GET /texting` says who asked for no more. Rebuild after upgrading.
- `POOL_NUMBERS`, `POST /number` and `collect.js?pool=1` assign tracking numbers to visitors (`lease` kind).
- `CALL_EXCLUDE` omits staff and test numbers. `OPEN_HOURS` (`createHours`) limits waiting times and stale-feed checks to open hours.
- `GET /calls`, `GET /calls/summary`, `openCalls` and `callSummary` report missed calls and call counts.
- `followed` and `GET /followed` report how many callers reached a step, by call result, talk time, language and callback.
- `board` and `GET /board` list people by step, with unreturned missed calls first. A step accepts `wait`.

### Attribution and reporting

- The board and reports read less, and `/board`, `/report`, `/followed` and `/calls/summary` are shared between readers for a moment (`age` header).
- `touch` and `attribute` attribute an outcome to a visit at `policy.same` confidence or above.
- `outcome`, `POST /convert` and `POST /event` record outcomes. `STAGES` sets the value, currency and action of each step.
- `restate` and `POST /restate` change a value. `kind` is `refund` or `write_off`. `values` and `GET /outcome` return the value history.
- `spend`, `POST /costs`, `googleCosts`, `metaCosts` and `costsFromCsv` record campaign costs. `conversions` and `conversionValue` hold platform-reported results (`GOOGLE_ADS_CONVERSIONS`, `META_ADS_CONVERSIONS`).
- A conversion with nothing to match by waits up to seven days for a click (`OutboxOptions.patience`).
- An ad click or a campaign visit in the window is credited before a call or text filed under its number.
- A visit in the same cluster is credited, however weak the chain of links to it (`AttributedTouch.joined`). The outbox sends its click unless `confidence` is set.
- A report, open calls and the board read the links of fifty thousand people at a time.
- A policy's `apart` keeps two subjects apart whose dates of birth differ, or whose first names can stand for no one name (`birthKeys`, `givenKeys`, `Link.conflict`). Under `given`, one number, email or browser given under one name is one person (`namedKeys`). Off by default.
- A journey shows no record, and no browser or caller, of a person in another group.
- `tools/accuracy` measures who is joined, rightly and wrongly, over made-up people. `docs/accuracy.md` has the figures of one run.
- `pay` and `POST /payment` take payments and refunds, and work out what an outcome is worth.
- `people` and `POST /people` read several people at once. `POST /forget` takes a list of `subjects`.
- `report` and `GET /report` return spend, outcomes, people, `costPerOutcome`, `returnOnCost`, delays, value changes and platform-reported conversions. `by` adds a breakdown, and `per` selects the step for cost.
- `recordNotLead` and `POST /not-lead` exclude spam and wrong numbers (`notLeads`).
- `journey` and `GET /journey` return one person's events with the evidence for each subject.

### Conversions and consent

- `createOutbox` sends each outcome once, with leases, backoff and retries. `googleAds`, `meta`, `microsoftAds` and `tiktok` are targets.
- `outbox.hold`, `release`, `withdraw`, `takeBack` and `giveBack` change a queued or sent conversion. `GET /conversions` and `POST /retry` list and retry rejected conversions.
- `consent`, `consentHistory` and `POST /consent` record advertising consent, including Global Privacy Control.
- `POST /forget` with `ads: true` lists conversions held by ad platforms. `FORGET_ADS`, or `retract: true` for one deletion, asks platforms that support it to retract them. `GET /me` returns `retraction`.

### Operations

- `npm start` runs the server from environment variables. `compose.yaml` runs it with PostgreSQL.
- `createHandler` serves the routes and the reviewer screen. `REVIEW_TOKENS` gives each reviewer a token, and `GET /me` returns its owner.
- `createOps`, `GET /ops` and Health report feeds, jobs, alerts and the outbox. `ALERT_WEBHOOK`, `RETURN_HOURS` and `LATE_HOURS` configure alerts.
- `GET /health`, `GET /stats`, `GET /verify` and `GET /pulse` report server status.
- `LINK_SECRET` is at least 32 characters. Responses are sent with `no-store` and `nosniff`.
- Requests with invalid UTF-8, NUL characters or more than 32 levels of nesting return 400.
- `examples/call-tracking.ts` takes a call tracking webhook, checks its signature and posts the call. `docs/pilot.md` is a trial that sends nothing to ad platforms.
- `OPEN_HOURS` takes `us` and `us-tx` for holidays. Spanish words ask for no more texts, and none undoes it. `POST /call/ringing` says where in Texas a number is from.
- `/identify` takes `speaker`, whoever speaks for the subject. Their browser and number are related to the subject and never joined to them, and what brought them earns the credit.
- A matching rule takes `relates`, for a kind that says two subjects are two people. Clusters need a `rebuild`, because the default policy has the new kind `behalf`.
- A `zip` tag with a Texas ZIP code adds `county`. `SERVER_RANGES_FILE` names the address ranges of data centers.
- A tap two callers could have made ties neither. On a number others are using, a tap has to be within thirty seconds of its call. A caller who is one visitor's takes another's pool number only while it is shown.
- `npm run firm` starts a sample firm, and `npm run bench -- scale` measures large graphs.

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
