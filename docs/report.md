# What each campaign cost and brought in

The report sets each campaign's cost beside the outcomes its visitors went on to produce. It answers "which campaigns pay for themselves" from the same links the graph already keeps.

```sh
curl -H "authorization: Bearer $REVIEW_TOKEN" \
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

The script tag reads these parameters:

| Parameter | Kept as |
| --- | --- |
| `utm_id`, or `campaignid` | `campaignId` |
| `adgroupid` | `adGroupId` |
| `adid`, or `creative` | `adId` |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` | `source`, `medium`, `campaign`, `term`, `content` |
| Names listed in `collect.js?params=mailing,placement` | `custom.mailing`, `custom.placement` |

A campaign can also be matched by name. When a touch has no id, its `utm_campaign` is compared with the campaign names in the costs, ignoring case.

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

## How an outcome finds its campaign

The report asks the graph the same question `/attribute` answers. Starting from the account, it follows links to the visitors that are the same person, and takes the newest arrival within 90 days that is tied at 0.9 or better.

That arrival's campaign gets the outcome. If the account is tied to no arrival strongly enough, the outcome goes on the `(none)` line, so the totals always add up.

A touch is filed under a source in this order: the platform of its click id, then its `utm_source`, then the site that referred it. `facebook`, `fb`, `instagram` and `ig` are read as `meta`; `adwords` as `google`; `bing` as `microsoft`.

> **An outcome counts on the day it happened, not the day of the click.** A click in October that enrolls in November is in November's report, under October's campaign.

## Reading it

| Column | Meaning |
| --- | --- |
| Cost, Clicks, Impressions | What the platform billed and counted, from the costs. |
| Arrivals | Visits the script tag recorded with a click id or a campaign. Far fewer arrivals than clicks means the tag is missing from landing pages. |
| One column per step | How many outcomes of that step were credited to the line, and their value. |
| `(none)` | Outcomes with no arrival to credit. |
| A source with no campaign | Arrivals whose address carried no campaign id or name. Add the tracking setting above. |

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
