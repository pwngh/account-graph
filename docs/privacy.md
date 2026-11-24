# What is kept about people

What the graph holds, what deletes it, and what the words for it are. This page makes no claim about any law.

## What is kept

| | Kept as | Can it be turned back? |
| --- | --- | --- |
| Email, phone, postal address | A hash of the normalized value | By guessing. Phone numbers are few enough to hash them all, and a known email can be hashed and compared. The hashes are the ones ad platforms match on, so they carry no secret. |
| Name | A keyed hash, only under a policy that uses names | Only with `IDENTIFIER_SECRET`. |
| Your own ids, such as `contact:7` | As written | They are yours. |
| A browser | The id its first-party cookie holds | It names a browser, not a person, until something ties the two. |
| IP address | As written; IPv6 as its /64 | It is the address. |
| Ad clicks, campaign ids, the parameters you named, landing pages without their query | As they came | They say what was clicked. |
| Calls | When, how long, how it went, which of your numbers, and the caller as a hash | As a phone number. Nothing said on a call is here. |
| Steps and their values | With the ids you gave | They are yours. |
| Decisions | Who decided, when, about which ids, and the reason as typed | They are what they say. |

The right word for hashed data here is **pseudonymous**: it says who somebody is to whoever holds the value that was hashed. Do not describe it as if nobody could be found in it. Treat the database as you would the list it was made from.

## What is sent

| To | What | When |
| --- | --- | --- |
| Ad platforms you set up | The outcome, its click id, and hashes of email and phone | For a step that names an action, and not where the person has said no to measuring ads |
| Services you set up: a fingerprint, an address check, a line check, a lookup of addresses | The one value being checked | When it arrives |
| Your own webhooks | Alerts and cluster changes, by id | When they happen |
| Anyone else | Nothing | |

## What deletes it

| | Deletes | Keeps |
| --- | --- | --- |
| `forget` | Everything recorded about one subject: sightings, ties, arrivals, steps and their values, calls and results, conversions, consent, decisions about it that keep it apart, value moved, and alerts | The entry in the record of decisions that it was forgotten, with its id. Earlier entries that name it stay too, because the record is sealed. That a pool number was held by somebody then. |
| `prune` | Sightings written down before a time, answers about advertising that no longer stand, results whose call never came, turns of pool numbers that ended | Ties and clusters, because each tie keeps its first and last sighting. Arrivals, steps, calls, the answer that stands. |
| A step restated or a call taken back | Nothing | The history of its values. |

What was already sent to an ad platform is there, and its own tools delete it. Backups keep what they hold until they are gone: forget again after restoring one.

Two things to hold to when writing a reason or an id, because the record of decisions keeps them for good: name the kind of matter and never the matter, and do not put a name, a phone or an email in an id.

## Consent

| | |
| --- | --- |
| What it covers | Sending somebody's outcomes to ad platforms, and using them for personalization. It is asked by your banner or your form, and by the browser's own Global Privacy Control signal. |
| What a refusal does | Nothing about ads leaves the page, no conversion of theirs is sent, and no pool number is shown to them. A later answer stands over an earlier one. |
| What it does not cover | Being called or written to. Consent to messages, opt-outs, hours and how often somebody is contacted belong to the system that calls or sends, and nothing here is a record of them. |
| What it does not stop | Keeping a visit, a call or a step for your own report. If somebody must not be kept, `forget` them. |
