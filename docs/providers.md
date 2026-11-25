# Providers

Every provider is optional. Each one turns on when its variables are set, and the server runs without any of them.

| Provider | Adds | Purpose |
| --- | --- | --- |
| [Fingerprint](#fingerprint) | A visitor id your server confirms | Linking the same browser across your sites |
| [MaxMind](#maxmind) | Whether an address is a home or shared by many people | Keeping VPNs, carriers and offices from linking strangers |
| [Google Ads](#google-ads) | Conversions sent to Google | Crediting Google ad clicks |
| [Meta](#meta) | Conversions sent to Meta | Crediting Meta ad clicks |
| [Microsoft Advertising](#microsoft-advertising) | Conversions sent to Microsoft | Crediting Microsoft ad clicks |
| [TikTok](#tiktok) | Conversions sent to TikTok | Crediting TikTok ad clicks |
| [Twilio](#twilio) | Phone calls, and the line type of a number | [Linking calls to visitors](calls.md#twilio); lowering the weight of throwaway numbers |
| [Smarty](#smarty) | A postal address as a single delivery point | Detecting accounts that share an address |
| [Campaign costs](#campaign-costs) | Google and Meta cost per campaign | [The report](report.md) |

## Verification

```sh
npm run live-check
```

`npm run live-check` calls each provider's real endpoint with the server's variables. Without keys, it sends an invalid one and prints the rejection, which confirms the address and request format. With your keys, it makes a call that records no data and reports the result.

| Provider | Call made with your keys |
| --- | --- |
| Fingerprint | Asks about an event that does not exist. |
| MaxMind, Smarty, Twilio line checks | Makes one lookup, billed as one query each. |
| Google Ads | Gets a token. With `GOOGLE_ADS_CUSTOMER_ID` and `GOOGLE_ADS_CONVERSION_ACTION_ID` set, also has Google validate a request without recording it. |
| Meta | Sends one event to the test tool. Requires `META_TEST_EVENT_CODE`. |
| Microsoft Advertising | Gets a token. |
| TikTok | Skipped, because any call would record an event. |
| Campaign costs | Reads yesterday's costs. |

## Fingerprint

Fingerprint is a paid service that gives each browser a visitor id. The browser receives an event id, and your server asks Fingerprint for that event's visitor.

1. Sign up at <https://dashboard.fingerprint.com/signup>. See the [quick start guide](https://docs.fingerprint.com/docs/quick-start-guide).
2. Copy the public key from **API keys > Public** in the dashboard sidebar (<https://dashboard.fingerprint.com/api-keys>).
3. Create a secret key under **API keys > Server API**, with **New secret key** (<https://dashboard.fingerprint.com/api-keys?type=api>).
4. Set the secret key on the server, and the public key on the script tag.

```sh
FINGERPRINT_SECRET=…        # the secret key
FINGERPRINT_REGION=us       # us, eu, or ap: the region the workspace was created in
```

```html
<script type="module" src="https://graph.example.org/collect.js?fingerprint=PUBLIC_KEY"></script>
```

Ad blockers stop requests to Fingerprint's own domain. To avoid this, serve Fingerprint from your subdomain, as described in [Protecting the JavaScript agent from ad blockers](https://docs.fingerprint.com/docs/protecting-the-javascript-agent-from-adblockers). Then add `&endpoints=https://your-subdomain` to the script tag.

## MaxMind

MaxMind classifies an address as a household, VPN, data center, phone carrier, campus or office. This requires its Insights service.

1. Create an account at <https://www.maxmind.com/en/geolite2/signup>.
2. Buy Insights queries. The [web services page](https://www.maxmind.com/en/geoip-api-web-services) lists $0.002 per query with a $20 minimum.
3. Create a license key from the account menu: **Manage License Keys**, then **Generate new license key** (<https://www.maxmind.com/en/accounts/current/license-key>). The key is shown once. See MaxMind's [steps](https://support.maxmind.com/hc/en-us/articles/4407111582235-Generate-a-License-Key).
4. Find your account ID in the account portal.

```sh
MAXMIND_ACCOUNT_ID=…
MAXMIND_LICENSE_KEY=…
```

The server caches each answer for a day, so a returning address costs one query a day.

A free GeoLite account works with `MAXMIND_HOST=geolite.info` and `MAXMIND_SERVICE=city`. It omits the type of address, so use it only for the country.

## Google Ads

Conversions use Google's Data Manager API, which replaced the Google Ads API for this purpose in June 2026.

1. Turn on auto-tagging in Google Ads, so ad clicks carry a `gclid`. See "Before you begin" in [Set up offline conversions using GCLID](https://support.google.com/google-ads/answer/7012522).
2. Create the conversion action, as in that article: **Goals > Summary > Create conversion action > Conversions offline > Add data source**, pick a connection, choose a category, **Save and continue**, **Agree and finish**. Wait 4 to 6 hours before sending to a new action, as Google advises.
3. Enable the **Data Manager API** in a Google Cloud project, from Google's [set up access](https://developers.google.com/data-manager/api/get-started/set-up-access) page.
4. Create a service account in that project and download its key file.
5. Give the service account access to the Google Ads account, with the [service account access steps](https://developers.google.com/google-ads/api/docs/oauth/service-accounts#account_access_setup).

```sh
GOOGLE_ADS_CUSTOMER_ID=123-456-7890            # the account that owns the conversion action
GOOGLE_SERVICE_ACCOUNT_FILE=/secrets/key.json
GOOGLE_ADS_LOGIN_CUSTOMER_ID=…                 # only when the service account belongs to a manager account
```

A conversion, or its step, names the conversion action by its id: `"actions": { "google": "987654321" }`, or `"action"` in [`STAGES`](report.md#steps).

## Meta

Conversions use the Conversions API.

1. Create a Meta pixel. The [get started page](https://developers.facebook.com/docs/marketing-api/conversions-api/get-started) requires a pixel ID and a Meta Business Suite account.
2. Create an access token in Events Manager: choose the pixel, open **Settings**, and under **Conversions API** click **Generate access token** beneath "Set up manually". Meta shows the link only to users with developer privileges.

```sh
META_PIXEL_ID=…
META_ACCESS_TOKEN=…
META_SITE_URL=https://example.org/       # sent as the page of an event when the click's landing page is unknown
META_TEST_EVENT_CODE=…                   # optional: routes events to Meta's test tool instead
```

A conversion names a Meta event: `"actions": { "meta": "Lead" }`. Meta rejects an event more than seven days old.

## Microsoft Advertising

Conversions use `ApplyOfflineConversions`, which requires a developer token and an OAuth refresh token.

1. Get a developer token. Microsoft's [get started guide](https://learn.microsoft.com/en-us/advertising/guides/get-started) says to sign in as a Super Admin, choose the user, and click **Request Token**. The current page is <https://ads.microsoft.com/cc/Settings/DevSettings>.
2. Register an application: in Azure App registrations, **New registration**, choose "Any Entra ID Tenant + Personal Microsoft accounts", and copy the **Application (client) ID**. See the [registration steps](https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-register).
3. Grant consent and get a refresh token, with the scope `https://ads.microsoft.com/msads.manage offline_access`. See the [consent steps](https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-consent).
4. Copy the customer ID and account ID from the `cid` and `aid` parameters of the Microsoft Advertising address on the Campaigns tab. Avoid the eight-character account number, as the get started guide notes.
5. Create an offline conversion goal, and turn on auto-tagging of the Microsoft Click ID so ad clicks carry `msclkid`.

```sh
MICROSOFT_CLIENT_ID=…
MICROSOFT_REFRESH_TOKEN=…
MICROSOFT_DEVELOPER_TOKEN=…
MICROSOFT_CUSTOMER_ID=…
MICROSOFT_ACCOUNT_ID=…
MICROSOFT_CLIENT_SECRET=…     # only for a web app registration
```

A conversion names the goal: `"actions": { "microsoft": "Enrolled" }`. Wait two hours after creating a goal before sending to it, as Microsoft advises. Microsoft rejects a conversion more than 90 days old.

## TikTok

Conversions use Events API 2.0, as web events.

1. Create a pixel: in TikTok Ads Manager, **Tools > Events > Connect data source > Web**, add your website, and choose **Manual setup** with **Events API**. See TikTok's [setup guide for web](https://business-api.tiktok.com/portal/docs/setup-guide-for-web/v1.3), which opens only in a browser. Choose version 1.3 in the menu at the top of the page.
2. Create an access token with **Generate access token** in the pixel's **Settings**, per the same guide.
3. Copy the pixel code.

```sh
TIKTOK_PIXEL_CODE=…
TIKTOK_ACCESS_TOKEN=…
TIKTOK_SITE_URL=https://example.org/     # sent as the page of an event when the click's landing page is unknown
```

A conversion names a TikTok event: `"actions": { "tiktok": "CompleteRegistration" }`. The script tag collects the `ttclid` from the landing page address.

## Twilio

Twilio provides two features with one auth token.

**Call reports.** Point the number's call status webhook at `/calls/twilio`. See [the Twilio steps](calls.md#twilio).

**Line checks.** Lookup's line type intelligence identifies a number as a mobile, a landline, or an internet calling app.

1. Copy the **Account SID** and **Auth Token** from the Twilio console's account page.
2. Enable line type intelligence, a paid Lookup package billed per number. Twilio's [line type intelligence page](https://www.twilio.com/docs/lookup/v2-api/line-type-intelligence) says numbers in some countries, including Canada, need approval first.

```sh
TWILIO_ACCOUNT_SID=AC…
TWILIO_AUTH_TOKEN=…
```

## Smarty

Smarty checks a United States postal address and returns its single delivery point.

1. Create an account at <https://www.smarty.com/>. The site advertises a 42-day free trial.
2. Create a secret key on the API keys page, <https://www.smarty.com/account/keys>. It has an id and a token. An embedded key is for browsers and will not work here.

```sh
SMARTY_AUTH_ID=…
SMARTY_AUTH_TOKEN=…
```

The server sends the key in a header. Smarty answers 401 for a wrong key and 402 for an expired subscription. In both cases the address is omitted from the sighting, and its note says the service did not answer.

## Campaign costs

The server reads campaign costs for [the report](report.md) from Google Ads and Meta. Record the costs of other platforms as [`cost` entries](report.md#costs).

**Google Ads.** Costs come from the Google Ads API, version 26, which requires a developer token.

1. Request a developer token in a Google Ads manager account, under **Admin > API Center**. Google's [developer token page](https://developers.google.com/google-ads/api/docs/get-started/dev-token) describes the access levels.
2. Enable the **Google Ads API** in the service account's Google Cloud project.
3. Use the service account and customer id from [Google Ads](#google-ads). Its access covers reading reports.

```sh
GOOGLE_ADS_DEVELOPER_TOKEN=…
```

**Meta.** Costs come from the Insights API of the ad account.

1. Find the ad account's id in Ads Manager: the number after `act=` in the address.
2. Create a system user token with the `ads_read` permission, which reads the account's reports. The Events Manager token used for conversions may lack it.

```sh
META_AD_ACCOUNT_ID=…
META_ADS_TOKEN=…
```

Both platforms also report conversion counts. Set `GOOGLE_ADS_CONVERSIONS=true`, and `META_ADS_CONVERSIONS=` the action's name in Meta's reports. [The report](report.md#platform-reported-conversions) compares them with credited outcomes. See [Google's metrics](https://developers.google.com/google-ads/api/fields/v26/metrics) and [Meta's action statistics](https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats/).

## Limitations

The setup steps come from each provider's pages, read in November 2026.

- The endpoints of Fingerprint, MaxMind, Google (token service, Data Manager, Ads reporting), Meta (conversions and cost reports), Microsoft (Advertising and token service), TikTok, Twilio Lookup and Smarty each rejected an invalid key as this code expects. Live credentials are untested, including for the two cost readers.
- Fingerprint: the pages read do not state the limits of the free plan.
- Fingerprint: the two browser loaders are untested.
- MaxMind: the pages read do not state where the portal shows the account ID.
- Google Ads: the pages read do not state the service account's access level, whether a developer token is needed, or where to find the conversion action id and customer id.
- Meta: the pages read do not state the source of the test event code.
- Microsoft: step 5 is unconfirmed, because both help pages failed to load. Email normalization is undocumented, so the server lowercases and trims.
- Twilio: the pages read do not state the price per lookup.
- Smarty and Twilio: both readers follow the providers' documented answers. Smarty refuses a wrong key the same way however it is sent, so only a real key can show that it accepts the key in a header, as its authentication page states.
- Google costs: the developer token steps and header come from memory of Google's developer token page, unread in November 2026.
- Meta costs: whether every row has `account_currency` is unconfirmed, as is the address of the next page. The server follows `paging.next`.
