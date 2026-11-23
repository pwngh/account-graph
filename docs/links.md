# Links that name a person, and one visitor across your sites

A link you send to one person can say who they are. When they open it, the browser that opened it is tied to that person, with no sign-in. The same signing keeps a visitor one visitor as they move between your sites.

```sh
curl -X POST https://graph.example.org/link -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"url":"https://example.org/offer","subject":"contact:42"}'
```

```json
{ "url": "https://example.org/offer?ag=Y29udGFjdDo0Mg.tqincp.TtJbaBSLuho3je4xwbXUiw" }
```

Send that address to contact 42 in an email or a text message. Both features need one setting on the server:

```sh
LINK_SECRET=$(openssl rand -hex 32)
```

## A link that names its person

```text
your backend ──▶ POST /link ──▶ address with a signed token
person opens it ──▶ script tag reads the token ──▶ POST /collect
server checks the signature ──▶ this browser and contact:42 share a link identifier
```

The token holds the subject and an expiry, signed with `LINK_SECRET`. The script tag sends it with the visit and then takes it out of the address bar, so it is not bookmarked or shared along with the page.

The tie is strong enough to join the browser to the person: 0.92, where 0.9 joins. From then on, an ad click in that browser, or a sign-up, belongs to someone you already know.

> **A forwarded link reaches the wrong browser.** Three rules keep that from joining the wrong people. The tie is 0.92, not 1. A person's link ties at most three browsers: a phone, a laptop, a tablet. And a browser that already belongs to someone of the same kind, another `contact:` say, is not tied to a second one.

Every opening is still written down as a note on the visitor, `opened:contact:42`, whether or not it ties. A reviewer sees who opened what.

| Setting | Default | Meaning |
| --- | --- | --- |
| `days` in the `/link` body | 30 | How long the link names its person, up to 366. After that it is an ordinary link. |
| `url` | required | Where the link leads: an `http` or `https` address. Other parameters on it are kept. |
| `subject` | required | Who it is for, up to 512 bytes. Anyone holding the link can read this, so use an id, not a name or an email. |

## One visitor across your sites

A browser keeps a separate cookie for each site, so a person who visits two of your sites is two visitors. Tell the script tag which other sites are yours and it carries the visitor across.

```html
<script type="module" src="https://graph.example.org/collect.js?domains=shop.example,help.example"></script>
```

```text
page on example.org ──▶ POST /carry ──▶ a token for this browser, good for an hour
visitor follows a link to shop.example ──▶ the script adds the token to that link
shop.example's script tag ──▶ POST /collect with the token ──▶ the two visitors are joined
```

Put the tag, with its own `domains`, on each site, and list each site in `ORIGINS`. Only links the visitor follows are touched, at the moment they follow them; a link to anywhere else is left alone.

> **A carry token works only in the browser it was made for.** It is bound to that browser's user agent and network. Sent to someone else, it ties nobody, so nobody can attach their own ad click to another person's sign-up by handing them a link.

The tie is 0.95: enough to join two visitors, not enough to merge two groups on its own. It is filed per receiving site, so one visitor carried to three of your sites is joined on each. One token used by several look-alike browsers on a shared network thins instead: a third holder ends the join, and a fifth ends the tie.

Subdomains of one site do not need this. `COOKIE=example.org` already gives them one cookie; see [Running the server](operations.md#behind-a-proxy).

## Limits

| Limit | Detail |
| --- | --- |
| Signed, not hidden | A token can be read by whoever holds it. It cannot be changed or made without the secret. |
| Changing `LINK_SECRET` | Every link already sent stops naming its person, and becomes an ordinary link. |
| Carry needs a followed link | A visitor who types the second site's address arrives as a stranger. A confirmed fingerprint or a sign-in still ties them. |
| A changed network | A visitor whose network changes between the two sites, such as leaving wifi, is not carried. |
| Behind a proxy | The network a token is bound to comes from `x-forwarded-for`, so `TRUST_PROXY` must say how many proxies you run. See [Running the server](operations.md#behind-a-proxy). |
| The menu | A link opened from the right-click menu is not carried, because the same menu can copy the address. |
| An old page | A token lasts an hour and is renewed after thirty minutes, and when a tab comes back into view. A link followed while the renewal is still on its way goes without one. |
| In the library | `knownLink(url, subject, { secret })` makes a link; `readToken` checks one. |
