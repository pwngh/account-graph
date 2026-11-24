# How it decides

A subject is anything with an identity: `account:42`, `visitor:9f3c`. An identifier is `kind:value`. The graph is the set of subject-identifier edges, each with a first and last sighting.

Two subjects that share an identifier get evidence from it:

```
evidence = weight × (2 / subjects sharing it) ^ dilution × 0.5 ^ (gap / halfLife)
```

`gap` is the time between the two subjects' sightings of it, and zero when they overlap. An identifier shared by more subjects than its `cap` gives no evidence. Evidence from several identifiers combines as `1 − Π(1 − evidence)`. At 0.9 the pair joins one cluster; at 0.5 it is reported as related.

Scores depend only on stored data, never on the current time or on arrival order.

| Kind | Weight | Cap | Half-life | What it is |
| --- | --- | --- | --- | --- |
| `review` | 1.00 | 100 | none | A reviewer joined these by hand |
| `passkey` | 0.99 | 5 | none | A passkey's credential id, after your server verified the sign-in |
| `email` | 0.99 | 25 | none | Stored as the SHA-256 Google also accepts |
| `device` | 0.98 | 10 | none | First-party cookie or install id |
| `payment` | 0.97 | 10 | none | Card or bank token |
| `fingerprint` | 0.97 | 20 | 720 days | Vendor visitor id the server confirmed |
| `hardware` | 0.95 | 10 | none | Hashed machine id from your client |
| `carry` | 0.95 | 4 | none | A visitor who followed a link from another of your sites, proven by a token made for that browser. Thins when one token is used by several |
| `link` | 0.92 | 5 | none | A link sent to one person, opened in this browser. Thins as more people's links are opened there |
| `dial` | 0.92 | 2 | none | A phone call that began just after exactly one visitor tapped its number |
| `phone` | 0.90 | 25 | none | A mobile or landline |
| `address` | 0.60 | 10 | none | A postal address confirmed to the door. A household, not a person |
| `voip` | 0.50 | 25 | none | A number from an internet calling app, which anyone can get and drop |
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

## What the weights rest on

The fingerprint, canvas, and address rows are set from how these identifiers behave in production, measured where the person behind each visit was known.

| Identifier | Values that only ever belonged to one person | Same person on the next sighting, by days since the last |
| --- | --- | --- |
| Vendor fingerprint | 98% | 98% up to 30 days, 95% at 31–90, 86% past 90 |
| Home-made canvas and user-agent hash | 53% | about 55% up to 7 days, 23% at 31–90, 7% past 90 |
| IP address | 46% | 89% next day, 73% in a week, 37% in a month, 5% past 90 |

Three things follow, and the defaults encode each.

- **A vendor fingerprint is strong and slow to fade.** It can join two subjects on its own.
- **A home-made hash is a coin flip.** Phones of one model share it. It can relate two subjects, never join them. Attribution that rests on it alone is wrong about half the time.
- **A few identifiers are shared by crowds.** A handful of fingerprints, each shared by more than twenty people, can produce most of the same-fingerprint pairs, and under 2% of those pairs are one person. Without a cap, those few values would merge hundreds of strangers.

An address shared by exactly two people points at the same one about 42% of the time, and by three to five people about 9%. That is why its evidence thins with the square of how many share it.

The other rows are priors. `measure` and `fit` compute the real values from pairs you have confirmed by hand.

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
| Strangers joined, and the reason is always one kind | Lower that kind's `weight` below `same` (0.9), so it can relate but not join. |
| One value joins many subjects: a shared mailbox, a kiosk | `ignore` that value. If it keeps happening for the kind, lower the kind's `cap`. |
| Known duplicates are only "related" | Raise the `weight` of the kind they share, or record more identifiers at sign-in. |
| Subjects joined by sightings months apart | Shorten the kind's `halfLife`. |
| Two groups joined through one account that touches both | Raise `bridge`, so one link has to be stronger to join groups. |
| Too many clusters flagged for review, or too few | Change `review`, the size past which a cluster is flagged. |

> **Measure before you guess.** `fit(await graph.reviewed(), policy)` sets every weight from the pairs your reviewers joined or kept apart, and reports how far each moved.

A setting applies to every subject. To fix one pair, use a reviewer decision instead: `separate`, `join`, or `ignore`.
