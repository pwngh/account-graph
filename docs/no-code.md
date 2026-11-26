# Connect an intake form

When someone submits a web form, one request can tell the graph who contacted the firm and record their inquiry. The first entry is a `profile` with the contact's email. The second is a `conversion` for the same subject with the stage `inquiry`. Ask the person who runs your graph for its HTTPS address, a service token and the stage name your firm uses.

The [OpenAPI file](openapi.json) gives the method, path, body and answers for each action. The three tools below cannot import it as it is: Zapier has no OpenAPI import, and Power Automate custom connectors take OpenAPI 2.0. Use the HTTP step each tool offers, as shown, with the bodies and answers the file describes. A developer building a connector of their own can start from it.

## Map the submission

Use a new-submission trigger that supplies a permanent record ID, the original submission time and an email address. These examples use the form name and record ID for the subject because the firm keeps an intake record per submission. If the firm already has a permanent contact ID, map that into `subject` in both entries. Keep the submission ID in both keys so a later inquiry by the same contact gets its own entry.

| Field in the HTTP step | Value to map |
| --- | --- |
| URL and method | Your graph address followed by `/v1/record`, using `POST`. |
| Headers | `Content-Type` set to `application/json` and `Authorization` set to `Bearer ` followed by the service token. Keep the token in the automation's private credentials or secret store. Only the automation sends it. |
| `key` | Choose a fixed prefix unique to this form. Append the submission ID and the entry name. A rerun of the same submission must produce exactly the same keys. |
| `at` | The submission time as a whole number of milliseconds since 1970-01-01 00:00 UTC. If the trigger gives Unix seconds, multiply by 1,000. Use the same number for both entries. |
| `facts.email` | The email submitted on the form. Map text fields with the connector's JSON encoder so quotes in a value are escaped. |

## Zapier

1. Start a Zap with your form's new-submission trigger. Test with submission `701`, submitted at `1795460000` Unix seconds by `pat@example.org`. Use a Formatter number step to multiply the trigger time by 1,000.
2. Add Webhooks by Zapier and choose Custom Request. Select POST, set the URL and headers above and use the JSON body below as Data. Map the trigger ID into both keys and subjects, the Formatter number into each `at` and the form email into `facts.email`. Leave the numbers unquoted. Custom Request sends Data as raw text. For this template, use numeric IDs and restrict the form email field to letters, digits, dots, plus signs, underscores, hyphens and one @. For unrestricted text, use an action that builds a JSON object from mapped fields so it escapes quotes and backslashes.
3. Test the action. Open its returned data and check both entries in `results` before enabling the Zap.

```http
POST /v1/record

{ "entries": [
  { "type": "profile", "key": "intake-701-profile", "at": 1795460000000, "subject": "intake:701", "facts": { "email": "pat@example.org" } },
  { "type": "conversion", "key": "intake-701-conversion", "at": 1795460000000, "subject": "intake:701", "stage": "inquiry" }
] }
```

## Make

1. Start a scenario with your form's new-response module. Suppose the response ID is `802`, the submission time in milliseconds is `1795463600000` and the email is `lee@example.org`.
2. Add JSON → Create JSON. Generate its data structure from the body below. Add two items to `entries`. Map the response ID into both keys and subjects, the submission time into both number fields and the email into the first item's facts. Keep `profile` first.
3. Add HTTP → Make a request. Set the URL, method and headers above, select the raw JSON body option and map the entire JSON string from the previous module without surrounding quotes. Enable response parsing. Run once and inspect each item in `results`.

```http
POST /v1/record

{ "entries": [
  { "type": "profile", "key": "survey-802-profile", "at": 1795463600000, "subject": "survey:802", "facts": { "email": "lee@example.org" } },
  { "type": "conversion", "key": "survey-802-conversion", "at": 1795463600000, "subject": "survey:802", "stage": "inquiry" }
] }
```

## Power Automate

The HTTP action is a premium connector, so the flow's owner needs a Power Automate licence that includes premium connectors.

1. Start an automated cloud flow with Microsoft Forms → When a new response is submitted. Use its Response Id in Get response details. In this example response `903` has email `sam@example.org` and submission time `1795467200000` in milliseconds. If the form gives an ISO timestamp, map it into a Compose action named `Submitted_time`. In the next Compose, enter `div(sub(ticks(outputs('Submitted_time')),ticks('1970-01-01T00:00:00Z')),10000)` to get milliseconds.
2. Add an HTTP action. Set Method, URI and Headers as above. Enter the example's JSON object in Body. Use dynamic content for Response Id in each key and subject, the submission time number in both `at` fields and the email answer in `facts.email`. Protect the token with secure inputs on the action.
3. After the HTTP action, use Apply to each on the response body's `results` array. Test the item's `ok` field in a Condition so a refusal goes to the person who handles intake.

```http
POST /v1/record

{ "entries": [
  { "type": "profile", "key": "forms-903-profile", "at": 1795467200000, "subject": "forms:903", "facts": { "email": "sam@example.org" } },
  { "type": "conversion", "key": "forms-903-conversion", "at": 1795467200000, "subject": "forms:903", "stage": "inquiry" }
] }
```

## Handle the answer and retries

HTTP 200 means the graph has an answer for each entry, in order. Mark the submission complete once both have `ok: true`. A replay can also have `value.duplicate: true`. If either has `ok: false`, keep its key and reason with the intake record. The other entry can still have succeeded. If your firm requires a successful profile before it records an inquiry, send the two entries in separate requests and run the second step only after the first returns `ok: true`.

For `NO_FACT_USED`, read `notes`, have staff correct the unusable fact and resubmit the refused profile with its original key. For `KEY_REUSED`, compare the fields named in the answer with the original submission and check for an ID collision. Send a truly new submission under its own key. Stop on `FORGOTTEN`. The [refusal table](http.md#refusals) describes the other reasons.

The graph cannot schedule a retry for a workflow that lost its connection. Set up the platform's retry or replay step and keep the original payload so it sends the same keys, times and facts, even after someone edits the form. A new run ID or the current time would change the request. After a timeout or a fault with `retryable: true`, replay the saved request. For a non-retryable fault, use its code to fix the problem first. See [faults](http.md#faults) and [how long keys are remembered](http.md#idempotency).
