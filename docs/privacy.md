# Privacy

The graph stores identifiers, campaign visits, calls, outcomes and consent. `POST /forget` deletes a person's data, and `POST /prune` deletes old records.

## Stored data

Hashed data here is **pseudonymous**: anyone who holds the original value can identify the person. Protect the database as you would the list it was made from.

| Data | Stored as | Reversible |
| --- | --- | --- |
| Email, phone, postal address, sent to `/identify`, `/call`, `/convert` or the outbox, or made with the hashing helpers | A hash of the normalized value | By guessing. The set of phone numbers is small enough to hash in full, and a known email can be hashed and compared. The hashes match those of ad platforms, so they carry no secret. |
| An identifier you write with `/observe` or `graph.observe` | As written, for any kind. Hash it first with `email()`, `phone()` and the other helpers. | Yes, unless you hashed it. |
| Name | A keyed hash, only under a policy that uses names | Only with `IDENTIFIER_SECRET`. |
| Your own ids, such as `contact:7` | As written | By you. |
| Browser | The id in its first-party cookie | It identifies a browser, and a person once something links the two. |
| IP address | As written; IPv6 as its /64 | Yes. |
| Ad clicks, campaign ids, the parameters you named, landing pages without their query | As received | They identify what was clicked. |
| Calls | Time, duration, result, your number, and the caller as a hash. Call content is not stored. | As a phone number. |
| Texts | Time, direction, your number, flags such as `opt_out`, and the other side as a hash. What was said is not stored. | As a phone number. |
| Steps and their values | With the ids you gave | By you. |
| Decisions | Author, time, ids concerned, and the reason as typed | Yes. |

> **Audit log entries are permanent.** In a reason, name the kind of matter and leave out the matter itself. Keep names, phones and emails out of ids.

## Data sent

| Recipient | Data | When |
| --- | --- | --- |
| Ad platforms you set up | The outcome, with whichever of these exist: that platform's click id, the email and phone hashed the way it matches them, and for Meta its browser id beside its click | For a step that names an action, when there is a click id or a hash to match by, and ad measurement was not refused |
| Services you set up: fingerprint, address check, line check, IP lookup | The one value being checked | On arrival |
| Your own webhooks | Alerts and cluster changes, by id | When they happen |

Data goes to these recipients only.

## Deletion

Deleting a person takes one `POST /forget` per subject, because it leaves the person's other subjects in place.

| Action | Deletes | Keeps |
| --- | --- | --- |
| `forget` one subject | Its sightings and links, identifiers with no other holder, visits, steps and their values, not-a-lead marks, its calls and their results, its texts, the links made for it, conversions, consent, separations, transfers, alerts, and the changes of its own cluster | See the list below |
| `prune` before a time | Sightings, superseded consent answers, and call results without a call, all stored before it. Also links that stopped naming anyone and pool assignments that ended before it, and not-a-lead marks set before it without a recorded outcome or call | Links and clusters, because each link keeps its first and last sighting and its count. Visits, steps, calls, and the consent answer that applies |
| Restating a step | None | Every value it has had |
| Correcting a call to unanswered | Its outcome, which leaves the report | The call, its result, and the history of its value |

`forget` keeps:

- Audit log entries that name the subject, including the deletion itself, because entries are hashed in a chain.
- Changes of other subjects that name it as their cluster.
- A muted identifier.
- Calls and texts of another subject that were linked to it, with the link removed.
- The fact that a pool number was held at that time, without the holder.
- Other subjects of the same person.

Backups keep their data until you delete them. Run `forget` again after restoring one.

## Data at ad platforms

`forget` deletes data here and leaves sent conversions at the platforms. Call `POST /forget` with `"ads": true` to list them:

```json
{ "changes": [], "sent": [{ "transactionId": "client-42", "target": "google", "action": "333", "at": 1795460000000, "state": "not_requested" }] }
```

| `state` | Meaning |
| --- | --- |
| `accepted` | The platform was asked to take it back and rejected nothing. |
| `rejected` | The platform rejected the request. `note` has the reason. |
| `not_requested` | No request was made. Ask with the platform's own tools. The note `may not have arrived` means the job was picked up, and its delivery was never confirmed. |

> **Save the response.** The server keeps no copy of this list after the deletion.

With `FORGET_ADS=true`, each deletion also asks every platform with a documented method to take the conversions back, with or without `ads`. The request follows the local deletion. A rejected request is not retried and does not restore the person.

The setting is off by default, because it sends the platform the click id and the hashed email and phone again.

To ask for one deletion only, send `"retract": true` with `POST /forget`, or select the option in the Delete dialog. The response includes `sent`. The request is rejected with 400, before anything is deleted, when no configured platform accepts retractions.

A retraction removes the conversion from the platform's reports. Microsoft does not state that it deletes the data.

| Platform | Documented method | Support |
| --- | --- | --- |
| Microsoft Advertising | [A retraction](https://learn.microsoft.com/en-us/advertising/campaign-management-service/offlineconversionadjustment), up to 90 days after the conversion | Asked, with `FORGET_ADS` or `retract` |
| Google Ads | [Removing users](https://developers.google.com/data-manager/api/reference/rest/v1/users/remove), for accounts on a list Google keeps. [A retraction](https://developers.google.com/google-ads/api/docs/conversions/upload-adjustments) in the Google Ads API removes a conversion from reports, without a stated deletion | Not asked |
| Meta | Removing people from audiences. The pages on sending events name no way to delete one | Not asked |
| TikTok | Unknown, because its documentation could not be read | Not asked |

To answer a person's request, write to the platform yourself and name the conversions in `sent`. A custom target can support deletion by implementing `forget(jobs)`.

## Consent

Two answers are stored separately: measuring ads (`adUserData`) and personalizing them (`adPersonalization`).

| Point | Effect |
| --- | --- |
| Page | With the Global Privacy Control signal, or a banner's no to measuring ads, the script omits the `touch`, the click id and the Analytics id. It still reports the page view. |
| Server, on a page view | The answer is stored. Meta's browser id is dropped when the applicable answer is no to measuring ads. |
| Pool number | Withheld from a browser that sends the signal or the no, or whose applicable answer is no to measuring ads. |
| Outbox, on send | Skipped when the outcome says no to measuring ads, or when the last answer of the subject or the clicking browser was no. For an outcome that carries a yes, only a no given since counts. |
| Personalization | A no does not stop the send. The answer is passed on when the outcome carries one, or when the subject and the clicking browser, if different, have both answered. Otherwise the platform gets no answer and applies the ad account's setting. |
| Later answer | Replaces an earlier one. A dated answer always replaces one without a time. |

## Limitations

- This page makes no claim about any law.
- Platform documentation does not state that a retraction deletes the data matched to reach a conversion.
- A request marked `reported` is unconfirmed beyond the platform's response.
- Consent covers advertising. Message consent, opt-outs, quiet hours and contact frequency belong to the system that calls or sends.
- A no to advertising still records visits, calls and steps for your own report. Use `forget` to delete them.
