# Setting up the providers

Every provider is optional. The server runs without any of them, and each one switches on when its variables are set.

```sh
npm run live-check
```

That command calls each provider's real endpoint. With no keys set it sends an invalid one and prints how the provider refused it, which confirms the address and the request shape. With your keys set, the same variables the server reads, it makes a real call that records nothing and says whether it worked.

| Provider | What it adds | Needed for |
| --- | --- | --- |
| [Fingerprint](#fingerprint) | A visitor id your server confirms | Linking the same browser across your sites |
| [MaxMind](#maxmind) | Whether an address is a home or a crowd | Keeping VPNs, carriers and offices from linking strangers |
| [Google Ads](#google-ads) | Conversions sent to Google | Crediting Google ad clicks |
| [Meta](#meta) | Conversions sent to Meta | Crediting Meta ad clicks |
| [Microsoft Advertising](#microsoft-advertising) | Conversions sent to Microsoft | Crediting Microsoft ad clicks |
| [TikTok](#tiktok) | Conversions sent to TikTok | Crediting TikTok ad clicks |
| [Twilio](#twilio) | Each phone call, and what kind of line a number is | [Tying calls to visitors](calls.md#from-twilio); counting a throwaway number for less |
| [Smarty](#smarty) | A postal address as the one delivery point it names | Seeing that two accounts share an address |
| [Campaign costs](#campaign-costs) | What Google and Meta charged per campaign | [The report](report.md) |

Steps below come from each provider's own pages, read in November 2026. Where a page did not state something, this says so instead of guessing.

## Fingerprint

A paid service that gives each browser a visitor id. The browser gets an event id; your server asks Fingerprint what visitor that event belongs to.

1. Sign up at <https://dashboard.fingerprint.com/signup>. The [quick start guide](https://docs.fingerprint.com/docs/quick-start-guide) walks through it.
2. Copy the public key: dashboard sidebar, **API keys > Public** (<https://dashboard.fingerprint.com/api-keys>).
3. Create a secret key: **API keys > Server API**, then **New secret key** (<https://dashboard.fingerprint.com/api-keys?type=api>).
4. Give the server the secret key, and put the public key on the script tag.

```sh
FINGERPRINT_SECRET=…        # the secret key
FINGERPRINT_REGION=us       # us, eu, or ap: the region the workspace was created in
```

```html
<script type="module" src="https://graph.example.org/collect.js?fingerprint=PUBLIC_KEY"></script>
```

Ad blockers stop requests to Fingerprint's own domain. Fingerprint's answer is to serve it from a subdomain of yours; see [Protecting the JavaScript agent from ad blockers](https://docs.fingerprint.com/docs/protecting-the-javascript-agent-from-adblockers). Then add `&endpoints=https://your-subdomain` to the script tag.

Not stated on the pages read: the limits of the free plan.

## MaxMind

Tells the server who uses an address: a household, or a VPN, data center, phone carrier, campus or office. Only its Insights service returns that.

1. Create an account at <https://www.maxmind.com/en/geolite2/signup>.
2. Buy Insights queries. The [web services page](https://www.maxmind.com/en/geoip-api-web-services) lists it at $0.002 a query with a $20 minimum.
3. Create a license key: account menu, **Manage License Keys**, then **Generate new license key** (<https://www.maxmind.com/en/accounts/current/license-key>). The key is shown once. MaxMind's [own steps](https://support.maxmind.com/hc/en-us/articles/4407111582235-Generate-a-License-Key).
4. Find your account ID in the account portal.

```sh
MAXMIND_ACCOUNT_ID=…
MAXMIND_LICENSE_KEY=…
```

The server keeps each answer for a day, so a returning address costs one query a day.

A free GeoLite account works with `MAXMIND_HOST=geolite.info` and `MAXMIND_SERVICE=city`, but it does not say who uses an address, so it cannot tell a home from a crowd. It is only useful for the country.

Not stated on the pages read: where in the portal the account ID is shown.

## Google Ads

Conversions go through Google's Data Manager API, which replaced the Google Ads API for this in June 2026.

1. Turn on auto-tagging in Google Ads, so ad clicks carry a `gclid`. Google lists this under "Before you begin" in [Set up offline conversions using GCLID](https://support.google.com/google-ads/answer/7012522).
2. Create the conversion action, following that same article: **Goals > Summary > Create conversion action > Conversions offline > Add data source**, pick a connection, choose a category, **Save and continue**, **Agree and finish**. Google says to wait 4 to 6 hours before sending to a new action.
3. Enable the **Data Manager API** in a Google Cloud project, from Google's [set up access](https://developers.google.com/data-manager/api/get-started/set-up-access) page.
4. Create a service account in that project and download its key file.
5. Give the service account access to the Google Ads account. Google's set-up page points to the [service account access steps](https://developers.google.com/google-ads/api/docs/oauth/service-accounts#account_access_setup) for this.

```sh
GOOGLE_ADS_CUSTOMER_ID=123-456-7890            # the account that owns the conversion action
GOOGLE_SERVICE_ACCOUNT_FILE=/secrets/key.json
GOOGLE_ADS_LOGIN_CUSTOMER_ID=…                 # only when the service account belongs to a manager account
```

An outcome names the conversion action by its id: `action: { google: '987654321' }`.

Not stated on the pages read: which access level the service account needs, whether a developer token is needed, and where the conversion action id and customer id are shown.

## Meta

Conversions go through the Conversions API.

1. Have a Meta pixel. Meta's [get started page](https://developers.facebook.com/docs/marketing-api/conversions-api/get-started) says you need a pixel ID and a Meta Business Suite account.
2. Create an access token in Events Manager: choose the pixel, open **Settings**, and under **Conversions API** click **Generate access token** beneath "Set up manually". Meta notes the link only shows for users with developer privileges.

```sh
META_PIXEL_ID=…
META_ACCESS_TOKEN=…
META_SITE_URL=https://example.org/       # sent as the page of an event when the click's landing page is unknown
META_TEST_EVENT_CODE=…                   # optional: routes events to Meta's test tool instead
```

An outcome names a Meta event: `action: { meta: 'Lead' }`. Meta refuses an event more than seven days old.

Not stated on the pages read: where the test event code comes from.

## Microsoft Advertising

Conversions go through `ApplyOfflineConversions`. This one has the most steps, because it needs a developer token and an OAuth refresh token.

1. Get a developer token. Microsoft's [get started guide](https://learn.microsoft.com/en-us/advertising/guides/get-started) says to sign in as a Super Admin, choose the user, and click **Request Token**. It names <https://ads.microsoft.com/cc/Settings/DevSettings> as the current place to do it.
2. Register an application: in Azure App registrations, **New registration**, choose "Any Entra ID Tenant + Personal Microsoft accounts", and copy the **Application (client) ID**. Microsoft's [registration steps](https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-register).
3. Grant consent and get a refresh token, with the scope `https://ads.microsoft.com/msads.manage offline_access`. Microsoft's [consent steps](https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-consent).
4. Read the customer ID and account ID from the Microsoft Advertising web address: the `cid` and `aid` parameters on the Campaigns tab. The get started guide says not to use the eight-character account number.
5. Create an offline conversion goal, and turn on auto-tagging of the Microsoft Click ID so ad clicks carry `msclkid`.

```sh
MICROSOFT_CLIENT_ID=…
MICROSOFT_REFRESH_TOKEN=…
MICROSOFT_DEVELOPER_TOKEN=…
MICROSOFT_CUSTOMER_ID=…
MICROSOFT_ACCOUNT_ID=…
MICROSOFT_CLIENT_SECRET=…     # only for a web app registration
```

An outcome names the goal: `action: { microsoft: 'Enrolled' }`. Microsoft says to wait two hours after creating a goal before sending to it, and refuses a conversion more than 90 days old.

Not confirmed: the steps for step 5. Both Microsoft help pages for it failed to load. Microsoft also does not document how to normalize an email before hashing it; this lowercases and trims.

## TikTok

Conversions go through Events API 2.0, as web events.

1. Create a pixel: in TikTok Ads Manager, **Tools > Events > Connect data source > Web**, add your website, and choose **Manual setup** with **Events API**. TikTok's [setup guide for web](https://business-api.tiktok.com/portal/docs/setup-guide-for-web/v1.3).
2. Create an access token: the same guide says you can **Generate access token** from the pixel's **Settings**.
3. Note the pixel code.

```sh
TIKTOK_PIXEL_CODE=…
TIKTOK_ACCESS_TOKEN=…
TIKTOK_SITE_URL=https://example.org/     # sent as the page of an event when the click's landing page is unknown
```

An outcome names a TikTok event: `action: { tiktok: 'CompleteRegistration' }`. The script tag collects the `ttclid` from the landing page address.

TikTok's reference opens only in a browser, and only after choosing version 1.3 from the version menu at the top of the page.

## Twilio

Twilio does two separate things here, with one auth token.

**Call reports.** [Page events and phone calls](calls.md#from-twilio) has the steps: point the number's call status webhook at `/calls/twilio`.

**Line checks.** Lookup's line type intelligence says whether a number is a mobile, a landline, or a number from an internet calling app.

1. Copy the **Account SID** and **Auth Token** from the Twilio console's account page.
2. Line type intelligence is a paid Lookup package, billed per number looked up. Twilio's [line type intelligence page](https://www.twilio.com/docs/lookup/v2-api/line-type-intelligence) describes it, and says numbers in some countries, Canada among them, need approval first.

```sh
TWILIO_ACCOUNT_SID=AC…
TWILIO_AUTH_TOKEN=…
```

Not stated on the pages read: the price per lookup.

## Smarty

Checks a United States postal address and returns the one delivery point it names.

1. Create an account at <https://www.smarty.com/>. The site advertises a 42-day free trial.
2. Create a secret key on the API keys page, <https://www.smarty.com/account/keys>. It has an id and a token. An embedded key, the other kind, is for browsers and will not work here.

```sh
SMARTY_AUTH_ID=…
SMARTY_AUTH_TOKEN=…
```

The server sends the key in a header, never in the address. Smarty answers 401 for a wrong key and 402 when the subscription has run out; either is logged and the address is left out of the sighting.

## Campaign costs

The report needs what each campaign cost. The server reads it from Google Ads and Meta; other platforms go through `POST /costs`.

**Google Ads.** Costs come from the Google Ads API, version 26, which needs one thing the conversion upload does not: a developer token.

1. Request a developer token in a Google Ads manager account, under **Admin > API Center**. Google's [developer token page](https://developers.google.com/google-ads/api/docs/get-started/dev-token) describes the access levels.
2. Enable the **Google Ads API** in the same Google Cloud project as the service account.
3. Use the same service account and customer id as [Google Ads](#google-ads) above. Its access to the account covers reading reports.

```sh
GOOGLE_ADS_DEVELOPER_TOKEN=…
```

**Meta.** Costs come from the Insights API of the ad account.

1. Find the ad account's id in Ads Manager. It is the number after `act=` in the address.
2. Create a token that may read the account's reports: a system user token with the `ads_read` permission. The token from Events Manager used for conversions may not have it.

```sh
META_AD_ACCOUNT_ID=…
META_ADS_TOKEN=…
```

Both can also say how many conversions they count, with `GOOGLE_ADS_CONVERSIONS=true` and `META_ADS_CONVERSIONS=` the name Meta's reports give the action. [The report](report.md#what-a-platform-says-it-brought) sets that beside what is credited here. The fields are in [Google's metrics](https://developers.google.com/google-ads/api/fields/v26/metrics) and [Meta's action statistics](https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats/).

Not stated on the pages read: the developer token steps and header, which are from Google's developer token page as remembered, not read this month; whether `account_currency` comes back on every Meta row; and the address of the next page of Meta results, which this follows from `paging.next`.

## What has and has not been checked

Each provider's real endpoint has answered an invalid key the way this code expects. No call has been made with real keys, so the first `npm run live-check` with yours is the first real one. The two cost readers are checked there too.
