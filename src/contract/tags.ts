/**
 * The address parameters that hold an ad platform's id of one click. Each fills the touch field of its name.
 * The browser tag, src/edge/collect.ts, keeps the same two tables, because it is served as one file. A test keeps them the same.
 */
export const CLICK_PARAMS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid'] as const

/** Address parameters and the touch field each fills. The first one present wins a field. */
export const TAG_PARAMS = [
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

/** The click ids and tags an address carries, by touch field. */
export function tagsOf(query: URLSearchParams): Record<string, string> {
  const found: Record<string, string> = {}
  for (const name of CLICK_PARAMS) {
    const value = query.get(name)
    if (value) found[name] = value
  }
  for (const [param, field] of TAG_PARAMS) {
    const value = query.get(param)
    if (value && !found[field]) found[field] = value
  }
  return found
}
