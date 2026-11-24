# Telling the server who someone is

Your backend knows things a browser never says: who signed in, their email, their phone, where they live. One call hands those to the server as they are. It hashes, normalizes and checks them, and answers with what moved.

```sh
curl -X POST https://graph.example.org/identify -H "authorization: Bearer $GRAPH_TOKEN" -d '{
  "subject": "account:42",
  "event": "signup",
  "device": "9f3c1c1e-…",
  "email": "Pat.Lee@gmail.com",
  "phone": "(555) 000-1111",
  "ip": "203.0.113.9",
  "address": { "street": "1 Main Street #2", "city": "Springfield", "state": "IL" }
}'
```

```json
{
  "changes": [{ "subject": "account:42", "from": "account:42", "to": "account:17" }],
  "identifiers": ["device:9f3c1c1e-…", "email:5e88…", "ip:203.0.113.9", "phone:1f0a…", "address:c41b…"],
  "notes": { "phone": "mobile", "address": "confirmed" }
}
```

`changes` says the sign-up joined `account:42` to the cluster of `account:17`. `notes` says what the checks found.

## Call it more than once

The graph only knows what it is told. An account seen once, at sign-up, is tied to one browser. Call `/identify` on every sign-in, and on any page where the person is signed in, with the `device` cookie and the request's `ip`. Each call is one more sighting, and a second phone or a new laptop is tied the day it is first used.

## What each fact becomes

| You send | The server keeps | Needs |
| --- | --- | --- |
| `device` | `device:…`, the `ag_device` cookie the script tag set. | Nothing. |
| `email` | `email:` and a hash. Gmail's dots and `+tags` are folded first. | Nothing. |
| `ip` | `ip:…`; an IPv6 address as its /64. | Nothing. |
| `phone` | `phone:` and a hash. With a line check: `voip:` for a number from an internet calling app, and nothing at all for a switchboard, a premium line or a pager. | Optional: Twilio, for the line check. |
| `address` | `address:` and a hash of the one delivery point the postal service knows it as, so two spellings of one address match. | Smarty. Without it, addresses are not used. |
| `name`, `dob` | `name:` and a keyed hash. See [names](#names). | `IDENTIFIER_SECRET`, and a policy with a `name` kind. |
| `identifiers` | Whatever you already have, as written: `payment:tok_…`, `passkey:…`. | Nothing. |
| `at`, `event` | When it happened, and what the person was doing. Default: now. | Nothing. |

Only hashes are kept. The email, the number, the address, the name and the date of birth themselves are not stored.

> **An address names a household, not a person.** Two accounts at one confirmed address are related at 0.6 and never joined by it alone. A rented mail box, a vacant address, and a building with the apartment missing tie nobody.

| What the check found | In `notes` | Effect |
| --- | --- | --- |
| A mobile or landline | `"phone": "mobile"` | Kept as `phone`, 0.9. |
| A number from an internet calling app | `"phone": "nonFixedVoip"` | Kept as `voip`, 0.5: related, not joined. |
| A toll-free or premium line | `"phone": "tollFree: not used"` | Not kept. |
| An address confirmed to the door | `"address": "confirmed"` | Kept as `address`, 0.6. |
| A rented mail box, or vacant | `"address": "a rented mail box: not used"` | Not kept. |
| The postal service does not know it | `"address": "not found"` | Not kept. |

A check that is down never loses the sighting. The phone is kept as a plain `phone`, the address is left out with a note saying the service did not answer, and the rest is recorded.

A number found to be from an internet calling app also stops counting as a `phone` wherever it was written before the check: by a phone call, or by a sighting made while the check was down. Phone calls ask the same question about the caller's number, so a call and an account on one such number are related at 0.5.

## Forms that post somewhere else

A form that posts to your own backend arrives with the `ag_device` cookie. A form that posts to another system does not: a hosted form, a CRM, a booking tool. Mark the form and the script tag adds the device id as it is submitted.

```html
<form action="https://forms.example-crm.com/submit" method="post" data-ag-fields>
```

```text
visitor submits ──▶ script adds ag_device and ag_landing ──▶ the other system
the other system ──▶ your backend, later ──▶ POST /identify { subject, device: ag_device }
```

| Field | Holds |
| --- | --- |
| `ag_device` | The visitor's device id. Send it back as `device`. |
| `ag_landing` | The address this browser session began on, with its click id and campaign. |

`collect.js?forms=all` fills every form that posts, without marking each. A script that posts a form itself can read the same two values from `accountGraph.fields()`.

| Case | What is filled |
| --- | --- |
| A form marked `data-ag-fields` | Both fields. |
| An unmarked form with `method="post"`, under `forms=all` | Both fields. |
| An unmarked form that sends its fields in the address, under `forms=all` | Nothing. An address is seen by more than its receiver. |
| A visitor who opted out of advertising | `ag_device` only. The landing page holds the ad click. |

When your backend can read the `ag_device` cookie, prefer it to the field. With `COOKIE=true` the server's cookie outlives what the page remembers; the id a page quotes is kept on the same visitor, so either one finds them.

## What is filtered out before it counts

| Filter | What it does |
| --- | --- |
| Declared bots | A visit whose user agent says it is a crawler, a link previewer or an uptime check is not recorded. `/stats` counts them under `bots`. |
| Confirmed bots | With Fingerprint set up, a visit Fingerprint flags as a bad bot is not recorded. |
| Shared addresses | With MaxMind set up, a VPN, data center or carrier address is recorded but ties nobody. |

With MaxMind, each visit is also noted with where its address places it, `place:US/FL/Miami`. The note links nothing. A reviewer sees it among the subject's sightings.


## Names

```json
{ "subject": "contact:7", "phone": "(555) 010-0007", "name": { "first": "José", "last": "Muñoz" }, "dob": "1990-02-03" }
```

A name confirms that two people who share a phone are one, and never makes a tie by itself. Names are off until two things are set: `IDENTIFIER_SECRET`, and a policy with a `name` kind, such as [the preset for contacts entered by staff](presets.md#contacts-entered-by-staff).

| Step | What happens |
| --- | --- |
| Folded | Accents, case and punctuation do not matter: `José Muñoz-Ruiz` and `JOSE MUNOZ RUIZ` are one name. |
| Placeholders dropped | `Unknown`, `Test`, `John Doe`, a single initial and the like make no key. |
| Tied to a place or a date | A key needs the zip code of a confirmed address, or a date of birth. A name with neither makes none. |
| Keyed | The key is an HMAC under `IDENTIFIER_SECRET`. Names are few enough to guess, so a plain hash of one could be reversed. Name keys are never sent to an ad platform. |
| Capped | A key that more than five people hold confirms nobody. |

`notes.name` says whether it was used, and if not, why. Any `dob` written by default, such as 1900-01-01, is ignored.

## Limits

| Limit | Detail |
| --- | --- |
| Addresses | United States only, through Smarty's US Street API. |
| A number that changes hands | Once a number is found to be from an internet calling app it stays muted as a `phone`, even if a later check calls it a mobile. Restore it by hand with `POST /ignore` and `ignored: false`. |
| Line checks cost money | Each new number is one paid Twilio lookup. Answers are kept for thirty days. |
| A bot that lies | Only bots that name themselves are filtered by user agent. One that pretends to be a browser needs Fingerprint. |
| Names | A name never ties two accounts by itself. It confirms a tie they already have, under a policy that has names. Nicknames, married names and spellings that differ by more than accents are different names. |
| `IDENTIFIER_SECRET` | Every name key is made with it. Change it and new keys match none of the old ones, and the old ones cannot be made again. |
| Not confirmed | No call has been made with real Smarty or Twilio keys. Both readers were written from the providers' documented answers. Smarty refuses a wrong key the same way however it is sent, so only a real key shows that it accepts the key in a header, as its authentication page says. |
