# Install the browser tag with Tag Manager

A site with a Tag Manager web container can load the collector from its own graph without adding a script to the site. Use one instance of the tag per page. Later firings reuse the first download and its settings. If the site already loads the graph through a script or another container, remove that installation when switching.

## Import the template

1. In the web container, open **Templates → Tag Templates → New**. In the template editor's menu, choose **Import** and select [account-graph.tpl](../examples/gtm/account-graph.tpl).
2. Open **Permissions → Injects scripts**. Replace the example origin in `https://graph.example.org/collect.js?gtm=1&*` with the graph's HTTPS origin. Keep the path and query pattern. The tag can read two storage consent types and call `accountGraph.setStorageGranted` on the page. It needs no other permissions.
3. Save the template. Under **Tags → New → Tag Configuration**, select **Account Graph browser tag**. Enter the same origin in **Graph address**, for example `https://graph.example.org`. Use a lowercase host and omit the default port 443. Changing this field alone cannot authorize a new host.
4. On the graph, include the site's origin in `ORIGINS`. If the site has a content security policy, allow the graph under `script-src` and `connect-src`. Use a graph version that serves `collect.js?gtm=1`.

## Choose what to collect

| Field | What to enter |
| --- | --- |
| Forms to fill | The default fills forms marked `data-ag-fields` on submit. Choose **Marked forms and every POST form** to include unmarked POST forms. Unmarked GET forms keep their original fields. |
| Allowed pages | Leave blank for all paths or enter a comma-separated list such as `/pricing,/help/*`. A literal matches its exact path. The subtree includes `/help` and its descendants. |
| Refused pages | Enter private paths such as `/account/*,/help/private/*`. Refusal wins over allowance. When either server list is configured, the collector uses the server's pair of lists. Set `ALLOW_PAGES` and `REFUSE_PAGES` there to protect other callers too. |
| Also require the graph banner's ad user data consent | Select this when the site's banner supplies `window.accountGraphConsent` and collection must wait for an affirmative answer. |
| Events to send | Enter names from the graph's `EVENTS` setting. For example, `phone_click,text_click,inquiry` reports taps on existing `tel:` and `sms:` links and an existing `data-ag-event="inquiry"` click or form submission. The list also applies to `accountGraph.event()`. Leave blank for visits without page events. |
| Add the visitor's code to text links | Enable this and set `TEXT_CODES=true` on the graph to add a code to an existing `sms:` link when followed. A `data-ag-code` element also displays the code. Text tap reporting is controlled independently by `text_click`. |

## Set the triggers and consent defaults

Choose **All Pages** as the firing trigger. To keep the script download off private pages, add a blocking trigger under **Exceptions**. For example, choose **Custom Event**, match the event name `.*` with **Use regex matching**, then choose **Some Custom Events** where **Page Path** matches the case-insensitive regular expression `^/(account|help/private)(/|$)`. This covers the two refused subtrees above on page views and later banner events. Match the paths and aliases your site actually serves. A site with a short list of public pages can restrict the firing triggers to those paths instead. The collector also checks its page lists when an application changes paths without reloading. The page's referrer policy controls what the script download itself discloses. [Page rules](privacy.md#pages-a-site-may-record)

Configure the consent banner to set defaults for both `ad_storage` and `analytics_storage` at **Consent Initialization**, before the tag fires. Use denied defaults when an answer is required. Tag Manager treats an unset storage type as granted. Keep consent checks enabled for the tag.

When either storage type is denied at firing, the template completes without downloading the collector. To start after a visitor grants consent on the same page, add a **Custom Event** firing trigger for the event your banner emits **after** updating Consent Mode. Keep the page exceptions on this trigger too and use **Once per event**. Once loaded, the tag listens for storage changes. Withdrawal of either grant stops collection on that page. Restoring both lets collection resume.

Storage grants do not supply the graph's advertising consent answer. With the additional graph consent box checked, the script may download after both storage grants, but it creates no identifier and sends nothing until `window.accountGraphConsent.adUserData` is true. The banner must update its graph answer and call `accountGraph.refresh()` after changes. Leave the box unchecked to use the collector's usual advertising consent and Global Privacy Control handling. [Consent and page collection](privacy.md#pages-a-site-may-record)

## Check in Preview

1. Use **Preview** with a fresh browser session on an allowed page. Check both storage types on the event's **Consent** tab. With either denied, the tag may show success, but the browser's Network panel should show neither a collector download nor a post to the graph.
2. Grant both and fire the banner event or reload. Look for one `/collect.js?gtm=1&…` from the approved graph, followed by a `POST /collect` when the graph's consent condition is met. Check that the request URL carries the chosen options. A script permission mismatch fails the firing. A 403 on the post calls for checking `ORIGINS`.
3. Tap a phone link with a synthetic number such as `202-555-0104`. With `phone_click` selected and accepted by the server, the post carries `kind: "event"` and `event: "phone_click"`. Withdraw one storage grant and repeat. There should be no new post. Open a refused page directly and confirm that its exception blocks the script download. Publish the container after these checks.

The browser can add a device field to a form. Recording a submitted profile or conversion still takes the site's own backend integration, or a WordPress integration file installed on the server. Keep service credentials on that server. [Hosted forms](identify.md#hosted-forms)
