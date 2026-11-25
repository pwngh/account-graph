/** What must compile, and what must not. `npm run check` is its test: nothing here is run. */
import { accountGraph, isFault } from '../src/index.ts'
import type { AccountGraph, GraphEvent, ReportRequest } from '../src/index.ts'
export async function calls() {
  const graph: AccountGraph = accountGraph({ url: 'https://graph.example.org', token: 't' })
  accountGraph({ memory: true }); accountGraph({ databaseUrl: 'x', workers: true, receiptSecrets: ['s'] })
  accountGraph({ memory: true, policy: { kinds: { phone: { weight: 0.8 } }, customKinds: { badge: { weight: 1, dilution: 0, cap: 2, halfLife: 'none' } } }, openHours: { mon: ['09:00-17:00'], holidays: ['us-tx', '2026-12-24'] } })
  // @ts-expect-error both places
  accountGraph({ memory: true, databaseUrl: 'x', workers: true, receiptSecrets: ['s'] })
  // @ts-expect-error remote and local
  accountGraph({ url: 'x', token: 't', memory: true })
  // @ts-expect-error workers must be said
  accountGraph({ databaseUrl: 'x', receiptSecrets: ['s'] })
  // @ts-expect-error receipt secrets must be given
  accountGraph({ databaseUrl: 'x', workers: true })
  // @ts-expect-error no secret at all
  accountGraph({ databaseUrl: 'x', workers: true, receiptSecrets: [] })
  // @ts-expect-error misspelled kind
  accountGraph({ memory: true, policy: { kinds: { phnoe: { weight: 0.8 } } } })
  // @ts-expect-error misspelled field
  accountGraph({ memory: true, policy: { kinds: { phone: { wieght: 0.8 } } } })
  // @ts-expect-error a new kind said in part
  accountGraph({ memory: true, policy: { customKinds: { badge: { weight: 1 } } } })
  // @ts-expect-error not a span
  accountGraph({ memory: true, openHours: { mon: ['nine to five'] } })
  // @ts-expect-error at is required
  void graph.record({ entries: [{ type: 'conversion', key: 'k', subject: 's', stage: 'x' }] })
  // @ts-expect-error a refund is an amount
  void graph.record({ entries: [{ type: 'restatement', key: 'k', at: 1, of: { type: 'conversion', key: 'c' }, change: { kind: 'refund', value: 1 } }] })
  const party = await graph.lookup({ kind: 'party', call: 'CA1' })
  const seen = party?.key ?? null
  // @ts-expect-error a party expectation belongs only to a party change
  void graph.record({ entries: [{ type: 'call_update', key: 'r', at: 2, call: 'CA1', change: { kind: 'not_returned', seen } }] })
  // @ts-expect-error a party expectation is a statement key or null
  void graph.record({ entries: [{ type: 'call_update', key: 'n', at: 2, call: 'CA1', change: { kind: 'party', role: 'unknown', by: 'desk', seen: 0 } }] })
  const { results } = await graph.record({ entries: [
    { type: 'profile', key: 'signup-1001', at: 1, subject: 'contact:1001', facts: { email: 'a@b.co', device: 'd' } },
    { type: 'conversion', key: 'enroll-1001', at: 1, subject: 'contact:1001', stage: 'enrolled', value: 200, currency: 'USD' },
    { type: 'call_update', key: 'u', at: 2, call: 'CA1', change: { kind: 'returned', reachedAt: 1 } },
    { type: 'call_update', key: 'p', at: 2, call: 'CA1', change: { kind: 'party', role: 'unknown', by: 'desk', seen } },
  ] })
  for (const row of results) if (!row.ok && row.reason === 'STALE') row.decision?.toUpperCase()
  for (const r of results) { if (r.ok) { r.value.duplicate; if (r.type === 'conversion') r.value.deliveries.length } else if (r.reason === 'KEY_REUSED') r.fields.length; else if (r.reason === 'CURRENCY_MISMATCH') r.expected.length }
  const p = await graph.lookup({ kind: 'person', subjects: ['contact:1001'], at: 1 })
  const d = await graph.decide({ key: 'k', at: 1, by: 'dana', seen: p.decisions, action: 'unmerge', pairs: [{ a: 'a', b: 'b' }] })
  if (!d.ok && d.reason === 'NOT_JOINED') d.pairs[0]?.because
  else if (!d.ok && d.reason === 'STALE') d.decision.toFixed()
  const c = await graph.report({ kind: 'pipeline', at: 1, days: 90 }); c.value.columns[0]?.rows[0]?.value
  const page = await graph.events({ after: null, limit: 500 }); if (page.ok) for (const e of page.value.events) if (e.type === 'callback.overdue') e.data.call
  try { await graph.events({ after: 'c', limit: 1 }) } catch (e) { if (isFault(e) && e.retryable) e.code }
  await graph.close();
}
export type Names = [GraphEvent, ReportRequest]
