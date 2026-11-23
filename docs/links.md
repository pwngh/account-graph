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

> **A link is a key: whoever holds it can use it.** A forwarded link reaches someone else's browser, and the rules below limit what that can join. They do not make it impossible.

| When | What happens |
| --- | --- |
| A person's link is opened in a first, second and third browser | Each is tied to them at 0.92, and joined. |
| It is opened in a fourth | Noted, not tied. A phone, a laptop and a tablet are one person; more is a forwarded link. |
| The browser already belongs to another person of the same kind, by a sign-in or a device cookie | Noted, not tied. `contact:alice`'s link on `contact:bob`'s phone does not join Alice to Bob. |
| Two people's links are opened in one browser that belongs to neither | Both are tied and thin each other to 0.61, so the browser is joined to neither. |

Every opening is written down as a note on the visitor, `opened:contact:42`, or `opened:contact:42 (not tied)`. A reviewer sees who opened what.

What the rules cannot see:

- **A browser with no account yet.** A link forwarded to a stranger's browser is tied to the person the link names. If that stranger later signs up there, the two meet in one cluster until a reviewer keeps them apart.
- **A person of another kind.** `contact:alice`'s link opened in a browser signed in as `account:bob` joins the two at once. The rule above compares like with like, because a contact opening their link where they hold an account is the ordinary case.
 Lower `link` in the policy below 0.9 if that risk outweighs the benefit; the link then relates a browser to its person without joining them.

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

> **A carry token is bound to the browser's user agent and network.** Sent to someone on another network, or with another browser version, it ties nobody. So a stranger cannot attach their ad click to someone's sign-up by handing them a link. Someone on the visitor's own network with the same browser version still can; see the limits below.

The tie is 0.95: enough to join two visitors, not enough to merge two groups on its own. It is filed per receiving site, so one visitor carried to three of your sites is joined on each. One token used by several look-alike browsers on a shared network thins instead: a third holder ends the join, and a fifth ends the tie.

A walk from one of your sites to another is not a new arrival. The first site shows up as the referrer, and a referrer that is one of `ORIGINS` leaves no touch, so the ad click that began the visit keeps the credit.

Subdomains of one site do not need this. `COOKIE=example.org` already gives them one cookie; see [Running the server](operations.md#behind-a-proxy).

## Limits

| Limit | Detail |
| --- | --- |
| Signed, not hidden | A token can be read by whoever holds it. It cannot be changed or made without the secret. |
| Changing `LINK_SECRET` | Every link already sent stops naming its person, and becomes an ordinary link. |
| Carry needs a followed link | A visitor who types the second site's address arrives as a stranger. A confirmed fingerprint or a sign-in still ties them. |
| A changed network | A visitor whose network changes between the two sites, such as leaving wifi, is not carried. |
| A look-alike on the same network | The token is bound to a browser's user agent and network, not to the browser itself. Someone on your visitor's own network, with the same browser version, could hand them a link that ties the two visits. Their lone visitor then joins the other's cluster, and their ad click can be credited with the other's sign-up. The tie cannot merge two groups of accounts by itself, and a reviewer can cut it. |
| Behind a proxy | The network a token is bound to comes from `x-forwarded-for`, so `TRUST_PROXY` must say how many proxies you run. See [Running the server](operations.md#behind-a-proxy). |
| The menu | A link opened from its menu (right-click, long press) is not carried, because the same menu can copy the address. This relies on the browser announcing the menu; whether every phone browser does on a long press was not checked. |
| An old page | A token lasts an hour and is renewed after thirty minutes, and when a tab comes back into view. A link followed while the renewal is still on its way goes without one. |
| In the library | `knownLink(url, subject, { secret })` makes a link; `readToken` checks one. |
