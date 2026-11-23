import type { Cost, Counted, Report, ReportRow, Touch } from './types.ts'

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

/** The day after a day written `YYYY-MM-DD`. */
export function nextDay(day: string): string {
  return new Date(dayStart(day) + 86_400_000).toISOString().slice(0, 10)
}

const round = (amount: number) => Math.round(amount * 1e6) / 1e6

type Line = Omit<ReportRow, 'stages'> & { stages: Map<string, { count: number; value: number }>; named: string }

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
): Report {
  const lines = new Map<string, Line>()
  const currencies = new Set<string>()
  // A campaign with an id is one line whatever it is called; without one, its name is all there is.
  const keyOf = (source: string, campaignId: string, campaign: string) => [source, campaignId, campaignId ? '' : campaign.toLowerCase()].join('\u0000')
  const line = (source: string, campaignId: string, campaign: string): Line => {
    const key = keyOf(source, campaignId, campaign)
    let found = lines.get(key)
    if (!found) lines.set(key, (found = { source, campaignId, campaign: campaignId ? '' : campaign, named: '', cost: 0, clicks: 0, impressions: 0, visits: 0, stages: new Map(), outcomes: 0, value: 0 }))
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
    // A campaign known only by name keeps one spelling of it, the first in order.
    if (!cost.campaignId && cost.campaign < found.campaign) found.campaign = cost.campaign
  }
  // When two campaigns of one source share a name, the name stands for the one that cost more.
  const byName = new Map<string, Line>()
  for (const found of [...lines.values()].sort((x, y) => y.cost - x.cost || (x.campaignId < y.campaignId ? -1 : 1))) {
    const name = `${found.source}\u0000${found.campaign.toLowerCase()}`
    if (found.campaign && !byName.has(name)) byName.set(name, found)
  }
  const costed = new Set(lines.keys())

  // Then every touch that names an id no cost has, so a touch that carries the id as its name can find it.
  const all = [...touches, ...credited.flatMap(({ touch }) => (touch ? [touch] : []))]
  const named = (source: string, name: string) => byName.get(`${source}\u0000${name.toLowerCase()}`)
  for (const touch of all) {
    const source = sourceOf(touch)
    if (touch.campaignId && !costed.has(keyOf(source, touch.campaignId, '')) && !(touch.campaign && named(source, touch.campaign))) line(source, touch.campaignId, '')
  }
  const lineOf = (touch: Touch): Line => {
    const source = sourceOf(touch)
    const name = touch.campaign ?? ''
    const byId = lines.get(keyOf(source, touch.campaignId || name, ''))
    if (touch.campaignId && costed.has(keyOf(source, touch.campaignId, ''))) return byId!
    const found = (name && named(source, name)) || byId || line(source, '', name)
    // A line known only from touches takes the first name in order, so the answer is the same however the rows arrive.
    if (found.campaignId && !found.named && name && name !== found.campaignId && (!found.campaign || name < found.campaign)) found.campaign = name
    return found
  }

  for (const touch of touches) lineOf(touch).visits += 1
  for (const { outcome, touch } of credited) {
    const found = touch ? lineOf(touch) : line('(none)', '', '')
    const stage = found.stages.get(outcome.stage) ?? { count: 0, value: 0 }
    found.stages.set(outcome.stage, stage)
    stage.count += 1
    stage.value += outcome.value
    found.outcomes += 1
    found.value += outcome.value
    if (outcome.currency) currencies.add(outcome.currency)
  }

  const sums = new Map<string, { count: number; value: number }>()
  const total = { cost: 0, clicks: 0, impressions: 0, visits: 0, outcomes: 0, value: 0 }
  const order = (found: Line) => `${found.source}\u0000${found.campaignId}\u0000${found.campaign}`
  const sorted = [...lines.values()].sort((x, y) => y.cost - x.cost || y.value - x.value || y.visits - x.visits || (order(x) < order(y) ? -1 : 1))
  // A step is named by whoever recorded the outcome, so the names are kept in maps until the very end.
  const rows = sorted.map(({ named: _, stages, ...found }): ReportRow => {
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
    total.outcomes += found.outcomes
    return { ...found, stages: Object.fromEntries(stages) }
  })
  return { from, to, rows, total: { ...total, stages: Object.fromEntries(sums) }, currencies: [...currencies].sort() }
}
