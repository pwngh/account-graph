import { randomBytes } from 'node:crypto'
import type { AccountGraph, CallOptions, LocalOptions } from '../contract/api.ts'
import { FAULT_CODES, fault } from '../contract/fault.ts'
import { plain } from '../contract/json.ts'
import { checked } from '../contract/validate.ts'
import type { CallName } from '../contract/validate.ts'
import { createEngine } from '../core/engine.ts'
import type { NewEvent } from '../core/events.ts'
import { createHours, hoursProblems } from '../core/hours.ts'
import { normalizePhone } from '../core/identifiers.ts'
import { ladderProblems } from '../core/ladder.ts'
import { createMemoryStore } from '../core/memory.ts'
import { createOps } from '../core/ops.ts'
import { defaultPolicy, plainPolicy, policyFrom, policyHash, policyProblems } from '../core/policy.ts'
import type { Policy } from '../core/policy.ts'
import { createReceipts, secretMark } from '../core/receipts.ts'
import { createSix } from '../core/six.ts'
import type { Asked } from '../core/six.ts'
import type { Store } from '../core/store.ts'
import { checkTags } from '../core/tags.ts'
import { targetProblems } from '../core/targets.ts'
import { createPostgresStore } from '../store/postgres.ts'
import type { Pool, PostgresStore } from '../store/postgres.ts'
import { createGate } from './closing.ts'
import { asFault } from './faults.ts'
import { keep } from './internals.ts'
import type { Internals } from './internals.ts'
import { checksOf, targetsOf } from './providers.ts'
import { createWorkers } from './workers.ts'
import type { Job } from '../core/outbox.ts'
import type { Workers } from './workers.ts'

/** What a program that keeps the database may do, and a caller may not. */
export interface Keeping {
  /** Takes the policy given as the database's, where it differs. Clusters must then be rebuilt. */
  adopt?: boolean
  log?: (line: string) => void
}

const policyOf = (given: NonNullable<LocalOptions['policy']>) => ({ ...given, kinds: { ...given.kinds, ...given.customKinds }, customKinds: undefined })

/** Everything wrong with the options, one line each. */
export function localProblems(options: LocalOptions): string[] {
  const wrong: string[] = []
  const given = options as unknown as Record<string, unknown>
  if (['url', 'databaseUrl', 'memory'].filter((name) => given[name] !== undefined).length !== 1) wrong.push('Exactly one of `url`, `databaseUrl` and `memory` must be given')
  if (given.databaseUrl !== undefined) {
    if (typeof given.databaseUrl !== 'string' || !given.databaseUrl) wrong.push('`databaseUrl` must be a string')
    if (typeof given.workers !== 'boolean') wrong.push('`workers` must be true or false')
    if (!Array.isArray(given.receiptSecrets) || given.receiptSecrets.length === 0 || given.receiptSecrets.some((each) => typeof each !== 'string' || each.length < 32)) wrong.push('`receiptSecrets` requires at least one secret of 32 characters or more')
    if (given.schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(String(given.schema))) wrong.push('`schema` must be a plain lowercase name')
  }
  for (const name of ['identifierSecret', 'linkSecret'] as const) if (options[name] !== undefined && options[name].length < 32) wrong.push(`\`${name}\` must be at least 32 characters`)
  if (options.timeoutMs !== undefined && !(Number.isInteger(options.timeoutMs) && options.timeoutMs >= 1 && options.timeoutMs <= 1_000_000_000)) wrong.push('`timeoutMs` must be an integer from 1 to 1,000,000,000')
  if (options.timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone })
    } catch {
      wrong.push('`timeZone` must be a time zone, such as America/New_York')
    }
  }
  if (options.policy) {
    for (const kind of Object.keys(options.policy.kinds ?? {})) if (!Object.hasOwn(defaultPolicy.kinds, kind)) wrong.push(`policy: kind "${kind}" is not built in: say it in full under customKinds`)
    for (const problem of policyProblems(JSON.parse(JSON.stringify(policyOf(options.policy))))) wrong.push(`policy: ${problem}`)
  }
  if (options.openHours) for (const problem of hoursProblems(options.openHours)) wrong.push(`openHours: ${problem}`)
  if (options.targets !== undefined) for (const problem of targetProblems(options.targets)) wrong.push(`targets: ${problem}`)
  if (options.stages) for (const problem of ladderProblems(options.stages, Object.entries(options.ads ?? {}).filter(([, value]) => typeof value === 'object').map(([name]) => name))) wrong.push(`stages: ${problem}`)
  for (const [number, channel] of Object.entries(options.phones?.numbers ?? {})) {
    try {
      normalizePhone(number)
      checkTags(channel.tags, number)
    } catch (error) {
      wrong.push(`phones.numbers: ${(error as Error).message}`)
    }
  }
  for (const [name, list] of [['exclude', options.phones?.exclude], ['pool.numbers', options.phones?.pool?.numbers]] as const) {
    for (const number of list ?? []) {
      try {
        normalizePhone(number)
      } catch {
        wrong.push(`phones.${name}: "${number}" is not a phone number`)
      }
    }
  }
  if (options.phones?.country !== undefined && !/^[1-9]\d{0,2}$/.test(options.phones.country)) wrong.push('phones.country must be a country code, such as 1')
  if (options.phones?.pool && !(options.phones.pool.minutes >= 1)) wrong.push('phones.pool.minutes must be at least 1')
  if (options.phones?.tapSeconds !== undefined && !(options.phones.tapSeconds >= 0 && options.phones.tapSeconds <= 3600)) wrong.push('phones.tapSeconds must be from 0 to 3600')
  if (options.webhook && !(options.webhook.url && options.webhook.secret)) wrong.push('`webhook` requires its url and its secret')
  return wrong
}

export function localGraph(options: LocalOptions, keeping: Keeping = {}): AccountGraph {
  const wrong = localProblems(options)
  if (wrong.length > 0) throw fault(FAULT_CODES.CONFIG.INVALID, wrong.join('\n'), { detail: { problems: wrong } })
  const log = keeping.log ?? (() => {})
  const gate = createGate()
  const timeout = options.timeoutMs ?? 30_000
  let pool: { end(): Promise<void> } | undefined
  let workers: Workers | undefined

  async function openStore(): Promise<Store> {
    if (options.databaseUrl === undefined) return createMemoryStore()
    const { default: pg } = await import('pg')
    const made = new pg.Pool({ connectionString: options.databaseUrl, connectionTimeoutMillis: timeout, keepAlive: true, query_timeout: 2 * timeout })
    pool = made
    const store: PostgresStore = createPostgresStore(made as unknown as Pool, options.schema, { lockTimeout: timeout })
    // An upgrade takes as long as it takes.
    const patient = new pg.Pool({ connectionString: options.databaseUrl, connectionTimeoutMillis: timeout, max: 1 })
    const applied = await createPostgresStore(patient as unknown as Pool, options.schema).migrate().finally(() => patient.end())
    log(applied.length > 0 ? `database upgraded: ${applied.join(', ')}` : 'database is up to date')
    return store
  }

  /** The policy the database was built with, and the marks of the secrets it holds keys of. A process that differs is told so before it writes. */
  async function settle(store: Store): Promise<Policy> {
    const given = options.policy && policyFrom(JSON.parse(JSON.stringify(policyOf(options.policy))))
    return store.write(async (tx) => {
      const kept = await tx.settingOf('policy')
      const stored = kept === undefined ? undefined : policyFrom(JSON.parse(kept))
      const built = await tx.builtWith()
      if (!keeping.adopt && given && stored && policyHash(given) !== policyHash(stored)) throw fault(FAULT_CODES.CONFIG.MISMATCH, 'The policy differs from the one this database was built with. Run account-graph rebuild.')
      if (!keeping.adopt && given && !stored && built !== undefined && built !== policyHash(given) && !(await tx.empty())) throw fault(FAULT_CODES.CONFIG.MISMATCH, 'The stored clusters were built with another policy. Run account-graph rebuild.')
      const policy = given ?? stored ?? defaultPolicy
      const unnamed = (await tx.kinds()).filter((kind) => !Object.hasOwn(policy.kinds, kind))
      if (unnamed.length > 0) throw fault(FAULT_CODES.CONFIG.MISMATCH, `Identifiers of kind ${unnamed.map((kind) => `"${kind}"`).join(', ')} are stored, and the policy names no such kind`)
      // What only credits or flags is no reason to refuse a process, and whoever is given none takes what was said last.
      if (!stored || (given && (keeping.adopt || JSON.stringify(plainPolicy(given)) !== JSON.stringify(plainPolicy(stored))))) await tx.setSetting('policy', JSON.stringify(plainPolicy(policy)))
      for (const name of ['identifierSecret', 'linkSecret'] as const) {
        const mark = secretMark(options[name])
        const before = await tx.settingOf(name)
        // A process without it makes none of its keys, so only one with another is refused.
        if (before !== undefined && options[name] !== undefined && before !== mark && !keeping.adopt) throw fault(FAULT_CODES.CONFIG.MISMATCH, `\`${name}\` differs from the one this database was set up with`)
        if (options[name] !== undefined && before !== mark) await tx.setSetting(name, mark)
      }
      return policy
    })
  }

  async function open(): Promise<Internals> {
    const store = await openStore()
    const receipts = createReceipts(options.databaseUrl === undefined ? [randomBytes(32).toString('hex')] : options.receiptSecrets, options.phones?.country)
    receipts.covers(options.databaseUrl === undefined ? [] : await store.read((tx) => tx.receiptSecrets()))
    const policy = await settle(store)
    const hours = options.openHours && createHours(options.openHours, options.timeZone)
    const { numbers, exclude, minimumSeconds, resultsExpectedWithinMinutes, country, tapSeconds, pool: shown } = options.phones ?? {}
    let tell: (jobs: Job[]) => Promise<void> = async () => {}
    const now = options.now ?? Date.now
    const targets = targetsOf(options)
    const engine = createEngine(store, {
      policy,
      now,
      ...checksOf(options),
      ...(options.stages && { stages: options.stages }),
      ...(options.identifierSecret && { identifierSecret: options.identifierSecret }),
      ...(shown && { pool: { numbers: shown.numbers, minutes: shown.minutes, grace: shown.graceMinutes, requireTapAfterReassignment: shown.requireTapAfterReassignment === true } }),
      calls: {
        ...(numbers && { numbers }), ...(exclude && { exclude }), ...(minimumSeconds !== undefined && { minimumSeconds }), ...(country && { country }), ...(tapSeconds !== undefined && { clickWindow: tapSeconds * 1000 }),
        ...(resultsExpectedWithinMinutes !== undefined && { results: 'expected' as const, resultWait: resultsExpectedWithinMinutes * 60_000 }),
      },
      ...(targets.length > 0 && { delivery: { targets, retractOnForget: options.ads?.retractOnForget ?? false, ...(options.ads?.delayMs !== undefined && { delay: options.ads.delayMs }), onFailed: (jobs) => tell(jobs) } }),
    })
    const emit = (event: NewEvent) => store.write((tx) => tx.emit([event]))
    const { quietHours, lateHours } = options.monitor ?? {}
    const ops = createOps(engine.graph, store.ops, {
      ...(options.alerts && { url: options.alerts.url }), ...(quietHours && { quiet: quietHours }), returnHours: options.phones?.returnHours ?? 24, ...(hours && { hours }),
      outbox: store.outbox, lateHours: lateHours ?? 6, timeZone: options.timeZone ?? 'UTC', now, emit, ...(options.fetch && { fetch: options.fetch }), onError: (error) => log(`alert: ${String((error as Error)?.message ?? error)}`),
    })
    tell = jobs => ops.failed(jobs, store).catch(error => log(String(error)))
    const six = createSix(engine, { receipts, returnHours: options.phones?.returnHours ?? 24, ...(options.linkSecret && { linkSecret: options.linkSecret }), ...(hours && { hours }), ...(options.timeZone && { timeZone: options.timeZone }) })
    if (options.databaseUrl !== undefined) {
      await engine.graph.repairCallReports()
      await six.repairForgottenParties()
    }
    workers = createWorkers(engine, ops, options, log)
    // From here on, and not from the first time it is posted to.
    if (options.webhook) await store.write(async (tx) => {
      const turn = await tx.claimDelivery('webhook', now(), 0)
      if (turn) await tx.setDelivery(turn)
    })
    if (options.workers ?? false) workers.start()
    return { options, engine, six, ops, hours, call: (name, request, asked) => gate.run(() => call(name, request, asked)), pass: () => workers!.pass() }
  }

  let opening: Promise<Internals> | undefined
  // One that failed is tried again by the next call: a database that was down comes back.
  const opened = (): Promise<Internals> => (opening ??= open().catch(async (error) => {
    opening = undefined
    await pool?.end().catch(() => undefined)
    pool = undefined
    throw error
  }))

  async function call(name: CallName, request: unknown, asked: Asked = {}): Promise<unknown> {
    const given = checked(name, request)
    if (asked.signal?.aborted) throw fault(FAULT_CODES.TRANSPORT.ABORTED, 'The call was aborted')
    const now = options.now ?? Date.now
    let timer: NodeJS.Timeout | undefined
    let heard: (() => void) | undefined
    try {
      // Counted from here, as the limit is: opening the database takes its part of the time.
      const until = now() + timeout * 0.9
      const work = opened().then(({ six }) => (six[name] as (request: unknown, asked: Asked) => Promise<unknown>)(given, { ...asked, until }))
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(fault(FAULT_CODES.TRANSPORT.INDETERMINATE, 'The call took too long', { retryable: true })), timeout)
        heard = () => reject(fault(FAULT_CODES.TRANSPORT.ABORTED, 'The call was aborted'))
        asked.signal?.addEventListener('abort', heard, { once: true })
      })
      work.catch(() => undefined)
      // What the caller gets is a value of its own, as it would be had it been sent.
      return plain(JSON.parse(JSON.stringify(await Promise.race([work, limit]))))
    } catch (error) {
      throw asFault(error)
    } finally {
      clearTimeout(timer)
      if (heard) asked.signal?.removeEventListener('abort', heard)
    }
  }

  const run = (name: CallName, request: unknown, { signal }: CallOptions = {}): Promise<any> => gate.run(() => call(name, request, { signal }))
  const graph: AccountGraph = {
    record: (request, how) => run('record', request, how),
    decide: (request, how) => run('decide', request, how),
    forget: (request, how) => run('forget', request, how),
    lookup: (request, how) => run('lookup', request, how),
    report: (request, how) => run('report', request, how),
    events: (request, how) => run('events', request, how),
    async close() {
      if (gate.ended) return closing
      closing = (async () => {
        await gate.end()
        await opening?.catch(() => undefined)
        await workers?.stop()
        await pool?.end().catch(() => undefined)
      })()
      return closing
    },
  }
  let closing: Promise<void> | undefined
  keep(graph, () => {
    if (gate.ended) return Promise.reject(fault(FAULT_CODES.GRAPH.CLOSED, 'This instance is closed'))
    return opened()
  })
  return graph
}
