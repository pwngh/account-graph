/**
 * Runs in the browser. Reports this visit to the graph's `/collect` route:
 * a first-party device id, the Google Analytics client id, optional
 * fingerprints, and the ad click or campaign that brought the visitor.
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
}

export interface Collected {
  device: string
  ga?: string
  fingerprintEvent?: string
  canvas?: string
  url: string
  touch?: Record<string, string>
  /** The browser sent its Global Privacy Control signal. */
  gpc?: boolean
  consent?: { adUserData: boolean; adPersonalization: boolean }
}

const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid'] as const
const TAGS = { utm_source: 'source', utm_medium: 'medium', utm_campaign: 'campaign' } as const
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
export function read(): Collected {
  const url = new URL(location.href)
  const touch: Record<string, string> = {}
  for (const name of CLICK_IDS) {
    const value = url.searchParams.get(name)
    if (value) touch[name] = value
  }
  for (const [param, field] of Object.entries(TAGS)) {
    const value = url.searchParams.get(param)
    if (value) touch[field] = value
  }
  // The Google tag keeps the last ad click here; use it when the URL has lost the parameter.
  // `collect` remembers what it sent, so a click kept in the cookie is reported once, not on every page.
  const stored = cookie('_gcl_aw')?.split('.')[2]
  if (!touch.gclid && stored && stored !== remembered('ag_click')) touch.gclid = stored
  if (document.referrer && new URL(document.referrer).origin !== location.origin) touch.referrer = document.referrer
  const arrived = Object.keys(touch).length > 0
  if (arrived) touch.landing = url.origin + url.pathname

  const ga = cookie('_ga')?.split('.').slice(-2).join('.')
  return {
    device: deviceId(),
    url: url.origin + url.pathname,
    ...(ga && { ga }),
    ...(arrived && { touch }),
  }
}

/** Reads the visit and sends it. Call once per page load, after the Google tag if you use one. */
export async function collect(options: CollectOptions): Promise<void> {
  const [fingerprintEvent, canvas] = await Promise.all(
    [options.fingerprintEvent, options.canvas].map((value) => Promise.resolve(value).catch(() => undefined)),
  )
  const visit = read()
  // A visitor who opted out of advertising is still seen, but nothing about ads leaves the page.
  if ((navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true) visit.gpc = true
  if (options.consent) visit.consent = options.consent
  if (visit.gpc || visit.consent?.adUserData === false) {
    delete visit.touch
    delete visit.ga
  }
  if (visit.touch?.gclid) remember('ag_click', visit.touch.gclid)
  const body = JSON.stringify({
    ...visit,
    ...(fingerprintEvent && { fingerprintEvent }),
    ...(canvas && { canvas }),
  })
  // text/plain keeps the request "simple", so the browser sends it without a preflight.
  if (navigator.sendBeacon?.(options.endpoint, new Blob([body], { type: 'text/plain' }))) return
  await fetch(options.endpoint, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } })
}
