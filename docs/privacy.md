# What is kept about people

What the graph holds, what deletes it, and what the words for it are. This page makes no claim about any law.

## What is kept

| | Kept as | Can it be turned back? |
| --- | --- | --- |
| Email, phone, postal address, sent to `/identify`, `/call`, `/convert` or the outbox, or made with the hashing helpers | A hash of the normalized value | By guessing. Phone numbers are few enough to hash them all, and a known email can be hashed and compared. The hashes are the ones ad platforms match on, so they carry no secret. |
| An identifier you write yourself, with `/observe` or `graph.observe` | As you wrote it, whatever its kind. Nothing hashes it for you: use `email()`, `phone()` and the rest. | It is what you wrote. |
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
| Ad platforms you set up | The outcome, with whichever of these there are: the click id of that platform, the email and phone hashed the way it matches them, and for Meta its browser id beside its click | For a step that names an action, where there is a click id or a hash to match by, and not where measuring ads was refused |
| Services you set up: a fingerprint, an address check, a line check, a lookup of addresses | The one value being checked | When it arrives |
| Your own webhooks | Alerts and cluster changes, by id | When they happen |
| Anyone else | Nothing | |

## What deletes it

| | Deletes | Keeps |
| --- | --- | --- |
| `forget` one subject | Its sightings and ties, identifiers nobody else holds, arrivals, steps and their values, calls it made and their results, conversions, consent, separations, value moved, alerts, and the changes of its own cluster | In the record of decisions: that it was forgotten, with its id, and earlier entries that name it, because the record is sealed. Changes of other subjects that name it as the cluster they were in. An identifier that is muted. Calls of another subject that were tied to it, with the tie removed. That a pool number was held by somebody then. Other subjects of the same person, until they are forgotten too. |
| `prune` before a time | Sightings written down before it, answers about advertising written down before it that no longer stand, results written down before it whose call never came, and turns of pool numbers that ended before it | Ties and clusters, because each tie keeps its first and last sighting and its count. Arrivals, steps, calls, and the answer that stands. |
| Restating a step | Nothing | Every value it has had. |
| Taking back a call that was not answered after all | Its outcome, so the report no longer counts it | The call, its result, and the history of its value. |

What was already sent to an ad platform is there, and its own tools delete it. Backups keep what they hold until they are gone: forget again after restoring one.

Two things to hold to when writing a reason or an id, because the record of decisions keeps them for good: name the kind of matter and never the matter, and do not put a name, a phone or an email in an id.

## Consent

Two answers are kept apart: measuring ads (`adUserData`) and personalizing them (`adPersonalization`).

| Where | What an answer does |
| --- | --- |
| The page | With the browser's Global Privacy Control signal, or a banner's no to measuring ads, the script leaves out the arrival, the click id and the Analytics id. The visit itself is still reported. |
| The server, at a visit | The answer is kept. Meta's browser id is not kept for somebody whose standing answer is no to measuring ads. |
| A pool number | None for a browser that sends the signal or the no, or whose standing answer is no to measuring ads. |
| The outbox, at sending | Nothing is sent where the outcome itself says no to measuring ads. Nor where the subject, or the browser that clicked, last said no: for an outcome that carries a yes, only a no given since counts. |
| Personalization | A no to it does not stop the outcome being sent. It is passed on where the outcome carries an answer of its own, or where the subject has answered and so has the browser that clicked, if that is a different subject. Otherwise the platform is sent no answer, and what it does then is set in the ad account. |
| A later answer | Stands over an earlier one, except that a dated answer always stands over one whose time is not known. |

| What consent here is not | |
| --- | --- |
| Being called or written to | Consent to messages, opt-outs, hours and how often somebody is contacted belong to the system that calls or sends. Nothing here is a record of them. |
| Being kept at all | It does not stop a visit, a call or a step being kept for your own report. If somebody must not be kept, `forget` them. |
