import { pageAddress } from './collect.ts'
import type { PageRules } from './collect.ts'
import { filterRecord } from './tokens.ts'

/** The HTTP referrer describes the page making the request. The referrer inside a touch describes the previous page. */
export function browserPage(body: any, rules: PageRules, referer: string | undefined): boolean {
  if (!pageAddress(body.url, rules) || referer && !pageAddress(referer, rules)) return false
  if (body.touch?.landing !== undefined) {
    const landing = pageAddress(body.touch.landing, rules)
    if (!landing) return false
    body.touch.landing = landing
  }
  if (body.touch?.referrer !== undefined) {
    const referrer = pageAddress(body.touch.referrer, rules)
    if (referrer) body.touch.referrer = referrer
    else delete body.touch.referrer
  }
  return true
}

export function recordPages(input: unknown, rules: PageRules, dispatch: (input: unknown) => Promise<unknown>) {
  return filterRecord(input, entry => {
    if (entry.type === 'link') {
      const url = pageAddress(entry.url, rules)
      return url ? { ...entry, url } : undefined
    }
    if (entry.type !== 'arrival') return entry
    const arrival = { ...entry }
    for (const field of ['landing', 'referrer'] as const) if (entry[field] !== undefined) {
      const clean = pageAddress(entry[field], rules)
      if (!clean) return undefined
      arrival[field] = clean
    }
    return arrival
  }, dispatch)
}
