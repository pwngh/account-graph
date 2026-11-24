# Matching

account-graph links subjects that share identifiers, scores each pair, and groups strong links into clusters. A subject is anything with an identity, such as `account:42` or `visitor:9f3c`. An identifier is `kind:value`, and each subject-identifier edge keeps a first and last sighting.

## Scoring

Two subjects that share an identifier get evidence from it:

```
evidence = weight × (2 / subjects sharing it) ^ dilution × 0.5 ^ (gap / halfLife)
```

| Term | Meaning |
| --- | --- |
| `gap` | Time from one subject's last sighting of the identifier to the other's first. Zero when they overlap. |
| `cap` | The most subjects an identifier can have and still give evidence. |
| `group` | Kinds that count once. The strongest reason adds to the score, and the others are shown. |
| `corroborates` | A kind that counts where the pair's other kinds already reach `related`. It creates no link by itself. |

A muted identifier gives no evidence.

Evidence that counts combines as a noisy-OR, `1 − Π(1 − evidence)`. Each identifier is one way two subjects could be one person, correct as often as its evidence states. The pair is two people only if every piece is a coincidence. At 0.9 (`same`) the pair joins one cluster, and at 0.5 (`related`) it is reported as related.

Scores depend only on stored data. The current time and the order of arrival leave them unchanged.

The default policy has no groups or corroborating kinds. [Presets](presets.md) has both: [the preset for contacts entered by staff](presets.md#contacts-entered-by-staff) defines a corroborating `name` kind.

### Kinds

| Kind | Weight | Cap | Half-life | Source |
| --- | --- | --- | --- | --- |
| `review` | 1.00 | 100 | none | A reviewer's join |
| `passkey` | 0.99 | 5 | none | A passkey's credential id, after your server verified the sign-in |
| `email` | 0.99 | 10 | none | Stored as the SHA-256 Google also accepts |
| `device` | 0.98 | 10 | none | First-party cookie or install id |
| `payment` | 0.97 | 10 | none | Card or bank token |
| `fingerprint` | 0.97 | 20 | 720 days | Vendor visitor id the server confirmed |
| `hardware` | 0.95 | 10 | none | Hashed machine id from your client |
| `carry` | 0.95 | 4 | none | A visitor who followed a link from another of your sites, proven by a token made for that browser. Thins when several browsers use one token |
| `link` | 0.92 | 5 | none | A link sent to one person, opened in this browser. Thins as more people's links are opened there |
| `dial` | 0.92 | 2 | none | A phone call or a text that began just after exactly one visitor tapped its number |
| `text` | 0.95 | 2 | none | A text that carried the code one visitor was given |
| `lease` | 0.90 | 2 | none | A phone call to a number shown to one visitor. An unmeasured prior |
| `phone` | 0.90 | 10 | none | A mobile or landline. Joins two subjects, relates three, and gives no link among four or more |
| `ga` | 0.90 | 10 | none | Google Analytics client id |
| `address` | 0.60 | 10 | none | A postal address confirmed to the door, which identifies a household |
| `voip` | 0.50 | 10 | none | A number from an internet calling app, which anyone can get and drop. Thins as more subjects share it |
| `canvas` | 0.50 | 20 | 45 days | Unconfirmed browser hash |
| `ip` | 0.30 | 10 | 14 days | IPv6 is stored as its /64 |
| `place` | 0 | 0 | none | Note: where an address places a visit |
| `opened` | 0 | 0 | none | Note: a browser opened the link sent to this person |
| `dialed` | 0 | 0 | none | Note: the number a visitor tapped, or a recorded call |

Notes give no evidence and link nothing.

## Clusters

Every subject reachable over `same` links forms a component. Three cuts, applied in order, divide a component into clusters.

1. **Separated pairs.** The direct link of each separated pair is removed.
2. **Paths between separated pairs.** If the two are still connected through others, the weakest set of links between them is cut. Strengths add up, so two weak links outweigh one.
3. **Weak bridges.** A link below 0.97 (`bridge`) cannot be the sole connection between two groups of two or more subjects. The weakest is cut first, until none remains. It may still add a single subject to a group. A group that names nobody, made only of browsers and phone numbers that called (`visitor:`, `caller:` and `call:`), then goes back to the named group it was cut from, if there is exactly one. With none or several, it stays apart.

For example, a chain of four accounts, each sharing one machine with the next, becomes two pairs. If the outer two also share a phone, all four form one cluster, because the groups are then connected twice.

A cluster above 50 members (`review`) is flagged `oversized`. Clusters that large come more often from one bad identifier than from one person.

### Cut algorithms

| Cut | Method | Cost and behavior |
| --- | --- | --- |
| Separated pairs | All direct links between separated pairs are removed. Each pair still connected, in order of id, is cut at minimum total strength: a maximum flow by shortest paths (Edmonds-Karp). Strength is `−log(1 − score)`, held to a maximum and rounded. Of all cheapest cuts, the unique one nearest the first subject is taken, so the result is independent of arrival order. | Each flow is at worst `O(V·E²)` in the subjects and links of one component. A component of hundreds is quick. |
| Weak bridges | Links below `bridge` are removed as described above. | The rule is off when `bridge` is at or below `same`. |

A component of tens of thousands indicates a shared identifier to cap or mute.

## Model assumptions

The result is a model score, uncalibrated as a probability. Correlated evidence makes it overconfident at any weights. Use [`fit`](library.md#fitting-the-weights) to compare it with pairs you have checked.

| Assumption | Where it fails |
| --- | --- |
| Coincidences are independent. | A household shares its phone, address and connection for one reason. Kinds in one `group` count once. Correlated kinds outside a group count twice. |
| Evidence only adds. | Shared and differing facts cannot lower a score. Two different dates of birth have no effect. Record the difference with `separate`. |
| One weight fits a kind. | A phone typed by staff is weaker than one a caller dialed from. Use [presets](presets.md). |
| Evidence fades with the gap. | Sightings that overlap do not fade, however old. A kind without a half-life keeps full evidence. |

## Asking about conflicts

`POST /conflicts` takes the people of a matter and answers which of them are kept apart, from each other or from anyone on record.

| `how` | Meaning |
| --- | --- |
| `recorded` | The two were separated |
| `same` | One is the same person as somebody separated from the other, or from somebody the other is |
| `possible` | One is only related to such a person. Somebody has to look. |

`rests` is the separated pair the answer rests on. Where the other side was not asked about, `b` is whoever on record they are kept apart from.

> **An empty list says that none is known here.** It does not say that there is none, and it does not replace your own conflict check. If the server cannot be reached, say that it was not asked.

## Decisions from your own systems

Your systems hold facts the graph cannot infer. Report them with `/separate` and `/join`.

| Fact | Owner | What to send |
| --- | --- | --- |
| Who is on the other side of a matter | Your case system. People who share a phone, a child or a case may be on one side or on two. | The pair, to `/separate`. |
| Which contact a call was about | Staff, when they take the call. | The caller and contact, to `/join`, when they are one person. A parent calling about a child is a separate person. [Caller attribution](presets.md#caller-attribution) depends on it. |
| Whether a person may be contacted | The system that sends messages. Consent here covers advertising only. | Message consent, opt-outs, quiet hours and contact frequency stay there. |

### Separate

Send a pair that is two people. The two stay in separate clusters while the decision stands.

```sh
curl -X POST https://graph.example.org/separate -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"source":"cases","pairs":[{"a":"contact:7","b":"contact:12","reason":"sides of one matter"}]}'
```

```json
{ "changes": [{ "subject": "contact:12", "from": "contact:7", "to": "contact:12" }], "recorded": 1, "already": 0 }
```

Send it at intake, when your conflict check runs, instead of in a later batch. Until it arrives, an outcome of one side can be credited to the other's ad click. Once it stands, neither is reached from the other, directly or through a third subject.

A list is written in one transaction, with one decision per pair by `system:cases`. A pair whose last report agrees and still holds is left alone, so a system can send its whole list again.

> **Reasons are permanent.** A reason stays in the audit log after its subjects are deleted. Name the kind of matter and leave out the matter itself.

### Join

Report a record merge in another system to `/join`. A join can be undone. Calling `forget` on the merged-away record deletes what it knew.

### Conflicting reports

| Case | Result |
| --- | --- |
| One person entered on both sides | Split, and stays split until the pair is withdrawn with `separated: false`. |
| Two records of one person sent as a pair | The duplicate is blocked until the pair is withdrawn. |
| Two systems that disagree | Each report that contradicts the last is recorded. A separation holds over a join. At three contradictions the pair is flagged on the reviewer screen and in `GET /disputes`. |

System separations bias `fit`, because they were picked for what the two share. `reviewed({ exclude: 'system:' })` leaves them out.

## Measured weights

The `fingerprint`, `canvas` and `ip` rows are set from these figures.

| Identifier | Values that belonged to one person only | Same person on the next sighting, by days since the last |
| --- | --- | --- |
| Vendor fingerprint | 98% | 98% up to 30 days, 95% at 31–90, 86% past 90 |
| Home-made canvas and user-agent hash | 53% | about 55% up to 7 days, 23% at 31–90, 7% past 90 |
| IP address | 46% | 89% next day, 73% in a week, 37% in a month, 5% past 90 |

The defaults follow from these measurements:

- **Vendor fingerprint.** It can join two subjects alone and fades slowly.
- **Home-made hash.** Phones of one model share it, so it relates subjects without joining them. Attribution based on it alone is wrong about half the time.
- **Shared values.** A handful of fingerprints, each shared by more than twenty people, can produce most same-fingerprint pairs. Under 2% of those pairs are one person, and caps exclude them.
- **IP address.** One shared by exactly two people points at the same one about 42% of the time, and by three to five about 9%. Its evidence thins with the square of the number sharing it.

The other rows are unmeasured priors, including 0.60 for postal `address`. `measure` and `fit` compute values from pairs you have confirmed by hand.

## Changing the policy

Change a setting, then call `rebuild()` to recompute every cluster under the new policy. On the server, set the change in `POLICY` and post to `/rebuild`. See [the policy](operations.md#policy).

```ts
import { createGraph, defaultPolicy } from 'account-graph'

let policy = { ...defaultPolicy, kinds: { ...defaultPolicy.kinds, hardware: { ...defaultPolicy.kinds.hardware, weight: 0.8 } } }
let graph = createGraph(store, policy)
await graph.rebuild({ by: 'ops', reason: 'hardware ids are shared in internet cafes' })
```

| Symptom | Change |
| --- | --- |
| Household members joined by a phone and an address together | Put the kinds a household shares in one `group`. |
| Strangers joined, always by one kind | Lower that kind's `weight` below `same` (0.9), so it relates without joining. |
| One value joins many subjects, such as a shared mailbox or a kiosk | `ignore` that value. If it recurs for the kind, lower the kind's `cap`. |
| Known duplicates are only related | Raise the `weight` of the kind they share, or record more identifiers at sign-in. |
| Subjects joined by sightings months apart | Shorten the kind's `halfLife`. |
| Two groups joined through one account that touches both | Raise `bridge`. |
| Too many or too few clusters flagged for review | Change `review`, the flagging size. |

`fit(await graph.reviewed(), policy)` sets every weight from the pairs your reviewers joined or separated, and reports how far each moved.

A setting applies to every subject. Fix a single pair with a reviewer decision: `separate`, `join` or `ignore`.

### Checked pairs from a file

`tools/labels.ts` reads a CSV of checked pairs and asks a running server what each pair shares. It prints precision and recall per kind, the counts behind them, and the weights `fit` would give. It is read-only, so a reviewer's token is enough.

```sh
printf 'a,b,label\ncontact:1,contact:2,same\ncontact:3,contact:9,different\n' > pairs.csv
GRAPH_URL=https://graph.example.org GRAPH_TOKEN=$REVIEWER npm run labels -- pairs.csv
```

A pair labelled both ways is left out and counted.

## Limitations

- **Conflict checks.** account-graph runs none. `/separate` acts on pairs you already know, and whom you may serve stays your decision.
- **Shared browsers.** A browser that both sides and a third person used can still be reached from each side.
- **Many separations in one component.** Pairs are cut one after another, which can remove more in total than the best combined cut. The exact multicut or multiway cut is hard to compute.
- **Score calibration.** Clusters come from the cuts above and carry no probability.
- **Staff labels.** Staff find pairs that already look alike. A kind they search by looks better than it is, and strangers who share it are hardly in the file.
- **Deleted evidence.** A merged record whose evidence was deleted cannot be used as a checked pair. The tool counts these, which were often the surest pairs.
