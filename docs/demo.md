# Demo

The demo runs a fictional law firm with three offices, North, River and Online, and two languages. It starts the server, the firm's site and a presenter page with one command:

```sh
npm ci
npm run firm
```

| Component | Location |
| --- | --- |
| PostgreSQL, in Docker | Deleted on stop. Without Docker, or with `MEMORY=1`, all data is in memory. |
| Graph server and reviewer screen | `http://localhost:8790/review`. Sign in with the token `demo`. |
| Firm site, in English and Spanish | `http://localhost:8791/?gclid=you&utm_id=30111` and `/es` |
| Presenter page | `http://localhost:8791/present` |
| Two months of seeded history | Filled in a few seconds in memory, about a minute in PostgreSQL. |

Docker downloads the database image once. After that the demo runs offline without keys, and includes its own ad platform and alert receiver. Every name, number, amount and address is fictional.

The site is live. Open it with `?gclid=you&utm_id=30333` and its number becomes one from the pool, held for you while the page is open.

## Setup

1. Open the presenter page, and the reviewer screen in a second tab. Sign in.
2. Press Space on the presenter page to run each scene. It shows the result and duration, and links to the view that changed.
3. Run all ten scenes before the presentation, or run them as you go. Each takes well under a second.

## Ninety-second script

| Time | View | What to explain |
| --- | --- | --- |
| 0:00 | **Board** | Everyone who called or inquired is in one column, with callers awaiting a callback at left. Position comes from recorded events, without manual assignment. |
| 0:15 | **Calls** | Scene 3 is a caller who hung up in the queue after the phone system picked up. Most trackers would count that call and pay the ad platform for it. Here it is a missed call, returned in scene 4. |
| 0:30 | **Journey** | One person from the Spanish ad to payment: visit, tap, missed call, callback, inquiry, and a value restated from 400 to 1,250. Each line gives the evidence for the person. |
| 0:50 | **Channels**, by office served | Cost and outcomes per campaign. The ad named North and River served the client. One week of the Online campaign shows no data in place of a cost. |
| 1:05 | **Matches** | A parent and child share a phone and stay related until someone decides. Two sides of one matter share a phone and email, and are separated permanently. |
| 1:20 | **Health** | Fourteen hours pass without a call. The feed is stale, which usually means a broken feed, and an alert is sent. |

## Scenes

| Scene | Demonstrates | View |
| --- | --- | --- |
| 1 | An ad visit with `office=north` and `lang=es` in its address | Channels |
| 2 | A phone tap, and a call held uncounted until its result | Calls |
| 3 | A caller who hung up in the queue: missed, uncounted, unsent | Board |
| 4 | A callback that reaches the person, with a contact named by staff and an inquiry credited to the ad and sent | Journey |
| 5 | A call to a map listing's number, without a page load, filed under that listing | Channels |
| 6 | A client served by a different office than the ad named | Channels |
| 7 | The other side of the matter with the same family phone and email, separated by the case system | Accounts |
| 8 | A parent and child on one phone: related without joining | Matches |
| 9 | The client's payment is recorded and the step restated | Journey |
| 10 | A night without calls: a stale feed and a delivered alert | Health |

## Limitations

- **Scale.** The demo has a few hundred people. See [Performance](performance.md) for measured speeds.
- **Clock.** Scene 10 moves the demo server's clock forward fourteen hours. The browser's clock stays put, so ages there and times here differ afterward. Run it last.
- **Repeats.** Each scene runs once. Restart the command to start over.
- **Firm systems.** Call answering, assignment and client messages belong to a firm's own systems. The demo only simulates their reports.
