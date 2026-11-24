# Demo

The demo runs a fictional law firm with three offices, North, River and Online, and two languages. It starts the server, the firm's site and a stage for presenting with one command:

```sh
npm ci
npm run firm
```

| Component | Location |
| --- | --- |
| PostgreSQL, in Docker | Deleted on stop. Without Docker, or with `MEMORY=1`, all data is in memory. |
| Stage: the reviewer screen with a caller's phone and the scenes | `http://localhost:8790/stage`. Signed in already. |
| Graph server and reviewer screen | `http://localhost:8790/review`. Sign in with the token `demo`. |
| Firm site, in English and Spanish | `http://localhost:8791/?gclid=you&utm_id=30111` and `/es` |
| Two months of seeded history | Filled in a few seconds in memory, about a minute in PostgreSQL. |

Docker downloads the database image once. After that the demo runs offline without keys, and includes its own ad platform and alert receiver. Every name, number, amount and address is fictional.

The site is live. Open it with `?gclid=you&utm_id=30333` and its number becomes one from the pool, held for you while the page is open.

## Setup

1. Open the stage. The caller's phone is at left, and the reviewer screen at right.
2. Press Space to run each scene. The phone shows what the caller does, and the screen opens the view that changed.
3. Press H to hide the bar, or P to play the whole show.

The story runs from a Monday to a Thursday that have passed. Each scene moves the demo's clock on, and the screens served by the demo go by that clock.

## Ninety-second script

Press P on the stage. After a count of three the bar hides and the show plays by itself, in time with these lines. Press P or Esc to stop it. It plays once: restart the command to play it again, with `MEMORY=1` for a restart of a few seconds.

| Time | On screen | What to say |
| --- | --- | --- |
| 0:00 | The caller's phone: an ad, the firm's site, a call, no answer. The caller on the **Board** | When someone clicks a law firm's ad and calls, and nobody picks up, that call often gets cut off from the ad that paid for it. |
| 0:21 | **Accounts**: the call joined to the visit | This is a sample firm with made-up data. The call is tied to the ad visit at 92%, and it shows why. |
| 0:33 | The call back, and the contact joining the graph | Staff called back, and the missed call is marked returned. |
| 0:43 | **Journey**, Monday to Thursday | They became a client. The value went from 400 to 1,250, and the update went to a sample ad platform. |
| 0:54 | **Accounts**: the other side of the matter, kept apart | The other side shared their phone and email, so the case system separated the two, and the decision is on the record. |
| 1:04 | **Channels**: cost per client, then by office served | This is what each campaign cost per client, and which office served those clients. |
| 1:17 | **Accounts**: one person, whole | The close. |

Costs per client depend on the day the demo runs, so do not read them out.

## Scenes

| Scene | Demonstrates | View |
| --- | --- | --- |
| 1 | An ad visit with `office=north` and `lang=es` in its address | Channels |
| 2 | A phone tap, and a call held uncounted until its result | Calls |
| 3 | A caller who hung up in the queue: missed, uncounted, unsent | Board |
| 4 | A callback that reaches the person, with a contact named by staff and an inquiry credited to the ad and sent | Journey |
| 5 | A call to a map listing's number, without a page load, filed under that listing | Channels |
| 6 | A client served by a different office than the ad named | Channels |
| 7 | The client's payment is recorded and the step restated | Journey |
| 8 | The other side of the matter with the same family phone and email, separated by the case system | Accounts |
| 9 | A parent and child on one phone: related without joining | Matches |
| 10 | A night without calls: a stale feed and a delivered alert | Health |

## Limitations

- **Scale.** The demo has a few hundred people. See [Performance](performance.md) for measured speeds.
- **Clock.** Scene 10 moves the clock forward fourteen hours. Run it last.
- **Repeats.** Each scene runs once. Restart the command to start over.
- **Firm systems.** Call answering, assignment and client messages belong to a firm's own systems. The demo only simulates their reports.
