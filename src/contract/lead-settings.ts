const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(value))
const only = (object: Record<string, unknown>, fields: readonly string[]) => Object.keys(object).every(key => fields.includes(key))

/** A validated path uses the same index whether the sender writes contacts.0 or contacts[0]. */
export const leadPath = (path: string): string[] => path.replace(/\[(\d+)\]/g, '.$1').split('.')

/** Where a lead source's subjects live: its own prefix, or lead:<name>. */
export const leadPrefix = (name: string, source: { readonly prefix?: string | undefined }): string => source.prefix ?? `lead:${name}`

/** Subject kinds the graph names itself, or that your own records conventionally use, which no lead source may write among. */
const BUILT_IN = new Set(['lead', 'visitor', 'caller', 'call', 'text', 'page', 'contact', 'account', 'record'])
/** Conversion keys the graph makes for calls, texts and page events. A bare `lead` would admit every lead source's conversions. */
const BUILT_IN_CONVERSIONS = new Set(['call', 'text', 'page'])
const firstPart = (text: string) => text.split(':')[0]!.toLowerCase()

/** Where a secret sits in a local graph's settings. */
const GRAPH_SECRETS = [
  'linkSecret', 'identifierSecret', 'webhook.secret', 'ads.meta.accessToken', 'ads.tiktok.accessToken', 'ads.microsoft.refreshToken', 'ads.microsoft.developerToken', 'ads.microsoft.clientSecret',
  'ads.google.serviceAccount.private_key', 'costs.google.developerToken', 'costs.google.serviceAccount.private_key', 'costs.meta.accessToken', 'checks.address.authToken', 'checks.lineType.authToken',
]

/** Every secret in a local graph's settings, which a lead secret must not repeat. */
export function graphSecrets(options: unknown): string[] {
  const at = (path: string) => path.split('.').reduce<unknown>((value, part) => object(value) ? value[part] : undefined, options)
  const receipts = at('receiptSecrets')
  return [...(Array.isArray(receipts) ? receipts : []), ...GRAPH_SECRETS.map(at)].filter((each): each is string => typeof each === 'string')
}

/** Fewer different characters than this is a placeholder, such as 32 of one letter, not a random secret. */
const VARIETY = 8
const overlap = (one: string, other: string) => one === other || one.startsWith(other + ':') || other.startsWith(one + ':')

/** JSON.parse keeps only the last of two sources with one name, so the text itself is read for a repeat. */
export function repeatsName(text: string): boolean {
  const seen = new Set<string>()
  let depth = 0
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"\s*:?|[{}[\]]/g)) {
    if (token === '{' || token === '[') depth += 1
    else if (token === '}' || token === ']') depth -= 1
    else if (depth === 1 && token.endsWith(':')) {
      const name = JSON.parse(token.slice(0, -1).trimEnd()) as string
      if (seen.has(name)) return true
      seen.add(name)
    }
  }
  return false
}

const validPath = (path: unknown): boolean => typeof path === 'string' && path.length <= 512 && /^[\w-]+(?:\.[\w-]+|\[(?:0|[1-9]\d*)\])*$/.test(path) && leadPath(path).every(part => !['__proto__', 'prototype', 'constructor'].includes(part))

/** A configuration error may go to an operator's log, so no submitted name, path or secret is quoted. */
export function leadProblems(leads: unknown, otherSecrets: readonly string[] = [], loggedNames: readonly string[] = []): string[] {
  if (leads === undefined) return []
  if (!object(leads)) return ['leads must be an object of named sources']
  const wrong: string[] = []
  const secrets = new Set(otherSecrets)
  const publicNames = new Set([...Object.keys(leads), ...loggedNames])
  const prefixes: { prefix: string, index: number }[] = []
  for (const [index, [name, entry]] of Object.entries(leads).entries()) {
    const where = `leads source ${index + 1}`
    if (name === '.' || name === '..' || !/^[\w.-]{1,64}$/.test(name)) wrong.push(`${where} requires a literal URL segment of 1 to 64 letters, digits, dots, underscores or hyphens`)
    if (otherSecrets.includes(name)) wrong.push(`${where} cannot put a credential in its public URL`)
    if (!object(entry) || !only(entry, ['kind', 'auth', 'secret', 'mapping', 'stage', 'prefix', 'perMinute', 'trustSubjects', 'updates', 'conversions', 'maxAmount'])) {
      wrong.push(`${where} must contain only lead source settings`)
      continue
    }
    const { kind, auth, secret, mapping, stage, prefix, perMinute, trustSubjects, updates, conversions, maxAmount } = entry
    if (kind !== 'lead' && kind !== 'payment') wrong.push(`${where}.kind must be lead or payment`)
    if (typeof secret !== 'string' || secret.trim().length < 32 || new Set(secret).size < VARIETY || /\p{Surrogate}/u.test(secret) || secrets.has(secret) || publicNames.has(secret) || (auth === 'bearer' && !/^[\x21-\x7e]+$/.test(secret))) wrong.push(`${where} requires a random private secret of 32 characters or more, with at least ${VARIETY} different characters, distinct from every source name, service credential and graph secret`)
    else secrets.add(secret)
    if (auth !== 'bearer' && !(object(auth) && only(auth, ['header', 'encoding']) && typeof auth.header === 'string' && /^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(auth.header) && (auth.encoding === 'hex' || auth.encoding === 'base64'))) wrong.push(`${where}.auth must be bearer or a signature header with hex or base64 encoding`)
    if (perMinute !== undefined && !(typeof perMinute === 'number' && Number.isSafeInteger(perMinute) && perMinute > 0)) wrong.push(`${where}.perMinute must be a positive whole number`)
    if (stage !== undefined && !(kind === 'lead' && typeof stage === 'string' && stage.trim() === stage && stage.length >= 1 && stage.length <= 200 && !/[\0\p{Surrogate}]/u.test(stage))) wrong.push(`${where}.stage must name a conversion step for a lead`)
    if (prefix !== undefined && !(kind === 'lead' && typeof prefix === 'string' && prefix.length <= 64 && /^[\w.-]+(?::[\w.-]+)*$/.test(prefix))) wrong.push(`${where}.prefix must name a lead subject prefix without a trailing colon`)
    else if (typeof prefix === 'string' && BUILT_IN.has(firstPart(prefix))) wrong.push(`${where}.prefix must not begin with a subject kind the graph, another source or your own records use`)
    else if (kind === 'lead') {
      const own = leadPrefix(name, { prefix: prefix as string | undefined })
      const other = prefixes.findIndex(each => overlap(each.prefix, own))
      if (other >= 0) wrong.push(`${where} writes under the same subject prefix as leads source ${prefixes[other]!.index + 1}`)
      prefixes.push({ prefix: own, index })
    }
    if (trustSubjects !== undefined && !(kind === 'lead' && typeof trustSubjects === 'boolean')) wrong.push(`${where}.trustSubjects must be true or false on a lead source`)
    if (updates !== undefined && !(kind === 'lead' && typeof updates === 'boolean')) wrong.push(`${where}.updates must be true or false on a lead source`)
    const keyPrefix = (each: unknown) => typeof each === 'string' && each.length <= 128 && /^[\w.-]+(?::[\w.-]+)*$/.test(each)
    if (kind === 'payment' ? !(Array.isArray(conversions) && conversions.length >= 1 && conversions.length <= 20 && conversions.every(keyPrefix)) : conversions !== undefined) wrong.push(`${where}.conversions must list 1 to 20 conversion key prefixes for a payment source`)
    else if (Array.isArray(conversions) && conversions.some(each => BUILT_IN_CONVERSIONS.has(firstPart(each)) || each.toLowerCase() === 'lead')) wrong.push(`${where}.conversions must not name the graph's own call, text or page conversions, or every lead source's`)
    if (kind === 'payment' ? !(typeof maxAmount === 'number' && maxAmount > 0 && maxAmount <= 1e10) : maxAmount !== undefined) wrong.push(`${where}.maxAmount must be a positive amount up to 1e10 for a payment source`)
    const fields = kind === 'payment' ? ['id', 'at', 'amount', 'currency', 'conversion'] : ['id', 'at', 'subject', 'first', 'last', 'email', 'phone', 'device', 'message']
    if (!object(mapping) || !only(mapping, fields) || !Object.hasOwn(mapping, 'id') || !Object.values(mapping).every(validPath)) wrong.push(`${where}.mapping requires id and literal field paths for its kind`)
    else if (kind === 'payment' && !(Object.hasOwn(mapping, 'amount') && Object.hasOwn(mapping, 'conversion'))) wrong.push(`${where}.mapping requires amount and conversion for a payment`)
  }
  return wrong
}
