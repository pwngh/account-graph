/**
 * Runs in the browser. Reports this visit to the graph's `/collect` route:
 * a first-party device id, the Google Analytics client id, optional
 * fingerprints, and the ad click, campaign and ad that brought the visitor.
 */

export interface CollectOptions {
  /** The full URL of the `/collect` route. */
  endpoint: string
  /** The event id from `fingerprintEvent`. The server confirms it with Fingerprint. */
  fingerprintEvent?: string | Promise<string | undefined>
  /** A hash computed in the browser, such as the one from `openFingerprint`. Nothing confirms it. */
  canvas?: string | Promise<string | undefined>
  /** What the visitor answered in your consent banner. Leave it out if they have not answered. */
  consent?: { adUserData: boolean; adPersonalization: boolean }
  /** Names of your own address parameters to keep with the arrival, such as `mailing` or `placement`. */
  params?: readonly string[]
  /** Your other sites, by host name. A link to one carries this visitor along, so they stay one visitor there. */
  domains?: readonly string[]
}

export interface Collected {
  device: string
  ga?: string
  fingerprintEvent?: string
  canvas?: string
  url: string
  touch?: Arrival
  /** The token of a link sent to one person, from the `ag` parameter. The server checks it. */
  known?: string
  /** The token another of your sites put on the link that led here, from `ag_from`. The server checks it. */
  carried?: string
  /** The browser sent its Global Privacy Control signal. */
  gpc?: boolean
  consent?: { adUserData: boolean; adPersonalization: boolean }
}

/** What an arrival carried: click ids and tags by name, and under `custom` the parameters of your own. */
export type Arrival = { [field: string]: string | Record<string, string> | undefined; custom?: Record<string, string> }

const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid'] as const
// Address parameters and the touch field each fills. The first one present wins a field.
const TAGS = [
  ['utm_source', 'source'],
  ['utm_medium', 'medium'],
  ['utm_campaign', 'campaign'],
  ['utm_term', 'term'],
  ['utm_content', 'content'],
  ['utm_id', 'campaignId'],
  ['campaignid', 'campaignId'],
  ['adgroupid', 'adGroupId'],
  ['adid', 'adId'],
  ['creative', 'adId'],
] as const
const YEAR = 365 * 24 * 60 * 60

function cookie(name: string): string | undefined {
  const found = document.cookie.split('; ').find((part) => part.startsWith(`${name}=`))
  return found ? decodeURIComponent(found.slice(name.length + 1)) : undefined
}

function remembered(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

/** The id this browser keeps for this site. Set as a cookie too, so your server can read it at sign-up. */
export function deviceId(): string {
  let id = cookie('ag_device')
  try {
    id ??= localStorage.getItem('ag_device') ?? undefined
    id ??= crypto.randomUUID()
    localStorage.setItem('ag_device', id)
  } catch {
    id ??= crypto.randomUUID()
  }
  document.cookie = `ag_device=${id}; Max-Age=${YEAR}; Path=/; SameSite=Lax; Secure`
  return id
}

/** Reads what this page view can tell the graph. Sends nothing. */
export function read(params: readonly string[] = []): Collected {
  const url = new URL(location.href)
  const touch: Arrival = {}
  for (const name of CLICK_IDS) {
    const value = url.searchParams.get(name)
    if (value) touch[name] = value
  }
  for (const [param, field] of TAGS) {
    const value = url.searchParams.get(param)
    if (value && !touch[field]) touch[field] = value
  }
  const custom: Record<string, string> = {}
  for (const name of params) {
    const value = url.searchParams.get(name)
    if (value) custom[name] = value
  }
  if (Object.keys(custom).length > 0) touch.custom = custom
  // The Google tag keeps the last ad click here; use it when the URL has lost the parameter.
  // `collect` remembers what it sent, so a click kept in the cookie is reported once, not on every page.
  const stored = cookie('_gcl_aw')?.split('.')[2]
  if (!touch.gclid && stored && stored !== remembered('ag_click')) touch.gclid = stored
  if (document.referrer && new URL(document.referrer).origin !== location.origin) touch.referrer = document.referrer
  const arrived = Object.keys(touch).length > 0
  if (arrived) touch.landing = url.origin + url.pathname

  const ga = cookie('_ga')?.split('.').slice(-2).join('.')
  const known = url.searchParams.get('ag')
  const carried = url.searchParams.get('ag_from')
  return {
    device: deviceId(),
    url: url.origin + url.pathname,
    ...(ga && { ga }),
    ...(arrived && { touch }),
    ...(known && { known }),
    ...(carried && { carried }),
  }
}

/** Takes the two tokens out of the address bar once they have been read, so they are not bookmarked or passed on. */
function tidy(): void {
  try {
    const url = new URL(location.href)
    if (!url.searchParams.has('ag') && !url.searchParams.has('ag_from')) return
    url.searchParams.delete('ag')
    url.searchParams.delete('ag_from')
    history.replaceState(history.state, '', url.href)
  } catch {}
}

/** Reads the visit and sends it. Call once per page load, after the Google tag if you use one. */
export async function collect(options: CollectOptions): Promise<void> {
  const [fingerprintEvent, canvas] = await Promise.all(
    [options.fingerprintEvent, options.canvas].map((value) => Promise.resolve(value).catch(() => undefined)),
  )
  const visit = read(options.params)
  // A visitor who opted out of advertising is still seen, but nothing about ads leaves the page.
  if ((navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true) visit.gpc = true
  if (options.consent) visit.consent = options.consent
  if (visit.gpc || visit.consent?.adUserData === false) {
    delete visit.touch
    delete visit.ga
  }
  if (typeof visit.touch?.gclid === 'string') remember('ag_click', visit.touch.gclid)
  tidy()
  // The first page of this browser session, for forms to carry along.
  try {
    if (!sessionStorage.getItem('ag_landing')) sessionStorage.setItem('ag_landing', location.href)
  } catch {}
  const body = JSON.stringify({
    ...visit,
    ...(fingerprintEvent && { fingerprintEvent }),
    ...(canvas && { canvas }),
  })
  // text/plain keeps the request "simple", so the browser sends it without a preflight.
  await post(options.endpoint, body)
}

async function post(endpoint: string, body: string): Promise<void> {
  if (navigator.sendBeacon?.(endpoint, new Blob([body], { type: 'text/plain' }))) return
  await fetch(endpoint, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } })
}

export interface EventDetail {
  /** Your id for this occurrence. Without one, an event counts once a day per browser. */
  id?: string
  /** For a tap on a phone link: the number, so a call that follows can be tied to this visitor. */
  number?: string
}

/**
 * Reports something the visitor did on the page: sent an inquiry, tapped
 * the phone number. The server keeps only the names it was told to accept.
 */
export async function event(options: CollectOptions, name: string, detail: EventDetail = {}): Promise<void> {
  const page = new URL(location.href)
  const body = JSON.stringify({
    device: deviceId(),
    event: name,
    url: page.origin + page.pathname,
    ...(detail.id && { id: detail.id }),
    ...(detail.number && { number: detail.number }),
  })
  await post(new URL('event', options.endpoint).href, body)
}

/**
 * Reports events without code on the page. A tap on any `tel:` link is
 * reported as `phone_click`. An element marked `data-ag-event="name"`
 * reports that name when clicked, or, on a form, when submitted;
 * `data-ag-id` gives the occurrence an id. Returns a function that stops listening.
 */
export function watch(options: CollectOptions): () => void {
  const report = (name: string | null, detail: EventDetail) => {
    if (name) void event(options, name, detail).catch(() => undefined)
  }
  const idOf = (marked: Element): EventDetail => {
    const id = marked.getAttribute('data-ag-id')
    return id ? { id } : {}
  }
  const clicked = (happened: Event) => {
    const target = happened.target as Element | null
    const phone = target?.closest?.('a[href^="tel:"]')
    if (phone) {
      const written = phone.getAttribute('href')!.slice(4)
      let number = written
      try {
        number = decodeURIComponent(written)
      } catch {}
      report('phone_click', { number })
    }
    const marked = target?.closest?.('[data-ag-event]')
    if (marked && marked.tagName !== 'FORM') report(marked.getAttribute('data-ag-event'), idOf(marked))
  }
  const submitted = (happened: Event) => {
    const form = (happened.target as Element | null)?.closest?.('form[data-ag-event]')
    if (form) report(form.getAttribute('data-ag-event'), idOf(form))
  }
  document.addEventListener('click', clicked, true)
  document.addEventListener('submit', submitted, true)
  return () => {
    document.removeEventListener('click', clicked, true)
    document.removeEventListener('submit', submitted, true)
  }
}


/**
 * Keeps a visitor the same visitor across your sites. Asks the server for a
 * short-lived token for this browser, and adds it to links that lead to one
 * of `domains` at the moment they are followed. The site that receives it
 * hands it to its own script tag. Returns a function that stops.
 */
export function carry(options: CollectOptions): () => void {
  // Written the way a link's host reads back: trimmed, lowercase, and a name in another script in its ASCII form.
  const domains = new Set(
    (options.domains ?? []).flatMap((host) => {
      try {
        return [new URL(`http://${host.trim()}`).hostname]
      } catch {
        return []
      }
    }),
  )
  let token: { value: string; at: number } | undefined
  let asking = false
  const ask = async () => {
    if (asking) return
    asking = true
    try {
      const response = await fetch(new URL('carry', options.endpoint).href, {
        method: 'POST',
        body: JSON.stringify({ device: deviceId() }),
        headers: { 'content-type': 'text/plain' },
        credentials: 'include',
      })
      if (response.ok) token = { value: (await response.json()).token, at: Date.now() }
    } catch {
    } finally {
      asking = false
    }
  }
  // A link's menu can copy its address, and a copied address must not carry a token. The menu opens by the right
  // button, by a long press, or by a key held with a click, so the token is taken off again whenever a menu opens.
  const menu = (happened: Event) => {
    const link = (happened.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null | undefined
    if (!link) return
    try {
      const url = new URL(link.href)
      if (!url.searchParams.has('ag_from')) return
      url.searchParams.delete('ag_from')
      link.href = url.href
    } catch {}
  }
  const followed = (happened: Event) => {
    if ((happened as MouseEvent).button === 2) return
    const link = (happened.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null | undefined
    if (!link) return
    let url: URL
    try {
      url = new URL(link.href)
    } catch {
      return
    }
    if (!domains.has(url.hostname.toLowerCase()) || url.hostname === location.hostname) return
    // A token lasts an hour. Past half of that, ask for the next one; it will be there for the next link.
    if (!token || Date.now() - token.at > 30 * 60_000) void ask()
    if (!token || Date.now() - token.at > 55 * 60_000) return
    url.searchParams.set('ag_from', token.value)
    link.href = url.href
  }
  if (domains.size === 0) return () => {}
  void ask()
  // A tab that comes back into view after a long while gets a fresh token before anyone clicks.
  const returned = () => {
    if (document.visibilityState === 'visible' && (!token || Date.now() - token.at > 30 * 60_000)) void ask()
  }
  // Pressing comes before following a link, whether by a click or by the middle button.
  for (const name of ['pointerdown', 'click']) document.addEventListener(name, followed, true)
  document.addEventListener('contextmenu', menu, true)
  document.addEventListener('visibilitychange', returned)
  return () => {
    for (const name of ['pointerdown', 'click']) document.removeEventListener(name, followed, true)
    document.removeEventListener('contextmenu', menu, true)
    document.removeEventListener('visibilitychange', returned)
  }
}


/**
 * What a form should carry so whatever receives it can say which visitor
 * filled it in: the device id, and the page this browser session began on.
 * The landing page holds the ad click, so it is left out for a visitor who
 * opted out of advertising.
 */
export function fields(consent?: CollectOptions['consent']): { ag_device: string; ag_landing?: string } {
  const optedOut = (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true || consent?.adUserData === false
  if (optedOut) return { ag_device: deviceId() }
  let landing: string | null = null
  try {
    landing = sessionStorage.getItem('ag_landing')
  } catch {}
  return { ag_device: deviceId(), ag_landing: landing ?? location.href }
}

/**
 * Adds those as hidden fields to a form at the moment it is submitted:
 * every form marked `data-ag-fields`, or with `all`, every form that posts.
 * A form that sends its fields in the address is only filled when marked,
 * because the address is seen by more than its receiver. Use it for forms
 * that post to a system the cookie does not reach, such as a hosted form or
 * a CRM. Returns a function that stops.
 */
export function fill(options: { all?: boolean; consent?: CollectOptions['consent'] } = {}): () => void {
  const submitted = (happened: Event) => {
    const form = (happened.target as Element | null)?.closest?.('form')
    if (!form) return
    const posts = (form.getAttribute('method') ?? 'get').toLowerCase() === 'post'
    if (!(form.hasAttribute('data-ag-fields') || (options.all && posts))) return
    for (const [name, value] of Object.entries(fields(options.consent))) {
      let input = form.querySelector(`input[name="${name}"]`) as HTMLInputElement | null
      if (!input) {
        input = document.createElement('input')
        input.type = 'hidden'
        input.name = name
        form.append(input)
      }
      input.value = value
    }
  }
  document.addEventListener('submit', submitted, true)
  return () => document.removeEventListener('submit', submitted, true)
}
