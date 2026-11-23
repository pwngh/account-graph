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
| `identifiers` | Whatever you already have, as written: `payment:tok_…`, `passkey:…`. | Nothing. |
| `at`, `event` | When it happened, and what the person was doing. Default: now. | Nothing. |

Only hashes are kept. The email, the number and the address themselves are not stored.

> **An address names a household, not a person.** Two accounts at one confirmed address are related at 0.6 and never joined by it alone. A rented mail box, a vacant address, and a building with the apartment missing tie nobody.

| What the check found | In `notes` | Effect |
| --- | --- | --- |
| A mobile or landline | `"phone": "mobile"` | Kept as `phone`, 0.9. |
| A number from an internet calling app | `"phone": "nonFixedVoip"` | Kept as `voip`, 0.5: related, not joined. |
| A toll-free or premium line | `"phone": "tollFree: not used"` | Not kept. |
| An address confirmed to the door | `"address": "confirmed"` | Kept as `address`, 0.6. |
| A rented mail box, or vacant | `"address": "a rented mail box: not used"` | Not kept. |
| The postal service does not know it | `"address": "not found"` | Not kept. |

A check that is down never loses the sighting. The phone is kept as a plain `phone`, the address is left out, and the rest is recorded.

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

`collect.js?forms=all` fills every form on the page without marking each. A script that posts a form itself can read the same two values from `accountGraph.fields()`.

## What is filtered out before it counts

| Filter | What it does |
| --- | --- |
| Declared bots | A visit whose user agent says it is a crawler, a link previewer or an uptime check is not recorded. `/stats` counts them under `bots`. |
| Confirmed bots | With Fingerprint set up, a visit Fingerprint flags as a bad bot is not recorded. |
| Shared addresses | With MaxMind set up, a VPN, data center or carrier address is recorded but ties nobody. |

With MaxMind, each visit is also noted with where its address places it, `place:US/FL/Miami`. The note links nothing. A reviewer sees it among the subject's sightings.

## Limits

| Limit | Detail |
| --- | --- |
| Addresses | United States only, through Smarty's US Street API. |
| Line checks cost money | Each new number is one paid Twilio lookup. Answers are kept for thirty days. |
| A bot that lies | Only bots that name themselves are filtered by user agent. One that pretends to be a browser needs Fingerprint. |
| Names | Names are not matched. Two accounts are not tied because both are called Pat Lee. |
| Not confirmed | No call has been made with real Smarty or Twilio keys. Both readers were written from the providers' documented answers. Smarty refuses a wrong key the same way however it is sent, so only a real key shows that it accepts the key in a header, as its authentication page says. |
