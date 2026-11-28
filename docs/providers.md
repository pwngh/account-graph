# Providers

All providers are optional. For an offline run, leave provider credentials, hosted browser scripts and remote webhook URLs unset, and use an isolated local graph. The server checks required groups of variables at startup. Configuring an ad target or a report reader on a running server can start background work. Use the standalone checker for a single approved case. See [provider variables and workers](operations.md).

| Provider | What account-graph uses |
| --- | --- |
| [Fingerprint](#fingerprint) | Hosted browser identification and server confirmation of an event |
| [MaxMind](#maxmind) | IP geography and, with Insights, network type |
| [Google Ads](#google-ads) | Offline and enhanced conversions, value changes |
| [Meta](#meta) | Server conversion events |
| [Microsoft Advertising](#microsoft-advertising) | Offline conversions and supported adjustments |
| [TikTok](#tiktok) | Web conversion events |
| [Twilio](#twilio) | Incoming voice and SMS callbacks, number line type |
| [CallRail](#callrail) | Signed post-call reports through the example receiver |
| [Smarty](#smarty) | US postal-address verification |
| [Campaign costs](#campaign-costs) | Google and Meta campaign reports |

## Verification

Run the offline cases first. They use published fixture data, generated records and simulated transports. List the available remote checks without sending a request.

```sh
node --test test/provider-fixtures.test.ts test/live-check.test.ts
npm run live-check -- --list
```

Once a person has approved a specific account, input and destination, run **one** named check, for example `npm run live-check -- google`. The checker reads the process environment. It does not load Compose's .env file. Keep credentials in a private launcher outside the checkout. Supply only the chosen case's variables. Missing inputs, failed requests and inconclusive results exit nonzero. Output describes what was sent and the result without printing keys, phone numbers, visitor IDs or raw replies.

| Name | What is sent and what a pass establishes |
| --- | --- |
| `fingerprint` | One regional lookup for an approved QA browser's fresh `FINGERPRINT_EVENT_ID`. The reply must identify the requested event and a visitor, within five minutes of the local clock, with confidence from 0.9 to 1 and no bad-bot or tampering flag. The check does not establish origin or single use. |
| `maxmind` | One authenticated lookup. The sandbox must give the published US answer for its fixture IP. Other hosts receive documentation IP `192.0.2.1` and must report a missing or reserved IP. May consume a query. |
| `google-token` | One signed assertion for a Data Manager access token. No Ads destination is checked. |
| `google` | OAuth and one validate-only Data Manager event with a random transaction ID and a hash of `proof@example.org`. Requires a receipt without field warnings. No click match, recorded conversion or adjustment is tested. |
| `meta` | One real test-coded `Lead`, source `other`, with a random ID and hashed test email. Requires one acknowledged event and no receipt messages. Check the selected dataset's Test Events view. |
| `microsoft` | One OAuth refresh. An access token proves refresh only. The provider may return a new refresh token. No goal is contacted. |
| `tiktok` | One test-coded web `CompleteRegistration` with a random ID, hashed test email and example.org page. Requires success code zero. Check the selected pixel's Test Events view. |
| `google-costs`, `meta-costs` | Each reads yesterday's campaign metrics using UTC date boundaries. An empty report is a valid read. Google also does OAuth. The Meta check stops if a second page is needed. Neither reconciles spend or requests optional conversions. |
| `smarty` | One fictional US address and the optional selected license, requiring an empty candidate list. May consume a lookup. No deliverable address is verified. |
| `twilio` | One potentially billable Lookup v2 request for an owner's expressly approved `TWILIO_LOOKUP_NUMBER` in international E.164 form. Requires a valid number and a line type. No call or SMS is placed. |

No provider is contacted when the name or its required keys are missing. The optional `--invalid-key` flag after a name makes **one real request** using dummy credentials and dummy inputs. Recognized access refusals prove only that the endpoint refused this request. A different error is inconclusive. Voice, SMS, CallRail ingress, pool leasing and the graph's outgoing event and alert webhooks have separate [call](calls.md) and [operations](operations.md) tests.

## Fingerprint

1. A person creates or selects their authorized hosted workspace. The Free plan lists up to 1,000 identifications per month. Fingerprint's terms prohibit automated account registration. See [Signup](https://dashboard.fingerprint.com/signup), [Plans](https://fingerprint.com/pricing/) and [Terms](https://docs.fingerprint.com/docs/terms-of-service).
2. In that workspace choose **API keys > Public** for the browser key. See [Quick start](https://docs.fingerprint.com/docs/quick-start-guide).
3. Choose **API keys > Server API > New secret key** for the server's `FINGERPRINT_SECRET`. Keep it off the page. See [Keys](https://dashboard.fingerprint.com/api-keys?type=api) and [Server event lookup](https://docs.fingerprint.com/reference/server-api-get-event).
4. Set both the script's `region` and `FINGERPRINT_REGION` to the workspace's `us`, `eu` or `ap`. For example, use `/collect.js?fingerprint=PUBLIC_KEY&region=eu` with `FINGERPRINT_REGION=eu`. After authorization to identify the device, capture a fresh event for the same workspace and run the named checker. See [Regions](https://docs.fingerprint.com/docs/regions) and [Browser start options](https://docs.fingerprint.com/reference/js-agent-start-function).

Control whether the page loads hosted identification before collecting the visitor's device or IP. The `endpoints` script parameter selects the events endpoint, but the hosted loader still fetches from Fingerprint's CDN. The separate open-source `canvas=open` loader needs no hosted key and gives no server-attested event. See [Proxy setup](https://docs.fingerprint.com/docs/protecting-the-javascript-agent-from-adblockers) and [FingerprintJS](https://github.com/fingerprintjs/fingerprintjs).

## MaxMind

1. Create the owner's account, activate the email and complete two-factor authentication. Enroll in the desired product in the portal. See [Account](https://www.maxmind.com/en/create-account) and [Two-factor authentication](https://support.maxmind.com/knowledge-base/articles/two-factor-authentication-2fa).
2. For GeoLite City select `MAXMIND_HOST=geolite.info` and `MAXMIND_SERVICE=city`. For Insights, check trial eligibility first. An eligible administrator can create a separate sandbox account. Use its credentials, `MAXMIND_HOST=sandbox.maxmind.com`, `MAXMIND_SERVICE=insights` and its published fixture IPs. The production default is Insights at `geoip.maxmind.com`. The US price page lists $0.002 per Insights query and no minimum usage. The $20 figure applies to auto-recharge. See [GeoLite](https://www.maxmind.com/en/geolite-free-ip-geolocation-data), [Sandbox eligibility](https://support.maxmind.com/knowledge-base/articles/test-with-the-maxmind-sandbox), [Sandbox records](https://dev.maxmind.com/geoip/docs/web-services/sandbox-environment/), [Prices](https://www.maxmind.com/en/geoip-api-web-services) and [Auto-recharge](https://support.maxmind.com/knowledge-base/articles/auto-recharge-your-maxmind-service-credit).
3. Within the chosen environment, open **Account > Manage License Keys > Generate new license key**, name it and privately save its one-time value as `MAXMIND_LICENSE_KEY`. See [License keys](https://support.maxmind.com/knowledge-base/articles/generate-a-maxmind-license-key).
4. Find the same account's ID at the top of **Account Information** and set `MAXMIND_ACCOUNT_ID`. See [Account ID](https://support.maxmind.com/knowledge-base/articles/find-your-maxmind-account-id).

GeoLite City can return approximate geography. Insights can add network classification. License terms restrict using these data to locate or identify a specific person, street address or household. Check the intended deployment against those terms. The process caches successful results for up to a day. Restarts, concurrent queries and eviction affect usage. See [GeoLite license](https://www.maxmind.com/en/geolite/eula) and [GeoIP Web Service Addendum](https://www.maxmind.com/en/geoip-web-service-addendum).

## Google Ads

This adapter uses Data Manager. Google's June 15, 2026 migration restriction applies to new or non-allowlisted offline upload integrations. Google Ads test accounts support reporting tests but cannot demonstrate conversion uploads. See [Migration](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/upgrade) and [Test accounts](https://developers.google.com/google-ads/api/docs/best-practices/test-accounts).

1. For an actual click integration, check **Admin > Account settings > Auto-tagging**. Validate-only needs no ad click. See [Auto-tagging](https://support.google.com/google-ads/answer/3095550).
2. In the account that owns the conversion choose **Goals > Summary > Create conversion action > Conversions offline > Add data source**. Connect or defer if offered, choose the category, define the action and save. The person accepts applicable terms. Select an eligible upload-from-clicks action and allow 4 to 6 hours for a new one. For enhanced leads, also enable the account setting, confirm first-party collection and accept customer-data terms. See [Offline setup](https://support.google.com/google-ads/answer/7012522) and [Enhanced leads](https://support.google.com/google-ads/answer/11347292).
3. Have a Cloud principal with service-enablement permission enable the **Data Manager API** on the nominated project. It does not require an Ads developer token. See [Set up access](https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access).
4. Create or select a service account, grant **Service Usage Consumer** on that project and privately download the JSON key if organization policy permits. Set `GOOGLE_SERVICE_ACCOUNT_FILE` to its readable private path. The Compose example supplies no credential-file mount. See [Access and roles](https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access) and [Key management](https://cloud.google.com/iam/docs/keys-create-delete).
5. Under Ads **Admin > Access and security > Users**, grant the service account appropriate access to the conversion-owning customer or authorized manager. Set `GOOGLE_ADS_CUSTOMER_ID` from the Ads profile and optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID` for manager access. Under **Conversions > chosen action > Details** find the numeric conversion type ID. Use it in `"actions": {"google":"987654321"}` or the [stage action](report.md#steps). `GOOGLE_ADS_CONVERSION_ACTION_ID` is a checker-only input. The minimum Ads role for ingestion was not verified. See [Account access](https://developers.google.com/google-ads/api/docs/oauth/service-accounts#account_access_setup), [Customer ID](https://support.google.com/google-ads/answer/1704344) and [Destination IDs](https://developers.google.com/data-manager/api/devguides/concepts/destinations).

The normal sender records events. The `google` checker sets `validateOnly` and tests an email-only request. It does not exercise the click, enhanced website or adjustment flows, nor check final processing. See [Ingest](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest) and [Request status](https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve).

## Meta

1. From an eligible Business Suite portfolio, create or select an isolated pixel or dataset in Events Manager. Keep a QA dataset disconnected from live campaigns and audiences. See [Get started](https://developers.facebook.com/documentation/ads-commerce/conversions-api/get-started).
2. Choose the dataset, then **Settings > Conversions API > manual setup > Generate access token**. This requires developer privileges. Set `META_PIXEL_ID`, `META_ACCESS_TOKEN` and `META_SITE_URL`, which is the fallback page for a website event. Under the same dataset's **Test Events** find the server test code. `META_TEST_EVENT_CODE` adds it to requests. Meta says these writes can be used in measurement and targeting. No per-event undo was verified. See [Setup](https://developers.facebook.com/documentation/ads-commerce/conversions-api/get-started) and [Using Test Events](https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api).

Use a Meta event name such as `Lead` as the action. Meta requires the converting browser's user agent for website events. By default the graph does not store a raw user agent in a visit or send it to Meta. Set `META_CLIENT_USER_AGENT=true` to store the converting request's actual user agent on the Meta job and send it for website events with affirmative ad-user-data consent. For page events the graph needs an affirmative consent on record. A GPC signal or an explicit denial on the browser event prevents capture. For previously queued jobs, record a consent change on the server. A standing denial stops delivery before the request starts. The outbox can keep the header while a job awaits delivery or retry, then clears it on a sent, skipped or terminally failed job. A backend that knows the actual converting browser can supply `userAgent` on the conversion. Earlier visits cannot be backfilled. If unavailable, the website event omits the field and may be rejected or diagnosed. For a genuine system-created conversion, set `channel: "SYSTEM_GENERATED"`. The checker uses `other` for its synthetic command-line event. See [Event sources and website fields](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/server-event).

## Microsoft Advertising

1. For testing, have the person sign into the Microsoft Advertising sandbox with their nominated outlook.com Microsoft account. If a new identity is approved, the person creates it privately. Select or create a sandbox advertising account, choose **Skip payment information** and use the sandbox's published shared developer token. Use `MICROSOFT_SANDBOX=true` for sandbox uploads and adjustments. In production a Super Admin requests the user's developer token. See [Sandbox](https://learn.microsoft.com/en-us/advertising/guides/sandbox?view=bingads-13) and [Production access](https://learn.microsoft.com/en-us/advertising/guides/get-started?view=bingads-13).
2. With permission to register apps in an Entra tenant, choose **App registrations > New registration**, enter the app's name and choose accounts in any organizational directory and personal Microsoft accounts. Register the platform and exact redirect URI. Record `MICROSOFT_CLIENT_ID`. See [App registration](https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-register).
3. Complete interactive OAuth consent for `https://ads.microsoft.com/msads.manage offline_access` using that redirect. Privately exchange the code for `MICROSOFT_REFRESH_TOKEN`. Confidential web clients also need `MICROSOFT_CLIENT_SECRET`. Microsoft may rotate the refresh token. The adapter keeps its replacement only in memory. An expired stored grant after restart requires private reauthorization. See [Consent](https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-consent) and [Tokens](https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-get-tokens).
4. In the selected environment, take numeric `cid` and `aid` from the Campaigns URL for `MICROSOFT_CUSTOMER_ID` and `MICROSOFT_ACCOUNT_ID`. Use them with the matching `MICROSOFT_DEVELOPER_TOKEN`. See [Account identifiers](https://learn.microsoft.com/en-us/advertising/guides/get-started?view=bingads-13).
5. Create an **Offline conversion** goal. Check MSCLKID auto-tagging, account scope, goal window and enhanced-conversion eligibility for hash-only events. Use the goal's exact name in `actions.microsoft`. Wait at least two hours before uploading to a new goal. The provider enforces the applicable goal window and a 90-day upper bound. The standalone checker exercises OAuth only. The sandbox can exercise upload handling but does not report attributed offline conversions. See [Sandbox reporting](https://learn.microsoft.com/en-us/advertising/bulk-service/offline-conversion?view=bingads-13), [Goal](https://learn.microsoft.com/en-us/advertising/campaign-management-service/offlineconversiongoal?view=bingads-13) and [Upload](https://learn.microsoft.com/en-us/advertising/campaign-management-service/applyofflineconversions?view=bingads-13).

## TikTok

1. In Ads Manager choose **Tools > Events > Connect data source > Web > Next**, enter the authorized site, choose **Manual setup > Events API**, then create or select a named isolated pixel. The sender uses Events API 2.0's v1.3 web endpoint. See [Web setup](https://business-api.tiktok.com/portal/docs/setup-guide-for-web/v1.3).
2. As an admin or operator of the asset, open pixel **Settings > Generate access token**. Set `TIKTOK_ACCESS_TOKEN` privately. See [Access](https://ads.tiktok.com/resources/help/article/getting-started-events-api).
3. In **Events > Data sources**, copy the chosen pixel's ID to `TIKTOK_PIXEL_CODE`. Set `TIKTOK_SITE_URL` as the fallback page. For a test, take the same pixel's server test code from **Test Events** and set `TIKTOK_TEST_EVENT_CODE`. The code goes at the top level of the request and is absent by default. The checker requires it. A zero code needs a corresponding Test Events observation to prove dashboard visibility. See [Pixel ID](https://ads.tiktok.com/resources/help/article/how-to-create-and-access-tiktok-pixel-id?lang=en-GB), [Test Events](https://business-api.tiktok.com/portal/docs/verify-gtm-setup/v1.3) and [Official request template](https://github.com/tiktok/gtm-template-eapi/blob/main/template.tpl).

Use an event name such as `CompleteRegistration` in `actions.tiktok`. The page tag collects `ttclid` from the landing URL.

## Twilio

1. On a designated configurable number, set **Voice > Call status changes**, POST, to the exact external `/calls/twilio` URL. Check that the current trial exposes final-status callbacks for your scenario. Availability on a shared trial number is not verified. See [Voice callbacks](https://www.twilio.com/docs/voice/twiml#statuscallback-request-parameters) and [Trial voice](https://www.twilio.com/docs/usage/trials/try-out-voice).
2. For an SMS-capable number, set **Messaging > A message comes in**, Webhook, POST, to the exact external `/texts/twilio` URL. A shared trial may offer **Try out SMS > Inbound > Auto-Reply settings > Custom**. Check country, verified-handset and trial restrictions for the selected scenario. See [Incoming SMS](https://www.twilio.com/docs/messaging/guides/webhook-request) and [Trial SMS](https://www.twilio.com/docs/usage/trials/try-out-sms).
3. For default form signing, set the **account** Auth Token as `TWILIO_AUTH_TOKEN` and the exact public URLs as `TWILIO_WEBHOOK_URL`, `TWILIO_TEXT_WEBHOOK_URL` or both. Check the account's signing mode. The code verifies default URL-plus-form signatures. See the [call and text setup](calls.md#twilio). See [Twilio signatures](https://www.twilio.com/docs/usage/webhooks/webhooks-security) and [Shared keys](https://www.twilio.com/docs/usage/webhooks/webhook-shared-keys).
4. For Lookup alone, set the account's `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`. The server requests the Line Type Intelligence field with each lookup. An absent or failed package yields no cached result. Verify your country coverage, entitlement and allowance first. Canada needs approval. The US price page lists $0.008 per query at the first tier. Trial units can cover eligible queries. The provider's Lookup magic numbers cover other packages. See [Line type](https://www.twilio.com/docs/lookup/v2-api/line-type-intelligence), [Prices](https://www.twilio.com/en-us/user-authentication-identity/pricing/lookup), [Trial Lookup](https://www.twilio.com/docs/usage/trials/try-out-lookup) and [Magic numbers](https://www.twilio.com/docs/lookup/magic-numbers-for-lookup).

The graph's [number pool](calls.md) leases numbers the owner already controls. Provisioning and routing happen separately on the provider. The graph implements no outgoing call or text sender. See [Number configuration](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource).

## CallRail

The [example receiver](../examples/call-tracking.ts) accepts an inbound post-call webhook. Follow the [CallRail setup](calls.md#a-call-tracking-service) to set its private spool, company signing key, graph URL and graph token. Use the QA company's **Integrations > Webhooks** and set its inbound post-call URL to the receiver's public `/calls`. The receiver verifies the HMAC over the exact request body and maps the tracking number and call. An answered line can be an automated system. A confirmed miss or voicemail gives a negative answer, otherwise the example leaves a human answer unknown. The graph does not query CallRail's REST API. See [Webhook setup](https://support.callrail.com/hc/en-us/articles/5711246459149-Webhooks), [Post-call payload](https://apidocs.callrail.com/#post-call-webhook), [Signatures](https://apidocs.callrail.com/#validating-payloads) and [Answer definition](https://support.callrail.com/hc/en-us/articles/5712132142605-Unanswered-calls-report).

## Smarty

1. A person creates the business account and activates an eligible **US Address Verification** subscription or trial. The trial advertises 42 days or 1,000 lookups, whichever comes first. If multiple licenses cover US Street, choose the authorized license under **Account Dashboard > Subscriptions** and set its value in `SMARTY_LICENSE`. With one applicable license, leave this unset. See [Trial](https://www.smarty.com/free-address-verification), [License selection](https://www.smarty.com/docs/account/license-selection) and [Agreement](https://www.smarty.com/legal/subscription-agreement).
2. Under **Account > API keys > Secret keys** create or select a server auth ID and token. Set `SMARTY_AUTH_ID` and `SMARTY_AUTH_TOKEN` privately. The server sends them as HTTP Basic credentials. A 401 indicates rejected authentication, a 402 indicates lack of an active applicable subscription. See [Keys](https://www.smarty.com/account/keys), [Authentication](https://www.smarty.com/docs/account/authentication) and [US Street](https://www.smarty.com/docs/apis/us-street-api/reference).

The adapter limits street to 50 characters, or 100 for a lone freeform street, street2 to 50, secondary to 32, city to 64, state to 32 and ZIP to 16. It requests one candidate. A confirmed, non-vacant delivery point outside a commercial mail receiving agency can supply an address identifier. The checker verifies the no-match response for a fictional address. See [Request fields and response](https://www.smarty.com/docs/apis/us-street-api/reference).

## Campaign costs

Only Google and Meta have automatic cost readers. Other platforms can use manual [cost entries](report.md#costs).

**Google Ads**

1. Choose the Cloud project's access level for the intended test or production customer. Google retired the developer token on September 9, 2026. An existing `GOOGLE_ADS_DEVELOPER_TOKEN` is optional for compatibility. See [Retirement](https://developers.google.com/google-ads/api/docs/api-policy/developer-token) and [Access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels).
2. Enable **Google Ads API** in the service account's project. Test access is sufficient for a test customer's report. See [Cloud setup](https://developers.google.com/google-ads/api/docs/oauth/cloud-project).
3. Give the service account reporting access on the selected customer. Use the customer ID, optional manager ID and private file described above. Set `GOOGLE_ADS_COSTS=true` to enable the normal reader. An existing developer token still enables it unless explicitly disabled. The reader uses the Ads OAuth scope and v26 searchStream. In the normal server, configuring the file and customer also configures the conversion target. The standalone report check reads only. See [Reporting](https://developers.google.com/google-ads/api/rest/common/search).

**Meta**

1. In Ads Manager select the authorized ad account and match its displayed numeric ID to `META_AD_ACCOUNT_ID`. See [Ad account](https://developers.facebook.com/docs/graph-api/reference/ad-account/).
2. A business administrator assigns the account to the reporting system user. Generate a token for an authorized app with `ads_read` and set `META_ADS_TOKEN`. Confirm this grant separately from the pixel's conversion token. The reader requires a valid Insights data array and follows only expected Graph pages within its limit. See [Access](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization) and [Insights](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/insights).

Every six hours, the normal worker reads from seven UTC days ago through today. For optional conversion metrics enable `GOOGLE_ADS_CONVERSIONS=true` or set `META_ADS_CONVERSIONS` to the chosen Insights action type. To reconcile existing spend, compare the same account, reporting day, currency, metric and attribution window with the provider. See [Google metrics](https://developers.google.com/google-ads/api/fields/v26/metrics) and [Meta action stats](https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats/).

## Loading your past

To load the sales, calls and payments you already have, send them with `"history": true` beside `entries` in the `record` request. They are recorded and counted in every report, and nothing is queued for an ad platform, now or later. Without it, a sale young enough for a platform to accept is sent however old it is, so three months of history would tell the platform of every sale again.

## What sending does

| Condition | Job outcome |
| --- | --- |
| The adapter accepts the provider's reply | `sent`. For Meta this requires the submitted count in `events_received`. It does not establish a match or campaign credit. |
| Retryable refusal or network error | `pending` with backoff from 30 seconds, doubling to one hour, shortened by jitter. After eight attempts by default, `failed`. Credential errors are classified by each adapter. |
| Non-retryable batch refusal | The outbox retries each member separately to isolate bad items. Some providers can already have accepted part of the batch. An individual refusal can be terminal. |
| No eligible click or permitted email/phone | `pending` with `no_match_key`, then `skipped` after seven days without a key. New evidence can make a job eligible. |
| Applicable subject or click-browser consent denies ad-user data | `skipped` with `consent_denied`. This includes an applicable refusal recorded after the conversion. |
| Older than the adapter window | `skipped` with `too_old`. The local maximum is seven days for all Meta sources and 90 for Microsoft. Goal windows can be shorter. |

A click below the default confidence threshold of 0.9 outside the subject's cluster is omitted. Available permitted hashes can still be sent. Match data is chosen when sending. Each adapter normalizes and hashes email and phone for its platform. Google selects `gclid`, then `gbraid`, then `wbraid`. Meta builds `fbc` from `fbclid` and click time, adding a valid `fbp` when available with that click. Microsoft selects `msclkid` and TikTok `ttclid`. Google's request can carry ad-user-data and ad-personalization flags. Other adapters do not forward every consent field. See [Google formatting](https://developers.google.com/data-manager/api/devguides/concepts/formatting), [Meta identifiers](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/fbp-and-fbc), [Microsoft](https://learn.microsoft.com/en-us/advertising/campaign-management-service/offlineconversion?view=bingads-13) and [TikTok](https://github.com/tiktok/gtm-template-eapi/blob/main/template.tpl).

Delivery is at least once. A retry can repeat a write after a lost response. Meta deduplication depends on event name, ID and timing. Google can restate value for the same transaction, action and destination. Zero value can leave the count in place. Microsoft adjustments use their own API. Match, final processing, value changes and any erasure need separate evidence. See [Meta deduplication](https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events/), [Google adjustments](https://developers.google.com/data-manager/api/devguides/events/google-ads/conversion-adjustments) and [Microsoft adjustments](https://learn.microsoft.com/en-us/advertising/campaign-management-service/applyofflineconversionadjustments?view=bingads-13).

## Limitations

Provider sources were read on November 25, 2026. The [offline fixtures and their sources](../test/fixtures/providers/README.md) and [checker tests](../test/live-check.test.ts) exercise contracts with local data. Earlier invalid-key observations establish only that the selected endpoints refused those requests at that time. No live account, hosted browser identification, real callback delivery, positive metered lookup, provider credit or historical spend reconciliation is verified.
