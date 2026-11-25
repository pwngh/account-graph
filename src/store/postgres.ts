import { affectedMisses, callTraces, creditSubject, ownerOf, partyOf, reopenWaits, stopCallJob, withoutGuesses } from '../core/call-party.ts'
import { malformed } from '../contract/fault.ts'
import type { Feed, KeptAlert, OpsStore } from '../core/ops.ts'
import type { Job, JobState, OutboxStore } from '../core/outbox.ts'
import type { GraphEvent } from '../contract/api.ts'
import type { Receipt } from '../core/receipts.ts'
import type { SaidOf, Topic } from '../core/said.ts'
import type { Store, Tx } from '../core/store.ts'
import { CLICK_IDS } from '../core/touch.ts'
import type { CallResult, CallTime, Consent, Cost, Counted, Decision, Edge, FlowEdge, Identifier, IdentifierState, KeptCall, KeptText, Labels, Lease, Moved, NotLead, OutcomeValue, Payment, SentLink, Sighting, Subject, Touch } from '../contract/types.ts'

/** Every ad click id a touch carries, as the index on them has it. */
const CLICKED = `array[${CLICK_IDS.map((name) => `detail->>'${name}'`).join(', ')}]`

/** The part of a `pg` client the store calls. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>
}

/** The part of a `pg` Pool the store calls. */
export interface Pool extends Queryable {
  connect(): Promise<Queryable & { release(destroy?: boolean): void }>
  on?(event: 'error', heard: (error: unknown) => void): unknown
  on?(event: 'connect', heard: (client: { on?(event: 'error', heard: (error: unknown) => void): unknown }) => void): unknown
}

/** Whether an error says that the connection is of no more use, and not that the database refused something. */
const silent = (error: unknown): boolean => error instanceof Error && !('severity' in error) && /^(Query read timeout|Connection terminated|Client has encountered a connection error)/.test(error.message)

const watched = new WeakSet<Pool>()
/**
 * A connection the database ends is heard of as an event, and an event nobody listens for ends the process. The pool
 * tells of one at rest. One in use tells only its own client, whose next statement then fails.
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

// Older writers left staff statements alone when replacing the call row. Some also recorded a call after a pending statement.
const overwrittenCalls = (schema: string) => `select c.id from ${schema}.call c where c.party is not null and (c.subject <>
  case when c.party->>'role' in ('self', 'representative') then c.party->>'subject' else 'call:' || c.id end
  or (c.direction = 'inbound' and c.subject = 'call:' || c.id and exists (select from ${schema}.sighting s where s.subject = c.subject
    and s.at = c.at and s.event = 'call' and s.identifier = 'dialed:call-' || c.id)))
  union all select c.id from (select distinct about from ${schema}.said where topic = 'party') s join ${schema}.call c on c.id = s.about where c.party is null`

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
  // Only this transaction knows whether its snapshot has any withdrawn edges.
  const bind = (db: Queryable, snapshot = { noReserved: false }): Tx => ({
    addAlert: (alert, again, calls) => addAlert(db, alert, again, calls),
    async pendingAlert({ key, text, at }, start) {
      const { rows } = await db.query(`select 1 from ${t('alert')} where key = $1 and text = $2 and at = $3 and delivered_at is null for share`, [key, text, at])
      if (!rows.length) return false
      start?.()
      return true
    },
    outbox: outboxOn(db),
    async nested(work) {
      await db.query('savepoint inside')
      try {
        const result = await work()
        await db.query('release savepoint inside')
        return result
      } catch (error) {
        snapshot.noReserved = false
        await db.query('rollback to savepoint inside; release savepoint inside').catch(() => undefined)
        throw error
      }
    },
    async addSightings(rows) {
      // Fold repeats first: one statement cannot upsert the same edge twice.
      const folded = new Map<string, Edge>()
      for (const { subject, identifier, at } of rows) {
        const key = `${subject}\u0000${identifier}`
        const edge = folded.get(key)
        if (edge) {
          edge.first = Math.min(edge.first, at)
          edge.last = Math.max(edge.last, at)
          edge.count += 1
        } else folded.set(key, { subject, identifier, first: at, last: at, count: 1 })
      }
      const edges = [...folded.values()]

      await db.query(
        `insert into ${t('sighting')} (subject, identifier, at, event, recorded_at)
         select * from unnest($1::text[], $2::text[], $3::bigint[], $4::text[], $5::bigint[])`,
        [rows.map((r) => r.subject), rows.map((r) => r.identifier), rows.map((r) => r.at), rows.map((r) => r.event ?? null), rows.map((r) => r.recorded ?? r.at)],
      )
      await db.query(
        `insert into ${t('subject')} (id, component, cluster)
         select distinct s, s, s from unnest($1::text[]) as s on conflict (id) do nothing`,
        [edges.map((e) => e.subject)],
      )
      const { rows: tally } = await db.query(
        `with upserted as (
           insert into ${t('edge')} (subject, identifier, first_at, last_at, sightings)
           select * from unnest($1::text[], $2::text[], $3::bigint[], $4::bigint[], $5::int[])
           on conflict (subject, identifier) do update set
             first_at = least(${t('edge')}.first_at, excluded.first_at),
             last_at = greatest(${t('edge')}.last_at, excluded.last_at),
             sightings = ${t('edge')}.sightings + excluded.sightings
           returning identifier, (xmax = 0) as fresh
         ), tally as (
           select identifier, count(*) filter (where fresh)::int as added from upserted group by identifier
         ), counted as (
           insert into ${t('identifier')} (id, fanout) select identifier, added from tally
           on conflict (id) do update set fanout = ${t('identifier')}.fanout + excluded.fanout
         )
         select identifier, added from tally where added > 0`,
        [
          edges.map((e) => e.subject),
          edges.map((e) => e.identifier),
          edges.map((e) => e.first),
          edges.map((e) => e.last),
          edges.map((e) => e.count),
        ],
      )
      return new Map(tally.map((row) => [row.identifier as Identifier, row.added as number]))
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
        await db.query(`delete from ${t('said')} where (topic in ('worth', 'lead') and about = any($1::text[])) or (topic in ('party', 'result', 'return') and about = any($2::text[]))`, [refs, ids])
        await db.query(`delete from ${t('not_lead')} where id = any($1::text[])`, [refs])
        for (const table of ['outcome', 'outcome_value', 'payment']) await db.query(`delete from ${t(table)} where transaction_id = any($1::text[])`, [refs])
        callJobs = (await db.query(`delete from ${t('conversion')} where transaction_id = any($1::text[]) returning *`, [refs])).rows.map(toJob)
      }
      await db.query(`delete from ${t('said')} where topic = 'party' and data->>'subject' = $1 and ($2::text[] is null or about = any($2))`, [subject, only ?? null])
      if (only) return callJobs
      await db.query(`delete from ${t('call_evidence')} where subject = $1`, [subject])
      if (!ids.length) await dropCallNotices(db, ids, [subject], [], [creditSubject(subject)])
      const { rows: left } = await db.query(
        `with gone as (delete from ${t('edge')} where subject = $1 returning identifier)
         update ${t('identifier')} set fanout = fanout - 1 where id in (select identifier from gone) returning id, fanout`,
        [subject],
      )
      // What nobody holds any more goes too, unless it is muted: that is a decision, and stands for whoever holds it next.
      await db.query(`delete from ${t('identifier')} where id = any($1::text[]) and fanout <= 0 and not ignored`, [left.filter((row) => row.fanout <= 0).map((row) => row.id)])
      await db.query(`delete from ${t('not_lead')} where id in (select transaction_id from ${t('outcome')} where subject = $1 union all select 'call:' || id from ${t('call')} where subject = $1 union all select 'text:' || id from ${t('message')} where subject = $1)`, [subject])
      await db.query(
        `delete from ${t('said')} where (topic in ('worth', 'lead') and about in (
             select transaction_id from ${t('outcome')} where subject = $1
             union all select transaction_id from ${t('outcome_value')} v where subject = $1 and not exists (select from ${t('outcome')} o where o.transaction_id = v.transaction_id)
             union all select 'call:' || id from ${t('call')} where subject = $1 union all select 'text:' || id from ${t('message')} where subject = $1))
           or (topic in ('result', 'return') and about in (select id from ${t('call')} where subject = $1))`,
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
      if (snapshot.noReserved) return false
      return (await db.query(`select from ${t('call_evidence')} limit 1`)).rows.length > 0
    },

    async rivalCalls(number, first, last, line) {
      const { rows } = await db.query(`${callRows} where c.direction = 'inbound' and c.dialed = $1 and c.at >= $2 and c.at < $3
        and ($4::text is null or coalesce(c.line_subject, c.subject) = $4)`, [number, first, last, line ?? null])
      return rows.map(row => ({ ...toCall(row), subject: row.line_subject ?? row.subject, flags: row.flags, ...(row.visitor && { visitor: row.visitor }) }))
    },

    async callEvidence({ subjects, identifiers, calls, before } = {}) {
      if (snapshot.noReserved) return []
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
      if (!ids.length) return new Map()
      const { rows } = await db.query(`select c.id, c.visitor from ${t('call')} c where c.id = any($1::text[]) and c.party is not null and exists (
        select from ${t('call_evidence')} e where e.call_id = c.id and e.subject = c.visitor and e.identifier in ('dial:' || c.id, 'lease:' || c.id, 'text:call:' || c.id)
        and not exists (select from ${t('identifier')} i where i.id = e.identifier and i.ignored))`, [ids])
      return new Map(rows.map(row => [row.id, row.visitor]))
    },

    async matchingEdges(subjects) {
      if (snapshot.noReserved || !subjects.length) return { active: await this.edgesOf(subjects), reserved: false }
      const { rows } = await db.query(`with active as materialized (select * from ${t('edge')} where subject = any($1::text[])),
        nearby as (select exists (select from ${t('call_evidence')} where subject = any($1::text[])
          union all select from active a join ${t('call_evidence')} r on r.identifier = a.identifier) as reserved)
        select e.*, nearby.reserved from nearby left join active e on true`, [subjects])
      return { active: rows[0]?.subject == null ? [] : rows.map(toEdge), reserved: rows[0]?.reserved === true }
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
      const { rows: unnamed } = await db.query(`select id from ${t('match_identifier')} where fanout >= 2 and not ignored and split_part(id, ':', 1) <> all($1::text[]) limit 1`, [kinds])
      if (unnamed.length > 0) throw malformed(`Identifier "${unnamed[0].id}" has a kind that is missing from the policy`)
      const rows = cursor(
        db,
        page,
        `select x.subject as a, y.subject as b, array_agg(x.identifier) as identifiers, array_agg(i.fanout) as fanouts,
           array_agg(array[x.first_at, x.last_at, x.sightings, y.first_at, y.last_at, y.sightings]) as times
         from ${t('match_identifier')} i
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
         from ${t('subject')} s full join (select distinct subject from ${t('edge')}) held on held.subject = s.id`,
        [],
      )
      for await (const batch of rows) yield batch.map((row) => ({ subject: row.id, labels: row.component === null ? undefined : { component: row.component, cluster: row.cluster }, held: row.held }))
    },

    async states(identifiers) {
      const out = new Map<Identifier, IdentifierState>()
      if (identifiers.length === 0) return out
      const { rows } = await db.query(
        `select id, fanout, ignored from ${t(snapshot.noReserved ? 'identifier' : 'match_identifier')} where id = any($1::text[]) and (fanout > 0 or ignored)`,
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
        `select id, fanout from ${t('match_identifier')} where fanout > 1 and not ignored and id in (select identifier from ${t('edge')} where subject = any($1::text[]))`,
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
      return (await db.query(`with gone as (delete from ${t('receipt')} where forgotten_at is null and recorded_at < $1 returning 1) select count(*)::int as n from gone`, [before])).rows[0].n
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
      if (subjects.length === 0) return out
      const { rows } = await db.query(`select distinct on (subject) * from ${t('consent_log')} where subject = any($1::text[]) order by subject, ${STANDING}`, [subjects])
      for (const row of rows) out.set(row.subject, { adUserData: row.ad_user_data, adPersonalization: row.ad_personalization })
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

    async overwrittenCalls(limit) {
      return (await db.query(`${overwrittenCalls(schema)} limit $1`, [limit])).rows.map(row => row.id)
    },

    async applyCallParty(id, arriving = false, overwritten = false) {
      const standing = await partyOf(this, id)
      if (!standing && !overwritten) return []
      const call = await this.callOf(id)
      const party = standing ?? call?.party
      if (!call || !party) return []
      const owner = ownerOf(id, party)
      const { rows: [raw] } = await db.query(`select coalesce(line_subject, subject) as line, line_kind from ${t('call')} where id = $1`, [id])
      const line = raw.line
      const first = overwritten || (!call.party && !arriving)
      const reported = overwritten ? call.subject : line
      if (overwritten) await db.query(`update ${t('call')} set visitor = null, tags = null, flags = $2 where id = $1`, [id, withoutGuesses(call.flags)])
      const { changes, affected } = first ? await callTraces(this, call, reported, raw.line_kind ?? undefined) : { changes: [], affected: [] }
      await this.reserveCall(changes.map(({ edge, recorded }) => ({ call: id, subject: edge.subject, identifier: edge.identifier, at: call.at, recorded })))
      for (const { edge, remove, next } of changes) {
        const { subject, identifier } = edge
        if (remove) await db.query(`delete from ${t('sighting')} where id in (select id from ${t('sighting')} where subject = $1 and identifier = $2 and at = $3 and event = 'call' order by id limit $4)`, [subject, identifier, call.at, remove])
        if (next) await db.query(`update ${t('edge')} set first_at = $3, last_at = $4, sightings = $5 where subject = $1 and identifier = $2`, [subject, identifier, next.first, next.last, next.count])
        else {
          await db.query(`delete from ${t('edge')} where subject = $1 and identifier = $2`, [subject, identifier])
          await db.query(`update ${t('identifier')} set fanout = fanout - 1 where id = $1`, [identifier])
        }
      }
      if (changes.length) {
        await db.query(`delete from ${t('identifier')} where id = any($1::text[]) and fanout <= 0 and not ignored`, [changes.map(({ edge }) => edge.identifier)])
        await db.query(`delete from ${t('subject')} s where id = any($1::text[]) and not exists (select from ${t('edge')} e where e.subject = s.id)`, [changes.map(({ edge }) => edge.subject)])
      }
      if (first && (!call.visitor || overwritten) && call.direction === 'inbound') await this.dropTouch(reported, call.at, `tel:${call.to}`, id, true)
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
           unsaid as (delete from ${t('said')} s where topic in ('result', 'return') and (about in (select id from gone) or (at < $1 and not exists (select from ${t('call')} c where c.id = s.about)))) select count(*)::int as n from gone`,
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
      // Fold repeats first, keeping the last: one statement cannot upsert the same row twice.
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
      return rows.reverse().map(toSighting)
    },

    async latelySeen(sightings) {
      const { rows } = await db.query(`select distinct subject from (select subject from ${t('sighting')} order by recorded_at desc, subject collate "C" limit $1) newest`, [sightings])
      return rows.map((row) => row.subject)
    },

    async *sightingsUntil(recorded) {
      for await (const batch of cursor(db, page, `select subject, identifier, at, event, recorded_at from ${t('sighting')} where recorded_at <= $1 order by id`, [recorded])) yield batch.map(toSighting)
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

    async unprovenParties(limit) {
      const { rows } = await db.query(`with erased as materialized (select distinct on (d.about->>0) d.about->>0 as subject, d.at, d.seq
          from ${t('decision')} d where d.action = 'forget' order by d.about->>0, d.seq desc),
        pending as not materialized (select s.about, s.key, erased.* from erased join ${t('said')} s on s.topic = 'party'
          and s.data->>'subject' = erased.subject where s.returned_after is distinct from erased.seq),
        calls as materialized (select distinct about from pending limit $1),
        prunes as materialized (select at, (about->>0)::bigint as cutoff from ${t('decision')} where action = 'prune')
        select p.*, c.recorded_at, (select min(at) from prunes where cutoff > p.at) as retry_from, (select min(w.recorded_at) from ${t('sighting')} w where w.subject = p.subject
          and not starts_with(w.identifier, 'review:') and w.recorded_at > p.at) as fresh
        from calls join pending p using (about) left join ${t('call')} c on c.id = p.about and c.at > p.at`, [limit])
      return rows.map(row => ({ subject: row.subject, call: row.about, key: row.key, deletion: Number(row.seq), erasedAt: Number(row.at),
        ...(row.fresh !== null && row.recorded_at !== null && { ready: Math.max(Number(row.fresh), Number(row.recorded_at)) }), ...(row.retry_from !== null && { retryFrom: Number(row.retry_from) }) }))
    },

    async partyReturn(subject, call) {
      const { rows: [row] } = await db.query(`select erased.seq, exists (select from ${t('call')} c where c.id = $2 and c.at > erased.at)
        and exists (select from ${t('edge')} e where e.subject = $1 and not starts_with(e.identifier, 'review:')) as allowed
        from (${erasedRecord('$1')}) erased`, [subject, call])
      return !row ? undefined : row.allowed ? Number(row.seq) : 'forgotten'
    },

    async confirmPartyReturn(call, key, deletion) {
      await db.query(`update ${t('said')} set returned_after = $3 where topic = 'party' and about = $1 and key = $2`, [call, key, deletion])
    },

    async removePartyStatements(call, keys) {
      await db.query(`delete from ${t('said')} where topic = 'party' and about = $1 and key = any($2::text[])`, [call, keys])
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

  async function run<T>(begin: string, lock: 'none' | 'shared' | 'exclusive', work: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    let lost = false
    try {
      await client.query(begin)
      if (lock !== 'none' && lockTimeout > 0) await client.query(`set local lock_timeout = ${Math.ceil(lockTimeout)}`)
      if (lock !== 'none') await client.query(`select pg_advisory_xact_lock${lock === 'shared' ? '_shared' : ''}(hashtext($1))`, [`account-graph:${schema}`])
      const result = await work(bind(client))
      // A write is counted as it commits, in the same trip to the database.
      try {
        await client.query(lock === 'exclusive' ? `update ${t('pulse')} set writes = writes + 1; commit` : 'commit')
      } catch (error) {
        // The answer to a commit was lost: it may have been made.
        if (lock === 'exclusive' && error instanceof Error && !('severity' in error)) Object.assign(error, { committing: true })
        throw error
      }
      return result
    } catch (error) {
      // A statement nobody answered leaves a connection that answers nothing. It is given up, and not asked to roll back.
      lost = silent(error)
      if (!lost) await client.query('rollback').catch((again) => void (lost = silent(again)))
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
    async start(jobs, send) {
      send(await standing(db, jobs, true), await settingOf(db, 'callParty'))
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
    start: (jobs, send) => run('begin', 'shared', (tx) => tx.outbox.start(jobs, send)),
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
    read: (work) => run('begin isolation level repeatable read read only', 'none', work),
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
        const { rows } = await client.query(`select id from ${t('upgrade')}`)
        const done = new Set(rows.map((row) => row.id as number))
        const applied: string[] = []
        for (const upgrade of upgrades(schema)) {
          if (done.has(upgrade.id)) continue
          for (const [i, sql] of (upgrade.phases ?? [upgrade.sql]).entries()) {
            // 29 and 30 together establish call ownership and remove the old owner's channel visits.
            if (i > 0 || (applied.length && upgrade.id !== 30)) {
              await client.query('commit')
              await client.query('begin')
            }
            await client.query(sql)
          }
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

function toSighting(row: any): Sighting {
  const sighting = { subject: row.subject, identifier: row.identifier, at: Number(row.at), recorded: Number(row.recorded_at) }
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
  /** Each phase before the last is idempotent and releases its table locks before the next one begins. */
  phases?: string[]
}

function callbackUpgrade(schema: string): Upgrade {
  const prepare = `alter table ${schema}.alert add column if not exists callback_calls text[];
    alter table ${schema}.event add column if not exists notice_key text, add column if not exists callback_calls text[];`
  // Gather each possible owner once. A legacy notice can depend on any earlier open miss or later attempt by that owner.
  const backfill = `select pg_advisory_xact_lock(hashtext('account-graph:${schema}'));
    lock table ${schema}.alert, ${schema}.event, ${schema}.event_once in share row exclusive mode;
    create temp table ag_callback_calls on commit drop as
    with owners as (
      select subject, id, at, recorded_at, direction from ${schema}.call
      union all select line_subject, id, at, recorded_at, direction from ${schema}.call where line_subject is not null
      union all select s.data->>'subject', c.id, c.at, c.recorded_at, c.direction from ${schema}.said s join ${schema}.call c on c.id = s.about
        where s.topic = 'party' and s.data->>'subject' is not null)
    select distinct o.subject, o.id, o.at, o.recorded_at, o.direction from owners o where o.direction = 'outbound'
    union all select distinct o.subject, o.id, o.at, o.recorded_at, o.direction from owners o join ${schema}.event_once n
      on n.said_once = 'unreturned:' || o.subject || ':' || o.id where o.direction = 'inbound';
    create index on ag_callback_calls (subject, direction, at);
    analyze ag_callback_calls;
    update ${schema}.event e set callback_calls = array(
      select c.id from ${schema}.call c where c.id = e.data->>'call'
      union select c.id from ag_callback_calls c where c.subject = e.subject and c.direction = 'inbound' and c.at <= (e.data->>'missedAt')::bigint and c.recorded_at <= e.at
      union select c.id from ag_callback_calls c where c.subject = e.subject and c.direction = 'outbound' and c.at > (e.data->>'missedAt')::bigint and c.at <= e.at and c.recorded_at <= e.at and (e.data->>'attempts')::int > 0
      union select 'legacy:credit' where not exists (
        select from ${schema}.call c where c.id = e.data->>'call' and c.party->>'role' in ('self','representative') and c.subject = e.subject)
        and not exists (select from ${schema}.touch v where v.subject = e.subject and v.at between (e.data->>'missedAt')::bigint - 7776000000 and (e.data->>'missedAt')::bigint
          and coalesce(v.detail->>'landing','') !~ '^(tel|sms):' and v.detail->>'campaign' is not distinct from e.data->>'campaign' and v.detail->>'campaignId' is not distinct from e.data->>'campaignId'
          and (v.detail ?| array['gclid','gbraid','wbraid','msclkid','ttclid','campaignId'] or v.detail->>'medium' ~* '^(cpc|ppc|cpm|cpv|paid.*|display)$')
          and case when v.detail ?| array['gclid','gbraid','wbraid'] then 'google' when v.detail ? 'fbclid' then 'meta' when v.detail ? 'msclkid' then 'microsoft' when v.detail ? 'ttclid' then 'tiktok' else lower(trim(v.detail->>'source')) end = e.data->>'source'))
      where e.type = 'callback.overdue';
    create temp table ag_callback_notices on commit drop as
      select subject, notice, array_remove(array_agg(distinct source), null) as calls from (
        select subject, 'unreturned:' || subject || ':' || (data->>'call') as notice, callback_calls
        from ${schema}.event where type = 'callback.overdue' and subject is not null) e
      left join lateral unnest(e.callback_calls) as s(source) on true
      group by grouping sets ((subject, notice), (subject));
    create index on ag_callback_notices (subject, notice);
    analyze ag_callback_notices;
    with matches as (
      select a.key, coalesce(exact.calls, array_prepend('legacy:credit', array_remove(all_calls.calls, 'legacy:credit'))) as calls
      from ${schema}.alert a left join ag_callback_notices exact on exact.subject = a.subject and exact.notice = a.key
      left join ag_callback_notices all_calls on all_calls.subject = a.subject and all_calls.notice is null where starts_with(a.key, 'unreturned:'))
    update ${schema}.alert a set callback_calls = array_prepend(null::text, matches.calls) from matches where a.key = matches.key;
    with corrected as materialized (
      select exists (select from ${schema}.call where party is not null and direction = 'inbound') as standing,
        (select max(u.forgotten_at) from ${schema}.receipt u where u.type = 'call_update' and u.forgotten_at is not null
          and (u.digest_version = 0 or exists (select from ${schema}.setting where name = 'callParty'))
          and exists (select from ${schema}.receipt c where c.type = 'call' and c.forgotten_at = u.forgotten_at)) as erased),
      unsupported as (
        select e.seq from ${schema}.event e, corrected where e.type = 'callback.overdue' and 'legacy:credit' = any(e.callback_calls)
          and (corrected.standing or corrected.erased >= e.at)
        union all select e.seq from ${schema}.event e, corrected where e.type = 'callback.overdue' and corrected.erased >= e.at
          and not exists (select from ${schema}.call where id = e.data->>'call')
        union all select e.seq from ${schema}.event e, corrected where e.type = 'callback.overdue' and corrected.erased >= e.at
          and (e.data->>'attempts')::int > 0 and (e.data->>'attempts')::int > (
            select count(*) from ag_callback_calls a join ${schema}.call c on c.id = a.id left join ${schema}.call_result r on r.id = a.id
            where a.subject = e.subject and a.direction = 'outbound' and a.at > (e.data->>'missedAt')::bigint and a.at <= e.at
              and c.subject = a.subject and c.recorded_at <= e.at and r.answered is not true and not exists (select from ${schema}.not_lead n where n.id = 'call:' || a.id))
        union all select e.seq from ${schema}.event e cross join lateral unnest(e.callback_calls) as src(id)
          join ${schema}.call c on c.id = src.id where e.type = 'callback.overdue' and c.party is not null and c.subject <> e.subject),
      stale as (delete from ${schema}.event e where e.seq in (select seq from unsupported)
        returning e.subject, 'unreturned:' || e.subject || ':' || (e.data->>'call') as notice),
      doomed as (
        select s.notice as key from stale s join ${schema}.alert a on a.key = s.notice and a.subject = s.subject
        union select a.key from ${schema}.alert a join (select distinct subject from stale) s on s.subject = a.subject
          where starts_with(a.key, 'unreturned:') and not exists (select from ag_callback_notices exact where exact.subject = a.subject and exact.notice = a.key)
        union select a.key from ${schema}.alert a, corrected where starts_with(a.key, 'unreturned:')
          and 'legacy:credit' = any(a.callback_calls) and (corrected.standing or corrected.erased >= a.at)),
      gone as (delete from ${schema}.alert a using doomed where a.key = doomed.key returning a.key)
      delete from ${schema}.event_once where said_once in (
        select key from gone union select n.said_once from ${schema}.event_once n join (select distinct subject from stale) s on s.subject = n.subject
        where starts_with(n.said_once, 'unreturned:') and not exists (select from ${schema}.alert a where a.key = n.said_once));
    create index if not exists callback_event_calls on ${schema}.event using gin (callback_calls) where type = 'callback.overdue';
    create index if not exists callback_alert_calls on ${schema}.alert using gin (callback_calls) where callback_calls is not null;`
  return { id: 31, name: 'calls behind callback notices', sql: prepare + '\n' + backfill, phases: [prepare, backfill] }
}

/**
 * Every change to the database's shape, oldest first. `migrate` applies the
 * ones a database has not had. To change the shape, add an entry with the
 * next id; never edit one that has shipped. The first entry creates
 * everything for a new database, so later entries must also be safe to run
 * on a database that the first entry just created.
 */
export function upgrades(schema = 'account_graph'): Upgrade[] {
  return [
    { id: 1, name: 'tables', sql: ddl(schema) },
    {
      id: 2,
      name: 'sighting record time',
      // For a database made before sightings were stamped with when they were written down.
      sql: `alter table ${schema}.sighting add column if not exists recorded_at bigint;
            update ${schema}.sighting set recorded_at = at where recorded_at is null;
            alter table ${schema}.sighting alter column recorded_at set not null;
            create index if not exists sighting_recorded on ${schema}.sighting (recorded_at);`,
    },
    {
      id: 3,
      name: 'cluster changes',
      // Each cluster change, written down as it happens, for "what changed lately".
      sql: `create table if not exists ${schema}.change (
              id bigint generated always as identity primary key,
              at bigint not null,
              subject text not null,
              from_cluster text,
              to_cluster text
            );
            create index if not exists change_subject on ${schema}.change (subject);
            create index if not exists subject_id_plain on ${schema}.subject (id collate "C");`,
    },
    {
      id: 4,
      name: 'outcomes and costs',
      // What subjects did and what campaigns cost, for the report.
      sql: `create table if not exists ${schema}.outcome (
              transaction_id text primary key,
              subject text not null,
              at bigint not null,
              stage text not null,
              value float8 not null,
              currency text not null
            );
            create index if not exists outcome_at on ${schema}.outcome (at);
            create index if not exists outcome_subject on ${schema}.outcome (subject);
            create table if not exists ${schema}.cost (
              day text not null,
              source text not null,
              campaign_id text not null,
              campaign text not null,
              amount float8 not null,
              currency text not null,
              clicks bigint not null,
              impressions bigint not null,
              primary key (day, source, campaign_id)
            );
            create index if not exists touch_at on ${schema}.touch (at);`,
    },
    {
      id: 5,
      name: 'write count',
      // One row, counted up by every write, so a screen can ask cheaply whether anything changed.
      sql: `create table if not exists ${schema}.pulse (
              one boolean primary key default true check (one),
              writes bigint not null
            );
            insert into ${schema}.pulse (writes) values (0) on conflict do nothing;`,
    },
    {
      id: 6,
      name: 'policy of the stored clusters',
      // One row at most: the hash of the policy the clusters were built with. A database from before has none, and it is not known.
      sql: `create table if not exists ${schema}.built (
              one boolean primary key default true check (one),
              policy text not null
            );`,
    },
    {
      id: 7,
      name: 'decisions by pair',
      // So what was last decided about two subjects is found without reading every decision.
      sql: `create index if not exists decision_pair on ${schema}.decision ((about->>0), (about->>1)) where action in ('join', 'separate', 'rejoin');`,
    },
    {
      id: 8,
      name: 'consent history',
      // Every answer, where only the latest was kept. What was kept is carried over: when it was given is not known, so any
      // dated answer stands over it. The old table goes, so nothing can go on writing where nothing reads.
      sql: `create table if not exists ${schema}.consent_log (
              id bigint generated always as identity primary key,
              subject text not null,
              at bigint not null,
              ad_user_data boolean not null,
              ad_personalization boolean not null,
              source text,
              recorded_at bigint not null
            );
            create index if not exists consent_log_subject on ${schema}.consent_log (subject, at);
            lock table ${schema}.consent in access exclusive mode;
            insert into ${schema}.consent_log (subject, at, ad_user_data, ad_personalization, source, recorded_at)
              select subject, 0, ad_user_data, ad_personalization, 'before history', (extract(epoch from now()) * 1000)::bigint from ${schema}.consent;
            drop table ${schema}.consent;`,
    },
    {
      id: 9,
      name: 'calls and their results',
      // A result is kept apart from its call, because either may arrive first. Conversions count their changes, so an old pass undoes no newer one.
      sql: `create table if not exists ${schema}.call (
              id text primary key,
              subject text not null,
              at bigint not null,
              dialed text not null,
              duration float8,
              flags text[] not null,
              visitor text,
              recorded_at bigint not null
            );
            create index if not exists call_at on ${schema}.call (at);
            create index if not exists call_subject on ${schema}.call (subject);
            create index if not exists call_visitor on ${schema}.call (visitor);
            alter table ${schema}.conversion add column if not exists rev bigint not null default 0;
            create table if not exists ${schema}.call_result (
              id text primary key,
              answered boolean,
              voicemail boolean,
              waited float8,
              recorded_at bigint not null
            );`,
    },
    {
      id: 10,
      name: 'calls you place',
      sql: `alter table ${schema}.call add column if not exists direction text not null default 'inbound';`,
    },
    {
      id: 11,
      name: 'feeds, jobs and alerts',
      // When each feed last wrote something, taken once from what is stored. Costs carry no time, so theirs is not known yet.
      sql: `create table if not exists ${schema}.feed (name text primary key, last_at bigint, watched_at bigint);
            insert into ${schema}.feed (name, last_at)
              select name, last_at from (values
                ('touches', (select max(at) from ${schema}.touch)),
                ('calls', (select max(recorded_at) from ${schema}.call)),
                ('results', (select max(recorded_at) from ${schema}.call_result))
              ) as seen (name, last_at) where last_at is not null on conflict do nothing;
            create table if not exists ${schema}.job (
              name text primary key,
              started_at bigint not null,
              succeeded_at bigint,
              failed_at bigint,
              error text,
              run text,
              outcome text
            );
            create table if not exists ${schema}.job_run (id text primary key, name text not null, started_at bigint not null);
            create index if not exists job_run_name on ${schema}.job_run (name);
            create table if not exists ${schema}.alert (
              key text primary key,
              text text not null,
              at bigint not null,
              subject text,
              error text,
              tried_at bigint not null,
              delivered_at bigint
            );
            create index if not exists alert_undelivered on ${schema}.alert (at) where delivered_at is null;
            create index if not exists alert_subject on ${schema}.alert (subject);`,
    },
    {
      id: 12,
      name: 'tags on outcomes and calls',
      sql: `alter table ${schema}.outcome add column if not exists tags jsonb;
            alter table ${schema}.call add column if not exists tags jsonb;`,
    },
    {
      id: 13,
      name: 'transfers kept by id',
      sql: `create table if not exists ${schema}.transfer (
              id text primary key,
              source text not null,
              target text not null,
              asset text not null,
              amount bigint not null,
              at bigint not null
            );
            create index if not exists transfer_source on ${schema}.transfer (source);
            create index if not exists transfer_target on ${schema}.transfer (target);`,
    },
    {
      id: 14,
      name: 'values of outcomes over time',
      // Every value an outcome has had. What an outcome is worth today starts its history, with no time: it may have been restated before.
      sql: `create table if not exists ${schema}.outcome_value (
              id bigint generated always as identity primary key,
              transaction_id text not null,
              subject text not null,
              value float8 not null,
              currency text not null,
              at bigint not null
            );
            create index if not exists outcome_value_transaction on ${schema}.outcome_value (transaction_id, id);
            create index if not exists outcome_value_subject on ${schema}.outcome_value (subject);
            insert into ${schema}.outcome_value (transaction_id, subject, value, currency, at)
              select transaction_id, subject, value, currency, 0 from ${schema}.outcome;`,
    },
    {
      id: 15,
      name: 'numbers shown to one visitor',
      sql: `create table if not exists ${schema}.lease (
              number text not null,
              subject text not null,
              start_at bigint not null,
              until_at bigint not null,
              primary key (number, start_at)
            );
            create index if not exists lease_subject on ${schema}.lease (subject);
            create index if not exists lease_until on ${schema}.lease (until_at);`,
    },
    {
      id: 16,
      name: 'touches found by ad click id',
      sql: `create index if not exists touch_clicked on ${schema}.touch using gin ((${CLICKED}));`,
    },
    {
      id: 17,
      name: 'returns reported by your own systems',
      sql: `alter table ${schema}.call_result add column if not exists returned_at bigint;`,
    },
    {
      id: 18,
      name: 'what was no lead',
      sql: `create table if not exists ${schema}.not_lead (id text primary key, kind text not null, at bigint not null);`,
    },
    {
      id: 19,
      name: 'why values changed',
      sql: `alter table ${schema}.outcome_value add column if not exists kind text;`,
    },
    {
      id: 20,
      name: 'what platforms say they brought',
      sql: `alter table ${schema}.cost add column if not exists conversions float8, add column if not exists claimed_value float8;`,
    },
    {
      id: 21,
      name: 'text messages',
      sql: `create table if not exists ${schema}.message (
              id text primary key,
              direction text not null,
              subject text not null,
              at bigint not null,
              ours text not null,
              flags text[] not null,
              visitor text,
              tags jsonb,
              recorded_at bigint not null
            );
            create index if not exists message_subject on ${schema}.message (subject, at);
            create index if not exists message_at on ${schema}.message (at);
            create index if not exists message_visitor on ${schema}.message (visitor);`,
    },
    {
      id: 22,
      name: 'links that were sent',
      sql: `create table if not exists ${schema}.sent_link (
              id text primary key,
              subject text not null,
              purpose text,
              at bigint not null,
              expires_at bigint not null,
              opened_at bigint,
              openings integer not null
            );
            create index if not exists sent_link_subject on ${schema}.sent_link (subject, at);
            create index if not exists sent_link_expires on ${schema}.sent_link (expires_at);`,
    },
    {
      id: 23,
      name: 'payments',
      sql: `create table if not exists ${schema}.payment (id text primary key, transaction_id text not null, amount float8 not null, kind text not null, currency text not null);
            create index if not exists payment_transaction on ${schema}.payment (transaction_id);`,
    },
    {
      id: 24,
      name: 'what was said, and when',
      // Restatements, results and the like as they were said, so what they come to does not depend on their order.
      sql: `create table if not exists ${schema}.said (
              topic text not null,
              about text not null,
              key text not null,
              at bigint not null,
              data jsonb not null,
              primary key (topic, about, key)
            );
            alter table ${schema}.cost add column if not exists read_at bigint, add column if not exists read_key text;
            alter table ${schema}.consent_log add column if not exists key text;
            alter table ${schema}.outcome_value add column if not exists why text;`,
    },
    {
      id: 25,
      name: 'receipts of keys',
      // Which keys were used, and for what, as hashes. A key whose subject was forgotten keeps its hash and nothing else.
      sql: `create table if not exists ${schema}.receipt (
              type text not null,
              key_mac text not null,
              secret_id text not null,
              digest jsonb,
              digest_version integer not null,
              ref_type text,
              ref_mac text,
              sent jsonb,
              at bigint not null,
              recorded_at bigint not null,
              forgotten_at bigint,
              primary key (type, key_mac)
            );
            create index if not exists receipt_ref on ${schema}.receipt (ref_type, ref_mac) where ref_mac is not null;
            create index if not exists receipt_recorded on ${schema}.receipt (recorded_at);
            create table if not exists ${schema}.receipt_subject (
              type text not null,
              key_mac text not null,
              subject text not null,
              primary key (type, key_mac, subject),
              foreign key (type, key_mac) references ${schema}.receipt on delete cascade
            );
            create index if not exists receipt_subject_subject on ${schema}.receipt_subject (subject);
            create table if not exists ${schema}.setting (name text primary key, value text not null);`,
    },
    {
      id: 26,
      name: 'events',
      // Cluster changes become events, in the order they were numbered, beside what people are told of.
      sql: `create table if not exists ${schema}.event_head (one boolean primary key default true check (one), seq bigint not null, epoch text not null, pruned bigint not null default 0);
            create table if not exists ${schema}.event (seq bigint primary key, type text not null, at bigint not null, data jsonb not null, subject text);
            create index if not exists event_subject on ${schema}.event (subject);
            create index if not exists event_at on ${schema}.event (at);
            create table if not exists ${schema}.event_once (said_once text primary key, subject text);
            create table if not exists ${schema}.event_delivery (sink text primary key, seq bigint not null, due bigint not null, attempts integer not null, since bigint, lease_until bigint not null);
            insert into ${schema}.event (seq, type, at, data, subject)
              select row_number() over (order by id), 'cluster.changed', at, jsonb_build_object('subject', subject, 'from', from_cluster, 'to', to_cluster), subject from ${schema}.change
              on conflict do nothing;
            insert into ${schema}.event_head (seq, epoch) select coalesce(max(seq), 0), substr(md5(random()::text || clock_timestamp()::text), 1, 8) from ${schema}.event on conflict do nothing;
            drop table ${schema}.change;`,
    },
    {
      id: 27,
      name: 'joins taken back',
      sql: `drop index if exists ${schema}.decision_pair;
            create index if not exists decision_pair on ${schema}.decision ((about->>0), (about->>1)) where action in ('join', 'unjoin', 'separate', 'rejoin');`,
    },
    {
      id: 28,
      name: 'events that name a cluster',
      // So that whoever is forgotten is found in what is said of others.
      sql: `create index if not exists event_from on ${schema}.event ((data->>'from')) where type = 'cluster.changed';
            create index if not exists event_to on ${schema}.event ((data->>'to')) where type = 'cluster.changed';`,
    },
    {
      id: 29,
      name: 'staff confirmation of a call',
      sql: `alter table ${schema}.call add column if not exists party jsonb, add column if not exists line_subject text,
              add column if not exists line_kind text check (line_kind in ('phone', 'voip', 'none'));
            create index if not exists call_line on ${schema}.call (line_subject) where line_subject is not null;
            create index if not exists said_party_subject on ${schema}.said ((data->>'subject')) where topic = 'party';`,
    },
    {
      id: 30,
      name: 'source call of a channel visit',
      // An older confirmation may have removed a different visit with the same line, number and time.
      sql: `alter table ${schema}.touch add column if not exists source_call text;
            delete from ${schema}.touch t using ${schema}.call c where t.source_call is null and c.party is not null and c.direction = 'inbound'
              and t.subject = c.line_subject and t.at = c.at and t.detail->>'landing' = 'tel:' || c.dialed;`,
    },
    callbackUpgrade(schema),
    {
      id: 32,
      name: 'withdrawn call evidence in shared identifier counts',
      // A confirmed call on an older database lost its line kind and visitor. Either phone kind may need to count that holder.
      sql: `create table if not exists ${schema}.call_evidence (
              call_id text not null references ${schema}.call (id) on delete cascade, subject text not null, identifier text not null,
              at bigint not null, recorded_at bigint not null, primary key (call_id, subject, identifier));
            create index if not exists call_evidence_subject on ${schema}.call_evidence (subject);
            create index if not exists call_evidence_identifier on ${schema}.call_evidence (identifier);
            insert into ${schema}.call_evidence select c.id, c.line_subject, k.kind || ':' || substr(c.line_subject, 8), c.at, c.recorded_at
              from ${schema}.call c cross join (values ('phone'), ('voip')) k(kind)
              where c.party is not null and c.direction = 'inbound' and starts_with(c.line_subject, 'caller:') and not ('toll_free' = any(c.flags))
              on conflict do nothing;
            create or replace view ${schema}.match_identifier as
              select id, sum(fanout)::int as fanout, bool_or(ignored) as ignored from (
                select id, fanout, ignored from ${schema}.identifier union all
                select w.identifier, count(distinct w.subject)::int, false from ${schema}.call_evidence w
                where not exists (select from ${schema}.edge e where e.subject = w.subject and e.identifier = w.identifier)
                group by w.identifier
              ) counts group by id;
            update ${schema}.built set policy = 'mixed' where exists (select from ${schema}.call_evidence);`,
    },
    {
      id: 33,
      name: 'forgotten subjects in the audit log',
      sql: `create index if not exists decision_forgotten on ${schema}.decision ((about->>0)) where action = 'forget';
            insert into ${schema}.setting (name, value) select 'repairForgottenParties', 'due' where exists (
              select from ${schema}.said s join ${schema}.decision d on d.action = 'forget' and d.about->>0 = s.data->>'subject' where s.topic = 'party')
            on conflict do nothing;`,
    },
    {
      id: 34,
      name: 'staff call ownership across server versions',
      // The older upsert always writes recorded_at. A failed statement rolls back the guesses made by the same transaction.
      sql: `create function ${schema}.reject_stated_report() returns trigger language plpgsql as $guard$
            begin
              if tg_op = 'UPDATE' or (exists (select from ${schema}.said where topic = 'party' and about = new.id) and not exists (select from ${schema}.call where id = new.id)) then
                raise exception using errcode = '23514', message = 'A staff statement owns this call. Retry the report on an upgraded server.';
              end if;
              return new;
            end; $guard$;
            create trigger stated_call_report before update of recorded_at on ${schema}.call for each row when (old.party is not null)
              execute function ${schema}.reject_stated_report();
            create trigger pending_call_report before insert on ${schema}.call for each row when (new.line_subject is null)
              execute function ${schema}.reject_stated_report();
            insert into ${schema}.setting (name, value) select 'repairCallReports', 'due' where exists (${overwrittenCalls(schema)}) on conflict do nothing;`,
    },
    {
      id: 35,
      name: 'party statements checked after a record returns',
      sql: `alter table ${schema}.said add column returned_after bigint;
            insert into ${schema}.setting (name, value) select 'repairForgottenParties', 'due' where exists (
              select from ${schema}.said s join ${schema}.decision d on d.action = 'forget' and d.about->>0 = s.data->>'subject' where s.topic = 'party')
            on conflict (name) do update set value = excluded.value;`,
    },
  ]
}

/** The tables the first upgrade makes, for reading. `migrate` makes these and everything `upgrades` adds after them. Times are epoch milliseconds. */
export function ddl(schema = 'account_graph'): string {
  return `
create schema if not exists ${schema};

-- The record: every time a subject was seen with an identifier. Append-only.
create table if not exists ${schema}.sighting (
  id bigint generated always as identity primary key,
  subject text not null,
  identifier text not null,
  at bigint not null,
  event text,
  recorded_at bigint not null
);
create index if not exists sighting_subject on ${schema}.sighting (subject, at);

-- Sightings folded per subject and identifier. This is the graph.
create table if not exists ${schema}.edge (
  subject text not null,
  identifier text not null,
  first_at bigint not null,
  last_at bigint not null,
  sightings int not null,
  primary key (subject, identifier)
);
create index if not exists edge_identifier on ${schema}.edge (identifier);

-- How many subjects carry each identifier, kept so a public one is never scanned.
create table if not exists ${schema}.identifier (
  id text primary key,
  fanout int not null,
  ignored boolean not null default false
);

-- Derived: which component and cluster each subject is in. Rebuildable from edges.
create table if not exists ${schema}.subject (
  id text primary key,
  component text not null,
  cluster text not null
);
create index if not exists subject_component on ${schema}.subject (component);
create index if not exists subject_cluster on ${schema}.subject (cluster);

-- The record: pairs a reviewer decided are different people. a < b.
create table if not exists ${schema}.apart (
  a text not null,
  b text not null,
  primary key (a, b)
);
create index if not exists apart_b on ${schema}.apart (b);

-- Value moved between two subjects, folded per pair and asset.
create table if not exists ${schema}.flow (
  source text not null,
  target text not null,
  asset text not null,
  transfers int not null,
  total bigint not null,
  first_at bigint not null,
  last_at bigint not null,
  primary key (source, target, asset)
);
create index if not exists flow_target on ${schema}.flow (target);

-- The record: marketing touchpoints.
create table if not exists ${schema}.touch (
  id bigint generated always as identity primary key,
  subject text not null,
  at bigint not null,
  detail jsonb not null
);
create index if not exists touch_subject on ${schema}.touch (subject, at);

-- The record: the latest advertising consent each subject gave.
create table if not exists ${schema}.consent (
  subject text primary key,
  ad_user_data boolean not null,
  ad_personalization boolean not null
);

-- The record: decisions people made about the graph, each sealed to the one before. Append-only.
create table if not exists ${schema}.decision (
  seq bigint primary key,
  at bigint not null,
  action text not null,
  about jsonb not null,
  actor text,
  reason text,
  hash text not null
);

-- The outbox: outcomes to send, one row per ad platform, and what became of each.
create table if not exists ${schema}.conversion (
  transaction_id text not null,
  target text not null,
  state text not null,
  due bigint not null,
  attempts int not null,
  job jsonb not null,
  primary key (transaction_id, target)
);
create index if not exists conversion_due on ${schema}.conversion (due) where state = 'pending';
`
}
