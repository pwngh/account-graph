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
3. Press P to play the whole show, R to start over, or H to hide the bar.

The phone is shown in a window at least 1,121 pixels wide. A narrower one shows the reviewer screen and the bar.

The story runs from a Monday to a Thursday that have passed. Each scene moves the demo's clock on, and the screens served by the demo go by that clock.

## Ninety-second script

Press P on the stage. After a count of three the bar hides and the show plays by itself, in time with these lines. Press P or Esc to stop it. It plays once: press R to start over, which takes a few seconds with `MEMORY=1` and about a minute with PostgreSQL.

| Time | On screen | What to say |
| --- | --- | --- |
| 0:00 | The phone: a search, the ad, the firm's site, a call, no answer. The caller on the **Board** | When someone clicks a law firm's ad and calls, and nobody picks up, that call often gets cut off from the ad that paid for it. |
| 0:15 | The call back, and staff entering the details | This is a sample firm with made-up data. Staff call back and take a name. The call and the visit are now tied to it, but not firmly enough to credit the ad. |
| 0:28 | The text, and the form it opens. Ad credit goes from 78% to 92% | They open a link staff texted, in the browser they came with. We now know whose phone this is, and the ad is credited. |
| 0:39 | The form sent, the documents signed. Their card moves along the **Board** | The form and the signature land on the same person, with no second contact. |
| 0:49 | A director scheduled, then calling on Wednesday | Staff schedule a director, who calls. Same timeline, still tied to the ad. |
| 1:00 | The enroll-and-pay link, and the payment | They enroll and pay, the payment is recorded, and it goes to a sample ad platform for that first click. |
| 1:14 | **Channels**: cost per client | So this is what each campaign cost per client. |
| 1:22 | **Journey**: one line from search to payment | The close. |

Costs per client depend on the day the demo runs, so do not read them out. Texts, forms, signing and card payment belong to the firm's own systems, so do not claim them. No live text, card payment or ad platform is used.

## Scenes

| Scene | Demonstrates | View |
| --- | --- | --- |
| 1 | An ad visit with `office=north` and `lang=es` in its address | Journey |
| 2 | A phone tap, and a call held uncounted until its result | Accounts |
| 3 | A caller who hung up in the queue: missed, uncounted, unsent | Board |
| 4 | A call back that reaches the person | Journey |
| 5 | Details entered by staff: the contact is tied to the call by phone at 85%, and the ad is not credited | Accounts |
| 6 | A signed link made for the contact, as staff would text it | Accounts |
| 7 | The link opened in the browser of the visit: tied at 92%, and the ad is credited | Accounts |
| 8, 9 | A form sent and documents signed, on the same person | Board |
| 10 | A call scheduled with a director, who is a tag on the step | Board |
| 11 | The director's call, on the same timeline | Journey |
| 12 | A signed link to enroll and pay | Journey |
| 13 | The payment recorded, by a different office than the ad named | Journey |
| 14 | The conversion sent to the ad platform for the first ad click | Journey |
| 15 | The client's value restated, from 400 to 1,250 | Journey |
| 16 | The other side of the matter with the same family phone and email, separated by the case system | Accounts |
| 17 | A call to a map listing's number, without a page load, filed under that listing | Channels |
| 18 | A parent and child on one phone: related without joining | Matches |
| 19 | A night without calls: a stale feed and a delivered alert | Health |

## Limitations

- **Scale.** The demo has a few hundred people. See [Performance](performance.md) for measured speeds.
- **Clock.** Scene 19 moves the clock forward fourteen hours. Run it last.
- **Repeats.** Each scene runs once. Press R to start over.
- **Firm systems.** Call answering, scheduling, texts, forms, signing and card payment belong to a firm's own systems. The demo shows made-up screens for them, and makes the requests such systems would.
- **Links.** The demo opens every link in the browser of the first visit. One opened in another browser is another visitor.
