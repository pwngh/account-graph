import type { Job, JobState, OutboxStore } from './outbox.ts'
import type { Store, Tx } from './store.ts'
import type { Consent, Decision, Edge, FlowEdge, Identifier, IdentifierState, Labels, Sighting, Subject, Touch } from './types.ts'

/** The part of a `pg` client the store calls. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>
}

/** The part of a `pg` Pool the store calls. */
export interface Pool extends Queryable {
  connect(): Promise<Queryable & { release(): void }>
}

export interface PostgresStore extends Store {
  /** Creates the schema and tables if they are missing. */
  migrate(): Promise<void>
}

/**
 * Keeps the graph in PostgreSQL. Writes take one advisory lock, so they run
 * one at a time across every process; reads take a repeatable-read snapshot
 * and never wait on a write.
 */
export function createPostgresStore(pool: Pool, schema = 'account_graph'): PostgresStore {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new TypeError(`Schema "${schema}" must be a plain lowercase name`)
  const t = (table: string) => `${schema}.${table}`

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
        `insert into ${t('sighting')} (subject, identifier, at, event)
         select * from unnest($1::text[], $2::text[], $3::bigint[], $4::text[])`,
        [rows.map((r) => r.subject), rows.map((r) => r.identifier), rows.map((r) => r.at), rows.map((r) => r.event ?? null)],
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
      await db.query(`delete from ${t('subject')} where id = $1`, [subject])
      await db.query(`delete from ${t('apart')} where a = $1 or b = $1`, [subject])
      await db.query(`delete from ${t('flow')} where source = $1 or target = $1`, [subject])
      await db.query(`delete from ${t('consent')} where subject = $1`, [subject])
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

    async largestClusters(limit) {
      const { rows } = await db.query(
        `select cluster, count(*)::int as size from ${t('subject')} group by cluster having count(*) > 1 order by size desc, cluster collate "C" limit $1`,
        [limit],
      )
      return rows.map((row) => ({ id: row.cluster as Subject, size: row.size as number }))
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

    async addFlow({ from, to, amount, at, asset }) {
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

    async setConsent(subject, consent) {
      await db.query(
        `insert into ${t('consent')} (subject, ad_user_data, ad_personalization) values ($1, $2, $3)
         on conflict (subject) do update set ad_user_data = excluded.ad_user_data, ad_personalization = excluded.ad_personalization`,
        [subject, consent.adUserData, consent.adPersonalization],
      )
    },

    async consentOf(subjects) {
      const out = new Map<Subject, Consent>()
      if (subjects.length === 0) return out
      const { rows } = await db.query(`select * from ${t('consent')} where subject = any($1::text[])`, [subjects])
      for (const row of rows) out.set(row.subject, { adUserData: row.ad_user_data, adPersonalization: row.ad_personalization })
      return out
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

    async history(subject) {
      const { rows } = await db.query(
        `select subject, identifier, at, event from ${t('sighting')} where subject = $1 order by at, id`,
        [subject],
      )
      return rows.map(toSighting)
    },

    async sightingsUntil(at) {
      const { rows } = await db.query(`select subject, identifier, at, event from ${t('sighting')} where at <= $1 order by id`, [at])
      return rows.map(toSighting)
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
  })

  async function run<T>(begin: string, lock: boolean, work: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query(begin)
      if (lock) await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`account-graph:${schema}`])
      const result = await work(bind(client))
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  // Each outbox call is one statement, so it needs neither the write lock nor a transaction.
  const toJob = (row: any): Job => ({ ...row.job, state: row.state, due: Number(row.due), attempts: row.attempts })
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
      return toJob(rows[0])
    },
    async claim(now, lease, limit) {
      const { rows } = await pool.query(
        `update ${t('conversion')} c set attempts = c.attempts + 1, due = $1::bigint + $2::bigint
         where (c.transaction_id, c.target) in (
           select transaction_id, target from ${t('conversion')}
           where state = 'pending' and due <= $1 order by due limit $3 for update skip locked
         )
         returning *`,
        [now, lease, limit],
      )
      return rows.map(toJob).sort((x, y) => (x.transactionId < y.transactionId ? -1 : x.transactionId > y.transactionId ? 1 : x.target < y.target ? -1 : 1))
    },
    async save(job) {
      await pool.query(
        `update ${t('conversion')} set state = $3, due = $4, attempts = $5, job = $6 where transaction_id = $1 and target = $2`,
        [job.transactionId, job.target, job.state, job.due, job.attempts, job],
      )
    },
    async get(transactionId) {
      const { rows } = await pool.query(`select * from ${t('conversion')} where transaction_id = $1 order by target`, [transactionId])
      return rows.map(toJob)
    },
    async counts() {
      const out: Record<JobState, number> = { pending: 0, sent: 0, skipped: 0, failed: 0 }
      const { rows } = await pool.query(`select state, count(*)::int as n from ${t('conversion')} group by state`)
      for (const row of rows) out[row.state as JobState] = row.n
      return out
    },
    async remove(subject) {
      await pool.query(`delete from ${t('conversion')} where job->>'subject' = $1`, [subject])
    },
  }

  return {
    outbox,
    write: (work) => run('begin', true, work),
    read: (work) => run('begin isolation level repeatable read read only', false, work),
    async migrate() {
      await pool.query(ddl(schema))
    },
  }
}

function toSighting(row: any): Sighting {
  const sighting = { subject: row.subject, identifier: row.identifier, at: Number(row.at) }
  return row.event === null ? sighting : { ...sighting, event: row.event }
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

/** The tables, for running by hand or reading. Times are epoch milliseconds. */
export function ddl(schema = 'account_graph'): string {
  return `
create schema if not exists ${schema};

-- The record: every time a subject was seen with an identifier. Append-only.
create table if not exists ${schema}.sighting (
  id bigint generated always as identity primary key,
  subject text not null,
  identifier text not null,
  at bigint not null,
  event text
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
