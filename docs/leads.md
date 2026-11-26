# Lead webhooks

A chat service, intake widget or payment relay can post directly to `https://graph.example.org/leads/<name>`. Each source has its own secret and a mapping from its fields to graph entries.

**Capture one real test post first.** These vendors do not publish a fixed format for these posts. Submit synthetic contact details through your own test integration and inspect the request privately. Find the stable lead or payment ID, the content type, and where the contact or payment fields appear. Every vendor field name and signature header in the examples below is a made-up placeholder. Replace each with what your vendor sends.

Set `LEADS_FILE` to a private JSON file containing the named sources you use, or supply the same object in `LEADS`. Each example shows the entire file for one source. To use several, put their names in the same object. Replace every example secret with a different random secret shared only with that sender. Keep credentials in headers and use HTTPS. Graph service tokens belong to your own services.

The server refuses to start when the sources are unsafe or ambiguous. Each secret must be at least 32 characters with at least 8 different characters, so a placeholder such as 32 of one letter is refused. It must also differ from every other source's secret and from every secret setting: the service and reviewer tokens, the receipt, link, identifier, webhook and Fingerprint secrets, the Twilio, Smarty, MaxMind and ad platform credentials, and the database password. Each source name may appear once. A `prefix` cannot begin with `lead`, `visitor`, `caller`, `call`, `text` or `page`, in any case, because the graph and the other sources name subjects with these. Nor can it begin with `contact`, `account` or `record`, the kinds your own records usually use. Two sources cannot share a prefix, and neither can sit inside the other, as `intake:web` sits inside `intake`.

## Live chat posting JSON

Suppose the test post to `/leads/chat` has content type `application/json` and this body.

<!-- schema config -->
```json
{
  "ticket_ref": "C17",
  "finished_on": "2026-11-24T16:40:00Z",
  "contacts": [{ "reply_to": "chat17@example.org", "given_part": "Sample", "family_part": "Contact" }],
  "hidden_fields": { "ag_device": "test-browser-17" },
  "conversation": "Example transcript left in the chat service."
}
```

Configure the source to read the first contact. A dot moves down one field and a numeric index picks one item, starting at zero. Both `contacts.0.reply_to` and `contacts[0].reply_to` select the same field. Map `device` when the service returns the visitor's hidden `ag_device` field. The graph drops the unmapped conversation and other extra fields before recording, and does not log their contents. See [Passing the browser ID to a chat service](identify.md#chat).

<!-- schema config -->
```json
{
  "chat": {
    "kind": "lead",
    "secret": "replace-with-private-chat-signing-key",
    "auth": { "header": "X-Chat-Proof", "encoding": "hex" },
    "mapping": {
      "id": "ticket_ref", "at": "finished_on",
      "first": "contacts.0.given_part", "last": "contacts.0.family_part",
      "email": "contacts.0.reply_to", "device": "hidden_fields.ag_device"
    }
  }
}
```

The sender computes HMAC-SHA256 over the exact body bytes using the source secret as the key and puts the hex digest in `X-Chat-Proof`. Use `"encoding": "base64"` when the sender supplies base64. The graph also accepts a digest written `sha256=<digest>`, hex in either case, and base64url or base64 without padding. Whitespace, escaping, and a final newline all affect the signature.

This post writes a profile of the subject `lead:chat:C17` and a conversion at the default `inquiry` step. The conversion's key is `lead:chat:C17`, and so is the profile's. With `updates` on, the profile's key is `lead:chat:` followed by a keyed hash of the ID and the mapped details. Use a vendor ID of 1 to 128 letters, digits, dots, underscores or hyphens. Integer IDs also work. The 200 answer is `{"recorded":["profile","conversion"],"duplicate":false}`.

## Intake widget posting a form

Suppose the widget's server posts this form to `/leads/intake`, with content type `application/x-www-form-urlencoded`. Configure its webhook to send `Authorization: Bearer <intake-secret>`. The word `Bearer` may be written in any case. Keep that secret on the widget's server.

```text
submission_ref=I28&callback_line=%2B12025550128&ag_device=test-browser-28
```

<!-- schema config -->
```json
{
  "intake": {
    "kind": "lead", "secret": "replace-with-private-intake-secret", "auth": "bearer",
    "stage": "submitted", "prefix": "intake",
    "mapping": { "id": "submission_ref", "phone": "callback_line", "device": "ag_device" }
  }
}
```

A phone sent as a JSON number, such as `2025550128`, is read as those digits. For a form with a field named `contacts[0][mail]`, map `email` to `contacts.0.mail`. For repeated fields named `mail` or `mail[]`, `mail.0` selects the first value.

The graph files the lead under the configured prefix and ID, `intake:I28`. The conversion key is `lead:intake:I28`.

**A source writes only to its own records.** Every subject a source writes starts with its prefix and a colon. Without `prefix`, the prefix is `lead:` and the source name, as in `lead:chat:C17`. A mapped `subject` must also start with the prefix, such as `intake:client-5`, or the post is refused with 400 and nothing is recorded. Anyone filling in a form can edit its hidden fields, so do not map `subject` from a form field at all.

A sender that must add contact details to records your own system assigned, such as `contact:28`, needs `"trustSubjects": true` on its source. The sender can then add contact details to any record in the graph, so set it only for a server you trust as fully as your own, never for a public form or a relay a visitor can reach.

This widget supplies no event time, so the graph uses the time the post arrived. A sender that knows the time can map `at` to an epoch number or an ISO timestamp with a time zone. A number below 100,000,000,000 is read as seconds, with up to three decimals, and a larger one as whole milliseconds, so `1790000000` and `1790000000000` are the same moment. A time more than one day after the post arrives, or not after 1970, is refused with 400.

## Webhooks by Zapier relaying any trigger

Add a **Webhooks by Zapier** action after your app's trigger. Choose **POST**, enter `https://graph.example.org/leads/relay`, and select a JSON payload. Under **Data**, map the trigger's stable record ID to `item_ref` and its contact email to `reply_address`. Under **Headers**, set `Authorization` to `Bearer <relay-secret>`. Use the same ID each time Zapier delivers the trigger.

<!-- schema config -->
```json
{
  "relay": {
    "kind": "lead", "secret": "replace-with-private-relay-secret", "auth": "bearer",
    "mapping": { "id": "item_ref", "email": "reply_address" }
  }
}
```

A test trigger might send `{"item_ref":"R31","reply_address":"relay31@example.org"}`. Choose only the fields the graph needs when building the action. The same JSON and bearer header work with an HTTP request step in Make.

To sign the post instead, set the source's `auth` to `{"header":"X-Relay-Proof","encoding":"hex"}`. In a **Code by Zapier** JavaScript step, provide `item_ref`, `reply_address` and the source secret as inputs.

```js
const { createHmac } = require('crypto')
const body = JSON.stringify({ item_ref: inputData.item_ref, reply_address: inputData.reply_address })
const proof = createHmac('sha256', inputData.secret).update(body, 'utf8').digest('hex')
return { body, proof }
```

Choose **Custom Request** in the Webhooks by Zapier action. Set the method to POST, put the Code step's `body` output directly in the raw data field, and send `Content-Type: application/json` and `X-Relay-Proof` with the `proof` output. Formatting the JSON again changes the signed bytes.

## Payment from a Zapier trigger

Choose the payment app's successful payment trigger. Add a **Webhooks by Zapier** POST to `https://graph.example.org/leads/settlements`, choose JSON and set `Authorization: Bearer <settlements-secret>`. Map the payment's own ID, the graph conversion key that payment settles, the amount in major currency units, and its currency code.

<!-- schema config -->
```json
{
  "settlements": {
    "kind": "payment", "secret": "replace-with-private-settlements-secret", "auth": "bearer",
    "conversions": ["lead:intake"], "maxAmount": 5000,
    "mapping": { "id": "payment_ref", "conversion": "outcome_ref", "amount": "total_paid", "currency": "unit_code" }
  }
}
```

A payment sets a conversion's value, so each payment source is limited. `conversions` lists the conversion key prefixes it may pay: `lead:intake` admits `lead:intake:I28` and refuses `lead:chat:C17` or a conversion your own services recorded. List your own key prefix, such as `case`, to let it pay those. `conversions` cannot name the graph's own `call`, `text` or `page` conversions, or a bare `lead`, which would admit every lead source's. `maxAmount` is the most the source may pay one conversion, over all its payments together. Both are required, and a payment outside them, or one that would take the source's payments to that conversion past `maxAmount`, is refused with 400.

For the intake above, carry its conversion key as a reference when starting the payment. A trigger reporting 2550 cents should send 25.50 for USD.

<!-- schema config -->
```json
{ "payment_ref": "P42", "outcome_ref": "lead:intake:I28", "total_paid": 25.50, "unit_code": "USD" }
```

The 200 answer is `{"recorded":["payment"],"duplicate":false}`. It records one received payment under `lead:settlements:P42`. A second payment against the same conversion needs its own payment ID. A payment can arrive before its conversion, as any payment entry can, and counts toward `maxAmount` from the start. See [Payment entries](http.md#entry-types).

## Checking delivery

Send the same test post twice. The second 200 answer is `{"recorded":[],"duplicate":true}`. The graph uses its ordinary record receipts. Retry a lost answer with the same source and ID. See [Receipt retention](operations.md#receipts).

A source takes no updates unless it has `"updates": true`. Without it, a later post with the same ID and other mapped details is refused with 409 and adds nothing. A post that differs only in its time or in unmapped fields is a duplicate.

Many vendors post a lead again as they learn more, under the same ID. With `"updates": true`, a later post with the same ID and new mapped details adds those details to the same subject and answers `{"recorded":["profile"],"duplicate":false}`. It adds facts and never removes earlier ones. The conversion keeps the subject and time of the first post, even if a later post gives another time. **Turn updates on only when the vendor assigns the ID.** If the ID comes from anything a visitor can edit, such as a form field or a page address, a visitor can post under somebody else's ID and attach their own details to that person's lead.

A later post that maps the same ID to another subject is refused with 409, with or without updates. A payment is not updated. A second payment with the same ID and a different amount, currency or conversion is refused with 409.

A lead without a usable identifying fact answers `{"recorded":[],"note":"NO_FACT_USED"}`, even while the graph is unavailable, since nothing would be recorded. Errors are answered as `{"error":"…"}` with the status codes listed in the HTTP reference.

**A forgotten subject stays forgotten.** After `forget`, a post with the same vendor ID answers `FORGOTTEN`. So does a post with a new vendor ID that would file the lead under a forgotten subject, such as a mapped `subject` naming it. The graph knows this from a tombstone `forget` leaves for each subject. `account-graph prune` keeps tombstones. A subject forgotten before this version has none, and a new vendor ID can bring it back. A new vendor ID with no mapped subject makes a new subject, which is a new record of that person. To bring a forgotten subject back on purpose, `record` a profile under that exact subject from your own services. This removes its tombstone, and lead posts may file under it again. A record the graph refuses as forgotten answers `{"recorded":[],"note":"FORGOTTEN"}`. Neither note calls for another delivery. See [HTTP status codes and retry behavior](http.md#lead-webhooks).
