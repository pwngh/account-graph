# Signed links

A signed link identifies the person it was sent to. Opening it links their browser to them without a sign-in. The same signing carries one visitor across your sites.

```sh
curl -X POST https://graph.example.org/link -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"url":"https://example.org/offer","subject":"contact:42"}'
```

```json
{ "url": "https://example.org/offer?ag=Y29udGFjdDo0Mg…", "id": "4c1f…" }
```

Send that address to contact 42 by email or text message. Both features need one setting on the server:

```sh
LINK_SECRET=$(openssl rand -hex 32)
```

## Personal links

```text
your backend ──▶ POST /link ──▶ address with a signed token
person opens it ──▶ script tag reads the token ──▶ POST /collect
server checks the signature ──▶ this browser and contact:42 share a link identifier
```

The token holds the subject and an expiry, signed with `LINK_SECRET`. The script tag sends it with the visit, then removes it from the address bar so it is not bookmarked or shared with the page.

The shared identifier scores 0.92, above the 0.9 that joins. Later ad clicks and sign-ups in that browser then belong to a known person.

> **Anyone who holds a link can use it.** A forwarded link reaches another person's browser. These rules limit what that can join, without preventing it.

| When | What happens |
| --- | --- |
| A person's link is opened in a first, second and third browser | Each is linked to them at 0.92, and joined |
| It is opened in a fourth | Recorded without linking. More than a phone, a laptop and a tablet suggests a forwarded link. |
| The browser already belongs to another person of the same kind, by a sign-in or a device cookie | Recorded without linking: `contact:alice`'s link on `contact:bob`'s phone does not join them |
| Two people's links are opened in one browser that belongs to neither | Both are linked, and their scores drop to 0.61, so the browser is joined to neither |

Each opening is a note on the visitor for reviewers: `opened:contact:42`, or `opened:contact:42 (not tied)`.

### What became of a link

Say what a link is for with `purpose`, a short word of your own: `form`, `documents`, `payment`. `GET /sent?subject=contact:42` lists the links made for the person, and their [journey](http.md) has them.

```json
[{ "id": "4c1f…", "subject": "contact:42", "purpose": "payment", "at": 1795460000000, "expires": 1798052000000, "opened": 1795460060000, "openings": 1 }]
```

Each link made is one row, with an id of its own, even for the same purpose. `opened` is the first opening, by whoever had the link. A link opened and not followed by its step, such as a payment, is one to ask about. Where a link leads is not kept. Once its person is deleted, a link names nobody.

| Setting | Default | Meaning |
| --- | --- | --- |
| `days` in the `/link` body | 30 | How long the link identifies its person, up to 366. It is then an ordinary link. |
| `url` | required | An `http` or `https` address. Its other parameters are kept. |
| `purpose` | none | What it is for, up to 64 letters, digits, dots, dashes and underscores. |
| `subject` | required | Who it is for, up to 512 bytes. Anyone holding the link can read it, so use an id. Avoid names and emails. |

## Cross-site visitors

Browsers keep a separate cookie for each site, so one person on two of your sites is two visitors. List your other sites on the script tag to carry the visitor across.

```html
<script type="module" src="https://graph.example.org/collect.js?domains=shop.example,help.example"></script>
```

```text
page on example.org ──▶ POST /carry ──▶ a token for this browser, good for an hour
visitor follows a link to shop.example ──▶ the script adds the token to that link
shop.example's script tag ──▶ POST /collect with the token ──▶ the two visitors are joined
```

Put the tag, with its own `domains`, on each site, and list each site in `ORIGINS`. The script changes a link to a listed site at the moment it is followed, and leaves other links alone.

> **A carry token is bound to the browser's user agent and network.** It has no effect on another network or browser version, which stops a stranger from attaching their ad click to a sign-up by handing over a link. [Limitations](#limitations) covers look-alike browsers on one network.

A carried visitor is linked at 0.95, which joins two visitors and cannot merge two groups on its own. It is recorded per receiving site, so one visitor carried to three sites is joined on each. When look-alike browsers on a shared network use one token, a third holder ends the join and a fifth ends the link.

A referrer listed in `ORIGINS` records no new visit, so the original ad click keeps the credit. Subdomains of one site can share a cookie instead with `COOKIE=example.org`; see [Operations](operations.md#behind-a-proxy).

## Limitations

| Area | Detail |
| --- | --- |
| Browser without an account | A forwarded link links a stranger's browser to the person it identifies. If the stranger later signs up there, the two share a cluster until a reviewer separates them. |
| Person of another kind | `contact:alice`'s link in a browser signed in as `account:bob` joins the two, because only subjects of the same kind are compared. Lower `link` in the policy below 0.9 to relate a browser to its person without joining. |
| Token contents | Anyone holding a token can read it. Changing or making one needs the secret. |
| Changing `LINK_SECRET` | Links already sent become ordinary links. |
| Typed addresses | A visitor who types the second site's address is not carried. A confirmed fingerprint or a sign-in still links them. |
| Changed network | A visitor whose network changes between the sites, such as on leaving wifi, is not carried. |
| Look-alike browser | Someone on your visitor's network with the same browser version could hand them a link that joins the two visits. That lone visitor joins the other's cluster, and their ad click can be credited with the other's sign-up. The link cannot merge two groups of accounts by itself, and a reviewer can separate them. |
| Proxies | The network comes from `x-forwarded-for`, so `TRUST_PROXY` must state how many proxies you run. See [Operations](operations.md#behind-a-proxy). |
| Link menu | A link opened from its menu (right-click, long press) is not carried, because the menu can also copy the address. This relies on the browser announcing the menu, which was not checked for long press on every phone browser. |
| Old pages | A token lasts an hour. It is renewed after thirty minutes, or when a tab returns to view. A link followed during renewal has none. |
| Library | `knownLink(url, subject, { secret })` makes a link; `readToken` checks one. |
