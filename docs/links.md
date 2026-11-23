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

> **A forwarded link ties the wrong browser.** That is why the tie is 0.92 and not 1. When two people's links are opened in one browser, each tie drops to 0.61 and the browser is joined to neither; past five people it counts for nothing.

| Setting | Default | Meaning |
| --- | --- | --- |
| `days` in the `/link` body | 30 | How long the link names its person. After that it is an ordinary link. |
| `url` | required | Where the link leads. Other parameters on it are kept. |
| `subject` | required | Who it is for, up to 256 characters. Anyone holding the link can read this, so use an id, not a name or an email. |

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

Subdomains of one site do not need this. `COOKIE=example.org` already gives them one cookie; see [Running the server](operations.md#behind-a-proxy).

## Limits

| Limit | Detail |
| --- | --- |
| Signed, not hidden | A token can be read by whoever holds it. It cannot be changed or made without the secret. |
| Changing `LINK_SECRET` | Every link already sent stops naming its person, and becomes an ordinary link. |
| Carry needs a followed link | A visitor who types the second site's address arrives as a stranger. A confirmed fingerprint or a sign-in still ties them. |
| A changed network | A visitor whose network changes between the two sites, such as leaving wifi, is not carried. |
| An old page | A token lasts an hour and is renewed after thirty minutes. A link followed from a page left open longer may go without one. |
| In the library | `knownLink(url, subject, { secret })` makes a link; `readToken` checks one. |
