/**
 * Reads what campaigns cost, per day, from the ad platforms' reporting APIs.
 * Each function returns rows `graph.spend` takes.
 * https://developers.google.com/google-ads/api/rest/common/search
 * https://developers.facebook.com/docs/marketing-api/insights
 */
import { malformed } from '../contract/fault.ts'
import type { Cost } from '../types.ts'

/** Reads the cost of every campaign for each day from `from` to `to`, both written `YYYY-MM-DD`. */
export type CostSource = (from: string, to: string) => Promise<Cost[]>

/** A reporting API refused the request. */
export class CostError extends Error {
  status: number
  /** The platform's id for the request, to quote to its support. */
  requestId: string | undefined
  constructor(message: string, status: number, requestId?: string) {
    super(message)
    this.status = status
    this.requestId = requestId
  }
}

/** How long a reporting API has to answer. */
const TIMEOUT = 60_000
const DAY = /^\d{4}-\d{2}-\d{2}$/
const days = (from: string, to: string) => {
  if (!DAY.test(from) || !DAY.test(to)) throw malformed('Costs are read between two days written YYYY-MM-DD')
}

export interface GoogleCostOptions {
  /** The Google Ads account whose campaigns to read. Dashes are removed. */
  customerId: string
  /** The developer token of your Google Ads manager account. */
  developerToken: string
  /** Resolves to an access token with the scope `https://www.googleapis.com/auth/adwords`. */
  accessToken: () => Promise<string>
  /** The manager account the credentials belong to, when they reach the account through one. */
  loginCustomerId?: string
  /** Read the conversions Google counts for each campaign too, those its bidding uses. Off unless asked for. */
  conversions?: boolean
  /** The Google Ads API version. Defaults to `v26`. */
  version?: string
  fetch?: typeof fetch
}

/** Daily cost per campaign from the Google Ads API. Campaigns with no impressions on a day are left out. */
export function googleCosts(options: GoogleCostOptions): CostSource {
  const fetcher = options.fetch ?? fetch
  const url = `https://googleads.googleapis.com/${options.version ?? 'v26'}/customers/${options.customerId.replace(/\D/g, '')}/googleAds:searchStream`
  return async (from, to) => {
    days(from, to)
    const query =
      'SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, ' +
      (options.conversions ? 'metrics.conversions, metrics.conversions_value, ' : '') +
      'customer.currency_code ' +
      `FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.impressions > 0`
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await options.accessToken()}`,
        'developer-token': options.developerToken,
        'content-type': 'application/json',
        ...(options.loginCustomerId && { 'login-customer-id': options.loginCustomerId.replace(/\D/g, '') }),
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const text = await response.text()
    let body: any
    try {
      body = JSON.parse(text)
    } catch {
      throw new CostError(`Google Ads answered ${response.status}: ${text.slice(0, 300)}`, response.status)
    }
    // A stream answers with a list of batches, and an error is the first thing in it.
    const batches: any[] = Array.isArray(body) ? body : [body]
    const refused = batches.find((batch) => batch?.error)?.error
    if (!response.ok || refused) {
      const detail = refused?.details?.find((each: any) => each?.errors)?.errors?.[0]?.message
      const requestId = refused?.details?.find((each: any) => each?.requestId)?.requestId ?? response.headers.get('request-id') ?? undefined
      throw new CostError(`Google Ads refused the cost report with ${response.status}: ${detail ?? refused?.message ?? text.slice(0, 300)}`, response.status, requestId)
    }
    const costs: Cost[] = []
    for (const batch of batches) {
      for (const row of batch?.results ?? []) {
        costs.push({
          day: row.segments.date,
          source: 'google',
          campaignId: String(row.campaign.id),
          campaign: row.campaign.name ?? '',
          // Whole numbers too large for a JSON number arrive as text.
          amount: Number(row.metrics?.costMicros ?? 0) / 1e6,
          ...(row.customer?.currencyCode && { currency: row.customer.currencyCode }),
          clicks: Number(row.metrics?.clicks ?? 0),
          impressions: Number(row.metrics?.impressions ?? 0),
          ...(options.conversions && { conversions: Number(row.metrics?.conversions ?? 0), conversionValue: Number(row.metrics?.conversionsValue ?? 0) }),
        })
      }
    }
    return costs
  }
}

export interface MetaCostOptions {
  /** The ad account's id, with or without the `act_` in front. */
  adAccountId: string
  /** A token that may read the ad account's reports. */
  accessToken: string
  /** Read how many of this action Meta counts for each campaign too, named as its reports name it, such as `offsite_conversion.fb_pixel_lead`. Off unless named. */
  conversions?: string
  /** The Graph API version. Defaults to `v27.0`. */
  version?: string
  fetch?: typeof fetch
}

/** What Meta lists under one action. An action that did not happen, or has no value, is not listed. */
const counted = (list: any, action: string): number | null | undefined => {
  const found = (Array.isArray(list) ? list : []).find((each) => each?.action_type === action)?.value
  return found === undefined || found === null ? found : Number(found)
}

/** Daily spend per campaign from Meta's Insights API. */
export function metaCosts(options: MetaCostOptions): CostSource {
  const fetcher = options.fetch ?? fetch
  const account = options.adAccountId.replace(/^act_/, '')
  return async (from, to) => {
    days(from, to)
    const first = new URL(`https://graph.facebook.com/${options.version ?? 'v27.0'}/act_${account}/insights`)
    first.search = new URLSearchParams({
      level: 'campaign',
      fields: `campaign_id,campaign_name,spend,clicks,impressions,account_currency${options.conversions ? ',actions,action_values' : ''}`,
      time_range: JSON.stringify({ since: from, until: to }),
      time_increment: '1',
      limit: '500',
    }).toString()
    const costs: Cost[] = []
    let next: string | undefined = first.href
    // Each answer names the address of the next page. Two hundred pages is a hundred thousand rows.
    for (let page = 0; next && page < 200; page++) {
      const response: Response = await fetcher(next, { headers: { authorization: `Bearer ${options.accessToken}` }, signal: AbortSignal.timeout(TIMEOUT) })
      const body: any = await response.json().catch(() => undefined)
      if (!response.ok || body?.error) {
        throw new CostError(`Meta refused the cost report with ${response.status}: ${body?.error?.message ?? 'no reason given'}`, response.status, body?.error?.fbtrace_id)
      }
      for (const row of body?.data ?? []) {
        // Listed with no number, how many there were is not known. Not listed, there were none.
        const count = options.conversions ? counted(row.actions, options.conversions) : null
        const value = options.conversions && counted(row.action_values, options.conversions)
        costs.push({
          day: row.date_start,
          source: 'meta',
          campaignId: String(row.campaign_id),
          campaign: row.campaign_name ?? '',
          amount: Number(row.spend ?? 0),
          ...(row.account_currency && { currency: row.account_currency }),
          clicks: Number(row.clicks ?? 0),
          impressions: Number(row.impressions ?? 0),
          ...(count !== null && { conversions: count ?? 0, ...(typeof value === 'number' && { conversionValue: value }) }),
        })
      }
      next = typeof body?.paging?.next === 'string' ? body.paging.next : undefined
    }
    return costs
  }
}

/**
 * Reads a spreadsheet saved as CSV into costs, for a platform with no
 * importer here. The first line names the columns: `day`, `source`, `amount`,
 * and optionally `campaign_id`, `campaign`, `currency`, `clicks`, `impressions`,
 * `conversions`, `conversionValue`.
 */
export function costsFromCsv(text: string): Cost[] {
  const lines = parseCsv(text).filter((cells) => cells.some((cell) => cell.trim()))
  const head = (lines.shift() ?? []).map((name) => name.trim().toLowerCase().replace(/[\s_]/g, ''))
  const column = (name: string) => head.indexOf(name)
  for (const needed of ['day', 'source', 'amount']) if (column(needed) < 0) throw malformed(`The CSV requires a "${needed}" column`)
  const number = (cells: string[], name: string) => {
    const cell = (cells[column(name)] ?? '').trim().replace(/[$,]/g, '')
    return cell === '' ? undefined : Number(cell)
  }
  return lines.map((cells, i) => {
    const text = (name: string) => (cells[column(name)] ?? '').trim()
    const amount = number(cells, 'amount')
    if (amount === undefined || !Number.isFinite(amount)) throw malformed(`Line ${i + 2} of the CSV has no amount`)
    const clicks = number(cells, 'clicks')
    const impressions = number(cells, 'impressions')
    const conversions = number(cells, 'conversions')
    const conversionValue = number(cells, 'conversionvalue')
    return {
      day: text('day'),
      source: text('source'),
      amount,
      ...(text('campaignid') && { campaignId: text('campaignid') }),
      ...(text('campaign') && { campaign: text('campaign') }),
      ...(text('currency') && { currency: text('currency') }),
      ...(clicks !== undefined && { clicks }),
      ...(impressions !== undefined && { impressions }),
      ...(conversions !== undefined && { conversions }),
      ...(conversionValue !== undefined && { conversionValue }),
    }
  })
}

/** Splits CSV text into rows of cells. A cell in double quotes may hold commas, line breaks, and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [[]]
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char !== '"') cell += char
      else if (text[i + 1] === '"') (cell += '"'), i++
      else quoted = false
    } else if (char === '"') quoted = true
    else if (char === ',') (rows.at(-1)!.push(cell), (cell = ''))
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      rows.at(-1)!.push(cell)
      cell = ''
      rows.push([])
    } else cell += char
  }
  rows.at(-1)!.push(cell)
  return rows
}
