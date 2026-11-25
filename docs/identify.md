# Identify

A `profile` entry of [`record`](http.md#record) records what your backend knows about a person: sign-in, email, phone and postal address. Send the facts as they are. The server normalizes, checks and hashes them, then answers with the cluster changes. A [signed link](#signed-links) says who opened it.

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

Beside `facts`, `at` is when it happened, `event` is what the person was doing, up to 200 characters, and `speaker` is the [person who speaks for](#speaking-for-somebody-else) the subject: their `device`, `phone` and `email`.

| Kind of your own | Value |
| --- | --- |
| `hardware` | The hashed machine id reported by your desktop client |
| `passkey` | A passkey's credential id, after your server verified the sign-in |
| `payment` | A card or bank token from your payment provider, in place of the number |

Facts that come to no identifier, such as an address without Smarty or a placeholder, are refused with `NO_FACT_USED` and the notes. With a `speaker`, `facts` may come to none, or be `{}`.

The email, number, address, name and date of birth are stored only as hashes.

## Checks

| Finding | `notes` value | Effect |
| --- | --- | --- |
| A mobile or landline | `"phone": "mobile"` | Kept as `phone`, 0.9. |
| A number of one digit, or a count such as 1234567890 | `"phone": "a placeholder: not used"` | Dropped. A profile with nothing else is refused with `NO_FACT_USED`. |
| An email made up to fill a field, such as `none@`, or at `test.com` | `"email": "a placeholder: not used"` | Dropped. |
| An office's email, such as `info@` or `office@`, at no public mail domain | `"email": "read by several: not used"` | Dropped, because several people are behind it. |
| A number from an internet calling app | `"phone": "nonFixedVoip"` | Kept as `voip`, 0.5: related without joining. |
| A toll-free or premium line | `"phone": "tollFree: not used"` | Dropped. |
| An address confirmed to the door | `"address": "confirmed"` | Kept as `address`, 0.6. |
| A rented mail box, or vacant | `"address": "a rented mail box: not used"` | Dropped. |
| Unknown to the postal service | `"address": "not found"` | Dropped. |

> **An address identifies a household.** Two accounts at one confirmed address are related at 0.6 and are not joined by it alone. A rented mail box, a vacant address, or a building with the apartment missing links no accounts.

A check that is down, or takes more than three seconds, keeps the sighting. The phone is stored as a plain `phone`, the address is omitted with a note that the service did not answer, and the rest is recorded.

A number identified as VoIP also stops counting as a `phone` wherever it was stored before the check, by a phone call or by a sighting during an outage. Calls check the caller's number the same way, so a call and an account on one such number are related at 0.5.

## Speaking for somebody else

A mother calls about her son. Without being told, the server takes her number and her browser for his. Send what is hers as `speaker`, from [a box on the form](#on-a-form) or a mark your staff make:

```json
{ "type": "profile", "key": "intake-9", "at": 1795460000000, "subject": "contact:son",
  "facts": { "email": "son@example.org" },
  "speaker": { "device": "9f3c1c1e-0000-4000-8000-000000000001", "phone": "(555) 000-1111", "email": "mother@example.org" } }
```

| What you send | What happens |
| --- | --- |
| `speaker.device`, `speaker.phone` | At least one is needed. The browser and the caller are related to the subject at 0.92 and never joined to them. |
| `speaker.email` | Written on the caller, or on the browser where there is no number. |
| A fact both in `speaker` and beside it | Not used for the subject, with a note. |
| A fact of the speaker's that is on the subject's record already | Left there, with a note. Nothing written before is undone: mute it, or forget the record. |
| Neither device nor phone | The subject is recorded, with a note. |

What brought the speaker's browser earns the credit for the subject. It is not passed on to anybody else they speak for, or back. The two are never offered for review as one person, and a number written on both later does not join them. A reviewer who joins them has the last word. To take it back, mute the `behalf:` mark of the browser and that of the caller on the reviewer screen. The mark stays muted when the same browser reports under another visitor ID. The subject is a record of yours, not a browser or a caller.

### On a form

Mark the box that says so with `data-ag-for-other`. When it is ticked, the script tag sends the device as `ag_speaker_device` in place of `ag_device`, so a backend that copies `ag_device` does not write the speaker's browser on the client.

```html
<form action="/inquiry" method="post" data-ag-fields>
  <label><input type="checkbox" name="other" value="yes" data-ag-for-other> This is about somebody else</label>
```

| Marked control | Says somebody else when |
| --- | --- |
| A checkbox | It is ticked |
| A radio button | It is chosen, and its value is `other` |
| A select, or any other field | Its value is `other` |

Send the field back as `speaker.device`, whatever number and email are the speaker's own beside it, and the client's own details as `facts`:

```json
{ "type": "profile", "key": "form-31", "at": 1795460000000, "subject": "contact:son",
  "facts": { "name": { "first": "Dario", "last": "Ferrer" }, "dob": "2008-07-08" },
  "speaker": { "device": "9f3c1c1e-0000-4000-8000-000000000001", "phone": "(555) 010-0047" } }
```

> **The cookie is the speaker's too.** A form that posts to your own backend brings the `ag_device` cookie whatever was ticked. When it is about somebody else, the cookie belongs in `speaker.device`. Go by the box itself, which also works without the script.

Only a marked control counts. The answer is read as the form is submitted, so it can be changed and the form sent again.

### At intake

Make it a required question with no answer chosen beforehand, on the form and in the script staff read: "Is this for you, or for somebody else?" Two radio buttons can be `required`. A box cannot, and one left alone says the client wrote. Then ask whose the number and the email are.

On a call, the caller's number is the speaker's `phone`, and the client's own number, if they gave one, goes in `facts`. Record the call itself as usual.

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
| `ag_speaker_device` | The same id, in place of `ag_device`, where the form is [about somebody else](#on-a-form). Send it back as `speaker.device`. |
| `ag_landing` | The address this browser session began on, with its click id and campaign. |

`collect.js?forms=all` fills every form that posts. A script that posts a form itself can read the same values from `accountGraph.fields()`, or from `accountGraph.fields(form)` where the form may be about somebody else.

| Form | Filled |
| --- | --- |
| Marked `data-ag-fields` | Both fields. |
| Unmarked, with `method="post"`, under `forms=all` | Both fields. |
| Unmarked, sending its fields in the address, under `forms=all` | None, because an address is seen by more than its receiver. |
| Visitor opted out of advertising | `ag_device` only, because the landing page holds the ad click. |
| [About somebody else](#on-a-form) | The same, with `ag_speaker_device` in place of `ag_device`. Never both. |

When your backend can read the `ag_device` cookie, prefer it to the field, and use it as the field would be used: for whoever wrote. With `COOKIE=true` the server's cookie outlives the page's stored id. The id a page reports is kept on the same visitor, so either one finds them.

## Chat

A chat service hands over a lead with an email or a phone number, and often no device. Have your backend record the person as a `profile`, with the phone or email and the `device` where there is one, then the step as a `conversion`. The profile comes first, so the conversion finds the click.

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

To use names, set `IDENTIFIER_SECRET` and a policy with a `name` kind that only corroborates, such as [the preset for contacts entered by staff](matching.md#contacts-entered-by-staff).

| Step | Behavior |
| --- | --- |
| Folding | Accents, case and punctuation are ignored: `José Muñoz-Ruiz` and `JOSE MUNOZ RUIZ` are one name. |
| Placeholders | `Unknown`, `Test`, `John Doe`, a single initial and similar values produce no key. |
| Scope | A key needs the zip code of a confirmed address, or a date of birth. |
| Keying | The key is an HMAC under `IDENTIFIER_SECRET`, because a plain hash of a guessable name can be reversed. Name keys are withheld from ad platforms. |
| Cap | A key held by more than five people confirms no one. |

Under a policy with [`apart`](matching.md#facts-that-keep-people-apart), `dob` is also kept by itself, with or without a name, to tell two people apart. It links nothing.

`notes.name` states whether the name was used, and the reason when it was not. A default `dob`, such as 1900-01-01, is ignored.

## Costs

Each new number is one paid Twilio lookup. Answers are kept for thirty days.

## Signed links

A signed link identifies the person it was sent to. Opening it links their browser to them without a sign-in. The same signing carries one visitor across your sites.

```json
{ "type": "link", "key": "offer-42", "at": 1795460000000, "subject": "contact:42", "url": "https://example.org/offer", "expires": 1798052000000 }
```

```json
{ "results": [{ "type": "link", "key": "offer-42", "ok": true, "value": { "duplicate": false, "stands": true, "url": "https://example.org/offer?ag=b2ZmZXItNDIK…" } }] }
```

The same entry always gives the same address, so a lost answer can be asked for again.

Send that address to contact 42 by email or text message. Both features need one setting on the server:

```sh
LINK_SECRET=$(openssl rand -hex 32)
```

### Personal links

```text
your backend ──▶ record a link ──▶ address with a signed token
person opens it ──▶ script tag reads the token ──▶ POST /collect
server checks the signature ──▶ this browser and contact:42 share a link identifier
```

The token holds the key, the subject and an expiry, signed with `LINK_SECRET`. Changing or making one needs the secret. The script tag sends it with the visit, then removes it from the address bar so it is not bookmarked or shared with the page.

The shared identifier scores 0.92, above the 0.9 that joins. Later ad clicks and sign-ups in that browser then belong to a known person.

> **Anyone who holds a link can use it.** A forwarded link reaches another person's browser. These rules limit what that can join, without preventing it.

| When | What happens |
| --- | --- |
| A person's link is opened in a first, second and third browser | Each is linked to them at 0.92, and joined |
| It is opened in a fourth | Recorded without linking. More than a phone, a laptop and a tablet suggests a forwarded link. |
| The browser already belongs to another person of the same kind, by a sign-in or a device cookie | Recorded without linking: `contact:alice`'s link on `contact:bob`'s phone does not join them |
| It is opened in a browser of whoever [speaks for](#speaking-for-somebody-else) the person | Recorded without linking: a mother who opens her son's link is not her son |
| Two people's links are opened in one browser that belongs to neither | Both are linked, and their scores drop to 0.61, so the browser is joined to neither |

The speaker check covers the recipient's whole cluster in one read and stops at the first match.

Each opening is a note on the visitor for reviewers: `opened:contact:42`, or `opened:contact:42 (not tied)`.

#### What became of a link

Say what a link is for with `purpose`, a short word of your own: `form`, `documents`, `payment`. The person's `journey` [lookup](http.md#lookup) has each link and whether it was opened.

```json
{ "at": 1795460000000, "subject": "contact:42", "kind": "link", "link": "offer-42", "purpose": "payment", "opened": 1795460060000, "openings": 1 }
```

Each link is one entry, with a key of its own, even for the same purpose. `opened` is the first opening, by whoever had the link. A link opened and not followed by its step, such as a payment, is one to ask about. Where a link leads is not kept. Once its person is deleted, a link names nobody.

| Field | Meaning |
| --- | --- |
| `key` | Yours. It is in the token. |
| `subject` | Who it is for, up to 512 bytes. Anyone holding the link can read it, so use an id. Avoid names and emails. |
| `url` | An `http` or `https` address. Its other parameters are kept. |
| `expires` | Until when the link identifies its person: after `at`, and at most 366 days later. It is then an ordinary link. |
| `purpose` | What it is for, up to 64 letters, digits, dots, dashes and underscores. May be left out. |

Without `LINK_SECRET`, a link is the fault `CONFIG.UNSUPPORTED`.

### Cross-site visitors

Browsers keep a separate cookie for each site, so one person on two of your sites is two visitors. List your other sites on the script tag to carry the visitor across.

```html
<script type="module" src="https://graph.example.org/collect.js?domains=shop.example,help.example"></script>
```

```text
page on example.org ──▶ POST /collect, kind carry ──▶ a token for this browser, good for an hour
visitor follows a link to shop.example ──▶ the script adds the token to that link
shop.example's script tag ──▶ POST /collect with the token ──▶ the two visitors are joined
```

Put the tag, with its own `domains`, on each site, and list each site in `ORIGINS`. The script changes a link to a listed site at the moment it is followed, and leaves other links alone.

> **A carry token is bound to the browser's user agent and network.** It has no effect on another network or browser version, which stops a stranger from attaching their ad click to a sign-up by handing over a link. [Limitations](#limitations) covers look-alike browsers on one network.

A carried visitor is linked at 0.95, which joins two visitors and cannot merge two groups on its own. It is recorded per receiving site, so one visitor carried to three sites is joined on each. When look-alike browsers on a shared network use one token, a third holder ends the join and a fifth ends the link.

A referrer listed in `ORIGINS` records no new visit, so the original ad click keeps the credit. Subdomains of one site can share a cookie instead with `COOKIE=example.org`; see [Operations](operations.md#behind-a-proxy).

## Limitations

- **Addresses.** United States only, through Smarty's US Street API.
- **Reassigned numbers.** A number identified as VoIP stays muted as a `phone`, even if a later check reports a mobile. Restore it with [`decide`](http.md#decide) `unmute` and the phone.
- **Undeclared bots.** User agents identify only bots that name themselves. One that imitates a browser needs Fingerprint.
- **Names.** Under `apart: ["given"]`, the table recognizes some short forms and spellings, including Gerald and Jerry, and Catherine and Katherine. An exact name key requires the same normalized first and last names, so a nickname or a married surname can give a different key.

| Signed links | Detail |
| --- | --- |
| Browser without an account | A forwarded link links a stranger's browser to the person it identifies. If the stranger later signs up there, the two share a cluster until a reviewer separates them. |
| Person of another kind | `contact:alice`'s link in a browser signed in as `account:bob` joins the two, because only subjects of the same kind are compared. Lower `link` in the policy below 0.9 to relate a browser to its person without joining. |
| Look-alike browser | Someone on your visitor's network with the same browser version could hand them a link that joins the two visits. That lone visitor joins the other's cluster, and their ad click can be credited with the other's sign-up. The link cannot merge two groups of accounts by itself, and a reviewer can separate them. |
| Not carried across sites | A visitor who types the second site's address. A confirmed fingerprint or a sign-in still links them.<br>A visitor whose network changes between the sites, such as on leaving wifi.<br>A link opened from its menu (right-click, long press), because the menu can also copy the address. This relies on the browser announcing the menu, which was not checked for long press on every phone browser.<br>A link followed while the token is renewed. A token lasts an hour, and is renewed after thirty minutes, or when a tab returns to view. |
| Proxies | The network comes from `x-forwarded-for`, so `TRUST_PROXY` must state how many proxies you run. See [Operations](operations.md#behind-a-proxy). |
