import type { Feed, KeptAlert, OpsStore } from './ops.ts'
import type { Job, JobState, OutboxStore } from './outbox.ts'
import type { Store, Tx } from './store.ts'
import type { CallResult, Consent, Cost, Counted, Decision, Edge, FlowEdge, Identifier, IdentifierState, KeptCall, Labels, Lease, Moved, OutcomeValue, Sighting, Subject, Touch } from './types.ts'

/** The part of a `pg` client the store calls. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>
}

/** The part of a `pg` Pool the store calls. */
export interface Pool extends Queryable {
  connect(): Promise<Queryable & { release(): void }>
}

export interface PostgresStore extends Store {
  /**
   * Brings the database up to date: creates what is missing and applies each
   * upgrade that has not run yet, in order, inside one transaction. Safe to
   * call on every start and from several processes at once. Returns the
   * names of the upgrades it applied.
   */
  migrate(): Promise<string[]>
}

/** The order `standingFirst` gives, in SQL. False sorts first, and rows equal in everything that counts are told apart by id. */
const STANDING = 'at desc, recorded_at desc, ad_user_data, ad_personalization, id'

/**
 * Keeps the graph in PostgreSQL. Writes take one advisory lock, so they run
 * one at a time across every process; reads take a repeatable-read snapshot
 * and never wait on a write.
 */
export function createPostgresStore(pool: Pool, schema = 'account_graph'): PostgresStore {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new TypeError(`Schema "${schema}" must be a plain lowercase name`)
  const t = (table: string) => `${schema}.${table}`

  const callRows = `select c.*, r.answered, r.voicemail, r.waited, r.recorded_at as result_at from ${t('call')} c left join ${t('call_result')} r on r.id = c.id`

  const bind = (db: Queryable): Tx => ({
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

    async removeSubject(subject) {
      await db.query(
        `with gone as (delete from ${t('edge')} where subject = $1 returning identifier)
         update ${t('identifier')} set fanout = fanout - 1 where id in (select identifier from gone)`,
        [subject],
      )
      await db.query(`delete from ${t('sighting')} where subject = $1`, [subject])
      await db.query(`delete from ${t('touch')} where subject = $1`, [subject])
      await db.query(`delete from ${t('outcome')} where subject = $1`, [subject])
      await db.query(`delete from ${t('outcome_value')} where subject = $1`, [subject])
      await db.query(`with gone as (delete from ${t('call')} where subject = $1 returning id) delete from ${t('call_result')} where id in (select id from gone)`, [subject])
      await db.query(`update ${t('call')} set visitor = null where visitor = $1`, [subject])
      await db.query(`delete from ${t('subject')} where id = $1`, [subject])
      await db.query(`delete from ${t('conversion')} where job->>'subject' = $1`, [subject])
      await db.query(`delete from ${t('apart')} where a = $1 or b = $1`, [subject])
      await db.query(`delete from ${t('flow')} where source = $1 or target = $1`, [subject])
      await db.query(`delete from ${t('transfer')} where source = $1 or target = $1`, [subject])
      await db.query(`delete from ${t('consent_log')} where subject = $1`, [subject])
      // Who held a number is forgotten. That somebody did stays, or a call in that time would go to whoever held it before.
      await db.query(`update ${t('lease')} set subject = '' where subject = $1`, [subject])
      await db.query(`delete from ${t('alert')} where subject = $1`, [subject])
      await db.query(`delete from ${t('change')} where subject = $1`, [subject])
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

    async allEdges() {
      const { rows } = await db.query(`select * from ${t('edge')}`)
      return rows.map(toEdge)
    },

    async states(identifiers) {
      const out = new Map<Identifier, IdentifierState>()
      if (identifiers.length === 0) return out
      const { rows } = await db.query(
        `select id, fanout, ignored from ${t('identifier')} where id = any($1::text[]) and (fanout > 0 or ignored)`,
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
      if (changes.length === 0) return
      await db.query(
        `insert into ${t('change')} (at, subject, from_cluster, to_cluster) select $1, * from unnest($2::text[], $3::text[], $4::text[])`,
        [at, changes.map((change) => change.subject), changes.map((change) => change.from ?? null), changes.map((change) => change.to ?? null)],
      )
    },

    async recentChanges(limit) {
      const { rows } = await db.query(`select * from ${t('change')} order by id desc limit $1`, [limit])
      return rows.map((row): Moved => ({ subject: row.subject, from: row.from_cluster ?? undefined, to: row.to_cluster ?? undefined, at: Number(row.at) }))
    },

    async fed(feed, at) {
      await db.query(`insert into ${t('feed')} (name, last_at) values ($1, $2) on conflict (name) do update set last_at = greatest(${t('feed')}.last_at, excluded.last_at)`, [feed, at])
    },

    async empty() {
      const { rows } = await db.query(`select 1 from ${t('subject')} limit 1`)
      return rows.length === 0
    },

    async builtWith() {
      const { rows } = await db.query(`select policy from ${t('built')}`)
      return (rows[0]?.policy as string | undefined) ?? undefined
    },

    async setBuiltWith(hash) {
      await db.query(`insert into ${t('built')} (policy) values ($1) on conflict (one) do update set policy = excluded.policy`, [hash])
    },

    async kinds() {
      const { rows } = await db.query(`select distinct split_part(id, ':', 1) as kind from ${t('identifier')} where fanout > 0 order by 1`)
      return rows.map((row) => row.kind as string)
    },

    async allLabels() {
      const { rows } = await db.query(`select id, component, cluster from ${t('subject')}`)
      return toLabels(rows)
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

    async addConsent(subject, { at, adUserData, adPersonalization, source, recorded }) {
      await db.query(
        `insert into ${t('consent_log')} (subject, at, ad_user_data, ad_personalization, source, recorded_at) values ($1, $2, $3, $4, $5, $6)`,
        [subject, at, adUserData, adPersonalization, source ?? null, recorded],
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
      return rows.map((row) => ({ at: Number(row.at), adUserData: row.ad_user_data, adPersonalization: row.ad_personalization, ...(row.source !== null && { source: row.source }), recorded: Number(row.recorded_at) }))
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

    async addTouch({ subject, at, ...detail }) {
      await db.query(`insert into ${t('touch')} (subject, at, detail) values ($1, $2, $3)`, [subject, at, detail])
    },

    async touchesOf(subjects, from, to) {
      if (subjects.length === 0) return []
      const { rows } = await db.query(
        `select subject, at, detail from ${t('touch')} where subject = any($1::text[]) and at between $2 and $3 order by id`,
        [subjects, from, to],
      )
      return rows.map((row) => ({ ...row.detail, subject: row.subject, at: Number(row.at) }) as Touch)
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

    async addValue(transactionId, subject, { value, currency, at }) {
      await db.query(`insert into ${t('outcome_value')} (transaction_id, subject, value, currency, at) values ($1, $2, $3, $4, $5)`, [transactionId, subject, value, currency, at])
    },

    async valuesOf(transactionId, subject) {
      const { rows } = await db.query(`select value, currency, at from ${t('outcome_value')} where transaction_id = $1 and subject = $2 order by id`, [transactionId, subject])
      return rows.map(toValue)
    },

    async firstValues(given) {
      if (given.length === 0) return new Map()
      const { rows } = await db.query(
        `select distinct on (v.transaction_id) v.*, max(v.value) over (partition by v.transaction_id) as most
         from unnest($1::text[], $2::text[]) as o (id, subject) join ${t('outcome_value')} v on v.transaction_id = o.id and v.subject = o.subject order by v.transaction_id, v.id`,
        [given.map((each) => each.transactionId), given.map((each) => each.subject)],
      )
      return new Map(rows.map((row) => [row.transaction_id as string, { ...toValue(row), most: row.most as number }]))
    },

    async removeOutcome(transactionId) {
      await db.query(`delete from ${t('outcome')} where transaction_id = $1`, [transactionId])
    },

    async setCall({ id, direction, subject, at, to, duration, flags, visitor, tags, recorded }) {
      await db.query(
        `insert into ${t('call')} (id, subject, at, dialed, duration, flags, visitor, recorded_at, direction, tags) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (id) do update set subject = excluded.subject, at = excluded.at, dialed = excluded.dialed, duration = excluded.duration,
           flags = excluded.flags, visitor = excluded.visitor, recorded_at = excluded.recorded_at, direction = excluded.direction, tags = excluded.tags`,
        [id, subject, at, to, duration ?? null, flags, visitor ?? null, recorded, direction, tags ?? null],
      )
    },

    async setCallResult(id, { answered, voicemail, waited, recorded }) {
      await db.query(
        `insert into ${t('call_result')} (id, answered, voicemail, waited, recorded_at) values ($1, $2, $3, $4, $5)
         on conflict (id) do update set answered = excluded.answered, voicemail = excluded.voicemail, waited = excluded.waited, recorded_at = excluded.recorded_at`,
        [id, answered ?? null, voicemail ?? null, waited ?? null, recorded],
      )
    },

    async callOf(id) {
      const { rows } = await db.query(`${callRows} where c.id = $1`, [id])
      return rows[0] && toCall(rows[0])
    },

    async callResultOf(id) {
      const { rows } = await db.query(`select answered, voicemail, waited, recorded_at as result_at from ${t('call_result')} where id = $1`, [id])
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
           and ($4::bigint is null or c.at > $4 or (c.at = $4 and c.id collate "C" > $5))
           and not exists (select 1 from ${t('call')} d join ${t('call_result')} s on s.id = d.id where d.subject = c.subject and d.at > c.at and s.answered)
         order by c.at, c.id collate "C" limit $3`,
        [from, to, limit, after?.at ?? null, after?.id ?? null],
      )
      return rows.map(toCall)
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
        `with gone as (delete from ${t('call_result')} r where recorded_at < $1 and not exists (select 1 from ${t('call')} c where c.id = r.id) returning 1) select count(*)::int as n from gone`,
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

    async addCosts(costs) {
      // Fold repeats first, keeping the last: one statement cannot upsert the same row twice.
      const last = [...new Map(costs.map((cost) => [[cost.day, cost.source, cost.campaignId].join('\u0000'), cost])).values()]
      if (last.length === 0) return
      await db.query(
        `insert into ${t('cost')} (day, source, campaign_id, campaign, amount, currency, clicks, impressions)
         select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::float8[], $6::text[], $7::bigint[], $8::bigint[])
         on conflict (day, source, campaign_id) do update set
           campaign = excluded.campaign, amount = excluded.amount, currency = excluded.currency, clicks = excluded.clicks, impressions = excluded.impressions`,
        [
          last.map((c) => c.day),
          last.map((c) => c.source),
          last.map((c) => c.campaignId),
          last.map((c) => c.campaign),
          last.map((c) => c.amount),
          last.map((c) => c.currency),
          last.map((c) => c.clicks),
          last.map((c) => c.impressions),
        ],
      )
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

    async sightingsUntil(recorded) {
      const { rows } = await db.query(
        `select subject, identifier, at, event, recorded_at from ${t('sighting')} where recorded_at <= $1 order by id`,
        [recorded],
      )
      return rows.map(toSighting)
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
         join ${t('decision')} d on d.about->>0 = pair.a and d.about->>1 = pair.b where d.action in ('join', 'separate', 'rejoin') order by d.seq`,
        [pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])],
      )
      return rows.map(toDecision)
    },

    async pairsDecidedBySystems(times) {
      const { rows } = await db.query(
        `select about->>0 as a, about->>1 as b from ${t('decision')} where starts_with(actor, 'system:') and action in ('join', 'separate', 'rejoin')
         group by 1, 2 having count(*) >= $1`,
        [times],
      )
      return rows.map((row) => [row.a, row.b] as [Subject, Subject])
    },
  })

  async function run<T>(begin: string, lock: boolean, work: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query(begin)
      if (lock) await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`account-graph:${schema}`])
      const result = await work(bind(client))
      // A write is counted as it commits, in the same trip to the database.
      await client.query(lock ? `update ${t('pulse')} set writes = writes + 1; commit` : 'commit')
      return result
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  // Each outbox call is one statement, so it needs neither the write lock nor a transaction.
  const toJob = (row: any): Job => ({ ...row.job, state: row.state, due: Number(row.due), attempts: row.attempts, rev: Number(row.rev) })
  const outbox: OutboxStore = {
    async add(job) {
      const { rows } = await pool.query(
        `with added as (
           insert into ${t('conversion')} (transaction_id, target, state, due, attempts, job) values ($1, $2, $3, $4, $5, $6)
           on conflict (transaction_id, target) do nothing returning *
         )
         select * from added union all select * from ${t('conversion')} where transaction_id = $1 and target = $2 limit 1`,
        [job.transactionId, job.target, job.state, job.due, job.attempts, job],
      )
      // Another call may have added it in the same moment, too late for the statement above to see. A new one sees it.
      return toJob(rows[0] ?? (await pool.query(`select * from ${t('conversion')} where transaction_id = $1 and target = $2`, [job.transactionId, job.target])).rows[0])
    },
    async claim(now, lease, limit) {
      const { rows } = await pool.query(
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
      const { rows } = await pool.query(
        `update ${t('conversion')} set state = $3, due = $4, attempts = $5, job = $6, rev = rev + 1 where transaction_id = $1 and target = $2 and rev = $7 returning 1`,
        [after.transactionId, after.target, after.state, after.due, after.attempts, after, before.rev],
      )
      return rows.length > 0
    },
    async standing(jobs) {
      const { rows } = await pool.query(
        `select c.transaction_id, c.target from unnest($1::text[], $2::text[], $3::bigint[]) as j (id, target, rev)
         join ${t('conversion')} c on c.transaction_id = j.id and c.target = j.target and c.rev = j.rev`,
        [jobs.map((job) => job.transactionId), jobs.map((job) => job.target), jobs.map((job) => job.rev)],
      )
      const found = new Set(rows.map((row) => `${row.transaction_id}\u0000${row.target}`))
      return jobs.filter((job) => found.has(`${job.transactionId}\u0000${job.target}`))
    },
    async get(transactionId) {
      const { rows } = await pool.query(`select * from ${t('conversion')} where transaction_id = $1 order by target`, [transactionId])
      return rows.map(toJob)
    },
    async list(state, limit) {
      const { rows } = await pool.query(`select * from ${t('conversion')} where state = $1 order by due desc, transaction_id limit $2`, [state, limit])
      return rows.map(toJob)
    },
    async oldestDue() {
      const { rows } = await pool.query(`select min(due) as due from ${t('conversion')} where state = 'pending'`)
      return rows[0].due === null ? undefined : Number(rows[0].due)
    },
    async counts() {
      const out: Record<JobState, number> = { held: 0, pending: 0, sent: 0, skipped: 0, failed: 0 }
      const { rows } = await pool.query(`select state, count(*)::int as n from ${t('conversion')} group by state`)
      for (const row of rows) out[row.state as JobState] = row.n
      return out
    },
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
    async addAlert({ key, text, at, subject, error }) {
      const { rows } = await pool.query(`insert into ${t('alert')} (key, text, at, subject, error, tried_at) values ($1, $2, $3, $4, $5, $3) on conflict do nothing returning 1`, [key, text, at, subject ?? null, error ?? null])
      return rows.length > 0
    },
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
    async alertDelivered(key, at) {
      await pool.query(`update ${t('alert')} set delivered_at = $2 where key = $1`, [key, at])
    },
    async alertFailed(key, error) {
      await pool.query(`update ${t('alert')} set error = $2 where key = $1`, [key, error])
    },
    async undelivered() {
      const { rows } = await pool.query(`select * from ${t('alert')} where delivered_at is null order by at`)
      return rows.map(toAlert)
    },
  }

  return {
    outbox,
    ops,
    write: (work) => run('begin', true, work),
    read: (work) => run('begin isolation level repeatable read read only', false, work),
    async migrate() {
      await pool.query(`create schema if not exists ${schema};
        create table if not exists ${t('upgrade')} (id int primary key, name text not null, applied_at bigint not null)`)
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`account-graph:${schema}:upgrade`])
        const { rows } = await client.query(`select id from ${t('upgrade')}`)
        const done = new Set(rows.map((row) => row.id as number))
        const applied: string[] = []
        for (const upgrade of upgrades(schema)) {
          if (done.has(upgrade.id)) continue
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
        client.release()
      }
    },
  }
}

function toSighting(row: any): Sighting {
  const sighting = { subject: row.subject, identifier: row.identifier, at: Number(row.at), recorded: Number(row.recorded_at) }
  return row.event === null ? sighting : { ...sighting, event: row.event }
}

function toCounted(row: any): Counted {
  return { transactionId: row.transaction_id, subject: row.subject, at: Number(row.at), stage: row.stage, value: row.value, currency: row.currency, ...(row.tags !== null && { tags: row.tags }) }
}

function toValue(row: any): OutcomeValue {
  return { value: row.value, currency: row.currency, at: Number(row.at) }
}

function toResult(row: any): CallResult {
  return { ...(row.answered !== null && { answered: row.answered }), ...(row.voicemail !== null && { voicemail: row.voicemail }), ...(row.waited !== null && { waited: row.waited }), recorded: Number(row.result_at) }
}

function toCall(row: any): KeptCall {
  return {
    id: row.id,
    direction: row.direction,
    subject: row.subject,
    at: Number(row.at),
    to: row.dialed,
    ...(row.duration !== null && { duration: row.duration }),
    flags: row.flags,
    ...(row.visitor !== null && { visitor: row.visitor }),
    ...(row.tags !== null && { tags: row.tags }),
    recorded: Number(row.recorded_at),
    ...(row.result_at !== null && { result: toResult(row) }),
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

function toEdge(row: any): Edge {
  return {
    subject: row.subject,
    identifier: row.identifier,
    first: Number(row.first_at),
    last: Number(row.last_at),
    count: row.sightings,
  }
}

/**
 * Every change to the database's shape, oldest first. `migrate` applies the
 * ones a database has not had. To change the shape, add an entry with the
 * next id; never edit one that has shipped. The first entry creates
 * everything for a new database, so later entries must also be safe to run
 * on a database that the first entry just created.
 */
export function upgrades(schema = 'account_graph'): { id: number; name: string; sql: string }[] {
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
