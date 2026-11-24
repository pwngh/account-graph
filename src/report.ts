import { DIMENSION, NOT_RECORDED, touchTag, touchTags } from './tags.ts'
import type { Breakdown, Cost, Counted, OutcomeValue, Report, ReportRow, StageCount, Touch, ValueChange } from './types.ts'

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

/**
 * Whether an arrival was paid for: it carries an ad click, names a campaign
 * by its id, or says so in its medium. Meta's click id alone does not say
 * so, because links nobody paid for carry it too.
 */
export function paid(touch: Touch): boolean {
  return Boolean(touch.gclid || touch.gbraid || touch.wbraid || touch.msclkid || touch.ttclid || touch.campaignId) || /^(cpc|ppc|cpm|cpv|paid.*|display)$/i.test(touch.medium ?? '')
}

// Making one is slow and asking it is not, so each zone's is kept.
const clocks = new Map<string, Intl.DateTimeFormat>()
function clockOf(timeZone: string): Intl.DateTimeFormat {
  let clock = clocks.get(timeZone)
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    if (clocks.size >= 100) clocks.clear()
    clocks.set(timeZone, clock)
  }
  return clock
}

/** How far a time zone is ahead of UTC at an instant, in milliseconds. */
export function ahead(at: number, timeZone: string): number {
  const parts = clockOf(timeZone).formatToParts(at)
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

interface Step {
  count: number
  value: number
  people: Set<string>
  /** Days from arrival to outcome, for those that have an arrival, and how many of those came inside the window. */
  days: number[]
  inside: number
}
type Tally = { stages: Map<string, Step>; outcomes: number; value: number; people: Set<string>; missed: number; notLeads: number }
const tally = (): Tally => ({ stages: new Map(), outcomes: 0, value: 0, people: new Set(), missed: 0, notLeads: 0 })
type Worked = 'costDays' | 'missingDays' | 'thin' | 'costPerOutcome' | 'returnOnCost'
type Line = Omit<ReportRow, 'stages' | 'breakdown' | 'people' | Worked> & Tally & { costed: Map<string, number>; bought: boolean; onDays: Map<string, { outcomes: number; value: number }>; named: string; parts: Map<string, Tally> }

/** An outcome, what it is credited to, whose it is, and how long after their arrival it came. */
export interface Credited {
  outcome: Counted
  touch: Touch | undefined
  /** Its first value, with no time when it may not be the first, and the most it was ever worth. */
  first?: (OutcomeValue & { most: number; refunded?: number; writtenOff?: number; lostIn?: readonly string[] }) | undefined
  /** Who it is: the cluster of its subject. Defaults to the subject. */
  person?: string
  /** Milliseconds from the newest strong arrival in the year before it, inside the window or not. */
  delay?: number | undefined
  /** Whether that arrival was inside the window. */
  inside?: boolean
}

/** Counts one outcome among others. With no timing given, a credited touch gives its own. */
function count(into: Tally, { outcome, touch, person = outcome.subject, delay = touch && outcome.at - touch.at, inside = touch !== undefined }: Credited): void {
  const step = into.stages.get(outcome.stage) ?? { count: 0, value: 0, people: new Set(), days: [], inside: 0 }
  into.stages.set(outcome.stage, step)
  step.count += 1
  step.value += outcome.value
  step.people.add(person)
  if (delay !== undefined) {
    step.days.push(delay / 86_400_000)
    if (inside) step.inside += 1
  }
  into.outcomes += 1
  into.value += outcome.value
  into.people.add(person)
}

const unchanged = (): ValueChange => ({ outcomes: 0, first: 0, now: 0, refunded: 0, writtenOff: 0, zeroed: 0, firstUnknown: 0 })

/** Adds what an outcome was first worth, and is worth now, to a sum of them. */
function revalued(into: ValueChange, { outcome, first }: Credited): void {
  into.outcomes += 1
  into.now += outcome.value
  into.refunded += first?.refunded ?? 0
  into.writtenOff += first?.writtenOff ?? 0
  if (outcome.value === 0 && first && first.most > 0) into.zeroed += 1
  // A value carried over from before there was a history may not be the first.
  if (first && first.at > 0) into.first += first.value
  else into.firstUnknown += 1
}

const roundedChange = (change: ValueChange): ValueChange => ({ ...change, first: round(change.first), now: round(change.now), refunded: round(change.refunded), writtenOff: round(change.writtenOff) })

/** The smallest value that at least this share of sorted values do not exceed. */
const percentile = (sorted: readonly number[], share: number) => sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)]!
/** The middle of sorted values, or the middle of the middle two. */
const middle = (sorted: readonly number[]) => (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2
const tenth = (days: number) => Math.round(days * 10) / 10

function plainSteps(stages: ReadonlyMap<string, Step>): Record<string, StageCount> {
  return Object.fromEntries(
    [...stages].map(([name, { count, value, people, days, inside }]) => {
      const sorted = [...days].sort((x, y) => x - y)
      const delay = sorted.length > 0 && { count: sorted.length, median: tenth(middle(sorted)), p95: tenth(percentile(sorted, 0.95)), inside: round(inside / sorted.length) }
      return [name, { count, value: round(value), people: people.size, ...(delay && { delay }) }]
    }),
  )
}

/** Hours and days of the week in their own order, other values by name, and what was not recorded last. */
const rank = (value: string) => (value === NOT_RECORDED ? '\uffff' : WEEKDAYS.includes(value) ? `${(WEEKDAYS.indexOf(value) + 6) % 7}` : value)

function plain(parts: Map<string, Tally>): Breakdown {
  if (!parts.has(NOT_RECORDED)) parts.set(NOT_RECORDED, tally())
  const rounded = ([name, part]: [string, Tally]) => ({ name, ...part, value: round(part.value), people: part.people.size, stages: plainSteps(part.stages) })
  return [...parts].sort(([x], [y]) => (rank(x) < rank(y) ? -1 : 1)).map(rounded)
}

export interface FoldOptions {
  /** Each missed call, with the touch it is credited to, or undefined for one nothing can be credited with. */
  missed?: readonly Told[]
  /** Each outcome and missed call that was said to be no lead, the same way. */
  notLeads?: readonly Told[]
  /** The dimension to break each line down by. */
  by?: string | undefined
  /** The one step to count in what an outcome cost. Every step is counted without it. */
  per?: string | undefined
  /** The time zone days and hours are in. Defaults to UTC. */
  timeZone?: string | undefined
  /** The last day costs could have been recorded for. Defaults to `to`. */
  through?: string
  /** Outcomes of the months before `through`, for how long steps take. Defaults to the credited ones. */
  history?: readonly Credited[]
}

/** How many whole days the slowest step takes, for 95 in 100 of those that can be credited. A handful of outcomes says nothing, so a step needs twenty. */
function slowest(history: readonly Credited[]): number {
  const all = tally()
  for (const each of history) if (each.inside ?? each.touch !== undefined) count(all, each)
  return Math.ceil(Math.max(0, ...[...all.stages.values()].map(({ days }) => (days.length >= 20 ? percentile(days.sort((x, y) => x - y), 0.95) : 0))))
}

/** Below this share of days with cost data, what anything cost is not said. */
const ENOUGH = 0.5

/** What was spent on some outcomes, by days that have cost data on both sides. */
type Spent = { cost: number; outcomes: number; value: number }

const ratios = ({ cost, outcomes, value }: Spent) => ({
  costPerOutcome: outcomes > 0 ? round(cost / outcomes) : null,
  returnOnCost: cost > 0 && value > 0 ? round(value / cost) : null,
})

/**
 * What a campaign's outcomes cost. Only the days that have cost data count,
 * on both sides: an outcome on a day whose cost is not known would look
 * free. A recorded zero is cost data, and so is a day that cost nothing.
 */
function worth(costDays: number, days: number, { campaign, campaignId, bought }: { campaign: string; campaignId: string; bought: boolean }, spent: Spent): Pick<ReportRow, Worked> {
  // Money spent on no campaign in particular says nothing of what one campaign's outcomes cost. A campaign with
  // paid arrivals has a cost somewhere; one without may be a newsletter, so with no cost data nothing is missing.
  const named = Boolean(campaignId || campaign)
  const thin = named && costDays < days * ENOUGH && (costDays > 0 || bought)
  return { costDays, missingDays: Math.max(0, days - costDays), thin, ...(named && costDays > 0 && !thin ? ratios(spent) : { costPerOutcome: null, returnOnCost: null }) }
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
  credited: readonly Credited[],
  { missed = [], notLeads = [], by, per, timeZone, through = to, history = credited }: FoldOptions = {},
): Report {
  // Days still to come have no cost yet, whatever rows there are for them.
  const last = through < to ? through : to
  const days = last < from ? 0 : Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  const lines = new Map<string, Line>()
  const currencies = new Set<string>()
  // A campaign with an id is one line whatever it is called; without one, its name is all there is.
  const keyOf = (source: string, campaignId: string, campaign: string) => [source, campaignId, campaignId ? '' : campaign.toLowerCase()].join('\u0000')
  const line = (source: string, campaignId: string, campaign: string): Line => {
    const key = keyOf(source, campaignId, campaign)
    let found = lines.get(key)
    if (!found) lines.set(key, (found = { source, campaignId, campaign: campaignId ? '' : campaign, named: '', cost: 0, clicks: 0, impressions: 0, visits: 0, ...tally(), worth: unchanged(), parts: new Map(), costed: new Map(), bought: false, onDays: new Map() }))
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
    if (cost.day <= last) found.costed.set(cost.day, (found.costed.get(cost.day) ?? 0) + cost.amount)
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
  const all = [...touches, ...credited.flatMap(({ touch }) => (touch ? [touch] : [])), ...[...missed, ...notLeads].flatMap(({ touch }) => (touch ? [touch] : []))]
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
  for (const touch of all) if (paid(touch)) lineOf(touch).bought = true
  const valueOf = by === undefined ? undefined : dimension(by, timeZone)
  const whole = new Map<string, Tally>()
  // Where an outcome or a missed call is counted: its line, and under its value there and in the total.
  const tallies = (found: Line, told: Told): Tally[] => {
    if (!valueOf) return [found]
    const value = valueOf(told)
    const part = (parts: Map<string, Tally>) => {
      const found = parts.get(value) ?? tally()
      parts.set(value, found)
      return found
    }
    return [found, part(found.parts), part(whole)]
  }
  const missing = (touch: Touch | undefined) => (touch ? lineOf(touch) : line('(none)', '', ''))
  for (const call of missed) for (const into of tallies(missing(call.touch), call)) into.missed += 1
  for (const each of notLeads) for (const into of tallies(missing(each.touch), each)) into.notLeads += 1
  const everything = tally()
  const worthAll = unchanged()
  const months = new Map<string, ValueChange>()
  for (const each of credited) {
    const { outcome, touch } = each
    for (const into of [everything, ...tallies(missing(touch), { at: outcome.at, touch, tags: outcome.tags })]) count(into, each)
    for (const currency of [outcome.currency, each.first?.currency, ...(each.first?.lostIn ?? [])]) if (currency) currencies.add(currency)
    const found = missing(touch)
    const month = each.first && each.first.at > 0 ? dayIn(each.first.at, timeZone).slice(0, 7) : NOT_RECORDED
    if (!months.has(month)) months.set(month, unchanged())
    for (const change of [found.worth, worthAll, months.get(month)!]) revalued(change, each)
    const day = dayIn(outcome.at, timeZone)
    const on = found.onDays.get(day) ?? { outcomes: 0, value: 0 }
    found.onDays.set(day, { outcomes: on.outcomes + (per === undefined || outcome.stage === per ? 1 : 0), value: on.value + outcome.value })
  }

  const total = { cost: 0, clicks: 0, impressions: 0, visits: 0, missed: 0, notLeads: 0, outcomes: 0, value: 0 }
  // The total of what things cost: campaigns with enough cost data, and the outcomes credited to them. Never all spend over all outcomes.
  const known: Spent = { cost: 0, outcomes: 0, value: 0 }
  let counted = 0
  const anyCost = new Set<string>()
  let leftOut = 0
  const order = (found: Line) => `${found.source}\u0000${found.campaignId}\u0000${found.campaign}`
  const sorted = [...lines.values()].sort((x, y) => y.cost - x.cost || y.value - x.value || y.visits - x.visits || (order(x) < order(y) ? -1 : 1))
  // A step is named by whoever recorded the outcome, so the names are kept in maps until the very end.
  const rows = sorted.map(({ named: _, stages, parts, costed: costDays, onDays, bought, people, ...found }): ReportRow => {
    found.cost = round(found.cost)
    found.value = round(found.value)
    total.cost = round(total.cost + found.cost)
    total.value = round(total.value + found.value)
    total.clicks += found.clicks
    total.impressions += found.impressions
    total.visits += found.visits
    total.missed += found.missed
    total.notLeads += found.notLeads
    total.outcomes += found.outcomes
    const spent: Spent = { cost: 0, outcomes: 0, value: 0 }
    for (const [day, cost] of costDays) {
      anyCost.add(day)
      spent.cost += cost
      spent.outcomes += onDays.get(day)?.outcomes ?? 0
      spent.value += onDays.get(day)?.value ?? 0
    }
    const worked = worth(costDays.size, days, { ...found, bought }, spent)
    if (worked.thin) leftOut += 1
    else if (costDays.size > 0 && (found.campaignId || found.campaign)) {
      counted += 1
      known.cost += spent.cost
      known.outcomes += spent.outcomes
      known.value += spent.value
    }
    return { ...found, ...worked, people: people.size, worth: roundedChange(found.worth), stages: plainSteps(stages), ...(valueOf && { breakdown: plain(parts) }) }
  })
  const said = new Set([...all.flatMap(touchTags).map((name) => `touch.${name}`), ...[...credited.map(({ outcome }) => outcome.tags), ...[...missed, ...notLeads].map(({ tags }) => tags)].flatMap((tags) => Object.keys(tags ?? {})).map((name) => `outcome.${name}`)])
  const steps = plainSteps(everything.stages)
  const wait = slowest(history)
  const after = new Date(Date.parse(`${through}T00:00:00Z`) - wait * 86_400_000).toISOString().slice(0, 10)
  return {
    from,
    to,
    rows,
    ...(wait > 0 && after < last && days > 0 && { filling: { after, days: wait } }),
    days,
    leftOut,
    months: [...months].sort(([x], [y]) => (rank(x) < rank(y) ? -1 : 1)).map(([month, change]) => ({ month, ...roundedChange(change) })),
    total: { ...total, costDays: anyCost.size, missingDays: Math.max(0, days - anyCost.size), thin: counted === 0 && leftOut > 0, ...ratios(known), people: everything.people.size, worth: roundedChange(worthAll), stages: steps, ...(valueOf && { breakdown: plain(whole) }) },
    ...(by !== undefined && { by }),
    ...(per !== undefined && { per }),
    dimensions: ['hour', 'weekday', ...[...said].sort()],
    currencies: [...currencies].sort(),
  }
}
