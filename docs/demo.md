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

`npm run firm -- injury` shows an injury firm in place of a family firm. See [Injury firm](#injury-firm).

Docker downloads the database image once. After that the demo runs offline without keys, and includes its own ad platform and alert receiver. Every name, number, amount and address is fictional.

The site is live. Open it with `?gclid=you&utm_id=30333` and its number becomes one from the pool, held for you while the page is open. The form and the text link work too: send the form and the contact it makes is on the Board. What was written and the consent to texts are not recorded here: the firm's own system keeps both.

## Setup

1. Open the stage. The caller's phone is at left, and the reviewer screen at right.
2. Press Space to run each scene. The phone shows what the caller does, and the screen opens the view that changed.
3. Press P to play the main story by itself in ninety seconds, R to start over, or H to hide the bar.

The phone is shown in a window at least 1,121 pixels wide. A narrower one shows the reviewer screen and the bar.

The story runs from a Monday to a Thursday that have passed. Each scene moves the demo's clock on, and the screens served by the demo go by that clock.

## Scenes

| Scene | Demonstrates | View |
| --- | --- | --- |
| 1 | An ad visit with `office=north` and `lang=es` in its address | Journey |
| 2 | A phone tap, and a call held uncounted until its result | Accounts |
| 3 | A caller who hung up in the queue: missed, uncounted, unsent | Board |
| 4 | A call back that reaches the person | Journey |
| 5 | Details entered by staff: the contact is tied to the call by phone at 85%, and the ad is not credited | Accounts |
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
| 17 | The other side of the matter with the same family phone and email, separated by the case system | Accounts |
| 18 | A call to a map listing's number, without a page load, filed under that listing | Channels |
| 19 | The form on the site in place of a call, credited by the browser | Board |
| 20 | A parent and child on one phone: related without joining | Matches |
| 21 | A night without calls: a stale feed and a delivered alert | Health |

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
- **Scale.** The demo has a few hundred people. See [Performance](performance.md) for measured speeds.
- **Clock.** Scene 21 moves the clock forward fourteen hours. Run it last.
- **Repeats.** Each scene runs once. Press R to start over.
- **Firm systems.** Call answering, scheduling, texts, forms, signing and card payment belong to a firm's own systems. The demo shows made-up screens for them, and makes the requests such systems would, with each text as `POST /text`. No live text, card payment or ad platform is used.
- **Links.** The demo opens every link in the browser of the first visit. One opened in another browser is another visitor.
