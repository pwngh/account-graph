import { malformed } from '../contract/fault.ts'
import { pageAddress } from './collect.ts'
import type { PageRules } from './collect.ts'

/** Screen every address before the first identifier, check, receipt or write. A generic refusal keeps the address out of errors and logs. */
export function browserPage(body: any, rules: PageRules, referer: string | undefined): boolean {
  if (!pageAddress(body.url, rules)) return false
  // An origin-only referrer could also be an actual visit to the root page.
  if (referer && !pageAddress(referer, rules)) return false
  for (const field of ['landing', 'referrer']) {
    if (body.touch?.[field] === undefined) continue
    const clean = pageAddress(body.touch[field], rules)
    if (!clean) return false
    body.touch[field] = clean
  }
  return true
}

export function recordPages(input: any, rules: PageRules): unknown {
  if (!Array.isArray(input?.entries)) return input
  for (const entry of input.entries) {
    const fields = entry?.type === 'arrival' ? ['landing', 'referrer'] : entry?.type === 'link' ? ['url'] : []
    for (const field of fields) {
      if (entry[field] === undefined) continue
      const clean = pageAddress(entry[field], rules)
      if (!clean) throw malformed('A page address is not permitted')
      entry[field] = clean
    }
  }
  return input
}
