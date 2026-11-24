# The demo

A made-up law firm with three offices, North, River and Online, and two languages. One command starts everything:

```sh
npm ci
npm run firm
```

| It starts | Where |
| --- | --- |
| A throwaway PostgreSQL, in Docker | Deleted when you stop. With no Docker, everything is kept in memory. With `DATABASE_URL`, it uses a schema named `firm_demo` there. |
| The graph server and its reviewer screen | `http://localhost:8790/review`. Sign in with the token `demo`. |
| The firm's site, in English and Spanish | `http://localhost:8791/?gclid=you&utm_id=30111` and `/es` |
| The presenter page | `http://localhost:8791/present` |
| Two months of seeded history | Filled in a few seconds in memory, about a minute in PostgreSQL. |

Docker fetches the database image once. After that nothing needs a network or a key: the ad platform and the alert's receiver are part of the demo. Every name, number, amount and address in it is made up.

## Before you start

1. Open the presenter page, and the reviewer screen in a tab beside it. Sign in.
2. On the presenter page, press Space for each scene. It says what happened and how long it took, and links to the view it changed.
3. Run all ten scenes before the talk, or run them as you go. Each takes well under a second.

## Ninety seconds

| | Show | Say |
| --- | --- | --- |
| 0:00 | **Board** | Everyone who called or asked is in one column. On the left are the people who rang and were not rung back. Nobody is assigned here; it is read from what happened. |
| 0:15 | **Calls** | Scene 3 was a person who waited in the queue and hung up. The phone system picked up, so most trackers would count that and pay the ad platform for it. Here it is a miss. Scene 4 rang back, so it is returned. |
| 0:30 | **Journey** | One person, from the Spanish ad to what they paid: the arrival, the tap, the miss, the call back, the inquiry, and the value that changed from 400 to 1,250. Each line says why it is this person. |
| 0:50 | **Channels**, broken down by office served | What each campaign cost and what followed. The ad said North and River served them. One week of the Online campaign has no costs recorded, and it says so and not zero. |
| 1:05 | **Decide** | A parent and a child share a phone. They are related, and not one person, until somebody who knows says so. Two sides of one matter share a phone and an email, and are kept apart for good. |
| 1:20 | **Health** | Fourteen hours pass and no call comes. A quiet feed is usually a broken one, so somebody is told. |

## The scenes

| | What happens | Look at |
| --- | --- | --- |
| 1 | An ad visit with `office=north` and `lang=es` in its address. | Channels |
| 2 | They tap the number. The call waits for its result, uncounted. | Calls |
| 3 | The result: they hung up in the queue. Missed, not counted, not sent. | Board |
| 4 | Staff ring back and reach them, and say which contact it is. The inquiry is sent, credited to the ad. | Journey |
| 5 | Somebody rings the number on a map listing. No page was loaded, and the call is filed under that listing. | Channels |
| 6 | They become a client, served by another office than the ad named. | Channels |
| 7 | The other side of the matter gives the same family phone and email. The case system keeps the two apart. | Accounts |
| 8 | A parent and a child give one phone. Related, not joined. | Decide |
| 9 | What the client paid is known, and the step is restated. | Journey |
| 10 | A night with no calls. The feed is quiet, and an alert is delivered. | Health |

The site is live too. Open it with `?gclid=you&utm_id=30333` and the number on it becomes one of the pool's, yours while the page is open.

## Limits

| Limit | Detail |
| --- | --- |
| Not a benchmark | A few hundred people. The [README](../README.md) has measured speeds. |
| The night | Scene 10 moves the demo server's clock on fourteen hours. The browser's own clock does not move, so ages there and times here differ after it. Run it last. |
| Once through | A scene runs once. Restart the command to start over. |
| The staff's side | Who answers calls, who is assigned and what is said to clients are a firm's own systems. The demo only reports what they would. |
