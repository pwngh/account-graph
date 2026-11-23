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
  return ALIASES[clean] ?? clean
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
  const utc = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN
  if (Number.isNaN(utc)) throw new TypeError(`"${day}" is not a day written YYYY-MM-DD`)
  try {
    // Ask twice: the zone's offset at the guess can differ from its offset at the answer, around a clock change.
    return utc - ahead(utc - ahead(utc, timeZone), timeZone)
  } catch {
    throw new TypeError(`"${timeZone}" is not a time zone`)
  }
}

/** The day after a day written `YYYY-MM-DD`. */
export function nextDay(day: string): string {
  return new Date(dayStart(day) + 86_400_000).toISOString().slice(0, 10)
}

const round = (amount: number) => Math.round(amount * 1e6) / 1e6

/**
 * Folds costs, arrivals and credited outcomes into one line per campaign.
 * A touch joins a cost by the campaign's id, or by its name when the touch
 * carries no id. Either may sit in `utm_campaign`.
 */
export function fold(
  from: string,
  to: string,
  costs: readonly Required<Cost>[],
  touches: readonly Touch[],
  credited: readonly { outcome: Counted; touch: Touch | undefined }[],
): Report {
  const rows = new Map<string, ReportRow>()
  const byName = new Map<string, string>()
  const currencies = new Set<string>()
  const row = (source: string, campaignId: string, campaign: string): ReportRow => {
    // A campaign with an id is one line whatever it is called; without one, its name is all there is.
    const key = [source, campaignId, campaignId ? '' : campaign.toLowerCase()].join('\u0000')
    let found = rows.get(key)
    if (!found) rows.set(key, (found = { source, campaignId, campaign, cost: 0, clicks: 0, impressions: 0, visits: 0, stages: {}, outcomes: 0, value: 0 }))
    if (!found.campaign) found.campaign = campaign
    return found
  }

  for (const cost of costs) {
    const source = sourceName(cost.source)
    const line = row(source, cost.campaignId, cost.campaign)
    if (cost.campaign) line.campaign = cost.campaign
    line.cost += cost.amount
    line.clicks += cost.clicks
    line.impressions += cost.impressions
    if (cost.currency) currencies.add(cost.currency)
    if (cost.campaignId && cost.campaign) byName.set(`${source}\u0000${cost.campaign.toLowerCase()}`, cost.campaignId)
  }

  const rowOf = (touch: Touch): ReportRow => {
    const source = sourceOf(touch)
    const name = touch.campaign ?? ''
    if (touch.campaignId) return row(source, touch.campaignId, name)
    const id = byName.get(`${source}\u0000${name.toLowerCase()}`) ?? (rows.has(`${source}\u0000${name}\u0000`) ? name : '')
    return id ? row(source, id, '') : row(source, '', name)
  }

  for (const touch of touches) rowOf(touch).visits += 1
  for (const { outcome, touch } of credited) {
    const line = touch ? rowOf(touch) : row('(none)', '', '')
    const stage = (line.stages[outcome.stage] ??= { count: 0, value: 0 })
    stage.count += 1
    stage.value += outcome.value
    line.outcomes += 1
    line.value += outcome.value
    if (outcome.currency) currencies.add(outcome.currency)
  }

  const total: Report['total'] = { cost: 0, clicks: 0, impressions: 0, visits: 0, stages: {}, outcomes: 0, value: 0 }
  const sorted = [...rows.values()].sort(
    (x, y) => y.cost - x.cost || y.value - x.value || y.visits - x.visits || (x.source + '\u0000' + x.campaignId + x.campaign < y.source + '\u0000' + y.campaignId + y.campaign ? -1 : 1),
  )
  for (const line of sorted) {
    for (const [name, stage] of Object.entries(line.stages)) {
      stage.value = round(stage.value)
      const sum = (total.stages[name] ??= { count: 0, value: 0 })
      sum.count += stage.count
      sum.value = round(sum.value + stage.value)
    }
    line.cost = round(line.cost)
    line.value = round(line.value)
    total.cost = round(total.cost + line.cost)
    total.value = round(total.value + line.value)
    total.clicks += line.clicks
    total.impressions += line.impressions
    total.visits += line.visits
    total.outcomes += line.outcomes
  }
  return { from, to, rows: sorted, total, currencies: [...currencies].sort() }
}
