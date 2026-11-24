# Text messages

A text from your site arrives with a code that says which visit it came from. The graph ties the text to that visit and its ad, lists the texts nobody has answered, and keeps nothing that was said.

```html
<script type="module" src="https://graph.example.org/collect.js?text=1"></script>
<a href="sms:+15550100101?body=I%20need%20a%20lawyer.">Text us</a>
```

```text
tap ──▶ I need a lawyer. Ref K7Q2MX ──▶ your number ──▶ POST /text ──▶ the visit, and its ad
```

Set `TEXT_CODES=true` on the server. The script asks for this browser's code and adds it to the message as the link is followed. Without an answer, the link works as you wrote it.

A browser keeps its code for a week and is then given another. A code names its browser for 30 days after it was last given, in capital or small letters.

## Recording a text

Report each text as it arrives or is sent.

```sh
curl -X POST https://graph.example.org/text -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"id":"SM1","from":"+15550100141","to":"+15550100101","at":1795460000000,"text":"I need a lawyer. Ref K7Q2MX"}'
```

```json
{ "subject": "caller:96f2c503…", "flags": ["first", "code"], "counted": true, "visitor": "visitor:fb919054…", "duplicate": false }
```

`counted` says the text is an outcome of the step `text`. Reported again with the same id, a text is a `duplicate`: the first report stands, whatever the second says, except that a text cannot change its direction. Report a text again, with the same id, until it is answered with 200.

1. **Sender.** The sender is the same subject as a caller from that number, so their calls, their texts and a contact with that number are tied.
2. **Visitor.** The code links the text to the one visitor it was given to, at 0.95. Without a code, the one visitor who tapped your text link within the [tap window](calls.md#busy-numbers) is linked, at 0.92. Either joins the two.
3. **Lead.** The first text of a conversation is an outcome of the step `text`. A conversation ends after 30 days of silence. It is the same whatever order texts are reported in: one that arrives late can take a lead counted from a later text back.
4. **Channel.** A text without a visitor is filed under the channel `CALL_NUMBERS` gives its number, with the medium `text`.

> **What a text says is never stored.** It is read for the code and for a word such as STOP, and dropped. To keep it from reaching the server at all, read the code yourself and send `code` in place of `text`.

| Flag | Meaning |
| --- | --- |
| `first` | It begins a conversation, and is counted |
| `code` | The code named the visitor |
| `taken` | It named a visitor already tied to another caller or sender, so the two are not tied |
| `tap` | The visitor tapped the text link just before |
| `ambiguous` | More than one visitor tapped it just before, so none is tied |
| `opt_out`, `opt_in` | It was STOP or START, or a word that means the same. It is no lead. |
| `toll_free` | The sender's number is toll-free, and is excluded from linking |
| `left_out` | From or to a number in `CALL_EXCLUDE`, or from a number that is no phone's. It is not kept. |

### Twilio

Twilio can report incoming texts directly. The server verifies Twilio's signature on each request.

1. In the Twilio console, open the phone number and set **A message comes in** to `https://graph.example.org/texts/twilio`, method POST. If a system of yours answers there already, have it post each text to `/text`.
2. Set `TWILIO_AUTH_TOKEN`, and `TWILIO_TEXT_WEBHOOK_URL` to that address exactly as entered.
3. Post the texts you send to `/text` with `"direction": "outbound"`.

The answer to Twilio is empty, so the sender gets no reply from the graph.

## Unanswered texts

`GET /texts` lists the oldest unanswered text of each sender, oldest first.

```json
{ "texts": [{ "id": "SM1", "direction": "inbound", "subject": "caller:96f2c503…", "at": 1795460000000, "flags": ["first", "code"], "unanswered": 2, "source": "google", "campaign": null, "campaignId": "30111" }], "next": null }
```

`unanswered` counts what they have sent since anyone replied. A text from you, or a call with them that someone answered, replies to every text before it, whatever order they are reported in.

| State of a text | Meaning |
| --- | --- |
| `open` | Nobody has replied |
| `replied` | `by` is the text or call that did, `how` says which, and `delay` is the time it took, in milliseconds |
| `stopped` | The sender asked for no more texts before anyone replied |

Mark a sender as no lead with `POST /not-lead` and `"transactionId": "text:SM1"`. Their texts then wait for nobody.

## Asking for no more texts

`GET /texting?subject=contact:7` answers `{ "optedOut": true, "at": 1795460000000 }` when the last such word from anyone in the subject's cluster was STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE or OPTOUT, and `optedOut` is `false` after START or UNSTOP. It is `null` when nobody has said either.

It is kept apart from [consent](privacy.md), which is about advertising. Your own system sends the texts, so it must check its own list as well.

## Limitations

| Area | Detail |
| --- | --- |
| Deleted codes | Someone who deletes the code from the message is tied by their tap, or not at all. |
| Forwarded texts | Whoever sends a message with the code is tied to the browser it was given to. One visitor is tied to one sender. |
| Computers | A code opened on one device and sent from another ties the two, which is usually right. |
| Opt-out words | Only a message that is one of the words above is read as one. A sentence that asks to stop is not. |
| Pictures and groups | A picture is recorded as a text. Group messages are not told apart. |
| Delivery | Whether a text you sent was delivered is not read. A text you report as sent counts as a reply. |
| Twilio's time | Twilio sends no time with an incoming text, so it is the time the report arrived. |
| Untested | No text has arrived from a live Twilio number. |
