# Identify

A `profile` entry of [`record`](http.md#record) records what your backend knows about a person: sign-in, email, phone and postal address. Send the facts as they are. The server normalizes, checks and hashes them, then answers with the cluster changes.

```bash
curl -X POST https://graph.example.org/v1/record -H "authorization: Bearer $GRAPH_TOKEN" -d '{ "entries": [{
  "type": "profile", "key": "signup-42", "at": 1795460000000, "subject": "account:42", "event": "signup",
  "facts": {
    "device": "9f3c1c1e-0000-4000-8000-000000000001",
    "email": "Pat.Lee@gmail.com",
    "phone": "(555) 000-1111",
    "ip": "203.0.113.9",
    "address": { "street": "1 Main Street #2", "city": "Springfield", "state": "IL" }
  } }] }'
```

```json
{ "results": [{ "type": "profile", "key": "signup-42", "ok": true, "value": {
  "duplicate": false, "stands": true,
  "changes": [{ "subject": "account:42", "from": "account:42", "to": "account:17" }],
  "notes": { "phone": "mobile", "address": "confirmed" } } }] }
```

`changes` shows that the sign-up joined `account:42` to the cluster of `account:17`. `notes` holds the results of the checks. The identifiers made from the facts stay in the graph.

Record a profile on every sign-in, and on any page where the person is signed in, with the `device` cookie and the request's `ip`. Each one adds a sighting, so a second phone or new laptop is linked the day it is first used. Give each a key of its own, such as your session's id.

To ask who somebody may be without recording it, use the `match` [lookup](http.md#lookup) with the same facts.

## Fields

| In `facts` | The server keeps | Needs |
| --- | --- | --- |
| `device` | `device:…`, the `ag_device` cookie the script tag set. | - |
| `email` | `email:` and a hash. Gmail's dots and `+tags` are folded first. | - |
| `ip` | `ip:…`; an IPv6 address as its /64. | - |
| `phone` | `phone:` and a hash. With a line check, `voip:` for an internet calling app, and no identifier for a switchboard, premium line or pager. | Optional: Twilio, for the line check. |
| `address` | `address:` and a hash of the postal service's delivery point, so two spellings of one address match. | Smarty. Otherwise addresses are ignored. |
| `name`, `dob` | `name:` and a keyed hash. See [Names](#names). | `IDENTIFIER_SECRET`, and a policy with a `name` kind. |
| `identifiers` | Identifiers you already hold, as written: `hardware:…`, `payment:tok_…`, `passkey:…`. At most 100. | A kind in the policy, and not one [the graph writes itself](http.md#refusals). |

Beside `facts`, `at` is when it happened, and `event` is what the person was doing, up to 200 characters.

| Kind of your own | Value |
| --- | --- |
| `hardware` | The hashed machine id reported by your desktop client |
| `passkey` | A passkey's credential id, after your server verified the sign-in |
| `payment` | A card or bank token from your payment provider, in place of the number |

`facts` must come to at least one identifier. Facts that come to none, such as an address without Smarty, are refused with `INPUT.MALFORMED`.

The email, number, address, name and date of birth are stored only as hashes.

## Checks

| Finding | `notes` value | Effect |
| --- | --- | --- |
| A mobile or landline | `"phone": "mobile"` | Kept as `phone`, 0.9. |
| A number from an internet calling app | `"phone": "nonFixedVoip"` | Kept as `voip`, 0.5: related without joining. |
| A toll-free or premium line | `"phone": "tollFree: not used"` | Dropped. |
| An address confirmed to the door | `"address": "confirmed"` | Kept as `address`, 0.6. |
| A rented mail box, or vacant | `"address": "a rented mail box: not used"` | Dropped. |
| Unknown to the postal service | `"address": "not found"` | Dropped. |

> **An address identifies a household.** Two accounts at one confirmed address are related at 0.6 and are not joined by it alone. A rented mail box, a vacant address, or a building with the apartment missing links no accounts.

A check that is down, or takes more than three seconds, keeps the sighting. The phone is stored as a plain `phone`, the address is omitted with a note that the service did not answer, and the rest is recorded.

A number identified as VoIP also stops counting as a `phone` wherever it was stored before the check, by a phone call or by a sighting during an outage. Calls check the caller's number the same way, so a call and an account on one such number are related at 0.5.

## Hosted forms

A form that posts to your own backend arrives with the `ag_device` cookie. For a hosted form, CRM or booking tool, mark the form and the script tag adds the device id on submit.

```html
<form action="https://forms.example-crm.com/submit" method="post" data-ag-fields>
```

```text
visitor submits ──▶ script adds ag_device and ag_landing ──▶ the other system
the other system ──▶ your backend, later ──▶ record a profile with facts.device: ag_device
```

| Field | Holds |
| --- | --- |
| `ag_device` | The visitor's device id. Send it back as `facts.device`. |
| `ag_landing` | The address this browser session began on, with its click id and campaign. |

`collect.js?forms=all` fills every form that posts. A script that posts a form itself can read the same two values from `accountGraph.fields()`.

| Form | Filled |
| --- | --- |
| Marked `data-ag-fields` | Both fields. |
| Unmarked, with `method="post"`, under `forms=all` | Both fields. |
| Unmarked, sending its fields in the address, under `forms=all` | None, because an address is seen by more than its receiver. |
| Visitor opted out of advertising | `ag_device` only, because the landing page holds the ad click. |

When your backend can read the `ag_device` cookie, prefer it to the field. With `COOKIE=true` the server's cookie outlives the page's stored id. The id a page reports is kept on the same visitor, so either one finds them.

## Chat

A chat service hands over a lead with an email or a phone number, and often no device. Have your backend record the person, then the step:

```bash
curl -X POST https://graph.example.org/v1/record -H "authorization: Bearer $GRAPH_TOKEN" -d '{ "entries": [
  { "type": "profile", "key": "chat-7", "at": 1795460000000, "subject": "contact:7", "event": "chat",
    "facts": { "phone": "+15550100142", "device": "9f3c1c1e-0000-4000-8000-000000000001" } },
  { "type": "conversion", "key": "chat-7", "at": 1795460000000, "subject": "contact:7", "stage": "chat" }
] }'
```

The profile comes first, so the conversion finds the click.

| The chat box | What to send |
| --- | --- |
| Takes fields of your own | Give it `accountGraph.fields().ag_device` when the chat opens, and send it back as `device`. The lead is then linked to that browser's recorded visits, if there are any. |
| Takes none | Leave `device` out. They are linked by a phone or email seen elsewhere, or not at all. |

What was said in the chat is not read or stored. Leave it in the chat service.

## Filters

| Filter | Behavior |
| --- | --- |
| Declared bots | A visit is dropped when its user agent names a crawler, link previewer or uptime check. |
| Confirmed bots | With Fingerprint set up, a visit it flags as a bad bot is dropped. |
| Shared addresses | With MaxMind set up, a VPN, data center or carrier address is recorded and links no subjects. |

With MaxMind, each visit also gets a location note, such as `place:US/FL/Miami`. The note links no subjects and appears among the subject's sightings on the reviewer screen.

## Names

A name confirms that two people who share a phone are one. It creates no link by itself.

```json
{ "type": "profile", "key": "intake-7", "at": 1795460000000, "subject": "contact:7",
  "facts": { "phone": "(555) 010-0007", "name": { "first": "José", "last": "Muñoz" }, "dob": "1990-02-03" } }
```

To use names, set `IDENTIFIER_SECRET` and a policy with a `name` kind that only corroborates, such as [the preset for contacts entered by staff](presets.md#contacts-entered-by-staff).

| Step | Behavior |
| --- | --- |
| Folding | Accents, case and punctuation are ignored: `José Muñoz-Ruiz` and `JOSE MUNOZ RUIZ` are one name. |
| Placeholders | `Unknown`, `Test`, `John Doe`, a single initial and similar values produce no key. |
| Scope | A key needs the zip code of a confirmed address, or a date of birth. |
| Keying | The key is an HMAC under `IDENTIFIER_SECRET`, because a plain hash of a guessable name can be reversed. Name keys are withheld from ad platforms. |
| Cap | A key held by more than five people confirms no one. |

Under a policy with [`apart`](deciding.md#facts-that-keep-people-apart), `dob` is also kept by itself, with or without a name, to tell two people apart. It links nothing.

`notes.name` states whether the name was used, and the reason when it was not. A default `dob`, such as 1900-01-01, is ignored.

## Costs

Each new number is one paid Twilio lookup. Answers are kept for thirty days.

## Limitations

- **Addresses.** United States only, through Smarty's US Street API.
- **Reassigned numbers.** A number identified as VoIP stays muted as a `phone`, even if a later check reports a mobile. Restore it with [`decide`](http.md#decide) `unmute` and the phone.
- **Undeclared bots.** User agents identify only bots that name themselves. One that imitates a browser needs Fingerprint.
- **Names.** A name confirms a link two accounts already have, under a policy that includes names. Nicknames, married names and spellings that differ beyond accents are different names.
- **`IDENTIFIER_SECRET`.** Changing it makes new keys that match none of the old ones, and the old keys cannot be regenerated.
- **Verification.** Smarty and Twilio are untested with live credentials. Both readers follow the providers' documented answers. Smarty refuses a wrong key the same way however it is sent, so only a real key can show that it accepts the key in a header, as its authentication page states.
