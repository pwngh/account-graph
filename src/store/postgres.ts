import { createHash, randomUUID } from 'node:crypto'
import { contactFact, factActive, type FactProfile, type FactStamp } from '../core/fact-fold.ts'
import { later } from '../core/said.ts'
import { affectedMisses, callTraces, creditSubject, ownerOf, partyOf, reopenWaits, stopCallJob, withoutGuesses } from '../core/call-party.ts'
import { FAULT_CODES, fault, malformed } from '../contract/fault.ts'
import type { Feed, KeptAlert, OpsStore } from '../core/ops.ts'
import type { Job, JobState, OutboxStore } from '../core/outbox.ts'
import type { GraphEvent } from '../contract/api.ts'
import type { Receipt } from '../core/receipts.ts'
import type { Details } from '../core/details.ts'
import type { SaidOf, Topic } from '../core/said.ts'
import type { AddedSightings, Store, Tx } from '../core/store.ts'
import { CLICK_IDS } from '../core/touch.ts'
import { schemaSql } from './schema.ts'
import { defaultPolicy } from '../core/policy.ts'
import type { CallResult, CallTime, Consent, Cost, Counted, Decision, Edge, FlowEdge, Identifier, IdentifierState, KeptCall, KeptText, KeptWords, Labels, Lease, Moved, NotLead, OutcomeValue, Payment, SentLink, Sighting, Subject, Touch } from '../contract/types.ts'

/** Every ad click id a touch carries, as the index on them has it. */
const CLICKED = `array[${CLICK_IDS.map((name) => `detail->>'${name}'`).join(', ')}]`

/** The part of a `pg` client the store calls. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>
  /** `pg` 8.15 and later: `E` while a statement in the transaction has failed. */
  getTransactionStatus?(): string | null
  /** `pg`: whether the server has said it is ready since the last statement, and so the status is current. */
  readyForQuery?: boolean
}

/** The part of a `pg` Pool the store calls. */
export interface Pool extends Queryable {
  connect(): Promise<Queryable & { release(destroy?: boolean): void }>
  on?(event: 'error', heard: (error: unknown) => void): unknown
  on?(event: 'connect', heard: (client: { on?(event: 'error', heard: (error: unknown) => void): unknown }) => void): unknown
}

/** Whether an error says that the connection is of no more use, and not that the database refused something. */
const silent = (error: unknown): boolean => error instanceof Error && !('severity' in error) && /^(Query read timeout|Connection terminated|Client has encountered a connection error)/.test(error.message)

const sqlState = (error: unknown) => error instanceof Error && 'code' in error ? error.code : undefined

const watched = new WeakSet<Pool>()
/**
 * When the database ends a connection, it arrives as an event, and an event with no listener ends the process. The pool
 * emits it for an idle connection. A connection in use emits it only on its own client, whose next statement then fails.
 */
function watch(pool: Pool): void {
  if (!pool.on || watched.has(pool)) return
  watched.add(pool)
  pool.on('error', (error) => console.error(`database: ${(error as Error)?.message ?? error}`))
  pool.on('connect', (client) => void client.on?.('error', () => undefined))
}

export interface PostgresStore extends Store {
  /**
   * Brings the database up to date: creates what is missing and applies each
   * upgrade that has not run yet, in order, resuming at a committed upgrade. Safe to
   * call on every start and from several processes at once. Returns the
   * names of the upgrades it applied.
   */
  migrate(): Promise<string[]>
}

/** The order `standingFirst` gives, in SQL. False sorts first, and rows equal in everything that counts are told apart by id. */
const STANDING = `at desc, coalesce(key, '') collate "C" desc, recorded_at desc, ad_user_data, ad_personalization, id`

const READ_ONLY = 'begin isolation level repeatable read read only'

/**
 * Keeps the graph in PostgreSQL. Writes take one advisory lock, so they run
 * one at a time across every process; reads take a repeatable-read snapshot
 * and never wait on a write. What reads the whole graph reads `page` rows of
 * an answer at a time.
 */
export function createPostgresStore(pool: Pool, schema = 'account_graph', { page = 5_000, lockTimeout = 0 }: { page?: number; /** How long a write waits for the lock, in milliseconds. 0 waits for as long as it takes. */ lockTimeout?: number } = {}): PostgresStore {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw malformed(`Schema "${schema}" must be a plain lowercase name`)
  if (!(Number.isSafeInteger(page) && page > 0)) throw malformed('`page` must be a positive integer')
  const t = (table: string) => `${schema}.${table}`
  watch(pool)

  const callRows = `select c.*, r.answered, r.voicemail, r.waited, r.returned_at, r.recorded_at as result_at from ${t('call')} c left join ${t('call_result')} r on r.id = c.id`

  const erasedRecord = (subject: string) => `select d.at, d.seq from ${t('decision')} d where d.action = 'forget' and d.about->>0 = ${subject} order by d.seq desc limit 1`
  const namedPartyCalls = `select distinct about as id from ${t('said')} where topic = 'party' and data->>'subject' = any($1::text[]) and ($2::text[] is null or about = any($2))`
  const retainedPartyCalls = `select n.id from (${namedPartyCalls}) n cross join lateral (
    select data from ${t('said')} where topic = 'party' and about = n.id order by at desc, key collate "C" desc limit 1
  ) winner where winner.data->>'role' in ('self', 'representative') and winner.data->>'subject' <> all($1::text[])
    and not exists (select from ${t('call')} c where c.id = n.id and (c.line_subject = any($1::text[]) or c.subject = any($1::text[])))`
  const partyCalls = `select id from ${t('call')} where ($2::text[] is null or id = any($2)) and (line_subject = any($1::text[]) or (party is not null and subject = any($1::text[])))
    union (${namedPartyCalls} except ${retainedPartyCalls})`
  const dropCallNotices = async (db: Queryable, ids: string[], subjects: Subject[], misses: string[] = [], evidence: readonly string[] = [], knownAt?: number, owner?: Subject) => {
    const sources = [...ids, ...evidence]
    const conversions = ids.map(id => `call:${id}`)
    const { rows } = await db.query(`delete from ${t('alert')} where starts_with(key, 'unreturned:') and
      (callback_calls && $1::text[] or (delivered_at is null and (callback_calls[1] = any($3::text[]) or (callback_calls[1] is null and subject = any($2::text[]) and ($4::bigint is null or at >= $4 or subject = $5))))) returning key`, [sources, subjects, misses, knownAt ?? null, misses.length ? owner ?? null : null])
    const notices = rows.map(row => row.key)
    if (ids.length) await db.query(`delete from ${t('alert')} where starts_with(key, 'alert:conversions:') and (callback_calls && $1::text[] or
      (callback_calls is null and (position((chr(10) || '…and ') in text) > 0 or exists (select from unnest($2::text[]) as c(id) where position(('• ' || c.id || ' to ') in text) > 0))))`, [ids, conversions])
    const removed = await db.query(`delete from ${t('event')} where (type = 'callback.overdue' and (data->>'call' = any($1::text[]) or callback_calls && $4::text[] or notice_key = any($3::text[]))) or (type = 'conversion.failed' and data->>'conversion' = any($2::text[])) returning type, subject, notice_key`, [ids, conversions, notices, sources])
    for (const row of removed.rows) if (row.notice_key) notices.push(row.notice_key)
    // An older event named the miss, but its once key named the first open miss. Keep keys that still belong to other notices.
    const older = removed.rows.filter(row => row.type === 'callback.overdue' && !row.notice_key).map(row => row.subject)
    await db.query(`delete from ${t('event_once')} n where said_once = any($3::text[]) or (subject = any($1::text[]) and said_once in (select 'unreturned:' || subject || ':' || id from unnest($2::text[]) as ids(id)))
      or (subject = any($4::text[]) and starts_with(said_once, 'unreturned:') and not exists (select from ${t('alert')} a where a.key = n.said_once))`, [subjects, ids, notices, older])
  }
  const addAlert = async (db: Queryable, { key, text, at, subject, error }: KeptAlert, again = false, calls?: readonly string[]) => {
    const conflict = again ? 'do update set at = excluded.at, text = excluded.text, error = excluded.error, tried_at = excluded.tried_at, delivered_at = null, callback_calls = excluded.callback_calls' : 'do nothing'
    const { rows } = await db.query(`insert into ${t('alert')} (key, text, at, subject, error, tried_at, callback_calls) values ($1, $2, $3, $4, $5, $3, $6) on conflict (key) ${conflict} returning 1`, [key, text, at, subject ?? null, error ?? null, calls ?? null])
    return rows.length > 0
  }
  const settingOf = async (db: Queryable, name: string): Promise<string | undefined> => (await db.query(`select value from ${t('setting')} where name = $1`, [name])).rows[0]?.value
  const latestConsent = async (db: Queryable, subjects: readonly Subject[]) => subjects.length === 0 ? [] : (await db.query(
    `select distinct on (subject) subject, at, ad_user_data, ad_personalization from ${t('consent_log')} where subject = any($1::text[]) order by subject, ${STANDING}`, [subjects],
  )).rows
  function evidenceIn(db: Queryable, readOnly: boolean) {
    let probed: Promise<boolean> | undefined
    const probe = async () => (await db.query(`select from ${t('call_evidence')} limit 1`)).rows.length > 0
    return {
      noReserved: false,
      // Concurrent reads on this client share the first probe. A writer can still add or roll back evidence.
      any() { return readOnly ? (probed ??= probe()) : !this.noReserved && probe() },
      async absent() { return readOnly ? !await this.any() : this.noReserved },
    }
  }
  // A former holder contributes once for an identifier, and only when it no longer holds the active edge.
  // Restrict both sides of match_identifier to the requested keys before counting.
  const scopedStates = (wanted: string) => `with wanted as materialized (${wanted}), former as (
    select w.identifier as id, count(distinct w.subject)::int as extra from wanted join ${t('call_evidence')} w on w.identifier = wanted.id
    where not exists (select from ${t('edge')} e where e.subject = w.subject and e.identifier = w.identifier) group by w.identifier
  ), states as (select wanted.id, coalesce(i.fanout, 0) + coalesce(former.extra, 0) as fanout, coalesce(i.ignored, false) as ignored
    from wanted left join ${t('identifier')} i using (id) left join former using (id))`
  type Folded = Edge & { profile?: FactProfile | undefined }
  const edgeKey = (row: Edge) => row.subject + '\u0000' + row.identifier
  const latest = (a?: FactProfile, b?: FactProfile) => !a || b && later(b, a) > 0 ? b : a
  function combine(a: Folded, b: Folded): Folded {
    return { subject: a.subject, identifier: a.identifier, first: Math.min(a.first, b.first), last: Math.max(a.last, b.last), count: a.count + b.count, profile: latest(a.profile, b.profile) }
  }
  const fieldsOf = (rows: Folded[]) => [rows.map(r => r.subject), rows.map(r => r.identifier), rows.map(r => r.first), rows.map(r => r.last), rows.map(r => r.count),
    rows.map(r => r.profile?.at ?? null), rows.map(r => r.profile?.key ?? null), rows.map(r => r.profile?.fact ?? null)]
  const rawFields = 'subject, identifier, first_at, last_at, sightings, profile_at, profile_key, source_fact'
  const rawValues = 'unnest($1::text[], $2::text[], $3::bigint[], $4::bigint[], $5::int[], $6::bigint[], $7::text[], $8::text[])'
  async function factRows(db: Queryable, subjects: Subject[]) {
    const masks = new Map<Subject, Map<Identifier, FactStamp>>()
    const saved = new Map<string, { edge: Folded; hidden: boolean }>()
    const masksRead = await db.query(`select distinct on (subject, identifier) subject, identifier, at, key from ${t('fact_withdrawal')} where subject = any($1::text[])
      order by subject, identifier, at desc, key desc`, [subjects])
    for (const row of masksRead.rows) {
      let own = masks.get(row.subject)
      if (!own) masks.set(row.subject, own = new Map())
      const fact = contactFact(row.identifier)
      const next = { at: Number(row.at), key: row.key }
      const before = own.get(fact)
      if (!before || later(next, before) > 0) own.set(fact, next)
    }
    const edges = await db.query(`select ${rawFields}, false as hidden from ${t('edge')} where subject = any($1::text[])
      union all select ${rawFields}, true as hidden from ${t('withdrawn_edge')} where subject = any($1::text[])`, [subjects])
    for (const row of edges.rows) {
      const edge: Folded = { ...toEdge(row), ...(row.profile_key !== null && { profile: { at: Number(row.profile_at), key: row.profile_key, ...(row.source_fact && { fact: row.source_fact }) } }) }
      saved.set(edgeKey(edge), { edge, hidden: row.hidden })
    }
    return { saved, masks }
  }
  async function hideEdges(db: Queryable, edges: Folded[]) {
    if (!edges.length) return
    await db.query(`insert into ${t('withdrawn_edge')} (${rawFields}) select * from ${rawValues}
      on conflict (subject, identifier) do update set (first_at, last_at, sightings, profile_at, profile_key, source_fact) =
        (excluded.first_at, excluded.last_at, excluded.sightings, excluded.profile_at, excluded.profile_key, excluded.source_fact)`, fieldsOf(edges))
  }
  /** Numbers the savepoints of this store, so each nested write names its own. */
  let savepoints = 0
  // `kept` is the savepoint of the last nested write that succeeded. It is released with the next savepoint, in the same trip.
  const bind = (db: Queryable, readOnly: boolean, snapshot = evidenceIn(db, readOnly), nesting: { kept?: string | undefined } = {}): Tx => ({
    async insertActivity(rows) {
      // PostgreSQL decodes these arrays against the destination column types. Generated ids keep their defaults.
      const insert = async (table: string, columns: string, values: readonly object[]) => {
        if (values.length) await db.query(`insert into ${t(table)} (${columns}) select ${columns} from jsonb_populate_recordset(null::${t(table)}, $1::jsonb)`, [JSON.stringify(values)])
      }
      await insert('touch', 'subject, at, detail, source_call', rows.touches.map(({ touch: { subject, at, ...detail }, call }) => ({ subject, at, detail, source_call: call })))
      await insert('outcome', 'transaction_id, subject, at, stage, value, currency, tags', rows.outcomes.map(({ transactionId, ...rest }) => ({ transaction_id: transactionId, ...rest })))
      await insert('outcome_value', 'transaction_id, subject, value, currency, at, kind, why', rows.values.map(({ transactionId, subject, value }) => ({ transaction_id: transactionId, subject, ...value })))
      await insert('call', 'id, subject, at, dialed, duration, flags, visitor, recorded_at, direction, tags, line_kind', rows.calls.map(({ call: { to, recorded, ...rest }, lineKind }) => ({ ...rest, dialed: to, recorded_at: recorded, line_kind: lineKind })))
      await insert('call_result', 'id, answered, voicemail, waited, returned_at, recorded_at', rows.results.map(([id, { returned, recorded, ...rest }]) => ({ id, ...rest, returned_at: returned, recorded_at: recorded })))
      await insert('decision', 'seq, at, action, about, actor, reason, hash', rows.decisions.map(({ by, ...rest }) => ({ ...rest, actor: by })))
      await insert('detail', 'subject, field, value, at, key', rows.details ?? [])
      if (rows.shown?.length) await db.query(`update ${t('identifier')} i set shown = g.value from unnest($1::text[], $2::text[]) g(id, value) where i.id = g.id and i.fanout > 0`, [rows.shown.map((row) => row.identifier), rows.shown.map((row) => row.value)])
    },
    addAlert: (alert, again, calls) => addAlert(db, alert, again, calls),
    async pendingAlert({ key, text, at }, start) {
      const { rows } = await db.query(`select 1 from ${t('alert')} where key = $1 and text = $2 and at = $3 and delivered_at is null for share`, [key, text, at])
      if (!rows.length) return false
      start?.()
      return true
    },
    outbox: outboxOn(db),
    async nested(work) {
      // Each savepoint has a name of its own, so one that succeeded can wait to be released until the next is made, a trip saved.
      // Writes inside one transaction run one after another, never together, as one connection answers one statement at a time.
      const name = `inside_${(savepoints += 1)}`
      const kept = nesting.kept
      nesting.kept = undefined
      await db.query(kept ? `release savepoint ${kept}; savepoint ${name}` : `savepoint ${name}`)
      try {
        const result = await work()
        // A statement that failed inside, and was caught there, leaves the transaction failed. Where the client cannot say so yet, releasing finds out.
        const status = db.readyForQuery === true ? db.getTransactionStatus?.() : undefined
        if (status === 'E') throw Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' })
        if (status === undefined || status === null) await db.query(`release savepoint ${name}`)
        // Released with the next savepoint, this one also releases those made inside it.
        else nesting.kept = name
        return result
      } catch (error) {
        snapshot.noReserved = false
        nesting.kept = undefined
        await db.query(`rollback to savepoint ${name}; release savepoint ${name}`).catch(() => undefined)
        throw error
      }
    },
    async addSightings(rows) {
      // Fold repeats first, because one statement cannot upsert the same edge twice.
      const folded = new Map<string, Folded>()
      for (const { subject, identifier, at, profileKey, fact } of rows) {
        const edge: Folded = { subject, identifier, first: at, last: at, count: 1, ...(profileKey !== undefined && { profile: { at, key: profileKey, ...(fact && { fact }) } }) }
        const previous = folded.get(edgeKey(edge))
        folded.set(edgeKey(edge), previous ? combine(previous, edge) : edge)
      }
      let edges = [...folded.values()]
      const found = await db.query(
        `with observed as (insert into ${t('sighting')} (subject, identifier, at, event, recorded_at, profile_key, source_fact)
           select * from unnest($1::text[], $2::text[], $3::bigint[], $4::text[], $5::bigint[], $6::text[], $7::text[]))
         select subject from (select distinct unnest($1::text[]) as subject) written
           where exists (select from ${t('fact_withdrawal')} f where f.subject = written.subject)`,
        [rows.map(r => r.subject), rows.map(r => r.identifier), rows.map(r => r.at), rows.map(r => r.event ?? null), rows.map(r => r.recorded ?? r.at),
          rows.map(r => r.profileKey ?? null), rows.map(r => r.fact ?? null)])
      await db.query(
        `insert into ${t('subject')} (id, component, cluster)
         select distinct s, s, s from unnest($1::text[]) as s on conflict (id) do nothing`,
        [edges.map((e) => e.subject)],
      )
      const regained = new Set<Subject>()
      if (found.rows.length) {
        const { saved, masks } = await factRows(db, found.rows.map(r => r.subject))
        const hidden: Folded[] = []
        const restored: Folded[] = []
        edges = edges.flatMap(edge => {
          const own = masks.get(edge.subject)
          if (!own) return [edge]
          const previous = saved.get(edgeKey(edge))
          const total = previous ? combine(previous.edge, edge) : edge
          if (factActive(edge.identifier, total.profile, own)) {
            if (!previous && !factActive(edge.identifier, total.profile?.fact ? { ...total.profile, at: -Infinity } : undefined, own)) regained.add(edge.subject)
            if (!previous?.hidden) return [edge]
            regained.add(edge.subject)
            restored.push(total)
            return [total]
          }
          hidden.push(total)
          return []
        })
        await hideEdges(db, hidden)
        if (restored.length) {
          await db.query(`delete from ${t('withdrawn_edge')} w using unnest($1::text[], $2::text[]) as r(subject, identifier) where w.subject = r.subject and w.identifier = r.identifier`, fieldsOf(restored).slice(0, 2))
        }
        if (regained.size) await this.setSetting('callParty', randomUUID())
      }
      const table = t('edge')
      const newer = `excluded.profile_at is not null and (${table}.profile_at is null or (excluded.profile_at, excluded.profile_key) > (${table}.profile_at, ${table}.profile_key))`
      const { rows: tally } = await db.query(
        `with upserted as (
           insert into ${table} (${rawFields})
           select * from ${rawValues}
           on conflict (subject, identifier) do update set
             first_at = least(${t('edge')}.first_at, excluded.first_at),
             last_at = greatest(${t('edge')}.last_at, excluded.last_at),
             sightings = ${table}.sightings + excluded.sightings,
             profile_at = case when ${newer} then excluded.profile_at else ${table}.profile_at end,
             profile_key = case when ${newer} then excluded.profile_key else ${table}.profile_key end,
             source_fact = case when ${newer} then excluded.source_fact else ${table}.source_fact end
           returning identifier, (xmax = 0) as fresh
         ), tally as (
           select identifier, count(*) filter (where fresh)::int as added from upserted group by identifier
         ), counted as (
           insert into ${t('identifier')} (id, fanout) select identifier, added from tally
           on conflict (id) do update set fanout = ${t('identifier')}.fanout + excluded.fanout
         )
         select identifier, added from tally where added > 0`,
        fieldsOf(edges),
      )
      const added: AddedSightings = new Map(tally.map((row) => [row.identifier as Identifier, row.added as number]))
      if (regained.size) added.restored = regained
      return added
    },

    async withdrawFact(subject, identifiers, at, key, recorded, decision) {
      const facts = [...new Set(identifiers)]
      await db.query(`insert into ${t('fact_withdrawal')} (subject, identifier, at, key, recorded_at, decision)
        select $1, id, $3, $4, $5, $6 from unnest($2::text[]) as id on conflict do nothing`, [subject, facts, at, key, recorded, decision ?? null])
      const { masks, saved } = await factRows(db, [subject])
      const hidden = [...saved.values()].filter(({ edge, hidden }) => !hidden && !factActive(edge.identifier, edge.profile, masks.get(subject)!)).map(row => row.edge)
      if (hidden.length) {
        await hideEdges(db, hidden)
        const ids = hidden.map(row => row.identifier)
        await db.query(`with gone as (delete from ${t('edge')} where subject = $1 and identifier = any($2::text[]) returning identifier)
          update ${t('identifier')} set fanout = fanout - 1, shown = case when fanout > 1 then shown end where id in (select identifier from gone)`, [subject, ids])
        await db.query(`delete from ${t('identifier')} where id = any($1::text[]) and fanout = 0 and not ignored`, [ids])
      }
      return hidden.map(row => row.identifier)
    },

    async factWithdrawn(subject, identifiers, at, key) {
      const { masks, saved } = await factRows(db, [subject])
      const own = masks.get(subject)
      if (!own) return false
      return identifiers.every(id => {
        const stamp = own.get(contactFact(id))
        return stamp?.key === key && stamp.at === at && !factActive(id, saved.get(subject + '\u0000' + id)?.edge.profile, own)
      })
    },

    async factHistory(before) {
      const { rows } = await db.query(`select subject, at, key, decision, array_agg(identifier order by identifier collate "C") as identifiers
        from ${t('fact_withdrawal')} where recorded_at <= $1 group by subject, at, key, decision`, [before])
      return rows.map(r => ({ subject: r.subject, identifiers: r.identifiers, at: Number(r.at), key: r.key, ...(r.decision !== null && { decision: Number(r.decision) }) }))
    },

    async removeSubject(subject, only) {
      const ids = (await db.query(`${partyCalls} union select id from ${t('call')} where $2::text[] is null and subject = any($1::text[])`, [[subject], only ?? null])).rows.map(row => row.id as string)
      let callJobs: Job[] = []
      if (ids.length) {
        await reopenWaits(this, await this.callsWith(ids))
        const refs = ids.map(id => `call:${id}`)
        const { rows } = await db.query(`delete from ${t('call')} where id = any($1::text[]) returning subject, line_subject, direction, party`, [ids])
        const owners = rows.flatMap(row => [row.subject, row.line_subject]).filter(Boolean)
        await dropCallNotices(db, ids, [subject, ...owners], [], [...(only ? [] : [creditSubject(subject)]), ...(rows.some(row => row.direction === 'inbound' && row.party) ? ['legacy:credit'] : [])])
        await db.query(`delete from ${t('call_result')} where id = any($1::text[])`, [ids])
        await db.query(`delete from ${t('said')} where (topic in ('worth', 'lead') and about = any($1::text[])) or (topic in ('party', 'result', 'return', 'recording') and about = any($2::text[]))`, [refs, ids])
        await db.query(`delete from ${t('not_lead')} where id = any($1::text[])`, [refs])
        for (const table of ['outcome', 'outcome_value', 'payment']) await db.query(`delete from ${t(table)} where transaction_id = any($1::text[])`, [refs])
        callJobs = (await db.query(`delete from ${t('conversion')} where transaction_id = any($1::text[]) returning *`, [refs])).rows.map(toJob)
      }
      await db.query(`delete from ${t('said')} where topic = 'party' and data->>'subject' = $1 and ($2::text[] is null or about = any($2))`, [subject, only ?? null])
      if (only) return callJobs
      await db.query(`with created as (delete from ${t('profile_created')} where subject = $1), details as (delete from ${t('detail')} where subject = $1), written as (delete from ${t('body')} where subject = $1 or author = $1)
        , facts as (delete from ${t('fact_withdrawal')} where subject = $1), hidden as (delete from ${t('withdrawn_edge')} where subject = $1)
        , stops as (delete from ${t('text_stop')} where subject = $1 or line = $1), phones as (delete from ${t('text_phone_profile')} where subject = $1) delete from ${t('call_evidence')} where subject = $1`, [subject])
      if (!ids.length) await dropCallNotices(db, ids, [subject], [], [creditSubject(subject)])
      const { rows: left } = await db.query(
        `with gone as (delete from ${t('edge')} where subject = $1 returning identifier)
         update ${t('identifier')} set fanout = fanout - 1, shown = case when fanout > 1 then shown end where id in (select identifier from gone) returning id, fanout`,
        [subject],
      )
      // What nobody holds any more goes too, unless it is muted, because a mute is a decision and stands for whoever holds it next.
      await db.query(`delete from ${t('identifier')} where id = any($1::text[]) and fanout <= 0 and not ignored`, [left.filter((row) => row.fanout <= 0).map((row) => row.id)])
      await db.query(`delete from ${t('not_lead')} where id in (select transaction_id from ${t('outcome')} where subject = $1 union all select 'call:' || id from ${t('call')} where subject = $1 union all select 'text:' || id from ${t('message')} where subject = $1)`, [subject])
      await db.query(
        `delete from ${t('said')} where (topic in ('worth', 'lead') and about in (
             select transaction_id from ${t('outcome')} where subject = $1
             union all select transaction_id from ${t('outcome_value')} v where subject = $1 and not exists (select from ${t('outcome')} o where o.transaction_id = v.transaction_id)
             union all select 'call:' || id from ${t('call')} where subject = $1 union all select 'text:' || id from ${t('message')} where subject = $1))
           or (topic in ('result', 'return', 'recording') and about in (select id from ${t('call')} where subject = $1))`,
        [subject],
      )
      await db.query(`delete from ${t('sighting')} where subject = $1`, [subject])
      await db.query(`delete from ${t('touch')} where subject = $1`, [subject])
      await db.query(`delete from ${t('outcome')} where subject = $1`, [subject])
      // Of its outcomes, and those taken back, unless they are somebody else's since.
      await db.query(`delete from ${t('payment')} p where transaction_id in (select transaction_id from ${t('outcome_value')} where subject = $1) and not exists (select from ${t('outcome')} o where o.transaction_id = p.transaction_id)`, [subject])
      await db.query(`delete from ${t('outcome_value')} where subject = $1`, [subject])
      await db.query(`with gone as (delete from ${t('call')} where subject = $1 returning id) delete from ${t('call_result')} where id in (select id from gone)`, [subject])
      await db.query(`update ${t('call')} set visitor = null where visitor = $1`, [subject])
      await db.query(`delete from ${t('sent_link')} where subject = $1`, [subject])
      await db.query(`delete from ${t('message')} where subject = $1`, [subject])
      await db.query(`update ${t('message')} set visitor = null where visitor = $1`, [subject])
      await db.query(`delete from ${t('subject')} where id = $1`, [subject])
      const { rows: jobs } = await db.query(`delete from ${t('conversion')} where job->>'subject' = $1 returning *`, [subject])
      await db.query(`delete from ${t('apart')} where a = $1 or b = $1`, [subject])
      await db.query(`delete from ${t('flow')} where source = $1 or target = $1`, [subject])
      await db.query(`delete from ${t('transfer')} where source = $1 or target = $1`, [subject])
      await db.query(`delete from ${t('consent_log')} where subject = $1`, [subject])
      // Who held a number is forgotten. That somebody did stays, or a call in that time would go to whoever held it before.
      await db.query(`update ${t('lease')} set subject = '' where subject = $1`, [subject])
      await db.query(`delete from ${t('alert')} where subject = $1`, [subject])
      await db.query(`delete from ${t('event')} where subject = $1`, [subject])
      await db.query(`delete from ${t('event_once')} where subject = $1`, [subject])
      return [...callJobs, ...jobs.map(toJob)]
    },

    async hasCallEvidence() {
      return snapshot.any()
    },

    async rivalCalls(number, first, last, line) {
      const { rows } = await db.query(`${callRows} where c.direction = 'inbound' and c.dialed = $1 and c.at >= $2 and c.at < $3
        and ($4::text is null or coalesce(c.line_subject, c.subject) = $4)`, [number, first, last, line ?? null])
      return rows.map(row => ({ ...toCall(row), subject: row.line_subject ?? row.subject, flags: row.flags, ...(row.visitor && { visitor: row.visitor }) }))
    },

    async callEvidence({ subjects, identifiers, calls, before } = {}) {
      if (subjects?.length === 0 || identifiers?.length === 0 || calls?.length === 0 || await snapshot.absent()) return []
      const filters: string[] = []
      const values: unknown[] = []
      for (const [column, ids] of [['subject', subjects], ['identifier', identifiers], ['call_id', calls]] as const) if (ids) filters.push(`${column} = any($${values.push(ids)}::text[])`)
      if (before !== undefined) filters.push(`recorded_at <= $${values.push(before)}`)
      const { rows } = await db.query(`select * from ${t('call_evidence')}${filters.length ? ' where ' + filters.join(' and ') : ''}`, values)
      return rows.map(row => ({ call: row.call_id, subject: row.subject, identifier: row.identifier, at: Number(row.at), recorded: Number(row.recorded_at) }))
    },

    async reserveCall(rows) {
      if (!rows.length) return
      snapshot.noReserved = false
      await db.query(`insert into ${t('call_evidence')} (call_id, subject, identifier, at, recorded_at)
        select * from unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::bigint[]) on conflict do nothing`,
        [rows.map(row => row.call), rows.map(row => row.subject), rows.map(row => row.identifier), rows.map(row => row.at), rows.map(row => row.recorded)])
    },

    async markPartyCode(id, visitor) {
      await db.query(`update ${t('call')} set visitor = $3, flags = array_append(array_remove(array_remove(array_remove(flags,'ambiguous'),'pool'),'repeat'), $2::text) where id = $1 and party is not null`, [id, visitor ? 'code' : 'taken', visitor ?? null])
    },

    async callVisitors(ids) {
      if (!ids.length || await snapshot.absent()) return new Map()
      const { rows } = await db.query(`select c.id, c.visitor from ${t('call')} c where c.id = any($1::text[]) and c.party is not null and exists (
        select from ${t('call_evidence')} e where e.call_id = c.id and e.subject = c.visitor and e.identifier in ('dial:' || c.id, 'lease:' || c.id, 'text:call:' || c.id)
        and not exists (select from ${t('identifier')} i where i.id = e.identifier and i.ignored))`, [ids])
      return new Map(rows.map(row => [row.id, row.visitor]))
    },

    async matchingEdges(subjects) {
      if (!subjects.length || await snapshot.absent()) return { active: await this.edgesOf(subjects), reserved: false }
      const { rows } = await db.query(`with active as materialized (select * from ${t('edge')} where subject = any($1::text[])),
        nearby as (select exists (select from ${t('call_evidence')} where subject = any($1::text[])
          union all select from active a join ${t('call_evidence')} r on r.identifier = a.identifier) as reserved)
        select e.*, nearby.reserved from nearby left join active e on true`, [subjects])
      return { active: rows[0]?.subject == null ? [] : rows.map(toEdge), reserved: rows[0]?.reserved === true }
    },

    async setCreatedAt(subject, createdAt, at, key) {
      const { rows } = await db.query(
        `insert into ${t('profile_created')} as p (subject, created_at, at, key) values ($1, $2, $3, $4)
         on conflict (subject) do update set created_at = excluded.created_at, at = excluded.at, key = excluded.key
         where (p.at, p.key) < (excluded.at, excluded.key) returning 1`, [subject, createdAt, at, key])
      return rows.length > 0 || this.createdAtStands(subject, createdAt, at, key)
    },

    async setDetails(subject, given, at, key) {
      const fields = Object.keys(given)
      if (fields.length === 0) return
      await db.query(
        `insert into ${t('detail')} as d (subject, field, value, at, key) select $1, f, v, $4, $5 from unnest($2::text[], $3::text[]) g(f, v)
         on conflict (subject, field) do update set value = excluded.value, at = excluded.at, key = excluded.key where (d.at, d.key) < (excluded.at, excluded.key)`,
        [subject, fields, Object.values(given), at, key])
    },

    async setShown(subject, given) {
      if (given.size === 0) return
      await db.query(`update ${t('identifier')} i set shown = g.value from unnest($2::text[], $3::text[]) g(id, value) where i.id = g.id and i.shown is distinct from g.value
        and exists (select from ${t('edge')} e where e.subject = $1 and e.identifier = i.id)`, [subject, [...given.keys()], [...given.values()]])
    },

    async keepWords({ from, id, subject, at, recorded, text, cut, author }) {
      await db.query(`insert into ${t('body')} (source, id, subject, author, at, recorded_at, words, cut) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (source, id) do nothing`, [from, id, subject, author ?? null, at, recorded, text, cut])
    },

    async wordsOf(subjects, limit, since) {
      if (subjects.length === 0) return []
      const { rows } = await db.query(`select source, id, subject, at, words, cut from ${t('body')} where subject = any($1::text[]) and recorded_at >= $3 order by at desc, id, source limit $2`, [subjects, limit, since])
      return rows.map((row): KeptWords => ({ from: row.source, id: row.id, subject: row.subject, at: Number(row.at), text: row.words, cut: row.cut }))
    },

    async pruneWords(before) {
      return (await db.query(`with gone as (delete from ${t('body')} where recorded_at < $1 returning 1) select count(*)::int as n from gone`, [before])).rows[0].n
    },

    async contactsOf(subjects) {
      const found = new Map<Subject, { field: 'phone' | 'email'; value: string; last: number }[]>()
      if (subjects.length === 0) return found
      const { rows } = await db.query(
        `select e.subject, starts_with(i.id, 'email:') as email, i.shown, e.last_at from ${t('edge')} e join ${t('identifier')} i on i.id = e.identifier
         where e.subject = any($1::text[]) and i.shown is not null order by e.last_at desc, i.id collate "C"`, [subjects])
      for (const row of rows) {
        const contact = { field: row.email ? 'email' as const : 'phone' as const, value: row.shown as string, last: Number(row.last_at) }
        const list = found.get(row.subject)
        if (list) list.push(contact)
        else found.set(row.subject, [contact])
      }
      return found
    },

    async namedLike(text, limit) {
      // Asked of the names alone, which are few beside the sightings. A name is found by any part of it.
      const { rows } = await db.query(`select subject from ${t('detail')} where field = 'name' and position(lower($1) in lower(value)) > 0 order by subject collate "C" limit $2`, [text, limit])
      return rows.map((row) => row.subject)
    },

    async detailsOf(subjects) {
      const found = new Map<Subject, Details>()
      if (subjects.length === 0) return found
      // What is said of the record itself, then the number and the email it was seen with last.
      const { rows } = await db.query(
        `select subject, field, value from ${t('detail')} where subject = any($1::text[])
         union all
         select subject, field, shown from (
           select distinct on (e.subject, field) e.subject, case when starts_with(i.id, 'email:') then 'email' else 'phone' end as field, i.shown
           from ${t('edge')} e join ${t('identifier')} i on i.id = e.identifier
           where e.subject = any($1::text[]) and i.shown is not null
           order by e.subject, field, e.last_at desc, i.id collate "C"
         ) seen`, [subjects])
      for (const row of rows) found.set(row.subject, { ...found.get(row.subject), [row.field]: row.value })
      return found
    },

    async createdAtStands(subject, createdAt, at, key) {
      return (await db.query(`select from ${t('profile_created')} where subject = $1 and created_at = $2 and at = $3 and key = $4`, [subject, createdAt, at, key])).rows.length > 0
    },

    async subjectDates(subjects) {
      if (subjects.length === 0) return new Map()
      const { rows } = await db.query(
        `select s.subject, p.created_at, least(
           (select min(first_at) from ${t('edge')} where subject = s.subject and not starts_with(identifier, 'review:')),
           (select min(first_at) from ${t('withdrawn_edge')} where subject = s.subject),
           (select min(at) from ${t('sighting')} where subject = s.subject and not starts_with(identifier, 'review:')),
           (select min(at) from ${t('touch')} where subject = s.subject),
           (select min(at) from ${t('outcome')} where subject = s.subject),
           (select min(at) from ${t('call')} where subject = s.subject),
           (select min(at) from ${t('message')} where subject = s.subject),
           (select min(at) from ${t('consent_log')} where subject = s.subject and (at <> 0 or source is distinct from 'before history' or key is not null)),
           (select min(at) from ${t('sent_link')} where subject = s.subject),
           (select min(first_at) from ${t('flow')} where source = s.subject),
           (select min(first_at) from ${t('flow')} where target = s.subject)
         ) as first_seen from unnest($1::text[]) s(subject) left join ${t('profile_created')} p on p.subject = s.subject`, [subjects])
      return new Map(rows.filter(row => row.first_seen !== null || row.created_at !== null).map(row => [row.subject, {
        ...(row.first_seen !== null && { firstSeen: Number(row.first_seen) }), ...(row.created_at !== null && { createdAt: Number(row.created_at) }),
      }]))
    },

    async textNumbers(subjects) {
      if (!subjects.length) return []
      // Only a number with a withdrawal needs the dated statements. Ordinary numbers still use their line's last word.
      const line = (id: string) => `'caller:' || substr(${id}, strpos(${id}, ':') + 1)`
      const phone = (id: string) => `(starts_with(${id}, 'phone:') or starts_with(${id}, 'voip:'))`
      const edges = (table: string, active: boolean) => `select subject, ${line('identifier')} as line, ${active} as active, first_at, last_at, sightings, profile_at, profile_key
        from ${t(table)} where subject = any($1::text[]) and ${phone('identifier')}`
      const { rows } = await db.query(`with edges as (${edges('edge', true)} union all ${edges('withdrawn_edge', false)}),
        numbers as (select subject, line, bool_or(active) as active, min(first_at) as first_at, max(last_at) as last_at, sum(sightings) as sightings from edges group by subject, line),
        cuts as (select subject, ${line('identifier')} as line, at, key from ${t('fact_withdrawal')} where subject = any($1::text[]) and ${phone('identifier')}),
        changed as (select subject, line, min(at) as first_cut from cuts group by subject, line),
        observations as (
          select c.subject, c.line, s.at, s.profile_key as key from changed c join ${t('sighting')} s on s.subject = c.subject
            and s.identifier in ('phone:' || substr(c.line, 8), 'voip:' || substr(c.line, 8))
          union all select p.subject, p.line, p.at, p.key from ${t('text_phone_profile')} p join changed c using (subject, line)
        ), known as (select subject, line, count(*) as sightings from observations group by subject, line),
        statements as (
          select subject, line, at, key, false as held from cuts
          union select n.subject, n.line, n.first_at, '', true from numbers n join changed c using (subject, line) where n.first_at <= c.first_cut
          union select e.subject, e.line, e.profile_at, e.profile_key, true from edges e join changed c using (subject, line) where e.profile_key is not null
          union select subject, line, at, key, true from observations where key is not null
        ), history as (select subject, line, jsonb_agg(jsonb_build_object('at', at, 'key', key, 'held', held) order by at, key collate "C", held desc) as held
          from statements group by subject, line)
        select subject, line, coalesce(n.active, false) as active, n.first_at, n.last_at, h.held, p.at, p.key, p.through_at, p.through_key,
          h.held is not null and n.sightings > coalesce(k.sightings, 0) as incomplete from numbers n
          full join (select * from ${t('text_stop')} where subject = any($1::text[])) p using (subject, line)
          left join history h using (subject, line) left join known k using (subject, line)`, [subjects])
      return rows.map(r => {
        const first = Number(r.first_at)
        const held = r.held ?? (r.at !== null && r.active ? [{ at: first, key: '', held: true }] : undefined)
        return { subject: r.subject, line: r.line, active: r.active, ...(r.first_at != null && { first }), ...(held && { held }), ...(r.incomplete && { uncertain: { first, last: Number(r.last_at) } }),
          ...(r.at !== null && { stop: Number(r.at), stopKey: r.key }), ...(r.through_at != null && { through: { at: Number(r.through_at), key: r.through_key } }) }
      })
    },

    async phoneHoldersBefore(identifiers, at) {
      if (!identifiers.length) return []
      const holders = (table: string) => `select subject, identifier, first_at, last_at, sightings
        from ${t(table)} where identifier = any($1::text[]) and first_at <= $2`
      const { rows } = await db.query(`${holders('edge')} union all ${holders('withdrawn_edge')}`, [identifiers, at])
      return rows.map(toEdge)
    },

    async keepTextStops(stops) {
      if (!stops.length) return
      // Keep the latest STOP and the latest overridden START independently. They can come from different withdrawals.
      await db.query(`insert into ${t('text_stop')} as kept (subject, line, at, key, through_at, through_key)
        select subject, line, max(at), (array_agg(key order by at desc, key collate "C" desc))[1],
          max(through_at), (array_agg(through_key order by through_at desc nulls last, through_key collate "C" desc nulls last))[1]
        from unnest($1::text[], $2::text[], $3::bigint[], $4::text[], $5::bigint[], $6::text[]) as asked(subject, line, at, key, through_at, through_key)
        group by subject, line on conflict (subject, line) do update set at = greatest(kept.at, excluded.at),
          key = case when (kept.at, kept.key) < (excluded.at, excluded.key) then excluded.key else kept.key end,
          through_at = greatest(kept.through_at, excluded.through_at),
          through_key = case when kept.through_at is null or (kept.through_at, kept.through_key) < (excluded.through_at, excluded.through_key) then excluded.through_key else kept.through_key end`,
        [stops.map(r => r.subject), stops.map(r => r.line), stops.map(r => r.at), stops.map(r => r.key), stops.map(r => r.through?.at ?? null), stops.map(r => r.through?.key ?? null)])
    },

    async edgesOf(subjects) {
      if (subjects.length === 0) return []
      const { rows } = await db.query(`select * from ${t('edge')} where subject = any($1::text[])`, [subjects])
      return rows.map(toEdge)
    },

    async edgesOn(identifiers) {
      if (identifiers.length === 0) return []
      const { rows } = await db.query(`select * from ${t('edge')} where identifier = any($1::text[])`, [identifiers])
      return rows.map(toEdge)
    },

    async *sharing(caps, alone) {
      const kinds = Object.keys(caps)
      const table = t(await snapshot.absent() ? 'identifier' : 'match_identifier')
      const { rows: unnamed } = await db.query(`select id from ${table} where fanout >= 2 and not ignored and split_part(id, ':', 1) <> all($1::text[]) limit 1`, [kinds])
      if (unnamed.length > 0) throw malformed(`Identifier "${unnamed[0].id}" has a kind that is missing from the policy`)
      const rows = cursor(
        db,
        page,
        `select x.subject as a, y.subject as b, array_agg(x.identifier) as identifiers, array_agg(i.fanout) as fanouts,
           array_agg(array[x.first_at, x.last_at, x.sightings, y.first_at, y.last_at, y.sightings]) as times
         from ${table} i
         join unnest($1::text[], $2::bigint[]) as rule (kind, cap) on rule.kind = split_part(i.id, ':', 1) and i.fanout <= rule.cap
         join ${t('edge')} x on x.identifier = i.id
         join ${t('edge')} y on y.identifier = i.id and y.subject > x.subject
         where i.fanout >= 2 and not i.ignored
         group by x.subject, y.subject
         having count(*) > 1 or bool_or(rule.kind = any($3::text[]))`,
        [kinds, kinds.map((kind) => caps[kind]), alone],
      )
      for await (const batch of rows) {
        yield batch.map((row) =>
          row.identifiers.map((identifier: Identifier, i: number) => {
            const [first, last, count, otherFirst, otherLast, otherCount] = row.times[i].map(Number)
            const pair = [{ subject: row.a, identifier, first, last, count }, { subject: row.b, identifier, first: otherFirst, last: otherLast, count: otherCount }] as [Edge, Edge]
            // The database orders text its own way. A pair is ordered as JavaScript orders it.
            if (pair[0].subject > pair[1].subject) pair.reverse()
            return { a: pair[0], b: pair[1], fanout: row.fanouts[i] }
          }),
        )
      }
    },

    async *everyone() {
      const rows = cursor(
        db,
        page,
        `select coalesce(s.id, held.subject) as id, s.component, s.cluster, held.subject is not null as held
         from ${t('subject')} s full join (select distinct subject from ${t('edge')} union select subject from ${t('withdrawn_edge')}) held on held.subject = s.id`,
        [],
      )
      for await (const batch of rows) yield batch.map((row) => ({ subject: row.id, labels: row.component === null ? undefined : { component: row.component, cluster: row.cluster }, held: row.held }))
    },

    async states(identifiers) {
      const out = new Map<Identifier, IdentifierState>()
      if (identifiers.length === 0) return out
      const { rows } = await db.query(
        await snapshot.absent()
          ? `select id, fanout, ignored from ${t('identifier')} where id = any($1::text[]) and (fanout > 0 or ignored)`
          : `${scopedStates('select distinct unnest($1::text[]) as id')} select id, fanout, ignored from states where fanout > 0 or ignored`,
        [identifiers],
      )
      for (const row of rows) out.set(row.id, { fanout: row.fanout, ignored: row.ignored })
      return out
    },

    async setIgnored(identifier, ignored) {
      await db.query(
        `insert into ${t('identifier')} (id, fanout, ignored) values ($1, 0, $2)
         on conflict (id) do update set ignored = excluded.ignored`,
        [identifier, ignored],
      )
    },

    async shared(subjects) {
      // Of a few, looking each up is quickest. Of many, PostgreSQL may read both tables whole instead.
      if (subjects.length < 2_000) {
        const states = await this.states([...new Set((await this.edgesOf(subjects)).map((edge) => edge.identifier))])
        return new Map([...states].filter(([, state]) => state.fanout > 1 && !state.ignored))
      }
      const { rows } = await db.query(
        await snapshot.absent()
          ? `select id, fanout from ${t('identifier')} where fanout > 1 and not ignored and id in (select identifier from ${t('edge')} where subject = any($1::text[]))`
          : `${scopedStates(`select distinct identifier as id from ${t('edge')} where subject = any($1::text[])`)} select id, fanout from states where fanout > 1 and not ignored`,
        [subjects],
      )
      return new Map(rows.map((row) => [row.id, { fanout: row.fanout, ignored: false }]))
    },

    async labelsOf(subjects) {
      if (subjects.length === 0) return new Map()
      const { rows } = await db.query(`select id, component, cluster from ${t('subject')} where id = any($1::text[])`, [subjects])
      return toLabels(rows)
    },

    async membersOf(components) {
      if (components.length === 0) return new Map()
      const { rows } = await db.query(`select id, component, cluster from ${t('subject')} where component = any($1::text[])`, [components])
      return toLabels(rows)
    },

    async clusterOf(cluster) {
      const { rows } = await db.query(`select id from ${t('subject')} where cluster = $1`, [cluster])
      return rows.map((row) => row.id as Subject)
    },

    async counts() {
      const { rows } = await db.query(
        `select (select count(*) from ${t('subject')})::int as subjects,
                (select count(distinct cluster) from ${t('subject')})::int as clusters,
                (select count(*) from ${t('identifier')} where fanout > 0)::int as identifiers,
                (select count(*) from ${t('edge')})::int as edges,
                (select count(*) from ${t('sighting')})::int as sightings,
                (select count(*) from ${t('touch')})::int as touches,
                (select count(*) from ${t('decision')})::int as decisions,
                (select count(*) from ${t('outcome')})::int as outcomes`,
      )
      return rows[0]
    },

    async version() {
      const { rows } = await db.query(`select writes from ${t('pulse')}`)
      return Number(rows[0]?.writes ?? 0)
    },

    async largestClusters(limit, offset = 0) {
      const { rows } = await db.query(
        `select cluster, count(*)::int as size from ${t('subject')} group by cluster having count(*) > 1 order by size desc, cluster collate "C" limit $1 offset $2`,
        [limit, offset],
      )
      return rows.map((row) => ({ id: row.cluster as Subject, size: row.size as number }))
    },

    async subjectsStarting(text, limit) {
      // starts_with takes the text as it is, so a percent sign or underscore in it means itself.
      const { rows } = await db.query(`select id from ${t('subject')} where starts_with(id, $1) order by id collate "C" limit $2`, [text, limit])
      return rows.map((row) => row.id as Subject)
    },

    async addChanges(at, changes) {
      await this.emit(changes.map(({ subject, from, to }) => ({ type: 'cluster.changed', at, subject, data: { subject, from: from ?? null, to: to ?? null } })))
    },

    async emit(given) {
      // One said already, or twice here, is left out before numbers are given.
      const names = given.flatMap(({ once }) => (once === undefined ? [] : [once]))
      const said = new Set(names.length > 0 ? (await db.query(`select said_once as name from ${t('event_once')} where said_once = any($1::text[])`, [names])).rows.map((row) => row.name) : [])
      const events = given.filter(({ once }) => once === undefined || (!said.has(once) && said.add(once)))
      if (events.length === 0) return 0
      const fresh = events.filter(({ once }) => once !== undefined)
      if (fresh.length > 0) await db.query(`insert into ${t('event_once')} (said_once, subject) select * from unnest($1::text[], $2::text[])`, [fresh.map(({ once }) => once), fresh.map(({ subject }) => subject ?? null)])
      await db.query(
        `with numbered as (update ${t('event_head')} set seq = seq + jsonb_array_length($1::jsonb) returning seq)
         insert into ${t('event')} (seq, type, at, data, subject, notice_key, callback_calls)
         select numbered.seq - jsonb_array_length($1::jsonb) + e.nth, e.v->>'type', (e.v->>'at')::bigint, e.v->'data', e.v->>'subject', case when e.v->>'type' = 'callback.overdue' then e.v->>'once' end,
           case when e.v ? 'calls' then array(select jsonb_array_elements_text(e.v->'calls')) end
         from numbered, jsonb_array_elements($1::jsonb) with ordinality as e (v, nth)`,
        [JSON.stringify(events)],
      )
      return events.length
    },

    async callbacksThrough(sources) {
      const { rows } = await db.query(`select key, callback_calls from ${t('alert')} where starts_with(key, 'unreturned:') and callback_calls && $1::text[]
        union select notice_key, callback_calls from ${t('event')} where type = 'callback.overdue' and notice_key is not null and callback_calls && $1::text[]`, [sources])
      return new Map(rows.map(row => [row.key, row.callback_calls]))
    },

    async dropCallbacks(keys) {
      await db.query(`delete from ${t('alert')} where key = any($1::text[])`, [keys])
      await db.query(`delete from ${t('event')} where type = 'callback.overdue' and notice_key = any($1::text[])`, [keys])
      await db.query(`delete from ${t('event_once')} where said_once = any($1::text[])`, [keys])
    },

    async eventHead() {
      const { rows } = await db.query(`select * from ${t('event_head')}`)
      return { seq: Number(rows[0].seq), epoch: rows[0].epoch, oldest: Number(rows[0].pruned) + 1 }
    },

    async eventsAfter(seq, limit) {
      const { rows } = await db.query(`select * from ${t('event')} where seq > $1 order by seq limit $2`, [seq, limit])
      return rows.map(toEvent)
    },

    async newEpoch() {
      return (await db.query(`update ${t('event_head')} set epoch = substr(md5(random()::text || clock_timestamp()::text), 1, 8) returning epoch`)).rows[0].epoch
    },

    async pruneEvents(before) {
      const { rows } = await db.query(
        `with upto as (select coalesce((select min(seq) from ${t('event')} where at >= $1), (select seq + 1 from ${t('event_head')})) as seq),
           gone as (delete from ${t('event')} where seq < (select seq from upto) returning seq),
           noted as (update ${t('event_head')} set pruned = greatest(pruned, coalesce((select max(seq) from gone), 0)))
         select count(*)::int as n from gone`,
        [before],
      )
      return rows[0].n
    },

    async pruneReceipts(before) {
      return (await db.query(`with gone as (delete from ${t('receipt')} where forgotten_at is null and ref_type is distinct from 'withdraw' and recorded_at < $1 returning 1) select count(*)::int as n from gone`, [before])).rows[0].n
    },

    async claimDelivery(sink, now, lease) {
      const { rows } = await db.query(
        `insert into ${t('event_delivery')} as d (sink, seq, due, attempts, lease_until) select $1, seq, 0, 0, $2::bigint + $3::bigint from ${t('event_head')}
         on conflict (sink) do update set lease_until = $2::bigint + $3::bigint where d.lease_until <= $2 and d.due <= $2 returning *`,
        [sink, now, lease],
      )
      return rows[0] && { sink, seq: Number(rows[0].seq), due: Number(rows[0].due), attempts: rows[0].attempts, ...(rows[0].since !== null && { since: Number(rows[0].since) }) }
    },

    async setDelivery({ sink, seq, due, attempts, since }) {
      await db.query(`update ${t('event_delivery')} set seq = $2, due = $3, attempts = $4, since = $5, lease_until = 0 where sink = $1`, [sink, seq, due, attempts, since ?? null])
    },

    async recentChanges(limit) {
      const { rows } = await db.query(`select * from ${t('event')} where type = 'cluster.changed' order by seq desc limit $1`, [limit])
      return rows.map(moved)
    },

    async changesAfter(seq, limit) {
      const { rows } = await db.query(`select * from ${t('event')} where type = 'cluster.changed' and seq > $1 order by seq limit $2`, [seq, limit])
      return rows.map((row) => ({ ...moved(row), seq: Number(row.seq) }))
    },

    async fed(feed, at) {
      await db.query(`insert into ${t('feed')} (name, last_at) values ($1, $2) on conflict (name) do update set last_at = greatest(${t('feed')}.last_at, excluded.last_at)`, [feed, at])
    },

    async empty() {
      const { rows } = await db.query(`select 1 from ${t('subject')} limit 1`)
      return rows.length === 0
    },

    async builtWith() {
      if (readOnly) return (await db.query(`select policy from ${t('built')}`)).rows[0]?.policy ?? undefined
      const { rows } = await db.query(`select (select policy from ${t('built')}) as policy, coalesce((select true from ${t('call_evidence')} order by call_id limit 1), false) as reserved`)
      snapshot.noReserved = rows[0]?.reserved === false
      return (rows[0]?.policy as string | undefined) ?? undefined
    },

    async setBuiltWith(hash) {
      await db.query(`insert into ${t('built')} (policy) values ($1) on conflict (one) do update set policy = excluded.policy`, [hash])
    },

    async kinds() {
      const { rows } = await db.query(`select distinct split_part(id, ':', 1) as kind from ${t('identifier')} where fanout > 0 order by 1`)
      return rows.map((row) => row.kind as string)
    },

    async setLabels(next) {
      const labels = [...next.values()]
      await db.query(
        `update ${t('subject')} set component = moved.component, cluster = moved.cluster
         from unnest($1::text[], $2::text[], $3::text[]) as moved (id, component, cluster) where ${t('subject')}.id = moved.id`,
        [[...next.keys()], labels.map((each) => each.component), labels.map((each) => each.cluster)],
      )
    },

    async setSeparated(a, b, separated) {
      const pair = a < b ? [a, b] : [b, a]
      if (separated) await db.query(`insert into ${t('apart')} (a, b) values ($1, $2) on conflict do nothing`, pair)
      else await db.query(`delete from ${t('apart')} where a = $1 and b = $2`, pair)
    },

    async separatedOf(subjects) {
      if (subjects.length === 0) return []
      const { rows } = await db.query(`select a, b from ${t('apart')} where a = any($1::text[]) or b = any($1::text[])`, [subjects])
      return rows.map((row) => [row.a, row.b] as [Subject, Subject])
    },

    async flowOf(id) {
      const { rows } = await db.query(`select * from ${t('transfer')} where id = $1`, [id])
      const row = rows[0]
      return row && { id: row.id, from: row.source, to: row.target, asset: row.asset, amount: Number(row.amount), at: Number(row.at) }
    },

    async addFlow({ id, from, to, amount, at, asset }) {
      await db.query(`insert into ${t('transfer')} (id, source, target, asset, amount, at) values ($1, $2, $3, $4, $5, $6)`, [id, from, to, asset, amount, at])
      await db.query(
        `insert into ${t('flow')} (source, target, asset, transfers, total, first_at, last_at) values ($1, $2, $3, 1, $4, $5, $5)
         on conflict (source, target, asset) do update set
           transfers = ${t('flow')}.transfers + 1,
           total = ${t('flow')}.total + excluded.total,
           first_at = least(${t('flow')}.first_at, excluded.first_at),
           last_at = greatest(${t('flow')}.last_at, excluded.last_at)`,
        [from, to, asset, amount, at],
      )
    },

    async flowsOf(subjects) {
      if (subjects.length === 0) return []
      const { rows } = await db.query(`select * from ${t('flow')} where source = any($1::text[]) or target = any($1::text[])`, [subjects])
      return rows.map(
        (row): FlowEdge => ({
          from: row.source,
          to: row.target,
          asset: row.asset,
          count: row.transfers,
          total: Number(row.total),
          first: Number(row.first_at),
          last: Number(row.last_at),
        }),
      )
    },

    async addConsent(subject, { at, adUserData, adPersonalization, source, recorded, key }) {
      await db.query(
        `insert into ${t('consent_log')} (subject, at, ad_user_data, ad_personalization, source, recorded_at, key) values ($1, $2, $3, $4, $5, $6, $7)`,
        [subject, at, adUserData, adPersonalization, source ?? null, recorded, key ?? null],
      )
    },

    async consentOf(subjects) {
      const out = new Map<Subject, Consent>()
      for (const row of await latestConsent(db, subjects)) out.set(row.subject, { adUserData: row.ad_user_data, adPersonalization: row.ad_personalization })
      return out
    },

    async consentHistory(subject, limit) {
      const { rows } = await db.query(`select * from ${t('consent_log')} where subject = $1 order by ${STANDING} limit $2`, [subject, limit ?? null])
      return rows.map((row) => ({ at: Number(row.at), adUserData: row.ad_user_data, adPersonalization: row.ad_personalization, ...(row.source !== null && { source: row.source }), recorded: Number(row.recorded_at), ...(row.key !== null && { key: row.key }) }))
    },

    async pruneConsent(before) {
      const { rows } = await db.query(
        `with gone as (
           delete from ${t('consent_log')} c where recorded_at < $1
             and id not in (select distinct on (subject) id from ${t('consent_log')} order by subject, ${STANDING}) returning 1
         ) select count(*)::int as n from gone`,
        [before],
      )
      return rows[0].n as number
    },

    async addTouch({ subject, at, ...detail }, call) {
      await db.query(`insert into ${t('touch')} (subject, at, detail, source_call) values ($1, $2, $3, $4)`, [subject, at, detail, call ?? null])
    },

    async dropTouch(subject, at, landing, call, confirmed = false) {
      await db.query(
        `with matches as (select id, source_call from ${t('touch')} where subject = $1 and at = $2 and detail->>'landing' = $3),
           own as (select id from matches where source_call = $4),
           older as (select id from matches where source_call is null order by id limit case when $5::boolean then null else 1 end)
         delete from ${t('touch')} where id in (select id from own union all select id from older where not exists (select from own))`,
        [subject, at, landing, call, confirmed],
      )
    },

    async callsBehind(touch) {
      const { rows } = await db.query(`with matches as (select source_call from ${t('touch')} where subject = $1 and at = $2 and detail->>'landing' = $3 and detail->>'source' is not distinct from $4 and detail->>'campaign' is not distinct from $5 and detail->>'campaignId' is not distinct from $6)
        select source_call as id from matches where source_call is not null union
        select id from ${t('call')} where subject = $1 and at = $2 and 'tel:' || dialed = $3 and direction = 'inbound' and visitor is null and party is null and exists (select from matches where source_call is null)`,
        [touch.subject, touch.at, touch.landing, touch.source ?? null, touch.campaign ?? null, touch.campaignId ?? null])
      return rows.map(row => row.id as string)
    },

    async touchesOf(subjects, from, to) {
      if (subjects.length === 0) return []
      const { rows } = await db.query(
        `select subject, at, detail from ${t('touch')} where subject = any($1::text[]) and at between $2 and $3 order by id`,
        [subjects, from, to],
      )
      return rows.map((row) => ({ ...row.detail, subject: row.subject, at: Number(row.at) }) as Touch)
    },

    async clicked(id, limit) {
      const { rows } = await db.query(`select distinct subject collate "C" as subject from ${t('touch')} where ${CLICKED} @> array[$1::text] order by 1 limit $2`, [id, limit])
      return rows.map((row) => row.subject as Subject)
    },

    async touchesBetween(from, to) {
      const { rows } = await db.query(`select subject, at, detail from ${t('touch')} where at >= $1 and at < $2 order by at, id`, [from, to])
      return rows.map((row) => ({ ...row.detail, subject: row.subject, at: Number(row.at) }) as Touch)
    },

    async setOutcome({ transactionId, subject, at, stage, value, currency, tags }) {
      await db.query(
        `insert into ${t('outcome')} (transaction_id, subject, at, stage, value, currency, tags) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (transaction_id) do update set subject = excluded.subject, at = excluded.at, stage = excluded.stage, value = excluded.value, currency = excluded.currency, tags = excluded.tags`,
        [transactionId, subject, at, stage, value, currency, tags ?? null],
      )
    },

    async outcomeOf(transactionId) {
      const { rows } = await db.query(`select * from ${t('outcome')} where transaction_id = $1`, [transactionId])
      return rows[0] && toCounted(rows[0])
    },

    async addValue(transactionId, subject, { value, currency, at, kind, why }) {
      await db.query(`insert into ${t('outcome_value')} (transaction_id, subject, value, currency, at, kind, why) values ($1, $2, $3, $4, $5, $6, $7)`, [transactionId, subject, value, currency, at, kind ?? null, why ?? null])
    },

    async valuesOf(transactionId, subject) {
      const { rows } = await db.query(`select value, currency, at, kind, why from ${t('outcome_value')} where transaction_id = $1 and subject = $2 order by id`, [transactionId, subject])
      return rows.map(toValue)
    },

    async firstValues(given) {
      if (given.length === 0) return new Map()
      const { rows } = await db.query(
        `with theirs as (
           select v.*, lag(v.value) over (partition by v.transaction_id order by v.id) - v.value as lost
           from unnest($1::text[], $2::text[]) as o (id, subject) join ${t('outcome_value')} v on v.transaction_id = o.id and v.subject = o.subject)
         select distinct on (transaction_id) *, max(value) over mine as most,
           coalesce(sum(lost) filter (where kind = 'refund') over mine, 0) + coalesce((select sum(amount) from ${t('payment')} p where p.transaction_id = theirs.transaction_id and p.kind = 'refund'), 0) + coalesce((select sum((x.data->>'amount')::float8) from ${t('said')} x where x.topic = 'worth' and x.about = theirs.transaction_id and x.data->>'kind' = 'refund'
             and not exists (select from ${t('said')} y where y.topic = 'worth' and y.about = x.about and y.data->>'kind' = 'reverse' and y.data->>'restatement' = x.key)
             and not exists (select from ${t('payment')} p where p.transaction_id = x.about)), 0) as refunded,
           coalesce(sum(lost) filter (where kind = 'write_off') over mine, 0) + coalesce((select sum((x.data->>'amount')::float8) from ${t('said')} x where x.topic = 'worth' and x.about = theirs.transaction_id and x.data->>'kind' = 'write_off'
             and not exists (select from ${t('said')} y where y.topic = 'worth' and y.about = x.about and y.data->>'kind' = 'reverse' and y.data->>'restatement' = x.key)
             and not exists (select from ${t('payment')} p where p.transaction_id = x.about)), 0) as written_off,
           array_agg(currency) filter (where kind is not null) over mine || array(select currency from ${t('payment')} p where p.transaction_id = theirs.transaction_id and p.kind = 'refund') as lost_in
         from theirs window mine as (partition by transaction_id) order by transaction_id, id`,
        [given.map((each) => each.transactionId), given.map((each) => each.subject)],
      )
      return new Map(rows.map((row) => [row.transaction_id as string, { ...toValue(row), most: row.most as number, refunded: row.refunded as number, writtenOff: row.written_off as number, lostIn: (row.lost_in ?? []) as string[] }]))
    },

    async removeOutcome(transactionId) {
      await db.query(`delete from ${t('outcome')} where transaction_id = $1`, [transactionId])
    },

    async setCall({ id, direction, subject, at, to, duration, flags, visitor, tags, recorded }, lineKind, pendingParty) {
      await db.query(
        `insert into ${t('call')} (id, subject, at, dialed, duration, flags, visitor, recorded_at, direction, tags, line_kind, line_subject)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, case when coalesce($12::boolean, exists (select from ${t('said')} where topic = 'party' and about = $1)) then $2 end)
         on conflict (id) do update set subject = excluded.subject, at = excluded.at, dialed = excluded.dialed, duration = excluded.duration,
           flags = excluded.flags, visitor = excluded.visitor, recorded_at = excluded.recorded_at, direction = excluded.direction, tags = excluded.tags where ${t('call')}.party is null`,
        [id, subject, at, to, duration ?? null, flags, visitor ?? null, recorded, direction, tags ?? null, lineKind ?? null, pendingParty ?? null],
      )
    },

    async callLine(id) {
      const { rows } = await db.query(`select coalesce(line_subject, subject) as line from ${t('call')} where id = $1`, [id])
      return rows[0]?.line
    },

    async applyCallParty(id, arriving = false) {
      const party = await partyOf(this, id)
      if (!party) return []
      const call = await this.callOf(id)
      if (!call) return []
      const owner = ownerOf(id, party)
      const { rows: [raw] } = await db.query(`select coalesce(line_subject, subject) as line, line_kind from ${t('call')} where id = $1`, [id])
      const line = raw.line
      const first = !call.party && !arriving
      const { changes, affected } = first ? await callTraces(this, call, line, raw.line_kind ?? undefined) : { changes: [], affected: [] }
      await this.reserveCall(changes.map(({ edge, recorded }) => ({ call: id, subject: edge.subject, identifier: edge.identifier, at: call.at, recorded })))
      for (const { edge, remove, next } of changes) {
        const { subject, identifier } = edge
        if (remove) await db.query(`delete from ${t('sighting')} where id in (select id from ${t('sighting')} where subject = $1 and identifier = $2 and at = $3 and event = 'call' order by id limit $4)`, [subject, identifier, call.at, remove])
        if (next) await db.query(`update ${t('edge')} set first_at = $3, last_at = $4, sightings = $5 where subject = $1 and identifier = $2`, [subject, identifier, next.first, next.last, next.count])
        else {
          await db.query(`delete from ${t('edge')} where subject = $1 and identifier = $2`, [subject, identifier])
          await db.query(`update ${t('identifier')} set fanout = fanout - 1, shown = case when fanout > 1 then shown end where id = $1`, [identifier])
        }
      }
      if (changes.length) {
        await db.query(`delete from ${t('identifier')} where id = any($1::text[]) and fanout <= 0 and not ignored`, [changes.map(({ edge }) => edge.identifier)])
        await db.query(`delete from ${t('subject')} s where id = any($1::text[]) and not exists (select from ${t('edge')} e where e.subject = s.id)`, [changes.map(({ edge }) => edge.subject)])
      }
      if (first && !call.visitor && call.direction === 'inbound') await this.dropTouch(line, call.at, `tel:${call.to}`, id, true)
      if (call.subject !== owner) await reopenWaits(this, [call])
      await db.query(`update ${t('call')} set line_subject = $2, line_kind = null, subject = $3, party = $4 where id = $1`, [id, line, owner, party])
      const transactionId = `call:${id}`
      if (owner !== call.subject) {
        for (const table of ['outcome', 'outcome_value']) await db.query(`update ${t(table)} set subject = $2 where transaction_id = $1 and subject = $3`, [transactionId, owner, call.subject])
      }
      // A worker can claim jobs outside the graph's write lock. Lock the rows before changing their revision.
      const { rows } = await db.query(`select * from ${t('conversion')} where transaction_id = $1 for update`, [transactionId])
      for (const row of rows) {
        const job = toJob(row)
        if (job.note !== 'call_party' || job.subject !== owner) await this.outbox.swap(job, stopCallJob(job, owner))
      }
      if (first || call.subject !== owner) await dropCallNotices(db, [id], [line, call.subject, owner], await affectedMisses(this, call, owner), first && call.direction === 'inbound' ? ['legacy:credit'] : [], Math.max(call.at, call.recorded), owner)
      return affected
    },

    async setCallResult(id, { answered, voicemail, waited, returned, recorded }) {
      await db.query(
        `insert into ${t('call_result')} (id, answered, voicemail, waited, returned_at, recorded_at) values ($1, $2, $3, $4, $5, $6)
         on conflict (id) do update set answered = excluded.answered, voicemail = excluded.voicemail, waited = excluded.waited, returned_at = excluded.returned_at, recorded_at = excluded.recorded_at`,
        [id, answered ?? null, voicemail ?? null, waited ?? null, returned ?? null, recorded],
      )
    },

    async notLeads(ids) {
      if (ids.length === 0) return new Map()
      const { rows } = await db.query(`select * from ${t('not_lead')} where id = any($1::text[])`, [ids])
      return new Map(rows.map((row) => [row.id, { kind: row.kind, at: Number(row.at) }]))
    },

    async setNotLead(id, said) {
      if (said) await db.query(`insert into ${t('not_lead')} (id, kind, at) values ($1, $2, $3) on conflict (id) do update set kind = excluded.kind, at = excluded.at`, [id, said.kind, said.at])
      else await db.query(`delete from ${t('not_lead')} where id = $1`, [id])
    },

    async pruneNotLeads(before) {
      const { rows } = await db.query(
        `with gone as (delete from ${t('not_lead')} n where at < $1 and not exists (select 1 from ${t('outcome')} o where o.transaction_id = n.id)
           and not exists (select 1 from ${t('call')} c where 'call:' || c.id = n.id) and not exists (select 1 from ${t('message')} m where 'text:' || m.id = n.id) returning 1) select count(*)::int as n from gone`,
        [before],
      )
      return rows[0].n
    },

    async removeCallResult(id) {
      await db.query(`delete from ${t('call_result')} where id = $1`, [id])
    },

    async callOf(id) {
      const { rows } = await db.query(`${callRows} where c.id = $1`, [id])
      return rows[0] && toCall(rows[0])
    },

    async callResultOf(id) {
      const { rows } = await db.query(`select answered, voicemail, waited, returned_at, recorded_at as result_at from ${t('call_result')} where id = $1`, [id])
      return rows[0] && toResult(rows[0])
    },

    async callsOf(subjects) {
      if (subjects.length === 0) return []
      const { rows } = await db.query(`${callRows} where c.subject = any($1::text[]) order by c.at, c.id collate "C"`, [subjects])
      return rows.map(toCall)
    },

    async openCalls(from, to, limit, after) {
      const { rows } = await db.query(
        `${callRows} where c.direction = 'inbound' and c.at >= $1 and c.at < $2 and r.answered = false and c.subject <> 'call:' || c.id
           and not exists (select 1 from ${t('not_lead')} n where n.id = 'call:' || c.id)
           and ($4::bigint is null or c.at > $4 or (c.at = $4 and c.id collate "C" > $5))
           and not exists (select 1 from ${t('call')} d join ${t('call_result')} s on s.id = d.id where d.subject = c.subject and not exists (select 1 from ${t('not_lead')} n where n.id = 'call:' || d.id) and ((d.at > c.at and s.answered) or (d.direction = 'inbound' and s.answered = false and s.returned_at > d.at and s.returned_at > c.at)))
         order by c.at, c.id collate "C" limit $3`,
        [from, to, limit, after?.at ?? null, after?.id ?? null],
      )
      return rows.map(toCall)
    },

    async callsWith(ids) {
      if (ids.length === 0) return []
      const { rows } = await db.query(`${callRows} where c.id = any($1::text[])`, [ids])
      return rows.map(toCall)
    },

    async callTimes(subjects) {
      if (subjects.length === 0) return []
      const { rows } = await db.query(
        `select c.id, c.direction, c.subject, c.at, c.party, r.answered, r.returned_at, r.waited from ${t('call')} c left join ${t('call_result')} r on r.id = c.id
         where c.subject = any($1::text[]) and not exists (select 1 from ${t('not_lead')} n where n.id = 'call:' || c.id) order by c.at, c.id collate "C"`,
        [subjects],
      )
      return rows.map(({ id, direction, subject, at, party, answered, returned_at: returned, waited }): CallTime => ({
        id,
        direction,
        subject,
        at: Number(at),
        ...(party && { party }),
        ...((answered !== null || returned !== null) && { result: { ...(answered !== null && { answered }), ...(returned !== null && { returned: Number(returned) }), ...(waited !== null && { waited }) } }),
      }))
    },

    async aroundOf(subjects) {
      if (subjects.length === 0) return new Map()
      const { rows } = await db.query(`select id, component, cluster from ${t('subject')} where component in (select component from ${t('subject')} where id = any($1::text[]))`, [subjects])
      return toLabels(rows)
    },

    async calledBetween(from, to) {
      const { rows } = await db.query(
        `select distinct c.subject from ${t('call')} c where c.at >= $1 and c.at < $2 and not exists (select 1 from ${t('not_lead')} n where n.id = 'call:' || c.id)`,
        [from, to],
      )
      return rows.map((row) => row.subject as Subject)
    },

    async missesBetween(from, to) {
      const { rows } = await db.query(
        `${callRows} where c.direction = 'inbound' and c.at >= $1 and c.at < $2 and (r.answered = false or exists (select 1 from ${t('not_lead')} n where n.id = 'call:' || c.id))
         order by c.at, c.id collate "C"`,
        [from, to],
      )
      return rows.map(toCall)
    },

    async addPayment({ id, transactionId, amount, kind, currency }) {
      await db.query(`insert into ${t('payment')} (id, transaction_id, amount, kind, currency) values ($1, $2, $3, $4, $5)`, [id, transactionId, amount, kind, currency])
    },

    async paymentOf(id) {
      const { rows } = await db.query(`select * from ${t('payment')} where id = $1`, [id])
      return rows[0] && toPayment(rows[0])
    },

    async paymentsOf(transactionId) {
      const { rows } = await db.query(`select * from ${t('payment')} where transaction_id = $1`, [transactionId])
      return rows.map(toPayment)
    },

    async setLink({ id, subject, purpose, at, expires, opened, openings }) {
      await db.query(
        `insert into ${t('sent_link')} (id, subject, purpose, at, expires_at, opened_at, openings) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (id) do update set opened_at = excluded.opened_at, openings = excluded.openings`,
        [id, subject, purpose ?? null, at, expires, opened ?? null, openings],
      )
    },

    async linkOf(id) {
      const { rows } = await db.query(`select * from ${t('sent_link')} where id = $1`, [id])
      return rows[0] && toLink(rows[0])
    },

    async linksSent(subjects) {
      if (subjects.length === 0) return []
      const { rows } = await db.query(`select * from ${t('sent_link')} where subject = any($1::text[]) order by at, id collate "C"`, [subjects])
      return rows.map(toLink)
    },

    async pruneLinks(before) {
      const { rows } = await db.query(`with gone as (delete from ${t('sent_link')} where expires_at < $1 returning 1) select count(*)::int as n from gone`, [before])
      return rows[0].n
    },

    async setText({ id, direction, subject, at, to, flags, visitor, tags, recorded }) {
      await db.query(
        `insert into ${t('message')} (id, direction, subject, at, ours, flags, visitor, tags, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (id) do update set direction = excluded.direction, subject = excluded.subject, at = excluded.at, ours = excluded.ours, flags = excluded.flags,
           visitor = excluded.visitor, tags = excluded.tags, recorded_at = excluded.recorded_at`,
        [id, direction, subject, at, to, flags, visitor ?? null, tags ?? null, recorded],
      )
    },

    async textOf(id) {
      const { rows } = await db.query(`select * from ${t('message')} where id = $1`, [id])
      return rows[0] && toText(rows[0])
    },

    async textsOf(subjects) {
      if (subjects.length === 0) return []
      const { rows } = await db.query(`select * from ${t('message')} where subject = any($1::text[]) order by at, id collate "C"`, [subjects])
      return rows.map(toText)
    },

    async openTexts(from, to, limit, after) {
      const { rows } = await db.query(
        `select * from (
           select distinct on (m.subject) m.* from ${t('message')} m
           where m.direction = 'inbound' and m.at >= $1 and m.at < $2 and not m.flags && array['opt_out', 'opt_in']
             and not exists (select 1 from ${t('message')} r where r.subject = m.subject and r.at > m.at and (r.direction = 'outbound' or 'opt_out' = any(r.flags)))
             and not exists (select 1 from ${t('call')} c join ${t('call_result')} s on s.id = c.id where c.subject = m.subject and c.at > m.at and s.answered
               and not exists (select 1 from ${t('not_lead')} n where n.id = 'call:' || c.id))
             and not exists (select 1 from ${t('message')} q join ${t('not_lead')} n on n.id = 'text:' || q.id where q.subject = m.subject)
           order by m.subject, m.at, m.id collate "C") oldest
         where $4::bigint is null or at > $4 or (at = $4 and id collate "C" > $5)
         order by at, id collate "C" limit $3`,
        [from, to, limit, after?.at ?? null, after?.id ?? null],
      )
      return rows.map(toText)
    },

    async callsBetween(from, to) {
      const { rows } = await db.query(`${callRows} where c.at >= $1 and c.at < $2 order by c.at, c.id collate "C"`, [from, to])
      return rows.map(toCall)
    },

    async newestLeases(numbers, by) {
      const { rows } = await db.query(`select distinct on (number) * from ${t('lease')} where number = any($1::text[]) and start_at <= $2 order by number, start_at desc`, [numbers, by])
      return rows.map((row): Lease => ({ number: row.number, subject: row.subject, start: Number(row.start_at), until: Number(row.until_at) }))
    },

    async setLease({ number, subject, start, until }) {
      await db.query(
        `insert into ${t('lease')} (number, subject, start_at, until_at) values ($1, $2, $3, $4)
         on conflict (number, start_at) do update set subject = excluded.subject, until_at = excluded.until_at`,
        [number, subject, start, until],
      )
    },

    async pruneLeases(before) {
      const { rows } = await db.query(`with gone as (delete from ${t('lease')} where until_at < $1 returning 1) select count(*)::int as n from gone`, [before])
      return rows[0].n
    },

    async pruneCallResults(before) {
      const { rows } = await db.query(
        `with gone as (delete from ${t('call_result')} r where recorded_at < $1 and not exists (select 1 from ${t('call')} c where c.id = r.id) returning id),
           unsaid as (delete from ${t('said')} s where topic in ('result', 'return', 'recording') and (about in (select id from gone) or (at < $1 and not exists (select from ${t('call')} c where c.id = s.about)))) select count(*)::int as n from gone`,
        [before],
      )
      return rows[0].n as number
    },

    async outcomesBetween(from, to) {
      const { rows } = await db.query(`select * from ${t('outcome')} where at >= $1 and at < $2 order by at, transaction_id collate "C"`, [from, to])
      return rows.map(toCounted)
    },

    async outcomesOf(subjects) {
      if (subjects.length === 0) return []
      const { rows } = await db.query(`select * from ${t('outcome')} where subject = any($1::text[]) order by at, transaction_id collate "C"`, [subjects])
      return rows.map(toCounted)
    },

    async newestOutcomes(from, to, each) {
      const { rows } = await db.query(
        `select * from (select o.*, row_number() over (partition by stage order by at desc, transaction_id collate "C" desc) as n from ${t('outcome')} o where at >= $1 and at < $2) as newest where n <= $3`,
        [from, to, each],
      )
      return rows.map(toCounted)
    },

    async addCosts(costs, read) {
      // Fold repeats first, keeping the last, because one statement cannot upsert the same row twice.
      const last = [...new Map(costs.map((cost) => [[cost.day, cost.source, cost.campaignId].join('\u0000'), cost])).values()]
      if (last.length === 0) return 0
      const { rows } = await db.query(
        `insert into ${t('cost')} (day, source, campaign_id, campaign, amount, currency, clicks, impressions, conversions, claimed_value, read_at, read_key)
         select *, $11::bigint, $12::text from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::float8[], $6::text[], $7::bigint[], $8::bigint[], $9::float8[], $10::float8[])
         on conflict (day, source, campaign_id) do update set
           campaign = excluded.campaign, amount = excluded.amount, currency = excluded.currency, clicks = excluded.clicks, impressions = excluded.impressions,
           conversions = excluded.conversions, claimed_value = excluded.claimed_value, read_at = excluded.read_at, read_key = excluded.read_key
         where $11::bigint is null or ${t('cost')}.read_at is null or (${t('cost')}.read_at, ${t('cost')}.read_key collate "C") <= ($11::bigint, $12::text collate "C")
         returning 1`,
        [
          last.map((c) => c.day),
          last.map((c) => c.source),
          last.map((c) => c.campaignId),
          last.map((c) => c.campaign),
          last.map((c) => c.amount),
          last.map((c) => c.currency),
          last.map((c) => c.clicks),
          last.map((c) => c.impressions),
          last.map((c) => c.conversions ?? null),
          last.map((c) => c.conversionValue ?? null),
          read?.at ?? null,
          read?.key ?? null,
        ],
      )
      return rows.length
    },

    async receiptOf(type, macs) {
      const { rows } = await db.query(`select * from ${t('receipt')} where type = $1 and key_mac = any($2::text[]) limit 1`, [type, macs])
      return rows[0] && toReceipt(rows[0])
    },

    async addReceipt({ type, mac, secretId, digest, version, ref, sent, at, recorded, forgotten }, subjects) {
      await db.query(
        `insert into ${t('receipt')} (type, key_mac, secret_id, digest, digest_version, ref_type, ref_mac, sent, at, recorded_at, forgotten_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [type, mac, secretId, digest && JSON.stringify(digest), version, ref?.type ?? null, ref?.mac ?? null, sent === undefined ? null : JSON.stringify(sent), at, recorded, forgotten ?? null],
      )
      if (subjects.length > 0) await db.query(`insert into ${t('receipt_subject')} (type, key_mac, subject) select $1, $2, * from unnest($3::text[]) on conflict do nothing`, [type, mac, subjects])
    },

    async setReceiptSent(type, macs, sent) {
      await db.query(`update ${t('receipt')} set sent = $3 where type = $1 and key_mac = any($2::text[])`, [type, macs, JSON.stringify(sent)])
    },

    async dropReceipt(type, macs) {
      await db.query(`delete from ${t('receipt')} where type = $1 and key_mac = any($2::text[])`, [type, macs])
    },

    async unname(subjects, keys) {
      await db.query(
        `update ${t('event')} set data = data || jsonb_build_object('from', case when data->>'from' = any($1::text[]) then null else data->'from' end, 'to', case when data->>'to' = any($1::text[]) then null else data->'to' end)
         where type = 'cluster.changed' and (data->>'from' = any($1::text[]) or data->>'to' = any($1::text[]))`,
        [subjects],
      )
      if (keys.length > 0) await db.query(`delete from ${t('alert')} where delivered_at is null and exists (select from unnest($1::text[]) as k (key) where position(k.key in text) > 0)`, [keys])
    },

    async keysOf(subjects, only) {
      const { rows } = await db.query(
        `with named as (${partyCalls}), theirs as (select transaction_id as id from ${t('outcome')} where $2::text[] is null and subject = any($1::text[])
           union select 'call:' || id from named
           union select transaction_id from ${t('outcome_value')} v where $2::text[] is null and subject = any($1::text[]) and not exists (select from ${t('outcome')} o where o.transaction_id = v.transaction_id))
         select 'conversion' as type, id as key from theirs
         union select 'call', id from ${t('call')} where $2::text[] is null and subject = any($1::text[])
         union select 'call', id from named
         union select 'call_update', key from ${t('said')} where topic = 'party' and (about in (select id from named) or (data->>'subject' = any($1::text[]) and ($2::text[] is null or about = any($2))))
         union all select 'text', id from ${t('message')} where $2::text[] is null and subject = any($1::text[])
         union all select 'payment', id from ${t('payment')} where transaction_id in (select id from theirs)
         union all select 'transfer', id from ${t('transfer')} where $2::text[] is null and (source = any($1::text[]) or target = any($1::text[]))
         union all select 'link', id from ${t('sent_link')} where $2::text[] is null and subject = any($1::text[])`,
        [subjects, only ?? null],
      )
      return rows.map((row) => ({ type: row.type, key: row.key }))
    },

    async retainedPartyCalls(subjects, only) {
      return (await db.query(retainedPartyCalls, [subjects, only ?? null])).rows.map(row => row.id)
    },

    async forgetReceipts(subjects, keys, at, retainedCalls = [], only) {
      if (retainedCalls.length) await db.query(
        `delete from ${t('receipt_subject')} s using ${t('receipt')} r where s.subject = any($1::text[]) and s.type = r.type and s.key_mac = r.key_mac and
          ((r.type = 'call' and r.key_mac = any($2::text[])) or (r.ref_type = 'call' and r.ref_mac = any($2::text[])))`, [subjects, retainedCalls],
      )
      await db.query(
        `insert into ${t('receipt')} (type, key_mac, secret_id, digest, digest_version, at, recorded_at)
         select k.type, k.mac, k.secret_id, null, 0, $4, $4 from unnest($1::text[], $2::text[], $3::text[]) as k (type, mac, secret_id)
         where not exists (select from jsonb_to_recordset($5::jsonb) as a (type text, mac text, other text) join ${t('receipt')} r on r.type = a.type and r.key_mac = a.other where a.type = k.type and a.mac = k.mac)
         on conflict do nothing`,
        [keys.map((each) => each.type), keys.map((each) => each.mac), keys.map((each) => each.secretId), at, JSON.stringify(keys.flatMap(({ type, mac, all }) => all.map((other) => ({ type, mac, other }))))],
      )
      await db.query(
        `with own as (
             select a.type, a.other as mac from jsonb_to_recordset($2::jsonb) as a (type text, other text)
             union select type, key_mac from ${t('receipt_subject')} where subject = any($1::text[])),
           gone as (
             update ${t('receipt')} r set digest = null, sent = null, ref_type = null, ref_mac = null, forgotten_at = $3
             where exists (select from own where own.type = r.type and own.mac = r.key_mac) or exists (select from own where own.type = r.ref_type and own.mac = r.ref_mac)
             returning r.type, r.key_mac)
         delete from ${t('receipt_subject')} s using gone where s.type = gone.type and s.key_mac = gone.key_mac`,
        [only ? [] : subjects, JSON.stringify(keys.flatMap(({ type, all }) => all.map((other) => ({ type, other })))), at],
      )
    },

    async receiptSecrets() {
      return (await db.query(`select distinct secret_id from ${t('receipt')}`)).rows.map((row) => row.secret_id)
    },

    settingOf: (name) => settingOf(db, name),

    async setSetting(name, value) {
      await db.query(`insert into ${t('setting')} (name, value) values ($1, $2) on conflict (name) do update set value = excluded.value`, [name, value])
    },

    async addSaid({ topic, about, key, at, data }) {
      const { rows } = await db.query(`insert into ${t('said')} (topic, about, key, at, data) values ($1, $2, $3, $4, $5) on conflict do nothing returning 1`, [topic, about, key, at, data])
      return rows.length > 0
    },

    async saidOf<T extends Topic>(topic: T, about: string) {
      const { rows } = await db.query(`select * from ${t('said')} where topic = $1 and about = $2`, [topic, about])
      return rows.map((row) => ({ topic, about, key: row.key, at: Number(row.at), data: row.data })) as unknown as SaidOf<T>[]
    },

    async saidAbout<T extends Topic>(topic: T, about: readonly string[]) {
      if (about.length === 0) return []
      const { rows } = await db.query(`select * from ${t('said')} where topic = $1 and about = any($2::text[])`, [topic, about])
      return rows.map((row) => ({ topic, about: row.about, key: row.key, at: Number(row.at), data: row.data })) as unknown as SaidOf<T>[]
    },

    async costsBetween(from, to) {
      const { rows } = await db.query(`select * from ${t('cost')} where day >= $1 and day <= $2 order by day, source collate "C", campaign_id collate "C"`, [from, to])
      return rows.map((row) => ({
        day: row.day,
        source: row.source,
        campaignId: row.campaign_id,
        campaign: row.campaign,
        amount: row.amount,
        currency: row.currency,
        clicks: Number(row.clicks),
        impressions: Number(row.impressions),
        ...(row.conversions !== null && { conversions: row.conversions as number }),
        ...(row.claimed_value !== null && { conversionValue: row.claimed_value as number }),
      }))
    },

    async history(subject, limit) {
      // Take the newest rows first when there is a limit, then hand them back oldest first.
      const { rows } = await db.query(
        `select subject, identifier, at, event, recorded_at from ${t('sighting')} where subject = $1 order by at desc, id desc limit $2`,
        [subject, limit ?? null],
      )
      return rows.reverse().map(row => toSighting(row))
    },

    async latelySeen(sightings) {
      const { rows } = await db.query(
        `with newest as materialized (select subject, recorded_at from ${t('sighting')} order by recorded_at desc, subject collate "C" limit $1)
         select subject, min(recorded_at) as oldest, count(*) as n, (select count(*) > $2 from newest) as older
         from (select * from newest order by recorded_at desc, subject collate "C" limit $2) taken group by subject`,
        [Number.isFinite(sightings) ? sightings + 1 : null, Number.isFinite(sightings) ? sightings : null],
      )
      return { subjects: rows.map(row => row.subject as Subject), count: rows.reduce((sum, row) => sum + Number(row.n), 0), oldest: rows.length ? rows.reduce((at, row) => Math.min(at, Number(row.oldest)), Infinity) : null, older: Boolean(rows[0]?.older) }
    },

    async subjectPage(after, inclusive, limit) {
      const { rows } = await db.query(`select id from ${t('subject')} where id collate "C" ${inclusive ? '>=' : '>'} $1 order by id collate "C" limit $2`, [after ?? '', limit])
      return rows.map(row => row.id as Subject)
    },

    async *sightingsUntil(recorded) {
      for await (const batch of cursor(db, page, `select * from ${t('sighting')} where recorded_at <= $1 order by id`, [recorded])) yield batch.map(row => toSighting(row, true))
    },

    async pruneSightings(before) {
      const { rows } = await db.query(`with gone as (delete from ${t('sighting')} where recorded_at < $1 returning 1) select count(*)::int as n from gone`, [before])
      return rows[0].n as number
    },

    async addDecision({ seq, at, action, about, by, reason, hash }) {
      await db.query(
        `insert into ${t('decision')} (seq, at, action, about, actor, reason, hash) values ($1, $2, $3, $4, $5, $6, $7)`,
        [seq, at, action, JSON.stringify(about), by ?? null, reason ?? null, hash],
      )
    },

    async lastDecision() {
      const { rows } = await db.query(`select * from ${t('decision')} order by seq desc limit 1`)
      return rows[0] && toDecision(rows[0])
    },

    async decisions() {
      const { rows } = await db.query(`select * from ${t('decision')} order by seq`)
      return rows.map(toDecision)
    },

    async decisionPage({ before, limit, author }) {
      const which = author === undefined ? '' : author === 'people' ? `and (actor is null or not starts_with(actor, 'system:'))` : author === 'system' ? `and starts_with(actor, 'system:')` : 'and actor = $3'
      const { rows } = await db.query(`select * from ${t('decision')} where ($1::bigint is null or seq < $1) ${which} order by seq desc limit $2`, [before ?? null, limit, ...(which.includes('$3') ? [author] : [])])
      return rows.map(toDecision)
    },

    async partyReturn(subject, call) {
      const { rows: [row] } = await db.query(`select erased.seq, exists (select from ${t('call')} c where c.id = $2 and c.at > erased.at)
        and (exists (select from ${t('edge')} e where e.subject = $1 and not starts_with(e.identifier, 'review:'))
          or exists (select from ${t('withdrawn_edge')} w where w.subject = $1 and not starts_with(w.identifier, 'review:'))) as allowed
        from (${erasedRecord('$1')}) erased`, [subject, call])
      return !row ? undefined : row.allowed ? Number(row.seq) : 'forgotten'
    },

    async confirmPartyReturn(call, key, deletion) {
      await db.query(`update ${t('said')} set returned_after = $3 where topic = 'party' and about = $1 and key = $2`, [call, key, deletion])
    },

    async decisionsNaming(subjects) {
      if (subjects.length === 0) return []
      const { rows } = await db.query(`select * from ${t('decision')} where action not in ('ignore', 'restore', 'prune') and about ?| $1::text[] order by seq`, [subjects])
      return rows.map(toDecision)
    },

    async newestNaming(names, after, among) {
      const { rows } = await db.query(`select * from ${t('decision')} where seq > $1 and action <> 'prune' and ($3::text[] is null or action = any($3::text[])) and about ?| $2::text[] order by seq desc limit 1`, [after, names, among ?? null])
      return rows[0] && toDecision(rows[0])
    },

    async decisionsAbout(pairs) {
      if (pairs.length === 0) return []
      const { rows } = await db.query(
        `select d.* from unnest($1::text[], $2::text[]) as pair (a, b)
         join ${t('decision')} d on d.about->>0 = pair.a and d.about->>1 = pair.b where d.action in ('join', 'unjoin', 'separate', 'rejoin') order by d.seq`,
        [pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])],
      )
      return rows.map(toDecision)
    },

    async pairsDecidedBySystems(times) {
      const { rows } = await db.query(
        `select about->>0 as a, about->>1 as b from ${t('decision')} where starts_with(actor, 'system:') and action in ('join', 'unjoin', 'separate', 'rejoin')
         group by 1, 2 having count(*) >= $1`,
        [times],
      )
      return rows.map((row) => [row.a, row.b] as [Subject, Subject])
    },
  })

  // Writes wait for one another at the database in any case. Those of one store wait here, so a long one leaves the pool's
  // connections to whoever reads, and the server answers while it lasts.
  let turn: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const mine = turn.then(work)
    turn = mine.catch(() => undefined)
    return mine
  }

  async function pendingUpgrades(db: Queryable) {
    const { rows } = await db.query(`select id, name from ${t('upgrade')}`)
    const all = upgrades(schema)
    // A database made before the first release was built by steps this version no longer has, and cannot be brought forward.
    const unknown = rows.find(row => all.find(upgrade => upgrade.id === row.id)?.name !== row.name)
    if (unknown) throw fault(FAULT_CODES.CONFIG.MISMATCH, `The database schema "${schema}" was made by a version before 0.1.0 (it has the step "${unknown.name}"). Use a new database or schema.`)
    const done = new Set(rows.map(row => row.id as number))
    return all.filter(upgrade => !done.has(upgrade.id))
  }

  async function run<T>(begin: string, lock: 'none' | 'shared' | 'exclusive', work: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    let lost = false
    try {
      await client.query(lock !== 'none' && lockTimeout > 0 ? `${begin}; set local lock_timeout = ${Math.ceil(lockTimeout)}` : begin)
      if (lock !== 'none') await client.query(`select pg_advisory_xact_lock${lock === 'shared' ? '_shared' : ''}(hashtext($1))`, [`account-graph:${schema}`])
      const result = await work(bind(client, begin === READ_ONLY))
      // A write is counted as it commits, in the same trip to the database.
      try {
        await client.query(lock === 'exclusive' ? `update ${t('pulse')} set writes = writes + 1; commit` : 'commit')
      } catch (error) {
        // The answer to a commit was lost, so it may have been made.
        if (lock === 'exclusive' && error instanceof Error && !('severity' in error)) Object.assign(error, { committing: true })
        throw error
      }
      return result
    } catch (error) {
      // A statement nobody answered leaves a connection that answers nothing. It is given up, and not asked to roll back.
      lost = silent(error)
      if (!lost) await client.query('rollback').catch((again) => void (lost = silent(again)))
      const code = sqlState(error)
      // A fresh reader learns the schema is old only if its query needs a missing column or table.
      if (!lost && begin === READ_ONLY && (code === '42703' || code === '42P01' || code === '3F000')) {
        const [next] = await pendingUpgrades(client).catch((check: unknown) => {
          if (sqlState(check) === '42P01' || sqlState(check) === '3F000') return upgrades(schema)
          lost = silent(check)
          throw check
        })
        if (next) throw fault(FAULT_CODES.CONFIG.MISMATCH, `Database upgrade ${next.id} (${next.name}) must run before this read. Start the upgraded server or call store.migrate().`)
      }
      throw error
    } finally {
      client.release(lost)
    }
  }

  // The send holds shared locks on its jobs until the request starts. Other outbox operations take one statement.
  const toJob = (row: any): Job => ({ ...row.job, state: row.state, due: Number(row.due), attempts: row.attempts, rev: Number(row.rev) })
  async function standing(db: Queryable, jobs: readonly Job[], lock = false): Promise<Job[]> {
    const { rows } = await db.query(
      `select c.transaction_id, c.target from unnest($1::text[], $2::text[], $3::bigint[]) as j (id, target, rev)
       join ${t('conversion')} c on c.transaction_id = j.id and c.target = j.target and c.rev = j.rev ${lock ? 'for share of c' : ''}`,
      [jobs.map((job) => job.transactionId), jobs.map((job) => job.target), jobs.map((job) => job.rev)],
    )
    const found = new Set(rows.map((row) => `${row.transaction_id}\u0000${row.target}`))
    return jobs.filter((job) => found.has(`${job.transactionId}\u0000${job.target}`))
  }
  const outboxOn = (db: Queryable): OutboxStore => ({
    async add(job, counted = false) {
      // The outcome is held until the job is there, so a deletion waits for it and then finds the job to delete.
      const there = counted ? `from (select 1 from ${t('outcome')} where transaction_id = $1 and subject = $6::jsonb->>'subject' for key share) as o` : ''
      const { rows } = await db.query(
        `with added as (
           insert into ${t('conversion')} (transaction_id, target, state, due, attempts, job) select $1, $2, $3, $4::bigint, $5::int, $6::jsonb ${there}
           on conflict (transaction_id, target) do nothing returning *
         )
         select * from added union all select * from ${t('conversion')} where transaction_id = $1 and target = $2 limit 1`,
        [job.transactionId, job.target, job.state, job.due, job.attempts, job],
      )
      // Another call may have added it in the same moment, too late for the statement above to see. A new one sees it.
      const row = rows[0] ?? (await db.query(`select * from ${t('conversion')} where transaction_id = $1 and target = $2`, [job.transactionId, job.target])).rows[0]
      return row && toJob(row)
    },
    async claim(now, lease, limit) {
      const { rows } = await db.query(
        `update ${t('conversion')} c set attempts = c.attempts + 1, due = $1::bigint + $2::bigint, rev = c.rev + 1
         where (c.transaction_id, c.target) in (
           select transaction_id, target from ${t('conversion')}
           where state = 'pending' and due <= $1 order by due limit $3 for update skip locked
         )
         returning *`,
        [now, lease, limit],
      )
      return rows.map(toJob).sort((x, y) => (x.transactionId < y.transactionId ? -1 : x.transactionId > y.transactionId ? 1 : x.target < y.target ? -1 : 1))
    },
    async swap(before, after) {
      const { rows } = await db.query(
        `update ${t('conversion')} set state = $3, due = $4, attempts = $5, job = $6, rev = rev + 1 where transaction_id = $1 and target = $2 and rev = $7 returning 1`,
        [after.transactionId, after.target, after.state, after.due, after.attempts, after, before.rev],
      )
      return rows.length > 0
    },
    standing: (jobs) => standing(db, jobs),
    async start(jobs, send, subjects = []) {
      const refusals = new Map<Subject, number>()
      for (const row of await latestConsent(db, subjects)) if (!row.ad_user_data) refusals.set(row.subject, Number(row.at))
      send(await standing(db, jobs, true), await settingOf(db, 'callParty'), refusals)
    },
    async get(transactionId) {
      const { rows } = await db.query(`select * from ${t('conversion')} where transaction_id = $1 order by target`, [transactionId])
      return rows.map(toJob)
    },
    async list(state, limit) {
      const { rows } = await db.query(`select * from ${t('conversion')} where state = $1 order by due desc, transaction_id limit $2`, [state, limit])
      return rows.map(toJob)
    },
    async oldestDue() {
      const { rows } = await db.query(`select min(due) as due from ${t('conversion')} where state = 'pending'`)
      return rows[0].due === null ? undefined : Number(rows[0].due)
    },
    async counts() {
      const out: Record<JobState, number> = { held: 0, pending: 0, sent: 0, skipped: 0, failed: 0 }
      const { rows } = await db.query(`select state, count(*)::int as n from ${t('conversion')} group by state`)
      for (const row of rows) out[row.state as JobState] = row.n
      return out
    },
  })
  const outbox: OutboxStore = {
    ...outboxOn(pool),
    // The shared graph lock also guards the time before the first party statement creates its setting.
    start: (jobs, send, subjects) => run('begin', 'shared', (tx) => tx.outbox.start(jobs, send, subjects)),
  }

  const toAlert = (row: any): KeptAlert => ({ key: row.key, text: row.text, at: Number(row.at), ...(row.subject !== null && { subject: row.subject }), ...(row.error !== null && { error: row.error }) })
  const ops: OpsStore = {
    async feeds() {
      const { rows } = await pool.query(`select * from ${t('feed')}`)
      return new Map(rows.map((row) => [row.name as Feed, { ...(row.last_at !== null && { last: Number(row.last_at) }), ...(row.watched_at !== null && { watched: Number(row.watched_at) }) }]))
    },
    async watch(feed, at) {
      await pool.query(`insert into ${t('feed')} as f (name, watched_at) values ($1, $2) on conflict (name) do update set watched_at = coalesce(f.watched_at, excluded.watched_at)`, [feed, at])
    },
    async jobStarted(run, name, at, forgotten) {
      await pool.query(
        `with gone as (delete from ${t('job_run')} where name = $2 and started_at < $4), begun as (insert into ${t('job_run')} (id, name, started_at) values ($1, $2, $3))
         insert into ${t('job')} (name, started_at, run) values ($2, $3, $1) on conflict (name) do update set started_at = excluded.started_at, run = excluded.run, outcome = null`,
        [run, name, at, forgotten],
      )
    },
    async jobEnded(run, name, at, error) {
      await pool.query(
        `with ended as (delete from ${t('job_run')} where id = $1)
         insert into ${t('job')} as j (name, started_at, run, succeeded_at, failed_at, error, outcome)
           values ($2, $3, $1, case when $4::text is null then $3::bigint end, case when $4::text is not null then $3::bigint end, $4, case when $4::text is null then 'done' else 'failed' end)
         on conflict (name) do update set succeeded_at = coalesce(excluded.succeeded_at, j.succeeded_at), failed_at = coalesce(excluded.failed_at, j.failed_at), error = coalesce(excluded.error, j.error),
           outcome = case when j.run = $1 then excluded.outcome else j.outcome end`,
        [run, name, at, error ?? null],
      )
    },
    async jobs() {
      const { rows } = await pool.query(`select j.*, array(select started_at from ${t('job_run')} r where r.name = j.name order by started_at desc) as open from ${t('job')} j order by name collate "C"`)
      return rows.map((row) => ({
        name: row.name,
        started: Number(row.started_at),
        ...(row.succeeded_at !== null && { succeeded: Number(row.succeeded_at) }),
        ...(row.failed_at !== null && { failed: Number(row.failed_at) }),
        ...(row.error !== null && { error: row.error }),
        ...(row.outcome !== null && { outcome: row.outcome }),
        open: row.open.map(Number),
      }))
    },
    addAlert: (alert, again, calls) => addAlert(pool, alert, again, calls),
    pendingAlert: (alert, start) => run('begin', 'none', tx => tx.pendingAlert(alert, start)),
    async keepAlert({ key, text, at, subject, error }) {
      await pool.query(
        `insert into ${t('alert')} as a (key, text, at, subject, error, tried_at) values ($1, $2, $3, $4, $5, $3)
         on conflict (key) do update set at = excluded.at, error = excluded.error, tried_at = excluded.tried_at, delivered_at = null where a.delivered_at is not null`,
        [key, text, at, subject ?? null, error ?? null],
      )
    },
    async claimAlert(now, before) {
      const { rows } = await pool.query(
        `update ${t('alert')} set tried_at = $1::bigint where key = (
           select key from ${t('alert')} where delivered_at is null and tried_at <= $2::bigint order by tried_at, at limit 1 for update skip locked
         ) returning *`,
        [now, before],
      )
      return rows[0] && toAlert(rows[0])
    },
    async alertDelivered(key, at, expected) {
      if (expected && key.startsWith('alert:conversions:')) {
        await pool.query(`delete from ${t('alert')} where key = $1 and text = $2 and at = $3 and delivered_at is null`, [key, expected.text, expected.at])
        return
      }
      await pool.query(`update ${t('alert')} set delivered_at = $2 where key = $1 and ($3::text is null or (text = $3 and at = $4))`, [key, at, expected?.text ?? null, expected?.at ?? null])
    },
    async alertFailed(key, error, expected) {
      await pool.query(`update ${t('alert')} set error = $2 where key = $1 and ($3::text is null or (text = $3 and at = $4))`, [key, error, expected?.text ?? null, expected?.at ?? null])
    },
    async undelivered() {
      const { rows } = await pool.query(`select * from ${t('alert')} where delivered_at is null order by at`)
      return rows.map(toAlert)
    },
  }

  return {
    outbox,
    ops,
    write: (work) => inTurn(() => run('begin', 'exclusive', work)),
    read: (work) => run(READ_ONLY, 'none', work),
    async migrate() {
      const client = await pool.connect()
      const key = [`account-graph:${schema}:upgrade`]
      let locked = false
      try {
        // Serialize startup across commits, including the first creation of the upgrade ledger.
        await client.query('select pg_advisory_lock(hashtext($1))', key)
        locked = true
        await client.query('begin')
        await client.query(`create schema if not exists ${schema};
          create table if not exists ${t('upgrade')} (id int primary key, name text not null, applied_at bigint not null)`)
        const applied: string[] = []
        for (const upgrade of await pendingUpgrades(client)) {
          // Each upgrade is kept as it finishes, so one that fails later does not undo it.
          if (applied.length) {
            await client.query('commit')
            await client.query('begin')
          }
          await client.query(upgrade.sql)
          await client.query(`insert into ${t('upgrade')} (id, name, applied_at) values ($1, $2, $3)`, [upgrade.id, upgrade.name, Date.now()])
          applied.push(upgrade.name)
        }
        await client.query('commit')
        return applied
      } catch (error) {
        await client.query('rollback').catch(() => undefined)
        throw error
      } finally {
        const released = locked && await client.query('select pg_advisory_unlock(hashtext($1))', key).then(() => true, () => false)
        client.release(!released)
      }
    },
  }
}

const moved = (row: any): Moved => ({ subject: row.data.subject, from: row.data.from ?? undefined, to: row.data.to ?? undefined, at: Number(row.at) })

function toSighting(row: any, replay = false): Sighting {
  const sighting = { subject: row.subject, identifier: row.identifier, at: Number(row.at), recorded: Number(row.recorded_at) }
  if (replay && row.profile_key != null) Object.assign(sighting, { profileKey: row.profile_key }, row.source_fact != null && { fact: row.source_fact })
  return row.event === null ? sighting : { ...sighting, event: row.event }
}

function toCounted(row: any): Counted {
  return { transactionId: row.transaction_id, subject: row.subject, at: Number(row.at), stage: row.stage, value: row.value, currency: row.currency, ...(row.tags !== null && { tags: row.tags }) }
}

function toEvent(row: any): GraphEvent {
  return { schemaVersion: 1, seq: Number(row.seq), type: row.type, at: Number(row.at), data: row.data }
}

function toReceipt(row: any): Receipt {
  return {
    type: row.type, mac: row.key_mac, secretId: row.secret_id, digest: row.digest, version: row.digest_version, at: Number(row.at), recorded: Number(row.recorded_at),
    ...(row.ref_type !== null && { ref: { type: row.ref_type, mac: row.ref_mac } }), ...(row.sent !== null && { sent: row.sent }), ...(row.forgotten_at !== null && { forgotten: Number(row.forgotten_at) }),
  }
}

function toValue(row: any): OutcomeValue {
  return { value: row.value, currency: row.currency, at: Number(row.at), ...(row.kind && { kind: row.kind }), ...(row.why && { why: row.why }) }
}

function toResult(row: any): CallResult {
  return { ...(row.answered !== null && { answered: row.answered }), ...(row.voicemail !== null && { voicemail: row.voicemail }), ...(row.waited !== null && { waited: row.waited }), ...(row.returned_at !== null && { returned: Number(row.returned_at) }), recorded: Number(row.result_at) }
}

function toCall(row: any): KeptCall {
  return {
    id: row.id,
    direction: row.direction,
    subject: row.subject,
    at: Number(row.at),
    to: row.dialed,
    ...(row.duration !== null && { duration: row.duration }),
    flags: row.party ? withoutGuesses(row.flags) : row.flags,
    ...(row.party && { party: row.party }),
    ...(!row.party && row.visitor !== null && { visitor: row.visitor }),
    ...(row.tags !== null && { tags: row.tags }),
    recorded: Number(row.recorded_at),
    ...(row.result_at !== null && { result: toResult(row) }),
  }
}

const toPayment = (row: any): Required<Payment> => ({ id: row.id, transactionId: row.transaction_id, amount: row.amount, kind: row.kind, currency: row.currency })

function toLink(row: any): SentLink {
  return {
    id: row.id,
    subject: row.subject,
    ...(row.purpose !== null && { purpose: row.purpose }),
    at: Number(row.at),
    expires: Number(row.expires_at),
    ...(row.opened_at !== null && { opened: Number(row.opened_at) }),
    openings: row.openings,
  }
}

function toText(row: any): KeptText {
  return {
    id: row.id,
    direction: row.direction,
    subject: row.subject,
    at: Number(row.at),
    to: row.ours,
    flags: row.flags,
    ...(row.visitor !== null && { visitor: row.visitor }),
    ...(row.tags !== null && { tags: row.tags }),
    recorded: Number(row.recorded_at),
  }
}

function toDecision(row: any): Decision {
  return {
    seq: Number(row.seq),
    at: Number(row.at),
    action: row.action,
    about: row.about,
    ...(row.actor !== null && { by: row.actor }),
    ...(row.reason !== null && { reason: row.reason }),
    hash: row.hash,
  }
}

function toLabels(rows: any[]): Map<Subject, Labels> {
  return new Map(rows.map((row) => [row.id as Subject, { component: row.component as Subject, cluster: row.cluster as Subject }]))
}

let cursors = 0

/** The rows of a query, a page at a time, so that they are never all in memory. Needs a transaction, as every `Tx` has. */
async function* cursor(db: Queryable, page: number, text: string, given: readonly unknown[]): AsyncGenerator<any[]> {
  // All of it will be read, so plan for all of it and not for a quick first page.
  await db.query('set local cursor_tuple_fraction = 1')
  const name = `account_graph_${++cursors}`
  await db.query(`declare ${name} no scroll cursor for ${text}`, [...given])
  for (;;) {
    const { rows } = await db.query(`fetch ${page} from ${name}`)
    if (rows.length === 0) break
    yield rows
  }
  await db.query(`close ${name}`)
}

function toEdge(row: any): Edge {
  return {
    subject: row.subject,
    identifier: row.identifier,
    first: Number(row.first_at),
    last: Number(row.last_at),
    count: row.sightings,
  }
}

interface Upgrade {
  id: number
  name: string
  sql: string
}

/**
 * Every change to the database's shape, oldest first. `migrate` applies the
 * ones a database has not had. The first entry makes everything for a new
 * database. To change the shape after a release, add an entry with the next
 * id, and never edit one that has shipped.
 *
 * Until the first release the schema itself is edited, so its step is named
 * by a mark of its text and of the kinds the graph writes. A database made
 * from another text, or kept under other kinds, is then refused, and is
 * never run on a shape or a policy this code does not expect.
 */
export function upgrades(schema = 'account_graph'): Upgrade[] {
  return [{ id: 1, name: `the schema ${createHash('sha256').update(schemaSql('s')).update(JSON.stringify(Object.keys(defaultPolicy.kinds).sort())).digest('hex').slice(0, 8)}`, sql: schemaSql(schema) }]
}
