import { UNSTORABLE } from './identifiers.ts'
import type { Touch } from './types.ts'

/** The fields that hold an ad platform's id of one click. */
export const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid'] as const

/** The fields of a touch that hold one text each. */
export const TOUCH_FIELDS = [
  'source', 'medium', 'campaign', 'campaignId', 'adGroupId', 'adId', 'term', 'content',
  ...CLICK_IDS, 'fbp', 'landing', 'referrer',
] as const
const KNOWN = new Set<string>(['subject', 'at', 'custom', ...TOUCH_FIELDS])

/** Throws for a touch that holds anything but text in the fields a touch has. */
export function checkTouch(touch: Touch): void {
  if (typeof touch?.subject !== 'string' || !touch.subject) throw new TypeError('A touch needs a subject')
  if (!Number.isSafeInteger(touch.at)) throw new TypeError('A touch needs a time in whole epoch milliseconds')
  const text = (name: string, value: unknown) => {
    if (typeof value !== 'string') throw new TypeError(`A touch needs its ${name} as text`)
    if (UNSTORABLE.test(name) || UNSTORABLE.test(value)) throw new TypeError('A touch holds text that cannot be kept')
  }
  for (const [name, value] of Object.entries(touch)) {
    if (!KNOWN.has(name)) throw new TypeError(`A touch has no field "${name.slice(0, 100)}"; parameters of your own go in custom`)
    if (value !== undefined && name !== 'at' && name !== 'custom') text(name, value)
  }
  if (touch.custom === undefined) return
  if (typeof touch.custom !== 'object' || touch.custom === null || Array.isArray(touch.custom)) throw new TypeError('A touch needs its custom as an object of texts')
  for (const [name, value] of Object.entries(touch.custom)) text(name, value)
}
