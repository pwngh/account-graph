# Demo

The demo runs a fictional law firm with three offices, North, River and Online, and two languages. It starts the server, the firm's site and a stage for presenting with one command. Press Ctrl-C to stop it and delete its data.

```sh
npm ci
npm --prefix apps/review ci
npm run firm
```

| Component | Location |
| --- | --- |
| PostgreSQL | Set `DATABASE_URL` to a database that permits creating schemas, or supply Docker with a local `postgres:16` image. Each run uses its own schema. |
| Stage with the caller's phone and scenes | `http://localhost:8790/stage`. Signs anyone who opens it in as the demo reviewer, with no token. This is for the demo only. |
| Graph server and review app | `http://localhost:8790/accounts`. Sign in with the reviewer token `demo`. The previous screen is at `/legacy`. |
| Firm site, in English and Spanish | `http://localhost:8791/?gclid=you&utm_id=30111` and `/es` |
| Two months of seeded history | The stage shows the number of people prepared, then reports when the history is saved. |

`npm run firm -- injury` shows an injury firm in place of a family firm. See [Injury firm](#injury-firm).

`npm run firm` builds the graph package and review app before starting. With neither a database nor a local Docker image available, run `MEMORY=1 npm run firm` to keep the same graph in memory. Use `PORT` for the graph and stage and `SITE_PORT` for the firm's site if the default ports are in use. The demo runs on loopback, includes its own ad platform and alert receiver, and uses fictional names, numbers, amounts and addresses.

The generator makes its usual observations, call results and decisions against the same graph policy in memory. The store writes the resulting evidence, history and cluster labels to PostgreSQL in batches, in one transaction. Restart uses a fresh schema and loads the same history. Run `npm run review:test` with `DATABASE_URL` to time the original writes, the batched start and the restart, compare their counts, and verify the clusters. The two batched loads must each finish in under ten seconds.

Campaigns are named as an agency would name them, such as `North | Family law | Search` and `North | Family law | Búsqueda`. A visit is recorded at `https://www.firm.example.org`, while the site of the demo runs on this machine.

The site works like a real one. Open it with `?gclid=you&utm_id=30333` and its number becomes one from the pool, held for you while the page is open. The form and the text link work too. Send the form, and the contact it makes appears on the Board. If you tick the form as about somebody else, the graph records your browser and number as the [speaker's](identify.md#speaking-for-somebody-else). The graph does not record what was written or the consent to texts. The firm's own system keeps both.

## Setup

1. Open the stage. It shows the loading progress or current scene held by the server. With JavaScript enabled, the page receives changes over a server-sent event stream.
2. Once loading finishes, use Next to run a scene. The phone shows what the caller does and the stage tells what happened. Each scene has a link to its reviewer view.
3. To start over, use Restart. The stage keeps its address. With JavaScript off, use the buttons to submit forms and reload to read newer progress.

With JavaScript, press Space for the next scene, P to play the main story, R to start over, or H to hide the controls.

The story runs from a Monday to a Thursday that have passed. Each scene moves the demo's clock on, and the screens served by the demo go by that clock.

## Scenes

| Scene | Demonstrates | View |
| --- | --- | --- |
| 1 | An ad visit with `office=north` and `lang=es` in its address | Journey |
| 2 | A phone tap, what the firm's screen says while it rings, and a call held uncounted until its result | Accounts |
| 3 | A caller who hung up in the queue: missed, uncounted, unsent | Board |
| 4 | A call back that reaches the person | Journey |
| 5 | Details entered by staff, checked for a duplicate first: the contact is tied to the call by phone at 85%, and the ad is not credited. Accounts shows when the firm's system created the contact | Accounts |
| 6 | A signed link to the form, recorded with its purpose and texted to the contact | Accounts |
| 7 | The link opened in the browser of the visit: tied at 92%, and the ad is credited | Accounts |
| 8, 9 | A form sent and documents signed, on the same person | Board |
| 10 | A call scheduled with a director, who is a tag on the step | Board |
| 11 | The director's call, on the same timeline | Journey |
| 12 | A signed link to enroll and pay, texted and not opened | Journey |
| 13 | The link opened, and not yet paid | Journey |
| 14 | The payment recorded, by a different office than the ad named | Journey |
| 15 | The conversion sent to the ad platform for the first ad click | Journey |
| 16 | The client's value restated, from 400 to 1,250 | Journey |
| 17 | The other side of the matter with the same family phone and email, separated by the case system, and the answer to a conflict check | Accounts |
| 18 | The other side calls from the family phone. Staff say who the call was with, and it leaves the contact's timeline | Journey |
| 19 | A second member of staff saves another answer for the same call, and is refused: the first answer stands | Journey |
| 20 | A call to a map listing's number, without a page load, filed under that listing | Channels |
| 21 | The form on the site in place of a call, credited by the browser | Board |
| 22 | A parent and child on one phone: related without joining | Matches |
| 23 | The parent entered twice: staff join the two, then separate parent and child, and the join holds | Accounts |
| 24 | Twins entered as Baby Girl, with one birthday and one phone: related without joining | Matches |
| 25 | A text reported without its words, then again with STOP: the opt-out is taken on the retry | Journey |
| 26 | The detail card behind Answered, with the target the firm set | Calls |
| 27 | A night without calls: the calls feed is stale and an alert is delivered, while visits, results and costs are within their limits | Health |

## Injury firm

`npm run firm -- injury` tells the same story for a firm paid from a recovery. A client signs and pays nothing then, so the conversion is the signed case, at the value the firm expects of it. Scene numbers, timing and views are the same.

| Scene | Family firm | Injury firm |
| --- | --- | --- |
| 5 | The matter is a divorce | The matter is a car accident |
| 9 | Documents signed, step `signed` | Medical records authorized, step `records` |
| 10, 11 | A director is scheduled, and calls | An attorney is scheduled, and calls |
| 12, 13 | A link to enroll and pay | A link to the representation agreement |
| 14 | Paid, step `client`, 400 USD | Signed, step `signed`, 2,500 USD expected |
| 16 | Restated from 400 to 1,250 | Restated from 2,500 to 6,000 |
| 17 | The other side of the matter | The driver, a relative the claim is against |

## Limitations

- **Scores.** A percentage on screen is a score from the sample policy's weights, not a measured accuracy.
- **Scale.** The demo has a few hundred people. See [Performance](operations.md#performance) for measured speeds.
- **Clock.** Each scene runs once. Scene 27 moves the clock forward fourteen hours, so run it last.
- **Firm systems.** Call answering, scheduling, texts, forms, signing and card payment belong to a firm's own systems. The demo shows made-up screens for them, and makes the requests such systems would, with each text as a `text` entry. No live text, card payment or ad platform is used.
- **Links.** The demo opens every link in the browser of the first visit. One opened in another browser is another visitor.
