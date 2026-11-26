# account-graph documentation

One page for each concept.

1. [Getting started](getting-started.md): install, script tag, first record, and a two-week trial.
2. [Identify](identify.md): profiles, forms, chat, names, and links that say who opened them.
3. [Calls and texts](calls.md): page events, taps, results, callbacks, number pools and text codes.
4. [Campaign report](report.md): costs, steps, payments, credit and the Board.
5. [Matching](matching.md): terms, scores, clusters, decisions and presets.
6. [Accuracy](accuracy.md): who is joined, rightly and wrongly, over made-up people.
7. [HTTP API](http.md): the six calls, field by field.
8. [Library](library.md): the same calls from Node, and what only Node has.
9. [Operations](operations.md): run, back up, upgrade, watch, every variable, and measured speeds.
10. [Providers](providers.md): where each key comes from, and what is sent to ad platforms.
11. [Privacy](privacy.md): what is kept, sent and deleted.
12. [Demo](demo.md): the made-up firm.
13. [PHP](php.md) covers the six calls, a transactional outbox and a CodeIgniter 3 integration.

## Who each page is for

| If you | You get | Start with |
| --- | --- | --- |
| Run the business | One view of what advertising costs and what it returns | [Demo](demo.md) |
| Buy the ads | Cost per outcome and ROAS by campaign, with outcomes split by office, language, hour or weekday | [Campaign report](report.md) |
| Answer the phones | A board of missed calls and people by step | [Calls and texts](calls.md) |
| Review matches | The evidence for each link, and joins and separations you can undo | [Matching](matching.md) |
| Build and run it | A server, and six calls over HTTP or from Node, with PostgreSQL or in-memory storage | [Getting started](getting-started.md), [Operations](operations.md), [HTTP API](http.md) |
| Look after privacy | What is stored, what is sent, and how to delete it | [Privacy](privacy.md) |

## Tools

| Command | Purpose |
| --- | --- |
| `npm run firm` | Sample firm with a stage for presenting |
| `npm run review` | Reviewer screen with sample data (`tools/review-demo.ts`) |
| `npm run demo` | The six calls from Node, on made-up data (`examples/six-calls.ts`) |
| `examples/site.ts` | Two-page site with the script tag and a signup form |
| `examples/call-tracking.ts` | Takes a call tracking webhook and records the call |
| `npm run live-check` | Calls each provider endpoint and prints its response (`tools/live-check.ts`) |
| `npm run labels` | Measures matching against a CSV of checked pairs (`tools/labels.ts`) |
| `npm run costs` | Sends a CSV of campaign costs to a server (`tools/costs.ts`) |
| `npm run bench` | Measures write and read speed (`tools/bench.ts`) |
| `tools/export.ts` | Writes edges, flows or cluster labels as CSV |
| `tools/accuracy/run.ts` | Measures matching on made-up people |
