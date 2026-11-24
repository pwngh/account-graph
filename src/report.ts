import { DIMENSION, NOT_RECORDED, touchTag, touchTags } from './tags.ts'
import type { Breakdown, Cost, Counted, Report, ReportRow, Touch } from './types.ts'

/** The platform each click id belongs to. A click id says where the visitor came from more surely than a tag does. */
const CLICK_IDS = [
  ['gclid', 'google'],
  ['gbraid', 'google'],
  ['wbraid', 'google'],
  ['fbclid', 'meta'],
  ['msclkid', 'microsoft'],
  ['ttclid', 'tiktok'],
] as const

/** Names people write in `utm_source` for the platforms costs are imported from. */
const ALIASES: Record<string, string> = {
  adwords: 'google',
  googleads: 'google',
  facebook: 'meta',
  fb: 'meta',
  instagram: 'meta',
  ig: 'meta',
  bing: 'microsoft',
  microsoftads: 'microsoft',
}

/** One name per platform, so `Facebook` on a link and `meta` on a cost land on the same line. */
export function sourceName(source: string): string {
  const clean = source.trim().toLowerCase()
  // A source is whatever a link said, so it may be the name of something every object has.
  return Object.hasOwn(ALIASES, clean) ? ALIASES[clean]! : clean
}

/** Where a touch came from: the platform of its click id, else its source tag, else the site that referred it. */
export function sourceOf(touch: Touch): string {
  for (const [field, platform] of CLICK_IDS) if (touch[field]) return platform
  if (touch.source) return sourceName(touch.source)
  if (touch.referrer) {
    try {
      return new URL(touch.referrer).hostname.replace(/^www\./, '')
    } catch {}
  }
  return '(other)'
}

/** How far a time zone is ahead of UTC at an instant, in milliseconds. */
function ahead(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at)
  const part = (type: string) => Number(parts.find((each) => each.type === type)!.value)
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - Math.floor(at / 1000) * 1000
}

/** The instant a day written `YYYY-MM-DD` begins in a time zone, in epoch milliseconds. */
export function dayStart(day: string, timeZone = 'UTC'): number {
  const utc = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? Date.parse(`${day}T00:00:00Z`) : NaN
  // Date.parse rolls 30 February into March; a day that does not read back as itself is not a day.
  if (Number.isNaN(utc) || new Date(utc).toISOString().slice(0, 10) !== day) throw new TypeError(`"${day}" is not a day written YYYY-MM-DD`)
  try {
    // Ask twice: the zone's offset at the guess can differ from its offset at the answer, around a clock change.
    const guess = utc - ahead(utc, timeZone)
    const refined = utc - ahead(guess, timeZone)
    // Where clocks go forward at midnight, midnight never happens: keep the earliest answer that falls on the day itself.
    const onDay = [refined, guess].filter((at) => new Date(at + ahead(at, timeZone)).toISOString().slice(0, 10) === day)
    return onDay.length > 0 ? Math.min(...onDay) : refined
  } catch {
    throw new TypeError(`"${timeZone}" is not a time zone`)
  }
}

/** The day it is at an instant in a time zone, written `YYYY-MM-DD`. */
export function dayIn(at: number, timeZone = 'UTC'): string {
  try {
    return new Date(at + ahead(at, timeZone)).toISOString().slice(0, 10)
  } catch {
    throw new TypeError(`"${timeZone}" is not a time zone`)
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** The hour and the day of the week it is at an instant in a time zone: `09`, `Tue`. */
export function hourIn(at: number, timeZone = 'UTC'): { hour: string; weekday: string } {
  const local = new Date(at + ahead(at, timeZone))
  return { hour: String(local.getUTCHours()).padStart(2, '0'), weekday: WEEKDAYS[local.getUTCDay()]! }
}

/** Something to be broken down: when it happened, what it was credited to, and what is known of it. */
interface Told {
  at: number
  touch: Touch | undefined
  tags?: Record<string, string> | undefined
}

/**
 * Reads one dimension of an outcome or a call. `touch.name` is what its
 * arrival said, `outcome.name` what is known of the outcome itself, and the
 * two are never mixed: where an office was advertised is not where the
 * person was served. `hour` and `weekday` are when it happened.
 */
export function dimension(by: string, timeZone?: string): (told: Told) => string {
  if (by === 'hour' || by === 'weekday') return ({ at }) => hourIn(at, timeZone)[by]
  const [, side, name] = /^(touch|outcome)\.(.+)$/.exec(by) ?? []
  if (!side || !name || !DIMENSION.test(name)) throw new TypeError(`"${by}" is not a dimension; use touch.<name>, outcome.<name>, hour or weekday`)
  if (side === 'touch') return ({ touch }) => touchTag(touch, name) ?? NOT_RECORDED
  return ({ tags }) => (tags && Object.hasOwn(tags, name) ? tags[name]! : NOT_RECORDED)
}

/** The day after a day written `YYYY-MM-DD`. */
export function nextDay(day: string): string {
  return new Date(dayStart(day) + 86_400_000).toISOString().slice(0, 10)
}

const round = (amount: number) => Math.round(amount * 1e6) / 1e6

type Tally = { stages: Map<string, { count: number; value: number }>; outcomes: number; value: number; missed: number }
type Line = Omit<ReportRow, 'stages' | 'breakdown'> & { stages: Map<string, { count: number; value: number }>; named: string; parts: Map<string, Tally> }

/** Counts one outcome among others. */
function count(into: Tally, outcome: Counted): void {
  const stage = into.stages.get(outcome.stage) ?? { count: 0, value: 0 }
  into.stages.set(outcome.stage, stage)
  stage.count += 1
  stage.value += outcome.value
  into.outcomes += 1
  into.value += outcome.value
}

/** Hours and days of the week in their own order, other values by name, and what was not recorded last. */
const rank = (value: string) => (value === NOT_RECORDED ? '\uffff' : WEEKDAYS.includes(value) ? `${(WEEKDAYS.indexOf(value) + 6) % 7}` : value)

function plain(parts: Map<string, Tally>): Breakdown {
  if (!parts.has(NOT_RECORDED)) parts.set(NOT_RECORDED, { stages: new Map(), outcomes: 0, value: 0, missed: 0 })
  const rounded = ([name, part]: [string, Tally]) => ({ name, ...part, value: round(part.value), stages: Object.fromEntries([...part.stages].map(([step, stage]) => [step, { count: stage.count, value: round(stage.value) }])) })
  return [...parts].sort(([x], [y]) => (rank(x) < rank(y) ? -1 : 1)).map(rounded)
}

/**
 * Folds costs, arrivals and credited outcomes into one line per campaign.
 * A touch joins a cost by the campaign's id, or by its name when no cost
 * carries that id. Either may sit in `utm_campaign`. The answer does not
 * depend on the order the rows are given in.
 */
export function fold(
  from: string,
  to: string,
  costs: readonly Required<Cost>[],
  touches: readonly Touch[],
  credited: readonly { outcome: Counted; touch: Touch | undefined }[],
  /** Each missed call, with the touch it is credited to, or undefined for one nothing can be credited with. */
  missed: readonly Told[] = [],
  /** The dimension to break each line down by, and the time zone its hours and days are in. */
  by?: string,
  timeZone?: string,
): Report {
  const lines = new Map<string, Line>()
  const currencies = new Set<string>()
  // A campaign with an id is one line whatever it is called; without one, its name is all there is.
  const keyOf = (source: string, campaignId: string, campaign: string) => [source, campaignId, campaignId ? '' : campaign.toLowerCase()].join('\u0000')
  const line = (source: string, campaignId: string, campaign: string): Line => {
    const key = keyOf(source, campaignId, campaign)
    let found = lines.get(key)
    if (!found) lines.set(key, (found = { source, campaignId, campaign: campaignId ? '' : campaign, named: '', cost: 0, clicks: 0, impressions: 0, visits: 0, missed: 0, stages: new Map(), outcomes: 0, value: 0, parts: new Map() }))
    // A campaign known only by name keeps one spelling of it, the first in order.
    if (!campaignId && campaign < found.campaign) found.campaign = campaign
    return found
  }

  // Costs first. A campaign takes the name its newest cost gives it.
  for (const cost of costs) {
    const found = line(sourceName(cost.source), cost.campaignId, cost.campaign)
    found.cost += cost.amount
    found.clicks += cost.clicks
    found.impressions += cost.impressions
    if (cost.currency) currencies.add(cost.currency)
    if (cost.campaignId && cost.campaign && cost.day >= found.named) [found.named, found.campaign] = [cost.day, cost.day === found.named && found.campaign > cost.campaign ? found.campaign : cost.campaign]
  }
  // When two campaigns of one source share a name, the name stands for the one that cost more.
  const byName = new Map<string, Line>()
  for (const found of [...lines.values()].sort((x, y) => y.cost - x.cost || (x.campaignId < y.campaignId ? -1 : 1))) {
    const name = `${found.source}\u0000${found.campaign.toLowerCase()}`
    if (found.campaign && !byName.has(name)) byName.set(name, found)
  }
  const costed = new Set(lines.keys())

  // Then every touch that names an id no cost has, so a touch that carries the id as its name can find it.
  const all = [...touches, ...credited.flatMap(({ touch }) => (touch ? [touch] : [])), ...missed.flatMap(({ touch }) => (touch ? [touch] : []))]
  // A touch finds a cost by name when it has no id. One with an id no cost knows only finds a cost that has no id either:
  // a different id under the same name is a different campaign.
  const named = (touch: Touch, source: string) => {
    const found = touch.campaign ? byName.get(`${source}\u0000${touch.campaign.toLowerCase()}`) : undefined
    return found && (!touch.campaignId || !found.campaignId) ? found : undefined
  }
  for (const touch of all) {
    const source = sourceOf(touch)
    if (touch.campaignId && !costed.has(keyOf(source, touch.campaignId, '')) && !named(touch, source)) line(source, touch.campaignId, '')
  }
  const lineOf = (touch: Touch): Line => {
    const source = sourceOf(touch)
    const name = touch.campaign ?? ''
    const byId = lines.get(keyOf(source, touch.campaignId || name, ''))
    if (touch.campaignId && costed.has(keyOf(source, touch.campaignId, ''))) return byId!
    const found = named(touch, source) ?? byId ?? line(source, '', name)
    // A line known only from touches takes the first name in order, so the answer is the same however the rows arrive.
    if (found.campaignId && !found.named && name && name !== found.campaignId && (!found.campaign || name < found.campaign)) found.campaign = name
    return found
  }

  for (const touch of touches) lineOf(touch).visits += 1
  const valueOf = by === undefined ? undefined : dimension(by, timeZone)
  const whole = new Map<string, Tally>()
  // Where an outcome or a missed call is counted: its line, and under its value there and in the total.
  const tallies = (found: Line, told: Told): Tally[] => {
    if (!valueOf) return [found]
    const value = valueOf(told)
    const part = (parts: Map<string, Tally>) => {
      const tally = parts.get(value) ?? { stages: new Map(), outcomes: 0, value: 0, missed: 0 }
      parts.set(value, tally)
      return tally
    }
    return [found, part(found.parts), part(whole)]
  }
  const missing = (touch: Touch | undefined) => (touch ? lineOf(touch) : line('(none)', '', ''))
  for (const call of missed) for (const tally of tallies(missing(call.touch), call)) tally.missed += 1
  for (const { outcome, touch } of credited) {
    for (const tally of tallies(missing(touch), { at: outcome.at, touch, tags: outcome.tags })) count(tally, outcome)
    if (outcome.currency) currencies.add(outcome.currency)
  }

  const sums = new Map<string, { count: number; value: number }>()
  const total = { cost: 0, clicks: 0, impressions: 0, visits: 0, missed: 0, outcomes: 0, value: 0 }
  const order = (found: Line) => `${found.source}\u0000${found.campaignId}\u0000${found.campaign}`
  const sorted = [...lines.values()].sort((x, y) => y.cost - x.cost || y.value - x.value || y.visits - x.visits || (order(x) < order(y) ? -1 : 1))
  // A step is named by whoever recorded the outcome, so the names are kept in maps until the very end.
  const rows = sorted.map(({ named: _, stages, parts, ...found }): ReportRow => {
    for (const [name, stage] of stages) {
      stage.value = round(stage.value)
      const sum = sums.get(name) ?? { count: 0, value: 0 }
      sums.set(name, sum)
      sum.count += stage.count
      sum.value = round(sum.value + stage.value)
    }
    found.cost = round(found.cost)
    found.value = round(found.value)
    total.cost = round(total.cost + found.cost)
    total.value = round(total.value + found.value)
    total.clicks += found.clicks
    total.impressions += found.impressions
    total.visits += found.visits
    total.missed += found.missed
    total.outcomes += found.outcomes
    return { ...found, stages: Object.fromEntries(stages), ...(valueOf && { breakdown: plain(parts) }) }
  })
  const said = new Set([...all.flatMap(touchTags).map((name) => `touch.${name}`), ...[...credited.map(({ outcome }) => outcome.tags), ...missed.map(({ tags }) => tags)].flatMap((tags) => Object.keys(tags ?? {})).map((name) => `outcome.${name}`)])
  return {
    from,
    to,
    rows,
    total: { ...total, stages: Object.fromEntries(sums), ...(valueOf && { breakdown: plain(whole) }) },
    ...(by !== undefined && { by }),
    dimensions: ['hour', 'weekday', ...[...said].sort()],
    currencies: [...currencies].sort(),
  }
}
