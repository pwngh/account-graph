# Privacy

The graph stores identifiers, campaign visits, calls, outcomes and consent. [`forget`](http.md#forget) deletes a person's data, and `account-graph prune` deletes old records.

## Stored data

Hashed data here is **pseudonymous**: anyone who holds the original value can identify the person. Protect the database as you would the list it was made from.

| Data | Stored as | Reversible |
| --- | --- | --- |
| Email, phone, postal address, in a `profile`, a `call`, a `text` or a `conversion` | A hash of the normalized value | By guessing. The set of phone numbers is small enough to hash in full, and a known email can be hashed and compared. The hashes match those of ad platforms, so they carry no secret. |
| An identifier you write under `facts.identifiers` | As written, for any kind. Send emails and phones as `email` and `phone`, which are hashed. | Yes, unless you hashed it. |
| Name | Keyed hashes of it, of the full names it may stand for and of its first letter, only under a policy that uses names | Only with `IDENTIFIER_SECRET`. There are few first names and 26 letters, so with it every one can be tried. |
| Date of birth | Keyed hashes of it, of its year and of its day and month, only under a policy that keeps people apart by it | Only with `IDENTIFIER_SECRET`. There are few dates, so with it every one can be tried. |
| Your own ids, such as `contact:7` | As written | By you. |
| Browser | The id in its first-party cookie | It identifies a browser, and a person once something links the two. |
| IP address | As written; IPv6 as its /64 | Yes. |
| Ad clicks, campaign ids, the parameters you named, landing pages without their query | As received | They identify what was clicked. |
| Calls | Time, duration, result, your number, and the caller as a hash. Call content is not stored. | As a phone number. |
| Texts | Time, direction, your number, flags such as `opt_out`, and the other side as a hash. What was said is not stored. | As a phone number. |
| Steps and their values | With the ids you gave | By you. |
| Decisions | Author, time, ids concerned, and the reason as typed | Yes. |
| Receipts of the keys you send | A keyed hash of the key, and keyed hashes of what came with it. See [receipts](operations.md#receipts). | Only with `RECEIPT_SECRETS`, and by guessing. |
| Keys of conversions, calls, texts, payments, links, transfers and restatements | As written, with the record, until it is deleted | By you. Keep names, phones and emails out of them. |

> **Audit log entries are permanent.** In a reason, name the kind of matter and leave out the matter itself. Keep names, phones and emails out of ids.

## Data sent

| Recipient | Data | When |
| --- | --- | --- |
| Ad platforms you set up | The outcome, with whichever of these exist: that platform's click id, the email and phone hashed the way it matches them, and for Meta its browser id beside its click | For a step that names an action, when there is a click id or a hash to match by, and ad measurement was not refused |
| Services you set up: fingerprint, address check, line check, IP lookup | The one value being checked | On arrival |
| Your own webhooks | Alerts and [events](operations.md#events), by id | When they happen |

Data goes to these recipients only.

## Deletion

A retry of a forgotten key is checked against its receipt before the graph asks a line or address provider about the entry.

An identification made for a single call belongs to that call. The original line stays private. Forgetting the original line or the record that currently owns the call erases the call, its statements, its conversion and value changes. When staff have since confirmed another record as the owner, that record keeps the call and its value history. Only statements naming the deleted record are removed, including their receipt field hashes. An unrelated alert stays even when its text happens to contain a removed statement's key. This also applies when the call has yet to arrive. When nobody else is confirmed as the owner, the call is erased. Every erased key has a tombstone, so a late retry receives `FORGOTTEN`.

A visitor known only from a call's tap, code or pool number supplies its campaign to reports. The named record's callback and pipeline rows keep the visitor's arrival time, landing address, language and custom fields private.

A platform that had already received a conversion can still appear in the deletion report. The delivery shown alongside the confirmed record omits the original click ID, matching confidence and consent. The store keeps the original matching details for refunds, corrected values and retractions on platforms that accept them. This also applies when the platform acknowledges the original send after the correction. A new conversion remains stopped. A later deletion erases that row.

When staff identify a call, the graph erases earlier delivery failure events for that call and any stored failure notices that count it, including calls beyond the first ten shown. An older truncated batch without stored call IDs is discarded when a call is corrected or erased. Forgetting someone with no calls preserves that batch. A pending notice that also names other failures is discarded as a whole. The events for those other failures stay. A notice already delivered to a webhook may still be held by its recipient.

An inbound call keeps which phone identifier it added until staff name its party. This lets the graph remove just that sighting, even after pruning. Calls stored before upgrade 29 have no such record. The graph uses the remaining sightings and the first and last times on each link. If both phone and VoIP could have supplied a pruned sighting, it weakens both possible links to avoid keeping evidence from the confirmed call.

Upgrade 30 records which call supplied a channel visit. Older visits only have the line, dialed number and time. If several old visits fit a confirmed call, all of those visits are removed to keep that call out of another record’s journey. The upgrade also clears these visits for calls that were already confirmed.

`forget` deletes the subjects you name and leaves the person's others in place. To delete a person, read their `members` with the `person` [lookup](http.md#lookup), check them, and send all of them as `subjects`, 50 at most: all are deleted, or none. A payment whose outcome was never recorded names no person and stays.

| Action | Deletes | Keeps |
| --- | --- | --- |
| `forget` one subject | Its sightings and links, identifiers with no other holder, visits, steps, their values and payments, not-a-lead marks, its calls and their results, its texts, the links made for it, conversions, consent, separations, transfers, alerts, and its events | See the list below |
| `prune` before a time | Sightings, superseded consent answers, and call results without a call, all stored before it. Also links that stopped naming anyone and pool assignments that ended before it, and not-a-lead marks set before it without a recorded outcome or call. Events from before it, and receipts that are also older than a year | Links and clusters, because each link keeps its first and last sighting and its count. Visits, steps, calls, and the consent answer that applies |
| Restating a step | None | Every value it has had |
| Correcting a call to unanswered | Its outcome, which leaves the report | The call, its result, and the history of its value |

`forget` keeps:

- Audit log entries that name the subject, including the deletion itself, because entries are hashed in a chain.
- A muted identifier.
- Calls and texts of another subject that were linked to it, with the link removed.
- The fact that a pool number was held at that time, without the holder.
- Other subjects of the same person.
- A tombstone of each key that was about it: a type, a keyed hash and times. The key is answered `FORGOTTEN` from then on, so a late retry brings nobody back. The same subject may be written again with new keys.

On a database where an older version already accepted a party statement after its record was forgotten, the first server to open the upgraded database cleans up those statements before serving requests. It uses the configured receipt secrets to tombstone the keys, including keys whose receipts were pruned. Only the affected calls and statements are checked. A new profile or independent outcome entered under the same record ID stays. An interrupted repair resumes on the next start.

A party statement naming a forgotten record receives `FORGOTTEN` under any key. The graph checks the signed deletion decision before storing the statement or its receipt.

Backups keep their data until you delete them. Run `forget` again after restoring one, with new keys.

The alert sender checks an overdue or rejected-conversion notice and starts its request while the notice is still current. A correction that finishes first cancels the old notice. A request already started can reach its receiver.

## Data at ad platforms

`forget` deletes data here and leaves sent conversions at the platforms. Its answer lists them:

```json
{ "ok": true, "value": { "duplicate": false, "changes": [], "sent": [{ "conversion": "client-42", "platform": "google", "action": "333", "at": 1795460000000, "state": "not_requested" }] } }
```

| `state` | Meaning |
| --- | --- |
| `pending` | The platform is being asked. An answer that was cut off stays so, and the request cannot be made again: the hashes it needs are gone. |
| `accepted` | The platform was asked to take it back and rejected nothing. |
| `rejected` | The platform rejected the request. `note` has the reason. |
| `not_requested` | No request was made. Ask with the platform's own tools. The note `may not have arrived` means the job was picked up, and its delivery was never confirmed. |

The list names no person. It is kept with the key of the deletion, so a lost answer can be asked for again, until the receipt is pruned.

With `FORGET_ADS=true`, each deletion also asks every platform with a documented method to take the conversions back, whatever `platforms` says. The request follows the local deletion. A rejected request is not retried and does not restore the person.

The setting is off by default, because it sends the platform the click id and the hashed email and phone again.

To ask for one deletion only, send `"platforms": "retract"`, or select the option in the Delete dialog. It is the fault `CONFIG.UNSUPPORTED`, before anything is deleted, when no configured platform accepts retractions.

A retraction removes the conversion from the platform's reports. Microsoft does not state that it deletes the data.

| Platform | Documented method | Support |
| --- | --- | --- |
| Microsoft Advertising | [A retraction](https://learn.microsoft.com/en-us/advertising/campaign-management-service/offlineconversionadjustment), up to 90 days after the conversion | Asked, with `FORGET_ADS` or `"platforms": "retract"` |
| Google Ads | [Removing users](https://developers.google.com/data-manager/api/reference/rest/v1/users/remove), for accounts on a list Google keeps. [A retraction](https://developers.google.com/google-ads/api/docs/conversions/upload-adjustments) in the Google Ads API removes a conversion from reports, without a stated deletion | Not asked |
| Meta | Removing people from audiences. The pages on sending events name no way to delete one | Not asked |
| TikTok | Unknown, because its documentation could not be read | Not asked |

To answer a person's request, write to the platform yourself and name the conversions in `sent`.

## Consent

Two answers are stored separately: measuring ads (`adUserData`) and personalizing them (`adPersonalization`).

| Point | Effect |
| --- | --- |
| Page | With the Global Privacy Control signal, or a banner's no to measuring ads, the script omits the arrival, the click id and the Analytics id. It still reports the page view. |
| Server, on a page view | The answer is stored. Meta's browser id is dropped when the applicable answer is no to measuring ads. |
| Pool number | Withheld from a browser that sends the signal or the no, or whose applicable answer is no to measuring ads. |
| Outbox, on send | Skipped when the outcome says no to measuring ads, or when the last answer of the subject or the clicking browser was no. For an outcome that carries a yes, only a no given since counts. |
| Personalization | A no does not stop the send. The answer is passed on when the outcome carries one, or when the subject and the clicking browser, if different, have both answered. Otherwise the platform gets no answer and applies the ad account's setting. |
| Later answer | Replaces an earlier one. A dated answer always replaces one without a time. |
| History | Each page view that reports consent adds a row. `account-graph prune` deletes superseded ones. |

The server stores every answer about advertising with its time and source. The answer given most recently applies, whatever order answers arrive in.

| Origin of the answer | Stored source |
| --- | --- |
| The browser's Global Privacy Control signal | `browser signal` |
| The banner's answer, passed by the page | `banner` |
| Your backend, with a `consent` entry | The source you name |
| An answer stored before consent history existed | `before history`, with no time |

Every page view reports the browser signal again. A signal that says no overrides an earlier banner yes from the first visit that carries it. A visit that carries both counts as the signal.

## Limitations

- This page makes no claim about any law.
- Platform documentation does not state that a retraction deletes the data matched to reach a conversion.
- A request marked `accepted` is unconfirmed beyond the platform's response. No live request has been made.
- Consent covers advertising. Message consent, opt-outs, quiet hours and contact frequency belong to the system that calls or sends. What is stored here is no record of consent to be called, texted or written to, and no legal record.
- A no to advertising still records visits, calls and steps for your own report. Use `forget` to delete them.
