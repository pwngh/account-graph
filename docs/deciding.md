# How it decides

A subject is anything with an identity: `account:42`, `visitor:9f3c`. An identifier is `kind:value`. The graph is the set of subject-identifier edges, each with a first and last sighting.

Two subjects that share an identifier get evidence from it:

```
evidence = weight × (2 / subjects sharing it) ^ dilution × 0.5 ^ (gap / halfLife)
```

`gap` is the time between the two subjects' sightings of it, and zero when they overlap. An identifier shared by more subjects than its `cap` gives no evidence. Evidence from several identifiers combines as `1 − Π(1 − evidence)`. At 0.9 the pair joins one cluster; at 0.5 it is reported as related.

Evidence that comes together is not independent. Kinds the policy puts in one `group` count once: of the reasons in a group, the strongest adds to the score and the others are shown and do not. The default policy has no groups. [Presets](presets.md) has one that does.

Scores depend only on stored data, never on the current time or on arrival order.

| Kind | Weight | Cap | Half-life | What it is |
| --- | --- | --- | --- | --- |
| `review` | 1.00 | 100 | none | A reviewer joined these by hand |
| `passkey` | 0.99 | 5 | none | A passkey's credential id, after your server verified the sign-in |
| `email` | 0.99 | 10 | none | Stored as the SHA-256 Google also accepts |
| `device` | 0.98 | 10 | none | First-party cookie or install id |
| `payment` | 0.97 | 10 | none | Card or bank token |
| `fingerprint` | 0.97 | 20 | 720 days | Vendor visitor id the server confirmed |
| `hardware` | 0.95 | 10 | none | Hashed machine id from your client |
| `carry` | 0.95 | 4 | none | A visitor who followed a link from another of your sites, proven by a token made for that browser. Thins when one token is used by several |
| `link` | 0.92 | 5 | none | A link sent to one person, opened in this browser. Thins as more people's links are opened there |
| `lease` | 0.90 | 2 | none | A phone call to a number that was shown to one visitor. A prior: nothing measured stands behind it |
| `dial` | 0.92 | 2 | none | A phone call that began just after exactly one visitor tapped its number |
| `phone` | 0.90 | 10 | none | A mobile or landline. Thins as more subjects share it: alone it joins two, relates three, and reports nothing among four or more |
| `address` | 0.60 | 10 | none | A postal address confirmed to the door. A household, not a person |
| `voip` | 0.50 | 10 | none | A number from an internet calling app, which anyone can get and drop. Thins as more share it |
| `ga` | 0.90 | 10 | none | Google Analytics client id |
| `canvas` | 0.50 | 20 | 45 days | Browser hash nothing confirmed |
| `ip` | 0.30 | 10 | 14 days | IPv6 is kept as its /64 |
| `place` | 0 | 0 | none | A note, not evidence: where an address places a visit. It links nothing |
| `opened` | 0 | 0 | none | A note, not evidence: a browser opened the link sent to this person. It links nothing |
| `dialed` | 0 | 0 | none | A note, not evidence: the number a visitor tapped, or a recorded call. It links nothing |

### From links to clusters

Every subject reachable over `same` links forms a component. A cluster is what is left of a component after three cuts, in this order.

1. **A pair a reviewer separated is never linked.**
2. **If the two are still connected through others, the weakest set of links between them is cut.** Evidence adds up along the way, so two weak links outweigh one.
3. **One link below 0.97 cannot be the only thing joining two groups.** It may add a single account to a group. Two groups of two or more need a strong link or a second, separate link. The weakest such link is cut first, then the next.

So a chain of four accounts, each sharing one machine with the next, becomes two pairs. Give the outer two a shared phone and it becomes one cluster, because the groups are now tied twice.

A cluster with more than 50 members is flagged `oversized`. A cluster that big is more often one bad identifier than one person.

### Decisions from your own systems

A system of yours may know that two people are not one person, whatever they share. Send the pair, and the two never share a cluster while it stands.

```sh
curl -X POST https://graph.example.org/separate -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"source":"cases","pairs":[{"a":"contact:7","b":"contact:12","reason":"sides of one matter"}]}'
```

```json
{ "changes": [{ "subject": "contact:12", "from": "contact:7", "to": "contact:12" }], "recorded": 1, "already": 0 }
```

Send it when your own conflict check runs, at intake, and not in a batch later. Until it arrives, an outcome of one side can be credited to the other's ad click. Once it is there, neither is reached from the other, directly or through a third subject. A browser that both sides and a third person used can still be reached from each.

> **This is not a conflict check.** It keeps two subjects you already know about apart in the graph. It finds nobody, and it decides nothing about whom you may serve.

A list is written in one transaction, with one decision for each pair by `system:cases`. A pair whose last report says the same and still holds is left alone, so a system can send its whole list again. Give a reason that names the kind of matter, never the matter itself: the reason is kept in the record for good, after the subjects are forgotten too.

When another system merges two records, report it to `/join` the same way. It is a join and can be undone. Do not `forget` the record that was merged away, which deletes what it knew.

| What to expect | Detail |
| --- | --- |
| One person entered on both sides | They are split, and stay so until the pair is withdrawn with `separated: false`. |
| Two records of one person sent as a pair | That duplicate is blocked until the pair is withdrawn. |
| Many separations in one component | They are cut one after another, which is not always the fewest links possible. |
| Two systems that disagree | Each report that contradicts the last is recorded, and a separation holds over a join. At three contradictions the pair is flagged on the reviewer screen and in `GET /disputes`. |
| `fit` | System separations are biased: they were picked because the two share something. `reviewed({ exclude: 'system:' })` leaves them out. |

## What the weights rest on

The fingerprint, canvas, and `ip` rows are set from how these identifiers behave in production, measured where the person behind each visit was known.

| Identifier | Values that only ever belonged to one person | Same person on the next sighting, by days since the last |
| --- | --- | --- |
| Vendor fingerprint | 98% | 98% up to 30 days, 95% at 31–90, 86% past 90 |
| Home-made canvas and user-agent hash | 53% | about 55% up to 7 days, 23% at 31–90, 7% past 90 |
| IP address | 46% | 89% next day, 73% in a week, 37% in a month, 5% past 90 |

Three things follow, and the defaults encode each.

- **A vendor fingerprint is strong and slow to fade.** It can join two subjects on its own.
- **A home-made hash is a coin flip.** Phones of one model share it. It can relate two subjects, never join them. Attribution that rests on it alone is wrong about half the time.
- **A few identifiers are shared by crowds.** A handful of fingerprints, each shared by more than twenty people, can produce most of the same-fingerprint pairs, and under 2% of those pairs are one person. Without a cap, those few values would merge hundreds of strangers.

An IP address shared by exactly two people points at the same one about 42% of the time, and by three to five people about 9%. That is why its evidence thins with the square of how many share it.

The other rows are priors, the postal `address` among them: no measurement stands behind its 0.60. `measure` and `fit` compute the real values from pairs you have confirmed by hand.

## Changing the settings

Change a setting when the graph is wrong in a way you can name. Then call `rebuild()`, which recomputes every cluster under the new policy. On the server, name the change in `POLICY` and post to `/rebuild`; [the policy](operations.md#the-policy) says how.

```ts
import { createGraph, defaultPolicy } from 'account-graph'

let policy = { ...defaultPolicy, kinds: { ...defaultPolicy.kinds, hardware: { ...defaultPolicy.kinds.hardware, weight: 0.8 } } }
let graph = createGraph(store, policy)
await graph.rebuild({ by: 'ops', reason: 'hardware ids are shared in internet cafes' })
```

| What you see | What to change |
| --- | --- |
| Members of a household joined, by a phone and an address together | Put the kinds a household shares in one `group`. |
| Strangers joined, and the reason is always one kind | Lower that kind's `weight` below `same` (0.9), so it can relate but not join. |
| One value joins many subjects: a shared mailbox, a kiosk | `ignore` that value. If it keeps happening for the kind, lower the kind's `cap`. |
| Known duplicates are only "related" | Raise the `weight` of the kind they share, or record more identifiers at sign-in. |
| Subjects joined by sightings months apart | Shorten the kind's `halfLife`. |
| Two groups joined through one account that touches both | Raise `bridge`, so one link has to be stronger to join groups. |
| Too many clusters flagged for review, or too few | Change `review`, the size past which a cluster is flagged. |

> **Measure before you guess.** `fit(await graph.reviewed(), policy)` sets every weight from the pairs your reviewers joined or kept apart, and reports how far each moved.

A setting applies to every subject. To fix one pair, use a reviewer decision instead: `separate`, `join`, or `ignore`.

### From a file of checked pairs

`tools/labels.ts` takes a CSV of pairs somebody has checked, and asks a running server what each pair shares. It prints precision and recall for each kind, with the counts behind them, and the weights `fit` would give. It writes nothing, so a reviewer's token is enough.

```sh
printf 'a,b,label\ncontact:1,contact:2,same\ncontact:3,contact:9,different\n' > pairs.csv
GRAPH_URL=https://graph.example.org GRAPH_TOKEN=$REVIEWER npm run labels -- pairs.csv
```

| What limits it | Why |
| --- | --- |
| Labels from staff are biased | They find the pairs that already look alike. A kind they search by looks better than it is, and strangers who share it are hardly in the file. |
| A merged record whose evidence was deleted cannot be used | Nothing is left to say what the two shared. The tool counts these, and they were often the surest pairs. |
| A pair labelled both ways | Left out, and counted. |
