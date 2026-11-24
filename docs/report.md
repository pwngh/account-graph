# What each campaign cost and brought in

The report sets each campaign's cost beside the outcomes its visitors went on to produce. It answers "which campaigns pay for themselves" from the same links the graph already keeps.

```sh
curl -H "authorization: Bearer $REVIEWER_TOKEN" \
  "https://graph.example.org/report?from=2026-11-01&to=2026-11-14"
```

```text
Source   Campaign              Cost   Clicks  Arrivals  inquiry  enrolled   Value
google   Search: garden tools  873.60    336         9        9         3     645
meta     Retarget visitors     392.00    154         6        6         1     230
google   Search: brand         164.50     70         5        5         3     625
(none)                           0.00      0         0        0         1     200
```

The same table is on the reviewer screen: open `/review` and press **Channels**. Run `npm run review` to see it over made-up data.

## What feeds it

```text
ad platform  ──▶ cost per campaign per day ───────┐
landing page ──▶ touch: click id and campaign id ─┼──▶ report
your backend ──▶ outcome: who, when, which step ──┘
```

Three things have to arrive. Each is one setting or one call.

### 1. The campaign's id on the landing address

A click id says which platform a visitor came from, not which campaign. Add the campaign's id to every ad's address, once, in the ad account's tracking settings. The script tag reads it from there.

| Platform | Where | What to add |
| --- | --- | --- |
| Google Ads | Account settings, **Tracking**, Final URL suffix | `utm_id={campaignid}&adgroupid={adgroupid}&creative={creative}&utm_term={keyword}` |
| Meta | Each ad, **URL parameters** | `utm_id={{campaign.id}}&adgroupid={{adset.id}}&adid={{ad.id}}` |
| Microsoft Advertising | Account settings, Final URL suffix | `utm_id={CampaignId}&adgroupid={AdGroupId}&adid={AdId}` |
| TikTok | Each ad's address | `utm_id=__CAMPAIGN_ID__&adgroupid=__AID__&adid=__CID__` |

To report by office or by language, add those too, in the same place. They are yours, so each campaign or ad group says its own:

```text
utm_id={campaignid}&office=north&lang=es
```

Then name them on the script tag, `collect.js?params=office,lang`. [Breaking it down](#breaking-it-down) reads `office` as the office advertised and `lang` as the language. Which office served somebody is another fact, known later, and goes on the outcome.

The script tag reads these parameters:

| Parameter | Kept as |
| --- | --- |
| `utm_id`, or `campaignid` | `campaignId` |
| `adgroupid` | `adGroupId` |
| `adid`, or `creative` | `adId` |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` | `source`, `medium`, `campaign`, `term`, `content` |
| Names listed in `collect.js?params=mailing,placement` | `custom.mailing`, `custom.placement` |

A campaign can also be matched by name. When a touch has no id, its `utm_campaign` is compared with the campaign names in the costs, ignoring case. A touch whose id no cost knows is matched by name only to a cost that has no id either, such as a row from a spreadsheet. An id written into `utm_campaign` is found too. When two campaigns of one source share a name, the name stands for the one that cost more.

### 2. Costs

For Google Ads and Meta the server reads costs itself, every six hours, once their variables are set. [providers.md](providers.md) has the steps.

```sh
GOOGLE_ADS_DEVELOPER_TOKEN=…     # with GOOGLE_ADS_CUSTOMER_ID and GOOGLE_SERVICE_ACCOUNT_FILE
META_AD_ACCOUNT_ID=…  META_ADS_TOKEN=…
```

For anything else, post the rows or send a spreadsheet saved as CSV:

```sh
curl -X POST https://graph.example.org/costs -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '[{"day":"2026-11-14","source":"mailer","campaign":"November postcard","amount":300,"currency":"USD"}]'

GRAPH_URL=https://graph.example.org GRAPH_TOKEN=… npm run costs -- spend.csv
```

A row for the same day, source and campaign replaces the one before, so sending a day again is safe. The server reads the last seven days each time, because platforms revise recent days.

### 3. Outcomes

Your backend says what a person did. Name the step in `stage`, and give it a value if it has one.

```sh
curl -X POST https://graph.example.org/convert -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"transactionId":"enroll-1001","subject":"account:42","at":1795460000000,"stage":"enrolled","value":200,"currency":"USD"}'
```

Add `action` and the same call also sends the outcome to the ad platforms; see [the outbox](library.md#the-outbox). Without it the outcome is counted here and sent nowhere. `POST /restate` changes a value later, for a refund or for what was actually paid.

## Steps and what each is worth

Most businesses count the same few steps: an inquiry, a call, a sale. Name them once, in order, with what each is worth, and an outcome needs only its step.

```sh
STAGES='{
  "inquiry": { "value": 5,   "currency": "USD", "action": { "google": "111", "meta": "Lead" } },
  "call":    { "value": 10,  "currency": "USD", "action": { "google": "222" } },
  "client":  { "value": 200, "currency": "USD", "action": { "google": "333", "meta": "Purchase" } }
}'
```

```sh
curl -X POST https://graph.example.org/convert -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"transactionId":"client-1001","subject":"account:42","at":1795460000000,"stage":"client"}'
```

That outcome is counted at 200 USD and sent to Google and Meta. A page event named `inquiry` and a phone call take their steps the same way, with no code on your side.

| An outcome that | Gets |
| --- | --- |
| Names a step and nothing else | The step's value, currency and action. |
| States its own value, currency or action | What it states. The step fills in only what is missing. |
| Names a step that is not listed | Nothing added. It is counted under that name. |

When the real amount is known, restate it. The report changes, and so does the value Google holds:

```sh
curl -X POST https://graph.example.org/restate -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"transactionId":"client-1001","value":1250}'
```

The report's columns follow the order of `STAGES`. A step whose action names a platform that is not set up stops the server at start, so a typo cannot quietly send nothing. That includes any action at all while no ad platform is set up.

> **A step that a page can report is a step a page can fake.** If a step is also listed in `EVENTS`, a browser can create it: once a day per browser, at the step's value. [Page events](calls.md#page-events) says how to choose which steps to allow.

## What one step cost

Cost per outcome counts every step, so it says what a call *or* a client cost. Name one step and it counts only that: `per=enrolled`, or **Cost per** on the Channels view. A campaign that cost 1,872 and brought nine calls and three clients cost 156 an outcome and 624 a client. The return still sets all value against the cost.

## Breaking it down

Ask for a dimension and every line is split by it: which office was advertised, which one served the person, in what language, at what hour.

```sh
curl -H "authorization: Bearer $REVIEWER_TOKEN" \
  "https://graph.example.org/report?from=2026-11-01&to=2026-11-14&by=outcome.office_served"
```

```json
{ "by": "outcome.office_served", "total": { "outcomes": 9, "breakdown": [
  { "name": "north", "outcomes": 5, "value": 1000, "missed": 0, "stages": { "enrolled": { "count": 5, "value": 1000 } } },
  { "name": "river", "outcomes": 3, "value": 600, "missed": 0, "stages": { "enrolled": { "count": 3, "value": 600 } } },
  { "name": "(not recorded)", "outcomes": 1, "value": 200, "missed": 0, "stages": { "enrolled": { "count": 1, "value": 200 } } } ] } }
```

| `by` | Splits by | Where it comes from |
| --- | --- | --- |
| `touch.<name>` | What the credited arrival said | A parameter of your own on the landing address (`collect.js?params=office,lang`), or the `tags` of the number that was rung |
| `outcome.<name>` | What is known of the outcome itself | `tags` on `POST /convert`, or on the `POST /call` it came from |
| `hour`, `weekday` | When it happened, in the report's time zone | Worked out |

The answer names the `dimensions` something in those days was recorded under. On the Channels view they are in **Break down by**.

> **Costs stay on the campaign.** A campaign that served several offices was charged once. Splitting its cost by where people were served would be a guess, so cost, clicks and arrivals are never split.

Outcomes with nothing recorded are always on a line of their own, `(not recorded)`. They are never folded into another value and never left out, so the parts add up to the line, rounding aside.

### The codes

Use these names, so reports read the same from month to month. Values are short codes you choose and keep: `north`, not `North Office (main)`.

| Name | On | Says |
| --- | --- | --- |
| `office_advertised` | arrivals and numbers | The office the ad or the listing was for. `office` in an address is read as this. |
| `office_served` | outcomes | The office that served the person. |
| `language` | arrivals, numbers, calls, outcomes | `en`, `es`. `lang` in an address is read as this. |

The advertised office and the serving office are two facts, and often differ. Neither is ever filled in from the other.

An outcome or a call carries at most 8 tags, each name of lowercase letters and underscores up to 32 characters, each value up to 64. `(not recorded)` is not a value: it is what a missing one is called.

## People by step

The Board puts each person in one column. A person is everyone the graph treats as one, whatever subjects they left.

| Column | Who is in it |
| --- | --- |
| Missed, not returned | Whoever has a missed call or a voicemail that nobody returned, however far they got. Being reached on any of their numbers returns it. A caller who hid their number cannot be rung back, so is not here. |
| Each step in `STAGES`, in order | Everybody else, at the furthest step they ever reached. A later inquiry does not move a client back. |

Each column counts its people and three things about today, in the time zone `REPORT_TIME_ZONE`:

| Count | Means |
| --- | --- |
| New today | They reached this step today, or their oldest missed call came today. |
| Waiting | Longer at this step than its `wait`, in hours, or longer unreturned than `RETURN_HOURS`. With no limit set, none is counted. |
| Went further today, returned or got through today | They left for a further step, or their call was returned or they rang again and got through. |

```sh
STAGES='{"inquiry":{"value":5,"wait":48},"client":{"value":200}}'
```

Only people who reached a step or had a call, to you or from you, in the period are read, 90 days unless you say. Rows show who has been there longest, at most 50 to a column; the counts are of everybody. The Board is read from what is recorded. It assigns nothing to anyone.

## What followed a call

Choose a step and a number of days, and the report counts who went on to reach it after calling.

```sh
curl -H "authorization: Bearer $REVIEWER_TOKEN" \
  "https://graph.example.org/followed?from=2026-09-01&to=2026-09-30&step=client&days=30"
```

```json
{ "step": "client", "days": 30, "least": 20, "leftOut": { "first": { "already": 4, "running": 0 }, "returned": { "already": 9, "running": 0, "through": 31 } }, "groups": [
  { "by": "returned", "thin": 0, "rows": [
    { "name": "returned within a day", "people": 64, "reached": 16, "share": 0.25 },
    { "name": "not returned within a day", "people": 51, "reached": 9, "share": 0.1765 } ] } ] }
```

| Group | Splits people by | The clock starts |
| --- | --- | --- |
| `answer` | Whether their first call in the period was answered, missed, or went to voicemail | When that call ended |
| `talk` | How long they talked, if it was answered: its length without the wait, and `(not recorded)` unless both are known | When that call ended |
| `language` | The `language` tag of that call | When that call ended |
| `returned` | Whether their first missed call was returned within a day | A day after the miss, for everyone |

People are counted, not calls: someone who rings from two numbers on file as theirs is one person, and what they did under an account is theirs. Whoever had reached the step before the clock started, or is still inside their days, is left out and counted under `leftOut`.

> **This is what followed, not what it caused.** People choose whether to call and how long to talk. Whoever rings back chooses whom. A row with a higher share may hold people who were going to sign up anyway.

The day after a miss is there for one bias in particular. People who are already signing up get rung about it, so a plain count makes ringing back look like the cause of sign-ups it only went with. Everyone's clock starts a day after the miss, and whoever had signed up or got through by themselves before then is in neither row. That removes this bias and not the others.

### Why a correlation is not an effect

Suppose 25% of the people rung back become clients, and 18% of the rest. Four things could make that so, and the table cannot tell them apart.

| What could be true | In this table it looks like |
| --- | --- |
| Ringing back wins clients. | Ringing back wins clients. |
| Staff ring back the ones who sounded ready. | Ringing back wins clients. |
| The ready ones answer when they are rung, and an answered call is what counts as returned. | Ringing back wins clients. |
| Calls on weekday mornings are rung back more, and weekday mornings bring readier callers. | Ringing back wins clients. |

To know, ring back some at random and not others, and compare. If that is not possible, use the table to find what to look into, and not to say what something was worth.

Rows of fewer than 20 people are not shown, and `thin` says how many people were in them. Nothing here ranks staff or scores callers.

## How an outcome finds its campaign

The report asks the graph the same question `/attribute` answers. Starting from the account, it follows links to the visitors that are the same person, and takes the newest arrival within 90 days that is tied at 0.9 or better.

That arrival's campaign gets the outcome. If the account is tied to no arrival strongly enough, the outcome goes on the `(none)` line, so the totals always add up.

A touch is filed under a source in this order: the platform of its click id, then its `utm_source`, then the site that referred it. `facebook`, `fb`, `instagram` and `ig` are read as `meta`; `adwords` as `google`; `bing` as `microsoft`.

> **An outcome counts on the day it happened, not the day of the click.** A click in October that enrolls in November is in November's report, under October's campaign.

## Reading it

| Column | Meaning |
| --- | --- |
| Cost, Clicks, Impressions | What the platform billed and counted, from the costs. |
| Cost per outcome | The campaign's cost over the outcomes credited to it, on the days that have cost data for it. See below. |
| Return | The value of those outcomes over the same cost. |
| Arrivals | Visits the script tag recorded with a click id or a campaign. Far fewer arrivals than clicks means the tag is missing from landing pages. |
| One column per step | How many outcomes of that step were credited to the line, and their value. |
| `(none)` | Outcomes with no arrival to credit. |
| A source with no campaign | Arrivals whose address carried no campaign id or name. Add the tracking setting above. |
| `(not recorded)` under Cost | Nobody reported a cost for that line. It may have cost nothing, or anything. |

### People, and how long it takes

Outcomes are counted, and so are the people they belong to. A person is a cluster: one person with two accounts is one, and a renewal is a second outcome and not a second person. Where a step's people and outcomes differ, the Channels view shows both.

For each step the report says how long it takes: the days from the newest arrival to the outcome.

| Field of `stages.<step>.delay` | Says |
| --- | --- |
| `count` | Outcomes that have an arrival in the year before them |
| `median`, `p95` | Half came within this many days, and 95 in 100 within that many |
| `inside` | The share that came inside the window, and so could be credited |

Costs arrive the day they are spent, and outcomes days or weeks later. So the last part of a period is always short of outcomes. When the period reaches into those days, the report has `filling`, the Channels view says so, and `after` is the last day that has had its time. How long is read from the newest 200 outcomes of each step in the last half year, whatever days were asked about. The slowest step with at least 20 that could be credited decides. With fewer, nothing is said.

### What an outcome turned out to be worth

A step's value is a guess. What was collected is known later, differs from person to person, and is sometimes nothing. So record the step with its value when it happens, and restate it when you know:

```sh
curl -X POST https://graph.example.org/convert -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"transactionId":"client-42","subject":"contact:42","at":1795460000000,"stage":"client"}'
curl -X POST https://graph.example.org/restate -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"transactionId":"client-42","value":420.50}'
```

Every value an outcome has had is kept, and `GET /outcome?id=client-42` lists them. The report shows these for each campaign (`worth`) and for each month outcomes were first recorded in (`months`):

| Figure | Says |
| --- | --- |
| `first` | What the outcomes were worth when first recorded |
| `firstUnknown` | How many were recorded before values were kept. They are not in `first` |
| `now` | What all of them are worth now |
| `zeroed` | How many were worth something once and are now worth nothing |

Restating also tells the platforms that can be told.

| Platform | When a value is restated |
| --- | --- |
| Google Ads | The value is sent again under the same id, and Google overwrites what it holds. It cannot retract a conversion: at zero it still counts as one. |
| Meta, Microsoft, TikTok | They keep the first value. Only the report changes. |

### What an outcome cost

A cost per outcome is easy to get wrong in two ways: dividing all the money by all the clients, or by outcomes from days whose cost never arrived. So the report does neither.

- It uses **only outcomes credited to that campaign**. Outcomes nothing could be credited with cost no campaign anything.
- It uses **only days that have cost data for that campaign**, on both sides. An outcome on a day with no cost would look free.
- It says how many days are missing: `missingDays` of `days`. Days still to come are not missing.
- When fewer than half of the days have cost data, `thin` is true and both figures are withheld. A campaign whose arrivals were not paid for, and which has no cost at all, is not counted as missing any: it may be a newsletter. Spend on no campaign in particular gives no figure.
- The total is worked out the same way, over the campaigns that were not withheld. `leftOut` says how many were.

A day with no row is a missing day, even where the campaign was simply paused: a platform that sends no row does not say which. Post a row of zero for a day you know cost nothing.


## Limits

| Limit | Detail |
| --- | --- |
| Credit | The newest strong touch gets all of it. Earlier touches are in `/attribute`, not in the report. |
| Currency | Amounts are summed as given. `currencies` lists every currency seen; more than one means the sums mix them. |
| Days | A day runs midnight to midnight in `REPORT_TIME_ZONE`, or the `tz` parameter. Use the ad account's time zone, so the days match the costs. |
| Work | The report is worked out when asked. It reads every outcome in the range and follows each one's links. |
| Range | Without `from` and `to`, the last thirty days. |
| Platforms read automatically | Google Ads and Meta. Costs from Microsoft, TikTok and anything else go through `/costs`. |
| Not confirmed | The tracking parameters in the first table are each platform's documented names, not checked against a live ad account here. |
