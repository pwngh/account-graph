# Getting started

Start with the example site and a synthetic signup. A two-week field pilot on your own data is a separate decision.

You need Node 22.18 or later. Docker is optional and provides PostgreSQL. The package is not published to npm, so clone the repository.

## The example site

```sh
docker compose up --build        # the server on :8080, and its database
node examples/site.ts            # in a second terminal: an example site on :3000
```

1. Open <http://localhost:3000/?gclid=demo-click&utm_id=20111> and enter `pat@example.org` on the example site.
2. The page shows the attributed ad click and its confidence, 98%.
3. Open <http://localhost:8080/review>, sign in with the token `change-me-review-token`, and open the account. **Channels** shows the signup under its campaign.

To use another port, run `GRAPH_PORT=8090 docker compose up --build` and `GRAPH_URL=http://localhost:8090 node examples/site.ts`.

## Install

For a pilot, the owner configures a private database, sets `ORIGINS`, and generates independent secrets for `GRAPH_TOKEN`, `REVIEW_TOKENS`, `LINK_SECRET` and `RECEIPT_SECRETS`. The backend uses the same `GRAPH_TOKEN`. One way to start the server with an existing PostgreSQL database is to put these settings and `DATABASE_URL` in a mode-0600 file outside the checkout, under a service account. Set `GRAPH_ENV_FILE` to its path in that account's private launcher.

```sh
node --env-file="${GRAPH_ENV_FILE:?}" src/bin.ts
```

`ORIGINS` lists the sites allowed to report. [Operations](operations.md) covers every setting.

Add the script to each page:

```html
<script type="module" src="https://graph.example.org/collect.js"></script>
```

## First record

Under the default policy a shared phone alone can make `lookup` with `kind: "match"` suggest `same` for someone else, including an opposing party. Treat the answer as a suggestion to check and never use it to block a contact. Where a wrong join matters, use the [intake preset](matching.md#an-intake-desk). Load known separations with [`split`](matching.md#split) before entering the first contact. You can send a pair before either person's record exists.

Record the person when they sign in or sign up. For this loopback example, the owner puts one line, `Authorization: Bearer <service token>`, into a private mode-0600 file outside the checkout. Set `GRAPH_AUTH_HEADER_FILE` to its path. Run credentialed commands under the private account with tracing and recording off. Curl reads the header from the file.

```bash
curl -q --noproxy 127.0.0.1 -X POST http://127.0.0.1:8080/v1/record \
  -H "@${GRAPH_AUTH_HEADER_FILE:?}" \
  -d '{"entries":[{"type":"profile","key":"signup-42","at":1795460000000,"subject":"account:42","event":"signup","facts":{"device":"9f3c1c1e-0000-4000-8000-000000000001","email":"pat@example.org"}}]}'
```

The server normalizes and hashes the email, phone and postal address. `device` is the `ag_device` cookie set by the script. The answer lists the subjects whose cluster changed. See [Identify](identify.md).

## A two-week trial

The two weeks measure how well the graph links your site's visits, contacts and calls. No provider enrollment is required. You can rehearse the same steps beforehand with synthetic data and a test clock.

For an offline rehearsal, start with an empty graph, an isolated process with no provider credentials, and no ad actions in `STAGES`. Use the library with `workers: false`. The normal server starts its workers. Deny connections outside loopback for the server and any test browser. Keep hosted fingerprint scripts, public CDNs, call-tracking tags and form capture off the test page. Leave address, IP and phone lookups, ad cost readers, event webhooks and alert destinations unset. The Compose example can pull images on first use and passes settings through from its environment. With dependencies already installed, `node --test test/provider-fixtures.test.ts` needs no images, browser, account or provider requests. See [Fixture sources](../test/fixtures/providers/README.md), [Fingerprint browser calls](https://docs.fingerprint.com/reference/js-agent-get-function) and [CallRail form capture](https://apidocs.callrail.com/#form-capture).

For a field pilot, agree on consent, retention and a daily reviewer before connecting real systems. Keep advertising targets, cost imports and other outside services off unless the owner has separately authorized the specific data and destination. Each live provider check has its own scope, account and allowance. See [Provider verification](providers.md#verification).

### Before you start

| Decide | Why |
| --- | --- |
| Who may read the data, and for how long it is kept | The server stores hashed emails and phones, visits and calls. See [Privacy](privacy.md). |
| What your counsel says about linking calls to site visits, and what your site tells visitors | The server records what you report. It does not decide whether you may. |
| One person who reviews matches each day | Matches are scores from weights. They are unmeasured on your data until somebody checks them. |
| What would end the trial | Write it down first: a wrong match that matters, or a share of wrong matches over a number you choose. |

### Steps

| Step | What to do | Done when |
| --- | --- | --- |
| 1. Server | Run it on a machine of yours, with HTTPS in front. Use [`examples/intake.json`](matching.md#an-intake-desk) where mixing two people's records must not happen, or [`examples/household.json`](matching.md#contacts-entered-by-staff) if staff enter contacts. [Operations](operations.md) | `/health` answers over HTTPS |
| 2. Backup | Dump it and restore into a new isolated database. Run `account-graph verify` there. Before starting followers on the copy, run `account-graph events new-epoch` on that copy. [Backups](operations.md#backups) | Verification lists no changes on the copy |
| 3. Apart | Send the pairs your conflict check keeps apart as a [`split`](matching.md#split) | They are shown separated |
| 4. Site | Add the [script tag](operations.md#script-tag) to every page, with your consent banner's answer | Your own visit is in the screen, with its ad |
| 5. Calls | Record each call, or take your provider's webhook. [Calls](calls.md), [`examples/call-tracking.ts`](../examples/call-tracking.ts) | A test call is tied to your own tap |
| 6. Contacts | Record each new contact from your form or case system as a [`profile`](identify.md) | A test form is tied to your own visit |
| 7. Clients | Record each signed client as a [`conversion`](report.md#outcomes), with the value you give it | The client is under a campaign |
| 8. Two weeks | Review Matches and the missed calls every day. Change nothing else | You have a list of right and wrong matches |

To rehearse steps 3 to 8, load a synthetic pair to keep apart. Use a synthetic campaign URL and consent decision, intercept the phone tap, replay a signed call locally, and submit a synthetic form and a nominal-value outcome with no ad action. Compare the journey, missed calls, value and separation with the fixture ledger. Only a field pilot needs fourteen days of observation.

### Deciding

1. Write down 100 pairs of contacts you know to be one person, and 100 you know not to be, chosen before looking at the screen.
2. Run `npm run labels -- pairs.csv` from the graph's private launcher on those pairs. It prints precision and recall for each kind of evidence, with the counts behind them. See [Labels](matching.md).
3. Compare the missed calls on the Board with your phone system's own list for a week.
4. Take ten clients at random. For each, ask how they found you, and compare it with the ad on their journey.
5. In a rehearsal, compare against the known fixture answers. For a field pilot, use the independent phone and client evidence above to decide whether any single provider test warrants separate approval.

### Stopping

Remove the script tag and test callbacks, stop intake and stop the server. [`forget`](http.md#forget) deletes one person from the graph. Dispose of the pilot database, restore copy, backups and call-forwarder spool on the agreed schedule. Older copies keep data until they expire.

### Limitations

- The server is one process and one database. A pilot has no failover.
- The offline tests cover the published examples. A field pilot still needs independent checks of real call delivery, case-system inputs and match accuracy. Live ad acceptance and attribution require separate provider tests.
- There is no import of past calls or contacts.
- Two weeks is too short to see clients who take months to sign.
