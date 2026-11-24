# Campaign report

The report lists each campaign's cost beside the outcomes its visitors produced, using the links already in the graph.

```sh
curl -H "authorization: Bearer $REVIEWER_TOKEN" \
  "https://graph.example.org/report?from=2026-11-01&to=2026-11-14"
```

```text
Source   Campaign              Cost   Clicks  Visits    inquiry  enrolled   Value
google   Search: garden tools  873.60    336         9        9         3     645
meta     Retarget visitors     392.00    154         6        6         1     230
google   Search: brand         164.50     70         5        5         3     625
(none)                           0.00      0         0        0         1     200
```

The **Channels** view at `/review` shows the same table. Run `npm run review` to see it with sample data.

## Data sources

```text
ad platform  ──▶ cost per campaign per day ───────┐
landing page ──▶ touch: click id and campaign id ─┼──▶ report
your backend ──▶ outcome: who, when, which step ──┘
```

### Campaign ids

A click id identifies the platform a visitor came from. To identify the campaign, add its id to every ad's address in the ad account's tracking settings.

| Platform | Where | What to add |
| --- | --- | --- |
| Google Ads | Account settings, **Tracking**, Final URL suffix | `utm_id={campaignid}&adgroupid={adgroupid}&creative={creative}&utm_term={keyword}` |
| Meta | Each ad, **URL parameters** | `utm_id={{campaign.id}}&adgroupid={{adset.id}}&adid={{ad.id}}` |
| Microsoft Advertising | Account settings, Final URL suffix | `utm_id={CampaignId}&adgroupid={AdGroupId}&adid={AdId}` |
| TikTok | Each ad's address | `utm_id=__CAMPAIGN_ID__&adgroupid=__AID__&adid=__CID__` |

To report by office or language, add your own parameters in the same place, for each campaign or ad group:

```text
utm_id={campaignid}&office=north&lang=es
```

Name them on the script tag as `collect.js?params=office,lang`. [Breakdowns](#breakdowns) read `office` as the advertised office and `lang` as the language.

| Parameter | Kept as |
| --- | --- |
| `utm_id`, or `campaignid` | `campaignId` |
| `adgroupid` | `adGroupId` |
| `adid`, or `creative` | `adId` |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` | `source`, `medium`, `campaign`, `term`, `content` |
| Names listed in `collect.js?params=mailing,placement` | `custom.mailing`, `custom.placement` |

Costs and visits are matched by campaign id first, then by name:

- A visit without an id matches a cost by `utm_campaign`, ignoring case. An id written into `utm_campaign` also matches.
- A visit whose id has no cost matches by name only a cost that has no id, such as a spreadsheet row.
- When two campaigns of one source share a name, the name matches the one that cost more.

### Costs

The server reads Google Ads and Meta costs every six hours once their variables are set. See [providers.md](providers.md) for the steps.

```sh
GOOGLE_ADS_DEVELOPER_TOKEN=…     # with GOOGLE_ADS_CUSTOMER_ID and GOOGLE_SERVICE_ACCOUNT_FILE
META_AD_ACCOUNT_ID=…  META_ADS_TOKEN=…
```

For other platforms, post the rows or send a CSV file:

```sh
curl -X POST https://graph.example.org/costs -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '[{"day":"2026-11-14","source":"mailer","campaign":"November postcard","amount":300,"currency":"USD"}]'

GRAPH_URL=https://graph.example.org GRAPH_TOKEN=… npm run costs -- spend.csv
```

A row replaces the earlier row for the same day, source and campaign, so a day can be sent again. Each read covers the last seven days, because platforms revise recent days.

### Outcomes

Your backend reports what a person did. Name the step in `stage`, and add a value if it has one.

```sh
curl -X POST https://graph.example.org/convert -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"transactionId":"enroll-1001","subject":"account:42","at":1795460000000,"stage":"enrolled","value":200,"currency":"USD"}'
```

Add `action` to send the outcome to the ad platforms through [the outbox](library.md#the-outbox). Without an action, here or in [`STAGES`](#steps), the outcome is counted in the report only.

## Steps

`STAGES` names your steps in order, with the value of each. An outcome then needs only its step.

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

This outcome counts 200 USD and is sent to Google and Meta. Page events named `inquiry` and phone calls take their steps the same way.

| An outcome that | Gets |
| --- | --- |
| Names only a step | The step's value, currency and action |
| States its own value, currency or action | What it states. The step fills in the rest. |
| Names a step that is not listed | Counted under that name, as sent |

When the real amount is known, [restate it](#value-changes) with `POST /restate`. The report changes, and so does the value Google holds:

```sh
curl -X POST https://graph.example.org/restate -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"transactionId":"client-1001","value":1250}'
```

Report columns follow the order of `STAGES`. The server refuses to start if an action names a platform that is not set up, or if any step has an action while no ad platform is set up.

> **Page-reported steps can be forged.** A step listed in both `EVENTS` and `STAGES` can be created by a browser: once a day per browser, at the step's value. See [Page events](calls.md#page-events) for choosing which steps to allow.

### Cost per step

Cost per outcome counts every step. Pass `per=enrolled`, or use **Cost per** on the Channels view, to count one step. A campaign that cost 1,872 with nine calls and three clients cost 156 per outcome and 624 per client. ROAS always uses all value.

## Breakdowns

A dimension splits each line by the advertised office, the serving office, the language, the hour or the weekday.

```sh
curl -H "authorization: Bearer $REVIEWER_TOKEN" \
  "https://graph.example.org/report?from=2026-11-01&to=2026-11-14&by=outcome.office_served"
```

```json
{ "by": "outcome.office_served", "total": { "outcomes": 9, "breakdown": [
  { "name": "north", "outcomes": 5, "value": 1000, "missed": 0, "stages": { "enrolled": { "count": 5, "value": 1000 } } },
  { "name": "river", "outcomes": 3, "value": 600, "missed": 0, "stages": { "enrolled": { "count": 3, "value": 600 } } },
  { "name": "(not set)", "outcomes": 1, "value": 200, "missed": 0, "stages": { "enrolled": { "count": 1, "value": 200 } } } ] } }
```

| `by` | Splits by | Source |
| --- | --- | --- |
| `touch.<name>` | The credited visit | A parameter of your own on the landing address (`collect.js?params=office,lang`), or the `tags` of the number dialed |
| `outcome.<name>` | The outcome | `tags` on `POST /convert`, or on the `POST /call` it came from |
| `hour`, `weekday` | When it happened | The report's time zone |

The response lists the `dimensions` recorded in the period; the Channels view offers them in **Breakdown**. Outcomes without a value have their own line, `(not set)`, so the parts add up to the total, rounding aside.

> **Costs stay on the campaign.** Cost, clicks and visits apply to the whole campaign and are excluded from breakdowns.

### Tag names

Use these names so reports stay comparable from month to month. Values are short codes you choose and keep: `north`, not `North Office (main)`.

| Name | On | Meaning |
| --- | --- | --- |
| `office_advertised` | visits and numbers | The office in the ad or listing. `office` in an address is read as this. |
| `office_served` | outcomes | The office that served the person |
| `language` | visits, numbers, calls, outcomes | `en`, `es`. `lang` in an address is read as this. |

The advertised and serving offices are separate facts, and neither is filled in from the other.

An outcome or call carries at most 8 tags. A name is lowercase letters and underscores, up to 32 characters; a value is up to 64. `(not set)` is reserved and rejected as a value.

## Not a lead

Mark a call or outcome that is spam, a wrong number, a supplier or an existing client:

```sh
curl -X POST https://graph.example.org/not-lead -H "authorization: Bearer $GRAPH_TOKEN" -d '{"call":"CA1","kind":"spam"}'
curl -X POST https://graph.example.org/not-lead -H "authorization: Bearer $GRAPH_TOKEN" -d '{"transactionId":"inquiry-1001"}'
```

| Where | Effect |
| --- | --- |
| The report | Excluded from outcomes, value, people, missed calls and cost per outcome. `notLeads` counts it on the campaign it would be credited to. |
| The call summary | Counted as `notLeads` only |
| The Calls view, the Board and alerts | A missed call no longer waits for a callback |
| Outcomes after a call | Excluded |
| A journey, `GET /call`, `GET /outcome` | Still shown, marked `notLead` |
| Ad platforms | Not sent if queued. Restated to zero where the platform supports it; kept by the others. |

A mark can precede its outcome; a call marked before its result is not counted when the result arrives. `"lead": true` removes the mark: everything counts again, and a conversion is sent at its current value. `forget` deletes the mark with its subject, and `prune` deletes marks whose outcome did not arrive.

> **Marks are not checked.** A campaign looks cheaper per lead when its poor leads are marked. Mark by a fixed rule, and read `notLeads` beside the cost.

## Board

The Board puts each person in one column. A person is a cluster, with all its subjects.

| Column | Who is in it |
| --- | --- |
| Missed calls | Anyone with an unreturned missed call or voicemail, whatever step they reached. Reaching them on any of their numbers returns it. Callers who hid their number are excluded. |
| Each step in `STAGES`, in order | Everyone else, at the furthest step they reached. A later inquiry does not move a client back. |

Each column counts its people, and three values for today in `REPORT_TIME_ZONE`:

| Count | Meaning |
| --- | --- |
| New today | They reached this step today, or their oldest missed call came today |
| Overdue | Longer at this step than its `wait`, in hours, or unreturned longer than `RETURN_HOURS`. Both count [opening hours](operations.md#opening-hours) where set. Without a limit, the count is empty. |
| Advanced today | They reached a further step, their call was returned, or they called again and got through |

```sh
STAGES='{"inquiry":{"value":5,"wait":48},"client":{"value":200}}'
```

The Board reads people with a step or a call, inbound or outbound, in the period: 90 days by default. Rows list the longest waiting first, at most 50 per column; counts include everyone. The Board makes no assignments.

## Outcomes after a call

`/followed` counts how many callers reached a step within a number of days.

```sh
curl -H "authorization: Bearer $REVIEWER_TOKEN" \
  "https://graph.example.org/followed?from=2026-09-01&to=2026-09-30&step=client&days=30"
```

```json
{ "step": "client", "days": 30, "least": 20, "excluded": { "first": { "already": 4, "running": 0 }, "returned": { "already": 9, "running": 0, "through": 31 } }, "groups": [
  { "by": "returned", "suppressed": 0, "rows": [
    { "name": "returned within a day", "people": 64, "reached": 16, "share": 0.25 },
    { "name": "not returned within a day", "people": 51, "reached": 9, "share": 0.1765 } ] } ] }
```

| Group | Splits people by | The clock starts |
| --- | --- | --- |
| `answer` | Whether their first call in the period was answered, missed, or went to voicemail | When that call ended |
| `talk` | Talk time of an answered call: its length without the wait, and `(not set)` unless both are known | When that call ended |
| `language` | The `language` tag of that call | When that call ended |
| `returned` | Whether their first missed call was returned within a day | A day after the missed call, for everyone |

A person is a cluster, so calls from two numbers and outcomes under an account count once. People who reached the step before the clock started, or whose days are still running, are excluded and counted under `excluded`. Rows of fewer than 20 people are hidden, and `insufficientData` counts the people in them.

The one-day delay in `returned` removes one bias: people already signing up are often called about it. Anyone who signed up or got through on their own before the clock started is excluded. Other biases remain.

### Correlation and effect

The figures show correlation. People choose whether to call and how long to talk, and staff choose whom to call back. A row with a higher share may hold people who would have signed up anyway.

If 25% of returned callers become clients and 18% of the rest do, any of these could explain it:

- Callbacks win clients.
- Staff call back the people who sounded ready.
- Ready people answer, and only an answered call counts as returned.
- Weekday-morning calls are returned more often, and come from readier callers.

To measure the effect, choose at random whom to call back, keep the list, and compare everyone chosen with everyone else, whether or not they answered. Otherwise, use the table to find what to investigate. The report does not rank staff or score callers.

## Attribution

The report uses the same attribution as `/attribute`. From the account, it follows links to the visitors that are the same person, and credits the newest visit within 90 days that is one person with it: in the same cluster, or linked at 0.9 or higher.

An outcome without such a visit goes on the `(none)` line, so totals add up. An outcome counts on the day it happened: an October click that enrolls in November is in November's report, under October's campaign.

A visit's source is the platform of its click id, then its `utm_source`, then the referring site.

| `utm_source` | Read as |
| --- | --- |
| `facebook`, `fb`, `instagram`, `ig` | `meta` |
| `adwords`, `googleads` | `google` |
| `bing`, `microsoftads` | `microsoft` |

## Columns

| Column | Meaning |
| --- | --- |
| Cost, Clicks, Impressions | What the platform billed and counted, from the costs |
| [Cost per outcome](#cost-per-outcome) | The campaign's cost over the outcomes credited to it, on days that have cost data |
| ROAS | The value of those outcomes over the same cost |
| Visits | Visits the script tag recorded with a click id or a campaign. Far fewer visits than clicks means the tag is missing from landing pages. |
| One column per step | Outcomes of that step credited to the line, and their value |
| `(none)` | Outcomes without an attributed visit |
| A source with no campaign | Visits whose address had no campaign id or name. [Add the tracking setting](#campaign-ids). |
| No data under Cost | No cost was reported for the line, so its cost is unknown |

### People and delay

Each step counts people as well as outcomes. A person is a cluster: two accounts of one person count once, and a renewal is a second outcome of the same person. The Channels view shows both numbers where they differ.

`stages.<step>.delay` gives the days from the newest visit to the outcome.

| Field | Meaning |
| --- | --- |
| `count` | Outcomes that have a visit in the year before them |
| `median`, `p95` | Median and 95th percentile, in days |
| `inside` | The share within the attribution window, and so eligible for credit |

Costs are recorded the day they are spent and outcomes later, so the end of a period is missing outcomes. When the period reaches into those days, the report has `incomplete`, with `after` as the last complete day, and the Channels view says so. The slowest step's 95th percentile sets the length, from the newest 200 outcomes per step in the last half year; a step needs at least 20 that could be credited.

### Value changes

A step's value is an estimate. Record the step when it happens, and restate the value when you know the amount collected:

```sh
curl -X POST https://graph.example.org/convert -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"transactionId":"client-42","subject":"contact:42","at":1795460000000,"stage":"client"}'
curl -X POST https://graph.example.org/restate -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"transactionId":"client-42","value":420.50}'
```

`value` is the outcome's value after the change. Set `kind` when money is returned or will not be paid:

| `kind` | Meaning |
| --- | --- |
| `refund` | Some of it was given back |
| `write_off` | Some of it will not be paid |
| omitted | The known amount is corrected |

```sh
curl -X POST https://graph.example.org/restate -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"transactionId":"client-42","value":300,"kind":"refund"}'
```

The decrease is the amount refunded or written off. To reverse one, send the same `kind` with the higher value, up to the amount recorded. Any other increase with a `kind`, or a different currency, answers 400.

Sending the same value again changes nothing, so a `kind` cannot be added to an earlier change.

`GET /outcome?id=client-42` lists every value an outcome has had. The report gives these figures for each campaign (`valueChange`) and for each month outcomes were first recorded in (`months`):

| Figure | Meaning |
| --- | --- |
| `first` | Value when first recorded |
| `firstUnknown` | Outcomes recorded before values were kept, excluded from `first` |
| `now` | Current value of all outcomes, net of the next two figures |
| `refunded` | Amount recorded as refunded |
| `writtenOff` | Amount recorded as written off |
| `zeroed` | Outcomes whose value was above zero and is now zero |

| Platform | When a value is restated |
| --- | --- |
| Google Ads | The value is sent again under the same id and overwrites the old one. Google cannot retract a conversion: at zero it still counts as one. |
| Meta, Microsoft, TikTok | They keep the first value. Only the report changes. |

### Cost per outcome

Cost per outcome and ROAS are computed per campaign:

- Only **outcomes credited to that campaign** count.
- Only **days that have cost data for that campaign** count, for both costs and outcomes.
- `missingDays` of `days` says how many days have no cost data. Future days are excluded.
- `insufficientData` is true when fewer than half of the days have cost data, and both figures are null. The screen shows insufficient data.
- A campaign without paid visits or any cost, such as a newsletter, is exempt from `insufficientData`.
- Spend without a campaign gives no figure.
- The total covers the campaigns with enough data, and `excluded` counts the others.

A day without a row is missing, even if the campaign was paused. Post a row of zero for a day you know cost nothing.

### Platform-reported conversions

Ad platforms count conversions by their own rules. Send their number with the cost to see it beside what is credited here:

```sh
curl -X POST https://graph.example.org/costs -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '[{"day":"2026-11-14","source":"microsoft","campaignId":"55","amount":300,"currency":"USD","conversions":7.5,"conversionValue":900}]'
```

A `conversionValue` requires `conversions`. CSV columns use the same names. The server can read both from Google Ads and Meta along with the costs; this is off by default.

| Setting | Reads |
| --- | --- |
| `GOOGLE_ADS_CONVERSIONS=true` | `metrics.conversions` and its value: the actions you let Google count as conversions |
| `META_ADS_CONVERSIONS=offsite_conversion.fb_pixel_lead` | How many of that one action Meta reports, and its value |

Campaigns with a number, and the total, have `reported`:

| Figure | Meaning |
| --- | --- |
| `days` | Days of the period, up to today, with a number from the platform |
| `conversions`, `value` | Platform-reported conversions and value on those days. `value` is null when some had none. |
| `credited`, `creditedValue` | Credited here on the same days, for the step in `per` or for every step |

The two counts can differ for several reasons:

- A platform may count on the day of the click; the report counts on the day of the outcome. Compare weeks.
- Two platforms may both report one client. The report credits one campaign at most.
- A platform counts visitors it recognizes and estimates some it does not, so its number may be a fraction.
- A platform counts the actions you set up there. Set `per` to the matching step.

Platforms add to a day for weeks. Set `COST_DAYS` to the length of the platform's window, such as `30`, to read those days again. A resent row replaces the whole row, so post costs and conversions together.

## Limitations

| Area | Detail |
| --- | --- |
| Credit | The newest strong visit gets all of it. Earlier visits are in `/attribute` only. |
| Currency | Amounts are summed as given. `currencies` lists every currency seen; more than one means the sums mix them. |
| Days | A day runs midnight to midnight in `REPORT_TIME_ZONE`, or the `tz` parameter. Use the ad account's time zone so the days match the costs. |
| Work | The report is computed on request. It reads every outcome and missed call in the range, and follows their links a thousand people at a time. |
| Range | Without `from` and `to`, the last thirty days. |
| Platforms read automatically | Google Ads and Meta. Costs from Microsoft, TikTok and others go through `/costs`. |
| Verification | The tracking parameters are each platform's documented names, untested against a live ad account. |
