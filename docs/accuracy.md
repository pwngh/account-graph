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

`tools/accuracy/world.ts` makes households, the people in them, their browsers, numbers and emails, and what they do over the days. Who is who is decided from people. It reads nothing of the graph: no import, weight, cap or window.

| It happens | So that |
| --- | --- |
| Adults share a computer, an email address or a landline | One device, email or number is two people's |
| One adult speaks for another | A record has somebody else's number and email |
| Two adults of a household both become contacts | Their records are near each other |
| Numbers and emails are mistyped, by their owner and by staff | One person's records differ, and may meet a stranger's |
| A number changes and is given to somebody else | One number is two people's in turn |
| A browser forgets its cookie, or its storage is cleared | One person is several browsers |
| Mobile visits come from a carrier's few addresses | Strangers share an address |
| A caller hides their number, or dials by hand | A call has nothing to join it by |
| Strangers tap and call at about the same time | A call may be tied to the wrong browser |
| Staff enter somebody twice | One person is two records |

`tools/accuracy/run.ts` reports each world to a server of its own with the default policy, in the order things happened. No line check, address service, fingerprint or reviewer is used. `tools/accuracy/score.ts` compares who was joined with who is who.

## What is counted

| Figure | Meaning |
| --- | --- |
| People whose record is with another's | Of people with a contact record, those in a cluster with somebody else's contact record. This is one person's history shown under another. |
| People mixed by anything | The same of every subject that is one person's only: contacts, callers and browsers |
| Joined pairs that are right | Of pairs of subjects in one cluster, those that are one person |
| True pairs found | Of pairs that are one person, those in one cluster |
| Of those with a chain of facts | The same, of pairs that share a device, number, email or tap, or are joined by such facts through the person's other subjects. Nobody could find the rest. |
| Links by kind | Direct links that join, by what they rest on, and how many are between two people |

A browser or telephone used by two people belongs with both. Joining both people's contact records through it is wrong, and is counted so. A call by one adult for another joined to the other's record is wrong too, because the caller is somebody else.

Each setting is twenty worlds with seeds 20261124 to 20261143. The range beside a figure is Student's 95% interval over the worlds, which are independent of each other; people in one world are not.

The plainest rule is scored beside it: whoever shares any one device, number or email is one person.

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
| Own email mistyped | 2% | 5% | 15% | Assumed. Vendors report 8 to 15% |
| Own number mistyped | 1% | 3% | 10% | Assumed. One [emergency department](https://pubmed.ncbi.nlm.nih.gov/10802416/), 2000: 16% unreachable, for every reason |
| Staff mistype an email; a number | 2%; 0.3% | 5%; 1% | 15%; 4% | Number: [0.29% a field](https://pmc.ncbi.nlm.nih.gov/articles/PMC10775420/) keyed, and assumed above it when heard. Email assumed |
| Hidden number | 1% | 3% | 8% | Assumed |
| Tapped, on a telephone; on a computer | 95%; 10% | 85%; 3% | 70%; 0% | Assumed |
| One adult speaks for another | 2% | 5% | 10% | Assumed |
| Entered twice | 5% | 10% | 20% | Assumed |
| Another adult of the household also comes | 5% | 10% | 25% | Assumed |
| Only visits; fills the form; calls; answered; email asked | 80%; 40%; 60%; 80%; 60% | same | same | Assumed. They set how much there is, not how hard it is |

`busy` is the base rates with 6,000 people in five days, for calls and taps by strangers close together.

## What would be bad

Written before anything was run.

| In | Bad |
| --- | --- |
| Base | More than 1% of people with a record share a cluster with somebody else's record, or the interval reaches 2% |
| Base | Fewer than 98% of joined pairs are right |
| Base | Fewer than 70% of the true pairs with a chain of facts are found |
| Base | The plainest rule mixes no more people's records than account-graph does |
| Base | A kind of evidence with 200 links or more has over 5% of them between two people |
| High | More than 5% of people with a record share a cluster with somebody else's |
| Busy | Over 5% of the links that rest on a tap are between two people |

Every setting and figure is published whichever way it comes out. A rate is not changed after a run; a new setting is added beside these.

## Limitations

- Most rates are assumed. Under `high`, every one is at its hard end at once.
- People act alone or with their household. Friends, offices and shelters that share a telephone or computer are not made up.
- Nobody lies about who they are.
- A world is small. Stranger pairs meet more often where more people are known, and fewer where fewer are.
