/**
 * Runs in the browser. Reports this visit to the graph's `/collect` route:
 * a first-party device id, the Google Analytics client id, optional
 * fingerprints, and the ad click, campaign and ad that brought the visitor.
 */

export interface PageRules {
  /** Other site origins to recognize in previous-page referrers. The current page's origin is always included. */
  origins?: readonly string[]
  /** Literal paths, or subtrees ending in /*. With an allow list, a page must match one of its entries. */
  allowPages?: readonly string[]
  /** A refusal wins over an allowance. */
  refusePages?: readonly string[]
}

interface PageOptions extends PageRules {
  /** Wait for an affirmative banner answer before making an identifier or collecting anything. */
  requireConsent?: boolean
  consent?: { adUserData: boolean; adPersonalization: boolean }
  /** A tag manager can withdraw storage permission while the page stays open. */
  storageGranted?: () => boolean
  signal?: AbortSignal
}

export interface CollectOptions extends PageOptions {
  /** The full URL of the `/collect` route. */
  endpoint: string
  /** Page events this tag may send. An empty list suppresses them all. */
  events?: readonly string[]
  /** The event id from `fingerprintEvent`. The server confirms it with Fingerprint. */
  fingerprintEvent?: string | Promise<string | undefined> | ((active: () => boolean) => Promise<string | undefined>)
  /** A hash computed in the browser, such as the one from `openFingerprint`. Nothing confirms it. */
  canvas?: string | Promise<string | undefined> | ((active: () => boolean) => Promise<string | undefined>)
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
  /** The token of a link sent to one person, from the `ag` parameter. The server checks it, and takes it as `link` too. */
  known?: string
  /** The token another of your sites put on the link that led here, from `ag_from`. The server checks it. */
  carried?: string
  /** The mark of a staff browser, from a staff link. The server checks it, and records nothing of a visit that carries a good one. */
  staff?: string
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

export const hasPageRules = (rules: PageRules) => rules.allowPages !== undefined || rules.refusePages !== undefined

// Compare paths as a site that folds case and Unicode might. Refuse ambiguous spellings instead of guessing how a second decoder or router treats them.
function pathName(raw: string): string | undefined {
  if (!raw.startsWith('/') || /[%]2f|[%]5c/i.test(raw)) return undefined
  try {
    const path = decodeURIComponent(raw).normalize('NFKC').toLowerCase()
    if (/[%?#;\\\x00-\x1f\x7f]/.test(path) || path.includes('//') || path.split('/').some(part => part === '.' || part === '..')) return undefined
    return path.replace(/\/$/, '') || '/'
  } catch {
    return undefined
  }
}

export function validPageRules(rules: PageRules): boolean {
  return [rules.allowPages, rules.refusePages].every(list => list === undefined || Array.isArray(list) && list.every(pattern => {
    if (typeof pattern !== 'string') return false
    const base = pattern.endsWith('/*') ? pattern.slice(0, -1) : pattern
    return !base.includes('*') && pathName(base) !== undefined
  }))
}

/** The part of a permitted address that may leave the page. A relative path stays relative. */
export function pageAddress(raw: unknown, rules: PageRules, referrerOf?: readonly unknown[]): string | undefined {
  if (typeof raw !== 'string') return undefined
  const bare = raw.split(/[?#]/, 1)[0]!
  const relative = bare.startsWith('/')
  if (bare.startsWith('//') || !relative && !/^https?:\/\/[^/]+/i.test(bare)) return undefined
  const below = (page: string, base: string, subtree: boolean) => page === base || subtree && (base === '/' || page.startsWith(base + '/'))
  try {
    const url = new URL(bare, 'https://example.org')
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    // Only a previous page can belong to another site. Without a known site origin, check its path too.
    if (!relative && referrerOf) {
      const sites = [...(rules.origins ?? []), ...referrerOf].filter((page): page is string => typeof page === 'string' && URL.canParse(page))
      if (sites.length && sites.every(page => new URL(page).origin !== url.origin)) return url.origin + url.pathname
    }
    if (url.username || url.password || /[\\\x00-\x20\x7f]/.test(bare)) return undefined
    const rawPath = relative ? bare : bare.replace(/^https?:\/\/[^/]+/i, '') || '/'
    const path = pathName(rawPath)
    if (!path || !validPageRules(rules)) return undefined
    // A refusal covers aliases on sites that fold paths. An allowance must also be safe on sites that distinguish every spelling.
    if (rules.refusePages?.some(pattern => {
      const subtree = pattern.endsWith('/*')
      return below(path, pathName(subtree ? pattern.slice(0, -1) : pattern)!, subtree)
    })) return undefined
    if (rules.allowPages && !rules.allowPages.some(pattern => {
      const subtree = pattern.endsWith('/*')
      const literal = subtree ? pattern.slice(0, -2) || '/' : pattern
      return below(url.pathname, new URL(literal, 'https://example.org').pathname, subtree)
    })) return undefined
    return (relative ? '' : url.origin) + url.pathname
  } catch {
    return undefined
  }
}

const bannerAnswer = () => (globalThis as { accountGraphConsent?: PageOptions['consent'] }).accountGraphConsent
const canStop = (options: PageOptions) => hasPageRules(options) || options.requireConsent || options.storageGranted !== undefined
const ready = (options: PageOptions) => !options.signal?.aborted && (!options.storageGranted || options.storageGranted()) && (!options.requireConsent || (bannerAnswer() ?? options.consent)?.adUserData === true) &&
  (!hasPageRules(options) || Boolean(pageAddress(location.href, options)))

const pageOf = (options: PageOptions) => hasPageRules(options) ? { url: pageAddress(location.href, options) } : {}
const guardedFetch = (options: PageOptions): RequestInit => ({
  ...(hasPageRules(options) && { referrerPolicy: 'no-referrer' }),
  ...(options.storageGranted && options.signal && { signal: options.signal }),
})

function cookie(name: string): string | undefined {
  const found = document.cookie.split('; ').find((part) => part.startsWith(`${name}=`))
  if (!found) return undefined
  // A cookie another script wrote may not be written the way this one reads. What it says is then not known.
  try {
    return decodeURIComponent(found.slice(name.length + 1))
  } catch {
    return undefined
  }
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
export function deviceId(): string
export function deviceId(options: PageOptions): string | undefined
export function deviceId(options: PageOptions = {}): string | undefined {
  if (!ready(options)) return undefined
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
export function read(params?: readonly string[]): Collected
export function read(params: readonly string[] | undefined, options: PageOptions): Collected | undefined
export function read(params: readonly string[] = [], options: PageOptions = {}): Collected | undefined {
  if (!ready(options)) return undefined
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
  if (document.referrer) {
    const referrer = hasPageRules(options) ? pageAddress(document.referrer, options, [location.origin]) : document.referrer
    if (referrer && new URL(referrer, url).origin !== location.origin) touch.referrer = referrer
  }
  const arrived = Object.keys(touch).length > 0
  if (arrived) touch.landing = url.origin + url.pathname
  // Meta's id for this browser goes along with an arrival, and is never one by itself.
  const fbp = arrived ? cookie('_fbp') : undefined
  if (fbp) touch.fbp = fbp

  const staff = staffMark()
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
    ...(staff && { staff }),
  }
}

/**
 * The mark of a staff browser, kept in a cookie of this site. A staff link
 * sets it with its `ag_staff` parameter, and `ag_staff=off` on any page
 * removes it. The mark is signed, and only the server can say whether it is
 * good: a browser that makes one up is counted like any other.
 */
function staffMark(): string | undefined {
  const given = new URL(location.href).searchParams.get('ag_staff')
  if (given) document.cookie = `ag_staff=${given === 'off' ? '' : encodeURIComponent(given)}; Max-Age=${given === 'off' ? 0 : 366 * 24 * 60 * 60}; Path=/; SameSite=Lax; Secure`
  return given === 'off' ? undefined : (given ?? cookie('ag_staff'))
}

/** Takes the tokens out of the address bar once they have been read, so they are not bookmarked or passed on. */
function tidy(): void {
  try {
    const url = new URL(location.href)
    const tokens = ['ag', 'ag_from', 'ag_staff'].filter((name) => url.searchParams.has(name))
    if (tokens.length === 0) return
    for (const name of tokens) url.searchParams.delete(name)
    history.replaceState(history.state, '', url.href)
  } catch {}
}

/** Reads the visit and sends it. Call once per page load, after the Google tag if you use one. */
export async function collect(options: CollectOptions): Promise<void> {
  if (!ready(options)) return
  const began = location.href
  // A bundled site can supply a function so even starting the vendor is behind the page and consent checks.
  const guarded = canStop(options)
  const active = () => !guarded || ready(options) && location.href === began
  // A vendor running on the page can read both addresses before the collector strips their query and fragment.
  const canIdentify = () => active() && (!hasPageRules(options) || !/[?#]/.test(location.href) && !/[?#]/.test(document.referrer) &&
    (!document.referrer || Boolean(pageAddress(document.referrer, options, [location.origin]))))
  const resolve = async (value: CollectOptions['canvas']) => {
    try {
      if (!canIdentify()) {
        // A caller may already have started a promise. Ignore its answer even if the vendor fails.
        if (typeof value !== 'function') void Promise.resolve(value).catch(() => undefined)
        return undefined
      }
      const answer = await (typeof value === 'function' ? value(canIdentify) : value)
      return canIdentify() ? answer : undefined
    } catch {
      return undefined
    }
  }
  const [fingerprintEvent, canvas] = await Promise.all([resolve(options.fingerprintEvent), resolve(options.canvas)])
  if (!active()) return
  const visit = read(options.params, options)
  if (!visit) return
  // A visitor who opted out of advertising is still seen, but nothing about ads leaves the page.
  if ((navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true) visit.gpc = true
  const consent = options.requireConsent ? bannerAnswer() ?? options.consent : options.consent
  if (consent) visit.consent = consent
  if (visit.gpc || visit.consent?.adUserData === false) {
    delete visit.touch
    delete visit.ga
  }
  if (typeof visit.touch?.gclid === 'string') remember('ag_click', visit.touch.gclid)
  tidy()
  if (!ready(options)) return
  // The first page of this browser session, for forms to carry along.
  try {
    const kept = sessionStorage.getItem('ag_landing')
    if (hasPageRules(options)) {
      const clean = pageAddress(kept, options) ?? visit.url
      if (clean !== kept) sessionStorage.setItem('ag_landing', clean)
    } else if (!kept) sessionStorage.setItem('ag_landing', location.href)
  } catch {}
  const body = JSON.stringify({
    ...visit,
    ...(fingerprintEvent && { fingerprintEvent }),
    ...(canvas && { canvas }),
  })
  // text/plain keeps the request "simple", so the browser sends it without a preflight.
  await post(options, body)
}

async function post(options: CollectOptions, body: string): Promise<void> {
  // A pending beacon cannot be cancelled when storage consent is withdrawn.
  if (!options.storageGranted && !hasPageRules(options) && navigator.sendBeacon?.(options.endpoint, new Blob([body], { type: 'text/plain' }))) return
  await fetch(options.endpoint, { ...guardedFetch(options), method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } })
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
  if (!ready(options) || options.events && !options.events.includes(name)) return
  const page = new URL(location.href)
  const staff = staffMark()
  // The page can replace its banner answer after the tag has loaded.
  const banner = bannerAnswer()
  const refusal = banner?.adUserData === false ? banner : options.consent?.adUserData === false ? options.consent : undefined
  const body = JSON.stringify({
    kind: 'event',
    ...((navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true && { gpc: true }),
    ...(refusal && { consent: refusal }),
    device: deviceId(),
    event: name,
    url: page.origin + page.pathname,
    ...(detail.id && { id: detail.id }),
    ...(detail.number && { number: detail.number }),
    ...(staff && { staff }),
  })
  await post(options, body)
}

/**
 * Reports events without code on the page. A tap on any `tel:` link is
 * reported as `phone_click`, and on any `sms:` link as `text_click`. An element marked `data-ag-event="name"`
 * reports that name when clicked, or, on a form, when submitted;
 * `data-ag-id` gives the occurrence an id. Returns a function that stops listening.
 */
export function watch(options: CollectOptions): () => void {
  if (!ready(options)) return () => {}
  const report = (name: string | null, detail: EventDetail) => {
    if (name) void event(options, name, detail).catch(() => undefined)
  }
  const idOf = (marked: Element): EventDetail => {
    const id = marked.getAttribute('data-ag-id')
    return id ? { id } : {}
  }
  const clicked = (happened: Event) => {
    if (!ready(options)) return
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
    const message = target?.closest?.('a[href^="sms:"]')
    if (message) {
      const written = message.getAttribute('href')!.slice(4).split(/[?&;]/)[0]!
      let number = written
      try {
        number = decodeURIComponent(written)
      } catch {}
      report('text_click', { number })
    }
    const marked = target?.closest?.('[data-ag-event]')
    if (marked && marked.tagName !== 'FORM') report(marked.getAttribute('data-ag-event'), idOf(marked))
  }
  const submitted = (happened: Event) => {
    if (!ready(options)) return
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
  if (!ready(options)) return () => {}
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
  const decorated = new Map<HTMLAnchorElement, { written: string; marked: string }>()
  let token: { value: string; at: number } | undefined
  let asking = false
  const ask = async () => {
    if (!ready(options) || asking) return
    asking = true
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        body: JSON.stringify({ kind: 'carry', ...pageOf(options), device: deviceId() }),
        headers: { 'content-type': 'text/plain' },
        credentials: 'include',
        ...guardedFetch(options),
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
    if (!ready(options)) return
    const link = (happened.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null | undefined
    if (!link) return
    try {
      const url = new URL(link.href)
      if (!url.searchParams.has('ag_from')) return
      url.searchParams.delete('ag_from')
      link.href = url.href
      decorated.delete(link)
    } catch {}
  }
  const followed = (happened: Event) => {
    if (!ready(options)) return
    if ((happened as MouseEvent).button === 2) return
    const link = (happened.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null | undefined
    if (!link) return
    let url: URL
    try {
      url = new URL(link.href)
    } catch {
      return
    }
    if (hasPageRules(options) && !pageAddress(url.href, options)) return
    if (!domains.has(url.hostname.toLowerCase()) || url.hostname === location.hostname) return
    // A token lasts an hour. Past half of that, ask for the next one; it will be there for the next link.
    if (!token || Date.now() - token.at > 30 * 60_000) void ask()
    if (!token || Date.now() - token.at > 55 * 60_000) return
    const written = decorated.get(link)?.written ?? link.href
    url.searchParams.set('ag_from', token.value)
    if (canStop(options)) decorated.set(link, { written, marked: url.href })
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
    for (const [link, { written, marked }] of decorated) if (link.href === marked) link.href = written
    decorated.clear()
    document.removeEventListener('contextmenu', menu, true)
    document.removeEventListener('visibilitychange', returned)
  }
}


/** Every control a form sends, wherever on the page it is. */
const controls = (form: HTMLFormElement) => Array.from(form.elements ?? []) as HTMLInputElement[]
/** Whether a form's answer is that it is about somebody else: a marked box that is ticked, or a marked choice whose value is `other`. */
const aboutOther = (form: HTMLFormElement): boolean =>
  controls(form).some((each) => each.hasAttribute('data-ag-for-other') && (each.type === 'checkbox' ? each.checked : each.value === 'other' && (each.type !== 'radio' || each.checked)))

/**
 * What a form should carry so whatever receives it can say which visitor
 * filled it in: the device id, and the page this browser session began on.
 * The landing page holds the ad click, so it is left out for a visitor who
 * opted out of advertising. With a form whose answer is that it is about
 * somebody else, the device goes by another name: it is not theirs, and
 * whoever copies `ag_device` must not write it on them.
 */
export function fields(consent?: CollectOptions['consent']): { ag_device: string; ag_landing?: string }
export function fields(consent: CollectOptions['consent'], form: HTMLFormElement | undefined, options?: PageOptions): { ag_device?: string; ag_speaker_device?: string; ag_landing?: string }
export function fields(consent?: CollectOptions['consent'], form?: HTMLFormElement, options: PageOptions = {}): { ag_device?: string; ag_speaker_device?: string; ag_landing?: string } {
  if (!ready(options)) return {}
  const device = form && aboutOther(form) ? { ag_speaker_device: deviceId() } : { ag_device: deviceId() }
  const optedOut = (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true || consent?.adUserData === false
  if (optedOut) return device
  let landing: string | null = null
  try {
    landing = sessionStorage.getItem('ag_landing')
  } catch {}
  if (hasPageRules(options)) {
    const safe = pageAddress(landing ?? location.href, options)
    return safe ? { ...device, ag_landing: safe } : device
  }
  return { ...device, ag_landing: landing ?? location.href }
}

/**
 * Adds those as hidden fields to a form at the moment it is submitted:
 * every form marked `data-ag-fields`, or with `all`, every form that posts.
 * A form that sends its fields in the address is only filled when marked,
 * because the address is seen by more than its receiver. Use it for forms
 * that post to a system the cookie does not reach, such as a hosted form or
 * a CRM. Returns a function that stops.
 */
export function fill(options: PageOptions & { all?: boolean } = {}): () => void {
  if (!ready(options)) return () => {}
  const off = new WeakSet<HTMLInputElement>()
  const restore = new Map<HTMLInputElement, () => void>()
  const keepFields = canStop(options)
  const before = (input: HTMLInputElement) => {
    if (!keepFields || restore.has(input)) return
    const { disabled, value } = input
    restore.set(input, () => Object.assign(input, { value, disabled }))
  }
  const submitted = (happened: Event) => {
    if (!ready(options)) return
    const form = (happened.target as Element | null)?.closest?.('form')
    if (!form) return
    const posts = (form.getAttribute('method') ?? 'get').toLowerCase() === 'post'
    if (!(form.hasAttribute('data-ag-fields') || (options.all && posts))) return
    const filled = fields(options.requireConsent ? bannerAnswer() ?? options.consent : options.consent, form, options)
    // A form filled before the visitor opted out gives up the landing page it was holding.
    const held = form.querySelector('input[name="ag_landing"]') as HTMLInputElement | null
    if (held) before(held)
    if (held && filled.ag_landing === undefined) held.value = ''
    // Nor does it send the device by the name it had before the answer changed. Disabled, a field is not sent at all, and one the page wrote is still there.
    for (const each of controls(form)) {
      if (each.name !== 'ag_device' && each.name !== 'ag_speaker_device') continue
      before(each)
      if (each.name in filled) {
        if (off.delete(each)) each.disabled = false
      } else if (!each.disabled) {
        off.add(each)
        each.value = ''
        each.disabled = true
      }
    }
    for (const [name, value] of Object.entries(filled)) {
      let input = form.querySelector(`input[name="${name}"]`) as HTMLInputElement | null
      if (!input) {
        input = document.createElement('input')
        input.type = 'hidden'
        input.name = name
        form.append(input)
        const added = input
        if (keepFields) restore.set(input, () => added.remove())
      } else before(input)
      input.value = value
    }
  }
  document.addEventListener('submit', submitted, true)
  return () => {
    document.removeEventListener('submit', submitted, true)
    for (const undo of restore.values()) undo()
    restore.clear()
  }
}

/** A text link with this visitor's code at the end of what it fills in. */
export function withCode(href: string, code: string): string {
  const ref = `Ref%20${code}`
  if (!/^sms:/i.test(href) || href.endsWith(ref)) return href
  const body = /([?&;]body=)([^&;]*)/i
  if (body.test(href)) return href.replace(body, (_, name: string, text: string) => `${name}${text ? `${text}%20` : ''}${ref}`)
  return `${href}${href.includes('?') ? '&' : '?&'}body=${ref}`
}

/**
 * Puts this visitor's code in the message a text link fills in, at the moment it is followed, so the text that arrives says
 * whose it is, and shows it in every element marked `data-ag-code`, for a caller to read out. Asks the server for the code
 * when the page has either. Returns a function that stops.
 */
export function texts(options: CollectOptions): () => void {
  if (!ready(options)) return () => {}
  const labels = new Map<Element, string | null>()
  const markedLinks = new Map<Element, () => void>()
  const guarded = canStop(options)
  let code: string | undefined
  let asked = false
  const show = () => {
    if (!ready(options)) return
    for (const marked of Array.from(document.querySelectorAll('[data-ag-code]'))) if (code && marked.textContent !== code) {
      if (guarded && !labels.has(marked)) labels.set(marked, marked.textContent)
      marked.textContent = code
    }
  }
  const ask = async () => {
    if (!ready(options) || asked || !document.querySelector('a[href^="sms:"], [data-ag-code]')) return
    asked = true
    const gpc = (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true
    const staff = staffMark()
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        body: JSON.stringify({ kind: 'text_code', ...pageOf(options), device: deviceId(), ...(gpc && { gpc }), ...(options.consent && { consent: options.consent }), ...(staff && { staff }) }),
        headers: { 'content-type': 'text/plain' },
        credentials: 'include',
        ...guardedFetch(options),
      })
      if (response.status === 200) {
        code = (await response.json()).code
        show()
      }
      // Nothing is given to a visitor who refused. Anything else is worth asking again.
      else if (response.status !== 204) asked = false
    } catch {
      // Without a code the link works as it was written, and the next touch asks again.
      asked = false
    }
  }
  const followed = (happened: Event) => {
    if (!ready(options)) return
    const link = (happened.target as Element | null)?.closest?.('a[href^="sms:"]')
    if (!link) return
    if (!code) return void ask()
    const written = link.getAttribute('href')!
    const marked = withCode(written, code)
    if (marked === written) return
    link.setAttribute('href', marked)
    // The page is put back as it was once the link has been followed.
    const undo = () => {
      if (link.getAttribute('href') === marked) link.setAttribute('href', written)
      markedLinks.delete(link)
    }
    if (guarded) markedLinks.set(link, undo)
    setTimeout(undo, 0)
  }
  const touched = () => {
    if (!ready(options)) return
    // One that came to the page later.
    show()
    void ask()
  }
  void ask()
  document.addEventListener('click', followed, true)
  document.addEventListener('pointerdown', touched, true)
  return () => {
    document.removeEventListener('click', followed, true)
    document.removeEventListener('pointerdown', touched, true)
    for (const undo of markedLinks.values()) undo()
    for (const [label, original] of labels) if (label.textContent === code) label.textContent = original
    labels.clear()
  }
}

/** A number as people write it in North America, or with its country code anywhere else. */
function written(number: string): string {
  const local = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number)
  return local ? `(${local[1]}) ${local[2]}-${local[3]}` : number
}

/**
 * Shows this visitor a number of their own wherever an element is marked
 * `data-ag-pool`, so a call to it is known to be theirs without a tap. A
 * marked link's `tel:` address is changed, and a phone number in the text of
 * a marked element. While the page is in view the number is kept; when it is
 * theirs no more, or there is none to give, the page shows what it was
 * written with. Returns a function that stops and puts that back.
 */
export function pool(options: CollectOptions): () => void {
  if (!ready(options)) return () => {}
  const PHONE = /\+?\(?\d[\d\s().-]{6,}\d/
  let original: (() => void)[] = []
  let until = 0
  let renewing: ReturnType<typeof setTimeout> | undefined
  let ending: ReturnType<typeof setTimeout> | undefined
  let asking = false
  let stopped = false
  let tries = 0
  /** Takes back every change, the last first: a marked element inside another is changed twice. */
  const undo = () => {
    for (const put of original.reverse()) put()
    original = []
  }
  const restore = () => {
    undo()
    until = 0
  }
  const show = (number: string) => {
    undo()
    for (const marked of Array.from(document.querySelectorAll('[data-ag-pool]'))) {
      const href = marked.getAttribute('href')
      if (href?.startsWith('tel:')) {
        marked.setAttribute('href', `tel:${number}`)
        original.push(() => marked.setAttribute('href', href))
      }
      const texts = document.createTreeWalker(marked, NodeFilter.SHOW_TEXT)
      for (let text = texts.nextNode(); text; text = texts.nextNode()) {
        const before = text.nodeValue ?? ''
        if (!PHONE.test(before)) continue
        const node = text
        node.nodeValue = before.replace(PHONE, written(number))
        original.push(() => (node.nodeValue = before))
      }
    }
  }
  const again = (ms: number) => {
    clearTimeout(renewing)
    if (!stopped) renewing = setTimeout(() => void ask(), ms)
  }
  const ask = async () => {
    if (!ready(options) || asking || stopped || document.visibilityState !== 'visible' || !document.querySelector('[data-ag-pool]')) return
    asking = true
    const gpc = (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true
    const staff = staffMark()
    let given: { number: string; lasts: number } | undefined
    // The server counts from before it answered, so the page counts from before it asked: never longer than the server does.
    const began = Date.now()
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        body: JSON.stringify({ kind: 'number', ...pageOf(options), device: deviceId(), ...(gpc && { gpc }), ...(options.consent && { consent: options.consent }), ...(staff && { staff }) }),
        headers: { 'content-type': 'text/plain' },
        credentials: 'include',
        ...guardedFetch(options),
      })
      if (response.status === 200) given = await response.json()
      // Nothing to give: what is shown stands until it runs out, and the next time of asking is soon enough.
    } catch {
    } finally {
      asking = false
    }
    if (stopped || !ready(options)) return
    const left = given ? began + given.lasts - Date.now() : 0
    if (given && left > 0) {
      show(given.number)
      until = began + given.lasts
      clearTimeout(ending)
      ending = setTimeout(restore, left)
    }
    // In the first moments the visit itself may still be on its way, so a visitor who got nothing asks again shortly.
    tries += 1
    again(left > 0 ? Math.min(5 * 60_000, left / 2) : tries < 3 ? 3_000 : 5 * 60_000)
  }
  // Hidden, a page neither renews nor counts on its timers: back in view, it looks at the clock first.
  const seen = () => {
    if (!ready(options)) return
    if (document.visibilityState !== 'visible') return
    if (until && Date.now() >= until) restore()
    void ask()
  }
  document.addEventListener('visibilitychange', seen)
  again(1_000)
  return () => {
    stopped = true
    clearTimeout(renewing)
    clearTimeout(ending)
    document.removeEventListener('visibilitychange', seen)
    restore()
  }
}
