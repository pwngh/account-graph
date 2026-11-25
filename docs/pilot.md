# Pilot

A trial on your own calls, forms and ads that sends nothing to an ad platform and changes nothing in your case system. You can stop it at any step.

```text
your site, phones, forms ──▶ server ──▶ reviewer screen
                                  ╳ nothing to ad platforms: no keys are set
```

## Before you start

| Decide | Why |
| --- | --- |
| Who may read the data, and for how long it is kept | The server stores hashed emails and phones, visits and calls. See [Privacy](privacy.md). |
| What your counsel says about linking calls to site visits, and what your site tells visitors | The server records what you report. It does not decide whether you may. |
| One person who reviews matches each day | Matches are scores from weights. They are unmeasured on your data until somebody checks them. |
| What would end the trial | Write it down first: a wrong match that matters, or a share of wrong matches over a number you choose. |

## Steps

| Step | What to do | Done when |
| --- | --- | --- |
| 1. Server | Run it on a machine of yours, with HTTPS in front. Use [`examples/household.json`](presets.md#contacts-entered-by-staff) if staff enter contacts. [Operations](operations.md) | `/health` answers over HTTPS |
| 2. Backup | Dump it, restore the dump into another database, and look at both. [Backups](operations.md#backups) | `account-graph verify` lists no changes on the copy |
| 3. Site | Add the [script tag](operations.md#script-tag) to every page, with your consent banner's answer | Your own visit is in the screen, with its ad |
| 4. Calls | Record each call, or take your provider's webhook. [Calls](calls.md), [`examples/call-tracking.ts`](../examples/call-tracking.ts) | A test call is tied to your own tap |
| 5. Contacts | Record each new contact from your form or case system as a [`profile`](identify.md) | A test form is tied to your own visit |
| 6. Clients | Record each signed client as a [`conversion`](report.md#outcomes), with the value you give it | The client is under a campaign |
| 7. Apart | Send the pairs your conflict check keeps apart as a [`split`](deciding.md#split) | They are shown separated |
| 8. Two weeks | Review Matches and the missed calls every day. Change nothing else | You have a list of right and wrong matches |

## Deciding

1. Write down 100 pairs of contacts you know to be one person, and 100 you know not to be, chosen before looking at the screen.
2. Run [`tools/labels.ts`](deciding.md) on them. It prints precision and recall for each kind of evidence, with the counts behind them.
3. Compare the missed calls on the Board with your phone system's own list for a week.
4. Take ten clients at random. For each, ask how they found you, and compare it with the ad on their journey.
5. Only then consider sending conversions to an ad platform.

## Stopping

Remove the script tag, stop recording, and stop the server. [`forget`](http.md#forget) deletes one person. Dropping the database deletes everyone, and your dumps still hold them until you delete those too.

## Limitations

- The server is one process and one database. A pilot has no failover.
- No call tracking service, case system or ad platform has been tried live. Expect a day of work for each, and check the first results by hand.
- There is no import of past calls or contacts.
- Two weeks is too short to see clients who take months to sign.
