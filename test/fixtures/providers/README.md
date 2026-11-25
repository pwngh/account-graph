# Provider samples

`test/provider-fixtures.test.ts` replays these files in memory. All sources were read on 2026-11-25. None of the URLs, addresses, numbers, IDs or published example keys in the fixtures are destinations or credentials for a live check.

`signed.json` contains Twilio's published signature vector, with the signature from Twilio. [Twilio Go SDK, Validating requests](https://github.com/twilio/twilio-go#validating-requests)

CallRail publishes a payload, key and signature for testing too. They name a caller and are left out of the repository. On 2026-11-25 the verifier accepted them and refused them altered. The test signs a made-up body instead. [CallRail, Validating Payloads](https://apidocs.callrail.com/#validating-payloads)

`responses.json` contains unsigned responses. These services authenticate the HTTP exchange. An offline replay exercises only how this code interprets the response.

| Fixture | Source |
| --- | --- |
| Google Data Manager | Published success response with a field warning. [Send events, Response](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events) |
| Google Ads costs | SearchStream's JSON batch format with one synthetic campaign, date and spend. [Search and SearchStream](https://developers.google.com/google-ads/api/rest/common/search) · [Metrics](https://developers.google.com/google-ads/api/fields/v26/metrics) |
| Meta Conversions | Meta's SDK test uses a received count of one. The trace is synthetic. A complete worked wire reply with these fields was not found. [SDK sample](https://github.com/meta/facebook-php-business-sdk/blob/main/test/FacebookAdsTest/Object/ServerSide/EventRequestTest.php#L106) [Meta's specification, Response events received](https://github.com/facebookarchive/Facebook-Server-Side-API-Swagger/blob/main/server-side-api.yaml) · [Meta SDK receipt parser](https://github.com/meta/facebook-ruby-business-sdk/blob/main/lib/facebook_ads/ad_objects/server_side/event_request.rb) |
| Meta Insights | Synthetic campaign, date and spend in the documented data array. [Insights fields](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/insights) |
| Microsoft Advertising | Shortened JSON template for a v13 partial refusal. The item index, numeric code and error text are synthetic. Microsoft's worked example prints partial errors without sample values. [Worked example](https://learn.microsoft.com/en-us/advertising/guides/code-example-offline-conversions?view=bingads-13) [ApplyOfflineConversions, Response JSON](https://learn.microsoft.com/en-us/advertising/campaign-management-service/applyofflineconversions?view=bingads-13) |
| TikTok Events API 2.0 | Published successful v1.3 receipt. The double braces around the request ID appear in the example. [Events API 2.0, HTTP responses](https://business-api.tiktok.com/portal/docs?id=1771100779668482) |
| MaxMind | Selected fields of the published Insights sandbox response for Houston. [Sandbox for the GeoIP web services](https://support.maxmind.com/knowledge-base/articles/sandbox-for-the-geoip-web-services) |
| Smarty | Selected fields from the valid US Street Address example, including its barcode and flags. [Example output](https://www.smarty.com/docs/apis/us-street-api/reference) |
| Fingerprint | Selected fields of the v4 event example. The visitor ID was replaced, and the IP and device details were omitted. [Get an event by event ID](https://docs.fingerprint.com/reference/server-api-get-event) |

No provider-signed response vector was found for those seven providers' outbound API integrations. The graph's own event signature and its unsigned alert use first-party contracts.
