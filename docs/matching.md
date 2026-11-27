# Matching

account-graph links subjects that share identifiers, scores each pair, and groups strong links into clusters. A subject is anything with an identity, such as `account:42` or `visitor:9f3c`. An identifier is `kind:value`, and each subject-identifier edge keeps a first and last sighting.

## Terms

| Term | Definition |
| --- | --- |
| Subject | A person, account or device that has an ID in one of your systems |
| Identifier | A value that helps recognize a subject, such as an email or device ID |
| Sighting | An observation of a subject with an identifier at a point in time |
| Link | Two subjects that share identifiers, with a match score and evidence |
| Cluster | The linked subjects that are resolved to one person |
| Visit | An arrival from an ad click or a campaign |
| Outcome | A business event that is counted, such as an inquiry or a sale |
| Conversion | An outcome reported to an ad platform |
| Decision | A recorded choice to merge, split or mute, kept in the audit log |

A subject is written `type:id`, such as `account:42`, and an identifier `kind:value`, such as `device:9f3c`. A match score is from 0 to 1. The reviewer screen calls a subject an ID, a merge a join, and a split a separation. The calls name a visit an `arrival`, and an outcome a `conversion`. Links, clusters and scores are computed from sightings.

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
| `relates` | A kind that says two subjects are two people. The pair is related, and kept apart as a separated pair is, whatever it shares, unless a reviewer or a system joins it. |

A muted identifier gives no evidence.

A statement about one call withdraws the line and browser evidence that came from that call. The original holders still count when scoring everybody else, including a proposed record. Two records that gave a shared number cannot become a stronger match because staff identified a call. Later calls still compete for the tap or number they dialed.

A withdrawn tie can also change where a separation cuts a group. The graph keeps people together only where they can remain together with any combination of those call ties withdrawn. Repeated carrier readings of one line count once when their dates, kinds and holder counts give the same evidence. Calls with different taps or dates that could change a match still count separately. Even above 64 readings, agreeing facts and links that no separation or weak bridge can cut keep a client with their duplicate records and browsers. Where more than 64 distinct readings still leave doubt, the graph keeps only the links it can establish across them. The reviewer sees a notice on the affected group's account page. A zero-weight tap can still permit corroboration when the related threshold is zero, so it counts among the possible readings. Journeys and campaign credit respect those same cuts. Other groups are scored separately. Muting or restoring a line, or forgetting one of its holders, checks both possible line kinds. A mute preview lists affected groups and keeps private call holders out of the list.

Evidence that counts combines as a noisy-OR, `1 − Π(1 − evidence)`. Each identifier is one way two subjects could be one person, correct as often as its evidence states. The pair is two people only if every piece is a coincidence. At 0.9 (`same`) the pair joins one cluster, and at 0.5 (`related`) it is reported as related.

Scores depend only on stored data. The current time and the order of arrival leave them unchanged.

| Two records share | Evidence | Score | Result |
| --- | --- | --- | --- |
| A browser, by its device id | 0.98 | 0.98 | Can join |
| A mobile or landline number | 0.90 | 0.90 | Can join |
| A postal address and an IP address | 0.60, 0.30 | 0.72 | Related |
| An address, an IP address and a browser hash | 0.60, 0.30, 0.50 | 0.86 | Related |

The last two could be one person or one household. With only this evidence, they are related and do not join on their own. These rows use the default weights, with two records per identifier and no time between sightings. A strong pair can still be [held apart](#clusters): by a separation, or as a single weak link between two groups.

Under the default policy, a shared phone alone can make `lookup` with `kind: "match"` return `same` for someone else, including an opposing party. Treat `match` as a suggestion for staff to check. Never use it to block intake. Where a wrong join matters, use the [intake preset](#an-intake-desk) and load known separations with [`split`](#split) before entering the first contact.

The default policy has no groups, and one corroborating kind, `named`. [Presets](#presets) has both. For example, [the preset for contacts entered by staff](#contacts-entered-by-staff) defines a corroborating `name` kind.

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
| `text` | 0.95 | 2 | none | A text that carried the code one visitor was given, or a call whose caller read it out |
| `named` | 0.999 | 10 | none | One number or email given under one name. It corroborates. Written where a policy keeps people apart by `given` |
| `ward` | 0.97 | 5 | none | Two who were spoken for by one number or email, under one name |
| `behalf` | 0.92 | 2 | none | Somebody who [speaks for](identify.md#speaking-for-somebody-else) somebody else. It relates and never joins |
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

Every subject reachable over `same` links forms a component. When checking a name changes a link, the component also includes the subjects reachable under the earlier spelling so a later report can update everyone affected. Three cuts, applied in order, divide a component into clusters.

1. **Separated pairs.** The direct link of each separated pair is removed, and of each pair whose [facts differ](#facts-that-keep-people-apart).
2. **Paths between separated pairs.** If a pair that staff separated is still connected through others, the graph cuts guessed links wherever that keeps every active merge. If a path consists entirely of merges, the separation stands and the cut breaks as few merged links as possible. Among cuts that break the same number, it takes the weakest set of links. After all separations hold, the graph reconsiders the merges it cut, in order of the two subject IDs. It restores a merge if the two groups can come together while every separated pair stays apart. Guessed links inside the reunited group count again when applying the [rules for conflicting facts](#facts-that-keep-people-apart).
3. **Weak bridges.** A link below 0.97 (`bridge`) cannot be the sole connection between two groups of two or more subjects. The weakest is cut first, until none remains. It may still add a single subject to a group. A group that names nobody is made only of browsers and phone numbers that called, under `visitor:`, `caller:` and `call:`. Such a group then goes back to the named group it was cut from, if there is exactly one. With none or several, it stays apart.

For example, a chain of four accounts, each sharing one machine with the next, becomes two pairs. If the outer two also share a phone, all four form one cluster, because the groups are then connected twice.

A cluster above 50 members (`review`) is flagged `oversized`. Clusters that large come more often from one bad identifier than from one person.

When a separation keeps an active staff join out of the cluster, open either subject's Links to see its join evidence. Decisions shows the original join and the separation. Matches lists undecided pairs, so it does not offer that join again.

### Cut algorithms

| Cut | Method | Cost and behavior |
| --- | --- | --- |
| Separated pairs | All direct links between separated pairs are removed. Each pair still connected is processed in order of ID by a maximum flow using shortest paths, the Edmonds-Karp method. After preserving as many merges as possible, the cut minimizes total strength. Strength is `−log(1 − score)`, capped and rounded. If several cuts tie, the one nearest the subject with the later first sighting wins. Equal times favor the cut nearest the smaller ID. | The flows for staff separations share one index of the component's links and their strengths. Each flow takes at worst `O(V·E²)` time and `O(V+E)` space for `V` subjects and `E` links. |
| Weak bridges | Links below `bridge` are removed as described above. | The rule is off when `bridge` is at or below `same`. |

With no `apart` facts, a full verification or rebuild rereads edges for staff joins only in components containing both ends of a separation or a link that says two people are different.

Once a cut separates two records, later comparisons of their birth dates can skip the search for a path. The remaining pairs are cut in the same order.

A component of tens of thousands indicates a shared identifier to cap or mute.

## Presets

A preset is a policy for a common situation. Set `POLICY_FILE` and the server applies it over the default.

```sh
POLICY_FILE=examples/household.json npm start
```

Rebuild after switching to or from a preset. See [the policy](operations.md#policy). The preset's weights are priors chosen for the situation. [Checked pairs](#checked-pairs-from-a-file) give values of your own.

### Contacts entered by staff

Use `examples/household.json` for a list that staff type in, where a parent, a child and a former spouse share one phone on file. The default policy suits people who contact you themselves, where the caller usually owns the number.

<!-- schema config -->
```json
{
  "kinds": {
    "phone": { "weight": 0.85, "dilution": 1, "cap": 10, "halfLife": 63072000000, "group": "household" },
    "voip": { "group": "household" },
    "address": { "group": "household" },
    "ip": { "group": "household" },
    "name": { "weight": 0.6, "dilution": 1, "cap": 5, "halfLife": "none", "group": "name", "corroborates": true }
  }
}
```

Under the preset, a phone alone relates two people without joining them. A phone, an address and an internet connection count once between them, because a household shares all three.

| Two subjects share | Default | Preset |
| --- | --- | --- |
| A phone | 0.90, joined | 0.85, related |
| A phone and a confirmed address | 0.96, joined | 0.85, related |
| A phone and an email | joined | joined |
| An IP and a confirmed address | 0.72, related | 0.60, related |
| A phone and a name | 0.90, joined | 0.94, joined |
| A name | kind absent | no link |

A name confirms a link that a phone, email or address already made. The two must be related without it, and share a first and last name with the same zip code or date of birth. See [Names](identify.md#names).

> **Names repeat in families.** A father and son, or mother and daughter, with one name at one address are joined once they also share a phone. `split` them when you know they are two people.

Phone evidence halves for each two years between the two sightings, because numbers change hands.

#### Caller attribution

Under the household preset, a contact who gave the caller's number is usually related to the line. Staff who know which record a particular call concerned can identify that call by its provider ID.

<!-- schema RecordEntry -->
```json
{ "type": "call_update", "key": "desk-CA1", "at": 1795460000000, "call": "CA1",
  "change": { "kind": "party", "role": "self", "subject": "contact:7", "by": "desk" } }
```

Use `representative` when someone called on the contact's behalf. Each later call can concern a different person. See [recording who was on one call](calls.md#recording-who-was-on-one-call).

#### Shared phones

Keep a shared phone on each person, and record what you know about the two. Removing the number can remove a guessed link. A confirmed call stays with its stated owner.

| What you know | Action |
| --- | --- |
| They are one person | `merge` the two. |
| They are two people, and the distinction has no consequence | Leave them related. |
| They are two people and must stay distinct | `split` them. |
| The number belongs to a front desk, a shelter or a school | `mute` that number. |

### An intake desk

Use `examples/intake.json` where mixing two people's records is worse than leaving one person with two, such as a law firm or a clinic. It is the preset above, and:

<!-- schema config -->
```json
{ "apart": ["birth", "given"], "records": "confirmed", "credit": 0.75 }
```

Send the `name` and `dob` you have with each `profile`. Without them nothing confirms that two records are one person, and each stays by itself until somebody joins them.

| Ask at intake | Send |
| --- | --- |
| Is this for yourself or for somebody else? Make it a required question. | Whoever calls or fills in the form as [`speaker`](identify.md#speaking-for-somebody-else) |
| First and last name, and date of birth, every time. Most duplicates that are missed have no date on one of the two. | `name` and `dob`, and a `match` before you enter somebody |
| Was this call about the person on screen? | A `call_update` with the record and the role the caller had on this call |
| Who is on the other side? | A [`split`](#split) |

### Custom presets

Write a policy the same way, rebuild, and start the server with it. A group is any name you choose, and kinds with the same group count once between them.

## Facts that keep people apart

Two records can share an email and a phone and still be two people. A policy can keep them apart by a date of birth, a first name, or both:

<!-- schema config -->
```json
{ "apart": ["birth", "given"] }
```

```text
contact:1 { email, born 1980-02-03 } ──┐
                                       ├─ share an email, born on two days ──▶ kept apart, shown as related
contact:2 { email, born 1984-07-01 } ──┘
```

The server then keeps a keyed `birth` of each `dob` in a [`profile`](identify.md), as a note that links nothing. Two subjects that would be in one group, both have a `birth`, and share no value of it are kept apart, whatever path joins them.

With `given` it keeps keyed notes of the names a first name may stand for, from the table in `src/core/names.ts`: `Bob` stands for `Robert`, and `Lupe` for `Guadalupe`. Catherine and Katherine, Kaitlyn and Caitlin, and Gerald and Jerry each share a possible full name. Gerald and Jeremiah stay distinct even though both can be called Jerry. Send the name again to record a newly recognized form.

| Two records | Come to |
| --- | --- |
| Dates that differ | Two people, unless the names agree and the dates have the year or the day and month in common. A father and a son of one name are two. |
| First names that can stand for no one name | Two people, unless the dates agree, or the names begin with one letter. A mother and a daughter who share a day of birth, and an Alex and an Alexandra, are then one where they share a number. |
| A name the table does not have | Nothing is said. |
| One number or email under one name | Confirmed, at 0.999 (`named`), for as long as the number or email is evidence. |
| Two who were [spoken for](identify.md#speaking-for-somebody-else) by one number or email, under one name | One person, at 0.97 (`ward`), and never the speaker, whatever name is typed. |

| Point | Behavior |
| --- | --- |
| One of them has no date | Nothing is said. |
| A merge, by a reviewer or from your own systems | Overrules it, whichever came first. Taking the merge back gives the fact back. The exception is a caller or a browser joined to two people of two dates of birth: it goes where the fewest such joins are left out, then with whoever was seen first, and the others are in Matches. Same changes nothing there: `split` the caller from the one it is not. |
| Where it shows | The `match` lookup counts the proposed record when applying caps to evidence and confirming facts. It checks facts on the candidate itself, including a caller or browser, and on the records it stands for. Withdrawing a call tie cannot turn a possible match into a definite one. A browser's former record can still rule out the proposed match. Its id and facts stay private. The lookup, Accounts and Matches show a conflict as related with `conflict: "birth"` or `"given"`, however high the score. Credit does not cross it. |
| Where it does not | The `conflicts` lookup, kept-apart lists, disputes and the audit log. Nobody decided it. |
| A corrected date | The record keeps both values, so it is kept apart from neither, until it is forgotten. |
| Shared browsers and callers | They go with one of the two, as after a separation. |
| Turning it on, or a new version of it | Rebuild once. Dates and names sent before are not known, or not all that is now kept of them. Send them again. |

It is off unless a policy lists it, as [the preset for an intake desk](#an-intake-desk) does. [Accuracy](accuracy.md#the-second-run) says what it did on made-up people, where it was still far from its bar. In [the third run](accuracy.md#results-of-the-third-run), eight of fifty marks came out bad.

## Records that have to be confirmed

What two records share, such as a mailbox, a number or a computer, may be a household's. With `"records": "confirmed"`, sharing it does not make them one person. The policy must also have `apart`, because it goes by those facts.

| Two records | Are |
| --- | --- |
| Somebody merged | One person |
| Agree on a date of birth, and differ in no name | One person, where what they share joins them |
| Have one first name, or one has a part of the other's two words, and differ in no date | One person, where what they share joins them |
| Have names that may stand for one another, such as Robert and Bob | One person with an agreeing date of birth, and unconfirmed without |
| Differ in a date of birth or a first name, or have two words of which one is another, such as Maria Elena and Maria Guadalupe | Two |
| Fit two others who differ, such as a Juan with no date beside a father and a son of that name | Unconfirmed with both |
| Have one full name and date of birth, as written, and anything else that agrees, such as a family's phone | One person |
| Have one full name and date of birth, or names that may be one and the same date, and nothing else | Two, shown as related with `unconfirmed: true`. `match` finds them, so ask it before you enter somebody |
| Share a number or an email given under one name, a name with one zip code or date of birth, or a passkey | One person |
| Share anything else, however strong | Two, shown as related with `unconfirmed: true`, and in Matches for somebody to decide |

| Limit | Detail |
| --- | --- |
| Names no table has | A date of birth confirms two records with such names only where a number or an email is under one name. Twins who share only a device and have no detail of their own can be joined by their date, where the policy has no `name` kind. |
| Two words | That a name has several words is noted from the day the rule is on. One sent before counts as one word. Send it again. Two second words in no table that begin with one letter look alike. |
| More than 300 records in one component | Nothing but a decision joins them. The 301st takes back what facts had joined there, so find what they all share and `mute` it. |
| Names not in Latin letters | The Latin short-form table supplies no `person` or `perhaps` key. An exact `name` key with a date or verified zip code still works in these scripts. |
| A father and a son | Of one name with no dates, they are one person by it, as two records of one man would be. |

For a phone or email given under a name, or by someone speaking for its owner, a placeholder such as Unknown / Not Provided gives no name evidence. The Spanish labels Desconocido, Desconocida, Sin Nombre and No Proporcionado, and the French Inconnu and Inconnue, are also missing names. The whole-field labels Неизвестно, غير معروف, अज्ञात, 姓名不详 and 氏名不詳 mean the name is unknown. Baby, Baby Boy and Baby Girl in the first-name field stand for an unnamed newborn. Baby in the surname field keeps its usual spelling. An equal birthday cannot confirm two such placeholders. A different birthday can still keep them apart. Recognizing a missing-name label also preserves the disagreement that its former spelling had with another named record. Where the name table could use part of a spelling, any letters it would lose must agree too. So María文 and Maria文 can agree, and Maria李 is a different name. The exact name key with a date or confirmed zip code works in other scripts. It keeps marks that distinguish letters, including Devanagari vowel signs and nukta, Thai tone marks, Greek iota subscript and diaeresis, and Japanese voicing marks. Composed and decomposed forms give the same key. Latin accents, Greek stress and optional Arabic and Hebrew points keep their earlier comparison.

When upgrading from the earlier name rules, stop the servers and run `account-graph rebuild`. The old hashes do not reveal which names lost letters or were placeholders. The rebuild drops those hashes as evidence for a join. They still count how many people share a spelling and carry its mutes. Different old names can still keep records apart, including while only one of the two profiles has been sent again. Where a spelling changes the weight of a link or what a name says about a person, two people stay together only if both the earlier and the checked spelling put them together. Losing one match cannot give that person to another record. Re-send named profiles from their original source with new report keys before serving the graph again. Recreate exact name keys with a date or zip code from the original names as well. The same rebuild warning covers spelling marks, newborns and the additional missing-name labels. A cached hash cannot recover a missing mark. Old dates can still disagree. A shared date on two older records cannot confirm them by itself until at least one is reported again without a placeholder. Staff decisions keep working through the upgrade.

A record is a subject that names somebody, such as `contact:7` or `account:42`. A browser or a caller is not a record. It goes with the records it is tied to most strongly, and of two as strong, with whoever was seen first.

> **Credit is another question.** An ad click on a browser two people share can be credited to both, whichever of them the browser goes with. It is not credited across a split, or between two whose dates of birth or names differ, because whoever is on the other side of a matter must not be shown there.

It is off unless a policy sets it, and turning it on needs a [rebuild](operations.md#policy). [The fourth run](accuracy.md#the-fourth-run) has what it did on made-up people.

### A bar of its own for credit

`"credit": 0.75` in a policy credits a visit at that confidence or above, where without it the bar is `same`, 0.9. A contact and the caller with the phone on file are tied at 0.85 under [the intake preset](#an-intake-desk), which is too little to join two people and enough to say which ad.

| Under the bar of its own | |
| --- | --- |
| Joins | Nobody |
| A journey, the members of a person | Show nothing of it |
| A browser that is one with another record | Is that record's, and is not credited here |
| A split, or a date of birth or a name that differs | Is not crossed |
| A call filed under its number's own channel | Needs `same`, as before |
| What is sent to an ad platform | Needs 0.9, as before |
| A changed bar | Needs no rebuild |

## Model assumptions

The result is a model score, uncalibrated as a probability. Correlated evidence makes it overconfident at any weights. Use [checked pairs](#checked-pairs-from-a-file) to compare it with what you know.

| Assumption | Where it fails |
| --- | --- |
| Coincidences are independent. | A household shares its phone, address and connection for one reason. Kinds in one `group` count once. Correlated kinds outside a group count twice. |
| Evidence only adds. | Shared and differing facts cannot lower a score. Two different dates of birth have no effect. Record the difference with `split`. |
| One weight fits a kind. | A phone typed by staff is weaker than one a caller dialed from. Use [presets](#presets). |
| Evidence fades with the gap. | Sightings that overlap do not fade, however old. A kind without a half-life keeps full evidence. |

## Asking about conflicts

The `conflicts` [lookup](http.md#lookup) takes the people of a matter and answers which of them are kept apart, from each other or from anyone on record.

| `how` | Meaning |
| --- | --- |
| `recorded` | The two were split |
| `same` | One is the same person as somebody separated from the other, or from somebody the other is |
| `possible` | One is only related to such a person. Somebody has to look. |

`rests` is the split pair the answer rests on. Where the other side was not asked about, `b` is whoever on record they are kept apart from.

When loading opposing parties, ask for both subject IDs and look for their exact pair with `how: "recorded"`. This works even if another system recorded the split. Replaying a particular `decide` key tells you whether that whole request still stands.

> **An empty list says that none is known here.** It does not say that there is none, and it does not replace your own conflict check. If the server cannot be reached, say that it was not asked.

## Decisions from your own systems

Use `decide` to tell the graph which people to keep apart. Use `record` to say who a call concerned. See [Six calls](http.md).

| Fact | Owner | What to send |
| --- | --- | --- |
| Who is on the other side of a matter | Your case system. People who share a phone, a child or a case may be on one side or on two. | The pair, as a `split`. |
| Which contact a call was about | Staff, when they take the call. | The call ID and the contact in a [party statement](calls.md#recording-who-was-on-one-call). A parent calling about a child can name the child's record with the representative role. |
| Whether a person may be contacted | The system that sends messages. Consent here covers advertising only. | Message consent, opt-outs, quiet hours and contact frequency stay there. |

| Action | Behavior |
| --- | --- |
| `split` | Holds whatever the two share later. Withdraw it with `unsplit`. It can be recorded before either account exists. |
| `merge` | The strongest link. A split still wins. Merging an account with one side of a split pair pulls it away from the other. Take it back with `unmerge`. |
| `mute` | Stops linking through one email, phone, IP address or identifier. Give it back with `unmute`. |

### Split

Send a pair that is two people. The two stay in separate clusters while the decision stands.

```bash
curl -X POST https://graph.example.org/v1/decide -H "authorization: Bearer $GRAPH_TOKEN" -d '{
  "key": "matter-31", "at": 1795460000000, "by": "system:cases", "action": "split",
  "pairs": [{ "a": "contact:7", "b": "contact:12", "reason": "sides of one matter" }] }'
```

```json
{ "ok": true, "value": { "duplicate": false, "changes": [{ "subject": "contact:7", "from": "contact:12", "to": "contact:7" }], "recorded": 1, "already": 0, "notAsAsked": [] } }
```

Load known pairs before entering the first contact. Send newly discovered pairs as soon as your conflict check identifies them. Until the split arrives, an outcome of one side can be credited to the other's ad click. Once it stands, neither is reached from the other, directly or through a third subject.

A list is written in one transaction, with one decision per pair. A pair whose last report agrees and still holds is left alone and counted under `already`, so a system can send its whole list again, with a new key. Sign a system's decisions `system:` and its name, so the audit log tells people's decisions from systems'.

> **Reasons are permanent.** A reason stays in the audit log after its subjects are deleted. Name the kind of matter and leave out the matter itself.

### Merge

Report a record merge in another system as a `merge`. Calling `forget` on the merged-away record deletes what it knew.

### Taking a merge back

Send `unmerge` with the same pair. There is nothing to keep from the merge.

<!-- schema DecideRequest -->
```json
{ "key": "undo-ticket-88", "at": 1795463600000, "by": "dana", "action": "unmerge", "pairs": [{ "a": "contact:7", "b": "contact:12" }] }
```

[`decide`](http.md#decide) lists the answers. To keep two apart whatever they share, use `split`.

The audit log keeps the merge and its undoing.

### Conflicting reports

| Case | Result |
| --- | --- |
| One person entered on both sides | Split, and stays split until the pair is withdrawn with `unsplit`. |
| Two records of one person sent as a pair | The duplicate is blocked until the pair is withdrawn. |
| A merge of a pair that is split | Recorded, and the pair is in `notAsAsked` with `split`. A split holds over a merge. |
| Two systems that disagree | Each report that contradicts the last is recorded. At three contradictions the pair is flagged on the reviewer screen. |

## Measured weights

The `fingerprint`, `canvas` and `ip` rows are set from these figures.

| Identifier | Values that belonged to one person only | Same person on the next sighting, by days since the last |
| --- | --- | --- |
| Vendor fingerprint | 98% | 98% up to 30 days, 95% at 31 to 90, 86% past 90 |
| Home-made canvas and user-agent hash | 53% | about 55% up to 7 days, 23% at 31 to 90, 7% past 90 |
| IP address | 46% | 89% next day, 73% in a week, 37% in a month, 5% past 90 |

The defaults follow from these measurements:

- **Vendor fingerprint.** It can join two subjects alone and fades slowly.
- **Home-made hash.** Phones of one model share it, so it relates subjects without joining them. Attribution based on it alone is wrong about half the time.
- **Shared values.** A handful of fingerprints, each shared by more than twenty people, can produce most same-fingerprint pairs. Under 2% of those pairs are one person, and caps exclude them.
- **IP address.** One shared by exactly two people points at the same one about 42% of the time, and by three to five about 9%. Its evidence thins with the square of the number sharing it.

The other rows are unmeasured priors, including 0.60 for postal `address`. [Checked pairs](#checked-pairs-from-a-file) give values of your own.

## Changing the policy

Set the change in `POLICY`, then run `account-graph rebuild` to recompute every cluster under the new policy. See [the policy](operations.md#policy).

```sh
POLICY='{"kinds":{"hardware":{"weight":0.8}}}' account-graph rebuild
```

| Symptom | Change |
| --- | --- |
| Household members joined by a phone and an address together | Put the kinds a household shares in one `group`. |
| Strangers joined, always by one kind | Lower that kind's `weight` below `same` (0.9), so it relates without joining. |
| One value joins many subjects, such as a shared mailbox or a kiosk | `mute` that value. If it recurs for the kind, lower the kind's `cap`. |
| Known duplicates are only related | Raise the `weight` of the kind they share, or record more identifiers at sign-in. |
| Subjects joined by sightings months apart | Shorten the kind's `halfLife`. |
| Two groups joined through one account that touches both | Raise `bridge`. |
| Too many or too few clusters flagged for review | Change `review`, the flagging size. |

A setting applies to every subject. Fix a single pair with a decision: `split`, `merge` or `mute`.

### Checked pairs from a file

What the default policy does on made-up people is in [Accuracy](accuracy.md).

`tools/labels.ts` reads a CSV of checked pairs and asks a running server what each pair shares. It prints precision and recall per kind, the counts behind them, and the weights `fit` would give. It is read-only, so a reviewer's token is enough.

```sh
printf 'a,b,label\ncontact:1,contact:2,same\ncontact:3,contact:9,different\n' > pairs.csv
GRAPH_URL=https://graph.example.org GRAPH_TOKEN=$REVIEWER npm run labels -- pairs.csv
```

A pair labelled both ways is left out and counted.

## Limitations

- **Conflict checks.** account-graph runs none. A `split` acts on pairs you already know, and whom you may serve stays your decision.
- **Splits from your own systems.** The graph applies them as received.
- **Shared browsers.** A browser that both sides and a third person used can still be reached from each side.
- **Many separations in one component.** Each merge left out by the separations would reconnect a separated pair. A different choice of cuts could still keep more merges overall. The exact multicut or multiway cut is hard to compute.
- **Three dates of birth on two lines.** Where staff joined two lines to people of three or more dates, more of those joins can be left out than need be, and which ones can depend on ids. One review met it in 3 of 15,000 random graphs.
- **Score calibration.** Clusters come from the cuts above and carry no probability.
- **Matches.** It covers subjects in the newest 10,000 sightings. A speaker mark on any member of either person's cluster keeps the pair out of Matches, even when the mark is older.
- **Staff labels.** Staff find pairs that already look alike. A kind they search by looks better than it is, and few strangers who share it are in the file.
- **Deleted evidence.** A merged-away record whose evidence was deleted cannot be used as a checked pair. The tool counts these, which were often the surest pairs.

## Withdrawing a matching fact

When someone gives up a number, send a `decide` request with `action: "withdraw"`, their exact record ID in `subject`, one `fact`, and the statement's `key`, `at` and `by`. The statement can arrive before the profile. It applies to the record named even when several records have been merged. A phone, email, device, IP address, or an identifying key your backend can supply in a profile can be withdrawn. For a verified address, use its matching identifier. A phone covers both its phone and VoIP hashes. Server-made speaker, review, name and call marks have their own meaning and cannot be withdrawn this way.

For each fact, the newest statement time wins. Ties go to the larger key in UTF-8 byte order. When a profile and a withdrawal have identical times and keys, the withdrawal wins. A newer keyed profile that gives this record the fact again restores its matching evidence, including its earlier sightings. A profile that gives only another fact, or gives this one to a speaker, leaves the withdrawal in force. A replay of the withdrawal says whether that exact statement stands now. Older builds did not keep profile keys or distinguish a profile from an ordinary sighting. A withdrawal sets that evidence aside even if the old sighting has a later time. Send a newer profile through an upgraded server to restore it.

The fact stops contributing to this record's links, scores, candidate lookups, duplicates, and inferred campaign credit. Its name-and-contact hashes also stop counting. With older hashes whose source contact cannot be recovered, withdrawing a contact sets those name-and-contact hashes aside until another keyed profile establishes them. Other holders still count. The graph recalculates holder counts and groups, including groups that can now match because a fact fell below its cap. Independent evidence, staff joins, separations, and a muted speaker mark continue to apply.

Every call still rang, and every visit remains on the subject that made it. Before and after withdrawal, an unconfirmed call belongs to its line. Earlier and later calls and visits that reached this record solely through the withdrawn fact disappear from its journey and credit. A call that staff confirmed for a particular record keeps that owner. A STOP on the number remains in the line's texting history and continues to apply there. Forgetting this record removes its withdrawals and matching evidence and tombstones its withdrawal keys, including after pruning. Pruning sightings alone preserves the standing decision and the evidence it takes out of matching.

A withdrawal can only move `textsOptedOut` toward fewer texts. A STOP sent while the record held a phone or VoIP number still applies to that record after withdrawal, even if the message arrives late. A START sent while the number was withdrawn cannot clear it. A later profile can give the line back, and a START sent while the record holds it again can clear that line's STOP. Other lines can still keep the person opted out. If a group comes apart, each member that would lose its opt-out keeps the STOP from the line that supplied it. A START already seen on that line cannot clear the inherited STOP only because the group split. A later START can clear it while the record holds the number. A staff join does not make a START from a withdrawn line count. If pruning has erased the profile that would establish who held a number at the time of a message, a possible STOP counts and a START requires surviving evidence.

Suppose two contacts shared a phone and the first also had a second number. A STOP from the second number at 96 counts for the contact who withdrew the shared phone at 104, even if the STOP or either profile arrived last. The graph checks the direct holders at the withdrawal time, applies the matching policy and staff separations, and reads their text history through that time. Someone who first acquired the shared phone at 105 cannot dilute the earlier link. A START dated after the withdrawal can clear that inherited STOP only while the contact holds the second number.

An opt-out already visible when the withdrawal splits the group is retained. This matters if a START from the second number at 100 arrives late. If it arrived before the withdrawal, the group had already resumed texts. If the withdrawal retained the visible STOP first, that late START cannot clear it on a record that never held the second number. A STOP dated after the withdrawal does not pass back across the former link unless it was already visible when the backdated withdrawal arrived.

Late recovery uses the surviving claims of direct holders of the withdrawn phone. It needs both records and the evidence that joined them. A later mute, separation or erasure can remove that evidence. For a record that withdrew another kind of fact, a former member that never withdrew the shared phone itself, or a link through a third record, only an opt-out already visible when the withdrawal splits the group is retained. An ordinary staff split uses the members who remain together. Reconstructing all former groups would require examining history even for records that have never withdrawn a fact.

Cluster changes produce the usual events. The decision history identifies the record and author. The event stream carries no new fact payload. A cached campaign report or a pending conversion uses the revised graph. As with an undone call tie, a conversion already sent stays on the platform. A withdrawal alone sends no refund or retraction. Ordinary corrected values and refunds still use the platform's existing adjustment rules. A call with a confirmed party keeps its existing restrictions on delivery and adjustment.

### Earlier dates after a withdrawal

The live graph applies a withdrawal when it receives it. In `attribute` and a `person` lookup, `at` limits the touches eligible for credit. Membership and paths to those touches come from the current graph. The `before` cursor of a journey selects earlier activity using today's membership. A report for a past day keeps the original visit and conversion dates and values, and assigns their credit using today's links. If a withdrawn number was the only connection, an earlier call can leave that record's journey, an earlier conversion can lose its campaign, and the same person lookup can return fewer members. Restoring the fact can change those answers again.

An explicit identity snapshot, `graph.asOf(t)` in the graph tools, rebuilds membership from the retained sightings and decisions recorded by that time. A withdrawal and a profile that restores the fact also have to have reached their effective time. Forgetting and pruning limit what a snapshot can reconstruct. For example, a pruned email edge keeps its first and last observations and their count. Two records can have identical folded observations even if one regained its email during an interval and the other regained it afterward.

Even on a database with no withdrawals, a historical credit calculation would need to read more evidence. Checking for withdrawals first would itself read withdrawal state in the same database snapshot. In the SQL driver fixture with 1,000 single-holder sightings and one credited touch, the ordinary calculation issued nine statements and read no sightings. Replaying identity and loading the same touch in one transaction issued ten statements and read all 1,000 sightings. Reports can include outcomes on both sides of a withdrawal and need the identity applicable to each outcome.
