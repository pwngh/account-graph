# Accuracy

How often account-graph joins one person's records, and how often it joins two people's, measured on made-up people whose true matches are known.

```sh
node tools/accuracy/run.ts
```

```text
made-up people ──▶ what a site, a telephone system and a front desk report ──▶ the server, over HTTP
       └─────────────── who is who ───────────────▶ score ◀── who was joined ──────────┘
```

Made-up people are no firm's customers. The figures say how the default settings do under the rates below, and not how they will do on yours. To measure your own, check pairs by hand and use [`tools/labels.ts`](deciding.md).

> **Scores are weights.** A link shown at 92% has a weight of 0.92 in the policy. It does not say that 92 of 100 such links are right.

## How it is made

`tools/accuracy/world.ts` makes households, the people in them, their browsers, numbers and emails, and what they do over the days. Who is who is decided from people. It reads nothing of the graph: no import, weight, cap or window. Its author knew the policy, so the cases it makes are not chosen blind to it. The code, rates and bad results were read by somebody else before any run.

| It happens | So that |
| --- | --- |
| Adults share a computer, an email address or a landline | One device, email or number is two people's |
| One adult speaks for another, mostly from their own browser | A record has somebody else's device, number and email |
| Two adults of a household both become contacts | Their records are near each other |
| Numbers, emails, names and birth dates are mistyped, by their owner and by staff | One person's records differ. A named, small share come out as another person's |
| A number changes and is given to somebody else | One number is two people's in turn |
| A browser forgets its cookie, or its storage is cleared | One person is several browsers |
| Mobile visits come from forty carrier addresses | Strangers share an address. Forty for everybody is harsher than a carrier is |
| A caller hides their number, or dials by hand | A call has nothing to join it by |
| A number is tapped and no call made, strangers who never visited call, callers call again | A call may be tied to the wrong browser |
| Staff enter somebody twice | One person is two records |

`tools/accuracy/run.ts` reports each world to a server of its own, in the order things happened, twice: with the default policy, and with `examples/household.json` and the names and birth dates it uses. No line check, address service, fingerprint or reviewer is used. `tools/accuracy/score.ts` compares who was joined with who is who.

## What is counted

| Figure | Meaning |
| --- | --- |
| People whose record is with another's | Of people with a contact record, those in a cluster with somebody else's contact record. This is one person's history shown under another. |
| Without those one spoke for | The same, leaving out two people of whom one spoke for the other. It is shown beside the first figure and does not replace it |
| People mixed by anything | The same of every subject that is one person's only: contacts, callers and browsers |
| Joined pairs that are right | Of pairs of subjects in one cluster, those that are one person |
| True pairs found | Of pairs that are one person, those in one cluster |
| Of those with a chain of facts | The same, of pairs that share a device, number, email or tap, or are joined by such facts through the person's other subjects: recall among pairs these four kinds of fact connect. Names and birth dates, which the household arm has, are not among them |
| Credit | Of contact records, those credited to the ad their person came by, to somebody else's, or to none; and records of people who never came by an ad that are credited to one. Each person's ad is their own, so a wrong one cannot be right by chance |
| Links by kind | Direct links that join, by what they rest on, and how many are between two people. A call tied by a tap is `dial` |

A browser or telephone used by two people belongs with both. Joining both people's contact records through it is wrong, and is counted so. A call by one adult for another joined to the other's record is wrong too, because the caller is somebody else. Who calls from a landline is everybody who did.

Credit is asked as of an hour after each record, with what is known at the end of the world, so later facts may help an earlier record. A report read on the day would have less.

Each setting is twenty worlds with seeds 20261124 to 20261143. The range beside a figure is Student's 95% interval over the worlds, which are independent of each other; people in one world are not.

Two plain rules are scored beside it: whoever shares any one device, number or email is one person, and whoever shares a phone or an email is, of records and callers alone. The second is what many firms do, and is held to pairs of records and callers; account-graph's figures for those alone are printed beside it.

## The rates

Set before anything was run. **Source** rates are published figures. **Assumed** rates have no usable source, and the range is a judgment.

| Rate | Low | Base | High | From |
| --- | --- | --- | --- | --- |
| Adults in a household, 1 to 4 | 40/44/11/5 | 35/47/12/6 | 30/50/13/7 | Assumed, to put 78, 82 and 85% of adults with another. Census [AD-3](https://www2.census.gov/programs-surveys/demo/tables/families/time-series/adults/ad3.xls): 14.8% of adults live alone |
| Home with a landline | 18% | 19.6% | 21% | CDC [wireless substitution](https://www.cdc.gov/nchs/data/nhis/earlyrelease/wireless202609.pdf), 2025: 18.6% both, 1.0% landline only |
| Calls from it on the landline | 10% | 18% | 30% | Assumed, from the same report's landline-mostly homes |
| Shared computer | 20% | 35% | 50% | Assumed |
| Couples sharing an email | 8% | 15% | 27% | Assumed below Pew, [2013](https://www.pewresearch.org/internet/2014/02/11/main-report-30/): 27% of couples online |
| Has a computer; visits on it | 70%; 30% | 70%; 35% | 70%; 40% | Assumed. Pew, [2015](https://www.pewresearch.org/short-reads/2015/11/25/device-ownership/): 66% own two or more devices |
| Telephone browser forgets after 7 days | 45% | 50% | 55% | WebKit's [rule](https://webkit.org/tracking-prevention/); share from [StatCounter](https://gs.statcounter.com), Oct 2026: iOS is 52% of US mobile |
| Storage cleared in a month | 5% | 15% | 31% | Assumed below comScore, 2006: 30.7% of computers |
| Mobile visits on the carrier's network | 20% | 35% | 50% | Assumed. Over 90% of mobile networks share addresses ([2016](https://arxiv.org/abs/1605.05606)) |
| Second email given | 5% | 10% | 25% | Assumed |
| Number changes in a year | 3% | 6% | 12% | Assumed. FCC, [2018](https://transition.fcc.gov/Daily_Releases/Daily_Business/2018/db0323/FCC-18-31A1.pdf): 35 million disconnected a year |
| Its next holder is one of these people | 0.01% | 0.05% | 0.5% | Assumed. Numbers rest at least 45 days ([47 CFR 52.15](https://www.law.cornell.edu/cfr/text/47/52.15)) |
| A typo comes out as another of these people's | 0.002% | 0.01% | 0.1% | Assumed. A firm's few thousand are among hundreds of millions |
| Name; birth date mistyped | 1%; 0.5% | 3%; 1% | 8%; 3% | Assumed |
| Asked for a birth date | 50% | 50% | 50% | Assumed |
| Own email mistyped | 2% | 5% | 15% | Assumed. Vendors report 8 to 15% |
| Own number mistyped | 1% | 3% | 10% | Assumed. One [emergency department](https://pubmed.ncbi.nlm.nih.gov/10802416/), 2000: 16% unreachable, for every reason |
| Staff mistype an email; a number | 2%; 0.3% | 5%; 1% | 15%; 4% | Number: [0.29% a field](https://pmc.ncbi.nlm.nih.gov/articles/PMC10775420/) keyed, and assumed above it when heard. Email assumed |
| Hidden number | 1% | 3% | 8% | Assumed |
| Tapped, on a telephone; on a computer | 95%; 10% | 85%; 3% | 70%; 0% | Assumed |
| One adult speaks for another | 2% | 5% | 10% | Assumed |
| On their own browser or telephone | 80% | 80% | 80% | Assumed |
| A telephone visit with a tap and no call | 0.5% | 1.5% | 4% | Assumed |
| Callers who never visited, for every 100 people; recorded | 3; 50% | 8; 50% | 18; 50% | Assumed |
| More calls by a caller, on average, without a tap | 0.3 | 0.6 | 1 | Assumed |
| In a firm's ten open hours | 80% | 80% | 80% | Assumed |
| Entered twice | 5% | 10% | 20% | Assumed |
| Another adult of the household also comes | 5% | 10% | 25% | Assumed |
| Only visits; fills the form; calls; answered; email asked | 80%; 40%; 60%; 80%; 60% | same | same | Assumed. They set how much there is, not how hard it is |

`busy` is the base rates with 6,000 people in a five-day window of visits and first calls by strangers, for calls and taps by strangers close together. What comes of them after it is counted too.

## What would be bad

Written before anything was run.

| In | Bad |
| --- | --- |
| Base, default policy | More than 1% of people with a record share a cluster with somebody else's record, or the interval reaches 2% |
| Base, default policy | Fewer than 98% of joined pairs are right |
| Base, default policy | Fewer than 70% of the true pairs with a chain of facts are found |
| Base, default policy | The rule of any shared fact mixes no more people's records than account-graph does |
| Base, default policy | Of records and callers, the rule of a shared phone or email mixes fewer people's records and finds as many true pairs |
| Base, default policy | More than 5% of `dial` links, or of any kind with 200 links or more, are between two people |
| Base, default policy | More than 2% of credited records go to somebody else's ad, or more than 2% of records of people who never came by an ad are credited to one |
| Base, default policy | Fewer than 70% of the records with a chain of facts to their ad are credited to it |
| Base, household policy | It mixes more people's records than the default policy does, or more than 1% |
| Base, household policy | Fewer than 50% of the true pairs with a chain of facts are found. Its purpose is to be careful |
| High, either policy | More than 5% of people with a record share a cluster with somebody else's |
| Busy, default policy | More than 5% of `dial` links are between two people |

Every written-down result is published whichever way it comes out, and [all that was printed](accuracy-run.txt) with it. A rate is not changed after a run; a new setting is added beside these. The commit and the Node version of the run are written with the figures.

## Results

Run once, at commit `17b7a532740eda99855ebf7d31e8b6d53c3f14cc` with Node v22.23.0. **Five of the results written down as bad came out bad.**

| Written as bad | Came out |
| --- | --- |
| Base, default: more than 1% of people with a record share a cluster with somebody else's, or the interval reaches 2% | **Bad.** 2.86% (2.40 to 3.33) |
| Base, default: fewer than 98% of joined pairs are right | **Bad.** 94.94% |
| Base, default: over 5% of a kind with 200 links or more are between two people | **Bad.** `email + phone`: 51 of 444 (11.5%). Others held: `device` 179 of 5,415, `phone` 128 of 5,331, `dial` 17 of 3,102 |
| Base, household: more than 1%, or more than the default policy | **Bad.** 2.86%, the same as the default |
| Busy, default: over 5% of `dial` links are between two people | **Bad.** 1,010 of 6,061 (16.7%) |
| Base, default: fewer than 70% of the true pairs with a chain of facts are found | Held. 90.14% |
| Base, default: any shared fact mixes no more | Held. It mixes 3.66% |
| Base, default: same phone or email mixes fewer and finds as many, of records and callers | Held. It mixes 3.36% and finds 86.94%, against 2.86% and 74.18% |
| Base, default: over 2% of credited records go to another's ad, or of records of people who came by none to one | Held. Among credited records of people who came by an ad, 1.63% as a mean over the worlds, and 94 of 5,832 pooled (1.61%). Counting every credited record, 97 of 5,835 pooled (1.66%). Of records of people who came by none, 3 of 1,333 pooled (0.23%) |
| Base, default: fewer than 70% of the records with a chain of facts to their ad are credited to it | Held. 93.42% |
| Base, household: fewer than 50% of those pairs are found | Held. 56.08% |
| High, either: over 5% of people with a record share a cluster with somebody else's | Held. 4.54% and 4.52%; the intervals reach 5.03 and 5.02 |

| Setting, policy | Records with another's | Without those one spoke for | Joined pairs right | True pairs found, with a chain | To another's ad, among credited records of people who came by one, mean over the worlds |
| --- | --- | --- | --- | --- | --- |
| Base, default | 2.86% (2.40 to 3.33) | 1.57% (1.21 to 1.93) | 94.94% | 90.14% | 1.63% |
| Base, household | 2.86% (2.40 to 3.33) | 1.57% (1.21 to 1.93) | 94.56% | 56.08% | 1.95% |
| Low, default | 1.14% (0.82 to 1.46) | 0.64% (0.44 to 0.83) | 97.84% | 95.39% | 0.69% |
| Low, household | 1.14% (0.82 to 1.46) | 0.64% (0.44 to 0.83) | 97.94% | 63.76% | 0.81% |
| High, default | 4.54% (4.05 to 5.03) | 2.34% (1.96 to 2.72) | 90.77% | 81.86% | 3.72% |
| High, household | 4.52% (4.03 to 5.02) | 2.34% (1.96 to 2.72) | 88.86% | 46.33% | 4.22% |
| Busy, default | 2.28% (1.94 to 2.63) | 1.36% (1.06 to 1.65) | 91.00% | 85.90% | 2.44% |
| Busy, household | 2.25% (1.90 to 2.59) | 1.36% (1.06 to 1.65) | 88.73% | 48.64% | 1.30% |

In busy, 4.00% of the records of people who came by no ad are credited to one under the default policy, a mean over the worlds. Counting every credited record there, 505 of 14,162 pooled (3.57%) go to the wrong ad.

### Beside the plain rules

Of records and callers alone, records mixed, then without those one spoke for, then joined pairs right and true pairs found:

| Setting | account-graph, default | account-graph, household | Same phone or email |
| --- | --- | --- | --- |
| Base | 2.86%, 1.57%, 93.84%, 74.18% | 2.86%, 1.57%, 88.69%, **21.69%** | 3.36%, **1.34%**, 93.53%, **86.94%** |
| Low | 1.14%, 0.64%, 97.15%, 87.91% | 1.14%, 0.64%, 95.58%, 31.52% | 1.11%, 0.51%, 97.20%, 95.26% |
| High | 4.54%, 2.34%, 90.71%, 53.45% | 4.52%, 2.34%, 79.86%, 12.34% | 5.72%, 1.91%, 90.37%, 69.59% |
| Busy | 2.28%, 1.36%, 93.10%, 74.38% | 2.25%, 1.36%, 81.64%, 16.30% | 2.27%, 1.01%, 94.95%, 87.51% |

The plain rule finds more true pairs of records and callers than account-graph does everywhere, and without those one spoke for mixes fewer records everywhere. The household preset only relates a phone, and this run has no staff who join a caller to a record as [the preset asks](presets.md#caller-attribution). Nothing of the plain rule ties a visit to a call or credits an ad.

### After the run

Looked for on the same seeds, once the figures above were known. These were not foreseen and test nothing.

- **Differences over the same worlds**, rule minus account-graph under the default policy, in percentage points of people with a contact record who share a cluster with somebody else's, and then without those one spoke for. A minus is a rule that mixes fewer.

| Setting | Any shared fact | without those | Same phone or email | without those |
| --- | --- | --- | --- | --- |
| Base | 0.80 (0.51 to 1.09) | 0.04 (-0.02 to 0.10) | 0.50 (0.14 to 0.86) | **-0.24 (-0.39 to -0.08)** |
| Low | 0.10 (-0.02 to 0.21) | 0.00 (0.00 to 0.00) | -0.03 (-0.18 to 0.13) | **-0.12 (-0.25 to 0.00)** |
| High | 1.67 (1.33 to 2.00) | 0.07 (0.00 to 0.13) | 1.17 (0.84 to 1.51) | **-0.42 (-0.62 to -0.23)** |
| Busy | 0.35 (0.25 to 0.45) | 0.01 (-0.01 to 0.03) | -0.01 (-0.19 to 0.17) | **-0.35 (-0.50 to -0.19)** |

- **Where wrong pairs of records are from**, base, default: 156. In 70 one spoke for the other. Of the rest, 68 share an email only, 13 share a device only, and 5 anything else.
- **Names.** Every link in the household arm that rests on a name is one person's: 0 of 141 wrong in base. A name or birth date that disagrees weighs nothing today.
- **Taps.** Counted from the worlds and not from links: in busy, of 32,037 calls, in the three minutes before and half a minute after, 3,793 have taps by two browsers or more, 3,871 by one that the caller has used, and 3,438 by one that the caller has never used. The results give the `dial` links in all.

## The second run

Written before any of its seeds was run. It asks whether two people who cannot be one can be kept apart, and at what cost. Nothing of the first run is replaced. Its code is at its commit, and the world has changed since, so its seeds now make other people.

### What is tried

Two facts of a contact may be kept, keyed as names are: the date of birth (`birth`), and the first letter of the first name, accents folded (`initial`). They link nothing. A policy may list one or both in `apart`: two subjects that would be in one group, that both have such a fact and share no value of it, are kept apart, whatever path joins them. An `initial` keeps apart nobody whose birth dates agree. A reviewer's join, and a join by one of your systems, overrule it, whichever came first. No weight changes.

| Arm | Beside |
| --- | --- |
| `default`, `household` | Nothing |
| `household staff`: staff join the caller to the record | `household` |
| `default staff` | `default` |
| `default pool`: a number of one's own | `default` |
| `default birth`, `default initial`, `default both` | `default` |
| `household staff birth`, `household staff initial`, `household staff both` | `household staff` |

Seeds 20270101 to 20270120 are for choosing between `birth`, `initial` and `both`, in base and high. Seeds 20270201 to 20270220 are held back. They are run once, at one commit, over the four settings, with the chosen option and what it is beside. Three options are tried, and the best of three looks better than it is; the held seeds say how much.

**How one is chosen.** Of the options that lose no more than 2% of the true pairs of records, and 2% of the records credited to their ad, that the arm beside finds in base, pooled over the worlds, under the default policy and under `household staff` both, the one with the fewest people's records mixed under the default policy, pooled. Where `birth` is within 0.3 points of it, `birth` is chosen, because a single letter is close to plain. Where none loses so little, none is chosen, and no policy is changed.

### What is new in the world

All assumed, and set before anything was run.

| Rate | Low | Base | High |
| --- | --- | --- | --- |
| Has a short form; a record has it; it begins with another letter | 20%; 15%; 15% | 35%; 30%; 25% | 50%; 45%; 35% |
| Surname changed, the new one on half of their records | 1% | 3% | 8% |
| Two surnames; a record has one | 10%; 20% | 20%; 35% | 35%; 50% |
| Spelled as another alphabet does, three in ten with another first letter | 0.5% | 1.5% | 4% |
| Name heard wrongly by staff; birth date | 3%; 1% | 8%; 2% | 15%; 5% |
| Two of a household born on one day; with one first name | 0.3%; 0.5% | 0.7%; 1% | 1.5%; 2% |
| Calls with a record that staff join; to somebody else's | 95%; 0.2% | 85%; 1% | 60%; 3% |
| Calls again on the number shown before | 80% | 70% | 60% |
| Numbers in the pool | 10 | 10, and 40 in busy | 10 |

First letters are uneven, as they are in life, so one couple in fourteen or so share theirs. No pool number is a fact here, so the plain rules and what is reachable are the same with a pool as without.

### What would be bad

Of the held seeds. A share is of counts pooled over the worlds. A comparison is by the mean of the paired differences, and is bad only where its 95% interval does not reach zero, except where the row says the interval.

| In | Bad |
| --- | --- |
| Base, the chosen option beside its arm | The difference in people whose record is with another's is not below zero over its whole interval |
| Base, default and the option | More than 1% of people with a record share a cluster with somebody else's |
| Base, the option | More than 2% of the true pairs of records found beside are lost, or more than 2% of the records credited to their ad |
| Base and high, the option | More callers and browsers are with a record that is not theirs than beside it: a mean difference above zero whose interval does not reach zero |
| High, the option | More than 2.5% of people with a record share a cluster with somebody else's, or more than 5% of the pairs or 5% of the credit are lost |
| Base, `household staff` | Fewer than 70% of the true pairs of records and callers are found |
| Busy, `default pool` | More than 5% of the links by a tap or by a number shown are between two people |
| Base, default and the option | Fewer than 98% of joined pairs are right. It is expected to be bad: shared browsers are not touched by this |

### What was chosen

The development seeds, 20270101 to 20270120, at `271997c9758852289e9f8cb63e47ca6db59efc3b`. Base, pooled, against 2% for each loss:

| Option | Arm | Records mixed | Record pairs lost | Credit lost |
| --- | --- | --- | --- | --- |
| `birth` | default | 214 of 9,355 (2.29%) | 3 of 633 (0.47%) | 4 of 5,738 (0.07%) |
| `birth` | household staff | 276 (2.95%) | 3 of 504 (0.60%) | 3 of 5,714 (0.05%) |
| `initial` | default | 18 (0.19%) | 26 of 633 (4.11%) | 25 (0.44%) |
| `initial` | household staff | 28 (0.30%) | 25 of 504 (4.96%) | 19 (0.33%) |
| `both` | default | 14 (0.15%) | 27 of 633 (4.27%) | 26 (0.45%) |
| `both` | household staff | 24 (0.26%) | 26 of 504 (5.16%) | 20 (0.35%) |

`birth` is the only one within the losses. Three were tried, and the two that mix fewest records were not chosen. That is the rule's doing, and no evidence against them. They are not in the product.

### Results of the second run

The held seeds, once, at that commit with Node v22.23.0. **Four of the eight results written down came out bad.**

| Written as bad | Came out |
| --- | --- |
| Base, default and `birth`: over 1% of people with a record share a cluster with somebody else's | **Bad.** 220 of 9,434 (2.33%) under default, 261 (2.77%) under household staff |
| High, `birth`: over 2.5% share one, or over 5% of the pairs or the credit are lost | **Bad** for the first. 388 of 11,908 (3.26%) and 573 (4.81%). Lost: pairs 1.89% and 2.82%, credit 0.24% and 0.13% |
| Busy, pool: over 5% of the links by a tap or a number shown are between two people | **Bad.** 888 of 10,668 (8.3%) |
| Base, default and `birth`: fewer than 98% of joined pairs are right | **Bad**, as expected. 95.27% |
| Base, `birth` beside its arm, people whose record is with another's: not below zero over the whole interval | Held. -0.59 points (-0.79 to -0.39) under default, -0.79 (-1.00 to -0.58) under household staff |
| Base, `birth`: over 2% of the pairs of records, or of the credit, lost | Held. Pairs 5 of 584 (0.86%) and 6 of 446 (1.35%); the second's interval by the mean reaches 2.27, so it is close. Credit 4 of 5,808 and 4 of 5,745 (0.07%) |
| Base and high, `birth`: more callers and browsers on the wrong side | Held. -2.85, -3.60, -5.35 and -11.75 pairs a world |
| Base, household staff: fewer than 70% of the true pairs of records and callers found | Held. 75.32% |

All that was printed is in [accuracy-held.txt](accuracy-held.txt), and the development run in [accuracy-dev.txt](accuracy-dev.txt). In both, `exhausted` counts requests that got no number for any reason, and not only a full pool.

**The code has changed since.** Review found that credit could still pass a link a fact had cut, and that a fact could cut a join a reviewer made. Both were fixed after this run, and the figures above are of the code before. Over the development seeds, base, `birth` after the fixes: under default, records mixed 214 (as before), record pairs lost 3 (as before), and credit lost 14 of 5,738 (0.24%) against 4 before; under household staff, records mixed 289 against 276, record pairs lost 3 (as before), and credit lost 13 of 5,714 (0.23%) against 3 of 5,714. Joins that staff made stand now, which mixes more there.

**Staff joins raise records mixed.** Base goes from 2.93% to 4.03% under the default policy and from 2.91% to 3.56% under household, and high to 7.88% under default, because staff join a speaker to the record they spoke for. With `birth`, household staff comes back to 2.77% in base. If staff join callers, turn `birth` on.

**A pool mixes more people in base, low and high.** People mixed by anything go up 2.05, 1.22 and 2.15 points, and in base joined pairs right go from 94.68% to 88.38%. Records with another's do not change. In busy, people mixed go down 0.22 points and true pairs found up from 57.63% to 68.15%. Records credited to their ad go from 64.63% to 71.29% in base, with 38 of 5,808 (0.65%) of those credited without it lost. Looked at after the run, on six of the base seeds: 12.6% of the `lease` links are wrong with calls again on the number shown before, and 1.0% without them.

## The third run

Written before any of its seeds was run. The two runs above stand as they are, and their settings make the same people as then, draw for draw. `base3`, `low3`, `high3`, `busy3` and `dirty3` are new settings, and are not `base` and the rest. The held seeds of the third run are opened once. This page counts the rounds: three so far, with this one.

### What is new in the world

All assumed unless it says otherwise, and set before anything was run.

| Rate | Low | Base | High |
| --- | --- | --- | --- |
| First names | From a list the author of the product's table had not seen, by its SHA-256. English names by their share in the 1990 census. Spanish names by shares that are assumed, and read by no fluent speaker | | |
| A record has a short form; an English form of a Spanish name | 15%; 10% | 30%; 20% | 45%; 35% |
| A Spanish name of two; a record has one of them | 15%; 30% | 25%; 50% | 40%; 70% |
| First and last name swapped | 0.5% | 1% | 2% |
| The speaker's name on the record of who they speak for | 3% | 6% | 12% |
| Two of a household with names a letter apart | 0.5% | 1% | 2% |
| Where somebody speaks for another, staff say so; a form's box is ticked | 80%; 75% | 60%; 50% | 30%; 25% |
| Said wrongly: by staff; by the box. Said a day or three late | 1%; 0.5%; 10% | 2%; 1%; 20% | 3%; 2%; 30% |
| The client's own number and email given beside, where the box is ticked | 70% | 50% | 30% |
| A form filed again from one browser, with another email or number | 10% | 15% | 20% |
| Calls again from another browser; from another line | 5%; 5% | 10%; 10% | 20%; 20% |
| How long a tap is before its call: up to 30 s; up to 60; up to 180 | 85/10/5 | 75/15/10 | 60/20/20 |
| Calls reported 5 to 120 seconds late | 5% | 10% | 20% |
| Cold callers who dial a number somebody else was shown | 2% | 4% | 8% |
| `dirty3`, base with placeholder numbers; shared office emails | | 3%; 3% of records | |

Somebody who speaks for another is told of by a field on `/identify`, and the arms that ask send it. The others send what was given as the subject's, as before. What was given, and so a chain of facts, is the same for both. The client's own number and email are typed with the same errors, are sent by the asking arms only, and count in no chain. A told box or call cannot know whose browser it was, so the client's browser is sometimes sent as the speaker's. `ownGiven` is of boxes that were told in time, which is 40% of told boxes in base.

### What is compared

`tools/accuracy/third.ts` makes each world once and reports it to two codes: `b9bba69`, under its default policy (`today`), and the code named below. They are matched by what was made (a browser, a record, a call), never by what a server called it.

| Arm | Code, policy and switches |
| --- | --- |
| `today` | `b9bba69`, the default policy |
| `new` | The named code, the default policy with `apart: ["birth", "given"]`, and the field for who speaks |
| `today pool`, `new pool` | The same, with a pool of numbers |

The code of the development seeds is `199cddf` on `feat/round3`. The code of the held seeds is named here before they are opened. The held names and the table:

| File | SHA-256 |
| --- | --- |
| `world-names.json`, the list of the worlds | `f5a69fbe139b8541f96a42dae40bf4d564d29d660f2aeb1add0eec776ec8ff2f` |
| Held short forms | `f17060b45a847d991932aad3e94e4cfa46e399669a77744a8267e3d058d2f438`, `a8d47c9bd3da66ebecb70a503977083bbe6d9b0b3edb8437396fde157df67f87` |

The table in `src/names.ts` was frozen at `8d5922b`, from a part of one list, 142 names and 56 pairs of the author's own. Five of 724 English and nine of 46 Spanish held pairs are in it, all by that. The tool prints how many of the written names are in a form the table knows, and what is kept apart for each.

**The line.** A firm with a busy line uses a pool, as [Calls](calls.md#number-pools) says, so `new pool` is judged in busy3 and beside base3, for what links by a tap or a number shown, against `today` without a pool. `new` without one is printed beside it and not judged.

### What would be bad

Of the held seeds. A share is of counts pooled over the worlds, and one with nothing to count is bad. "Kept" is of what `today` found, on the same items. **The old marks are repeated on the old settings too, and a mark that tying less could meet has a floor.** The rows are judged by the tool and not by hand.

| In | Bad |
| --- | --- |
| base3 | More than 1% of people with a record share a cluster with somebody else's |
| base3 | Fewer than 98% of joined pairs are right |
| base3 | A kind of link with 200 links or more, in `today` or in `new`, has over 5% of them between two people |
| base3 | More than 2% of credited records, cold ones among them, go to somebody else's ad |
| base3, and base3 with a pool, and busy3 with a pool | More than 5% of the links that rest on a tap or a number shown are between two people, each link counted once |
| base3 | Fewer than 90% kept of the pairs with a chain of facts, of the calls tied to a browser of their caller's, and of those with a pool |
| base3 and high3 | Fewer than 98% and 95% kept of the true pairs of records; fewer than 90% of the records credited to their ad |
| busy3, with a pool | Fewer than 90% kept of the calls tied to a browser of their caller's |
| high3 | More than 2.5% of people with a record share a cluster with somebody else's |
| dirty3 | More than 1.5% of people with a record share a cluster with somebody else's; over 2% of credited records go to the wrong ad; fewer than 98% kept of the pairs of records, or 90% of the records credited |

Development seeds 20270301 to 20270320, to make sure the code does what it should. There is one configuration, so nothing is chosen between on them. Where they show something broken, what is changed for it is listed here, and each look at them is counted as a round. The final commit is named here before 20270401. Held: 20270401 to 20270420, once.

Known and not changed: a couple's shared email is put on the first two adults of every household with two; a short form is drawn before an English form, so the realised shares of names are printed and not the rates; a person's ad is reachable by the end of the world and not at an hour after a record; callers are what the server calls them, so a subject of two callers is one of two people; and a Student's t range is how far simulated worlds differ, not how far a firm is.

## Limitations

- Most rates are assumed. Under `high`, every one is at its hard end at once.
- People act alone or with their household. Friends, offices and shelters that share a telephone or computer are not made up.
- Nobody lies about who they are. In the first run, nicknames and married names are not made up.
- Half of the records have a birth date, so both of a pair do a quarter of the time. That is the main limit on what `birth` can do.
- In the second run, staff join a call to a record that was made when the call was generated, so a call again can miss a record that exists by then.
- Twins, and a parent and child of one name, are cases that neither fact can see.
- A record's chain of facts may run through another person's subjects, so a few of those counted as reachable are so by a mistake.
- A digit of the area code mistyped is not made up, because it could be a real number.
- A world is small. Stranger pairs meet more often where more people are known, and fewer where fewer are.
