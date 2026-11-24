/**
 * Two stories on made-up data: duplicate accounts on a game platform, and an
 * enrollment traced back to an ad click. Run with `node demo.ts`.
 */
import { createGraph, createMemoryStore, createOutbox, email, googleAds, ip } from './src/index.ts'
import type { Link } from './src/index.ts'

const store = createMemoryStore()
const graph = createGraph(store)
const HOUR = 3_600_000
const noon = Date.UTC(2026, 10, 23, 18)

const explain = (links: Link[]) =>
  links.map(
    (link) =>
      `  ${link.subject}  ${link.level} ${link.score.toFixed(3)}  because ` +
      link.reasons.map((r) => `${r.identifier.split(':')[0]} ${r.evidence.toFixed(2)} (${r.fanout} share it)`).join(' + '),
  )

console.log('1. Duplicate accounts\n')
await graph.observe([
  { subject: 'account:ana', identifiers: ['hardware:HW-7F', 'canvas:c-iphone15', ip('203.0.113.20')], at: noon, event: 'login' },
  { subject: 'account:ana2', identifiers: ['hardware:HW-7F', 'canvas:c-iphone15', ip('198.51.100.4')], at: noon + HOUR, event: 'login' },
  // A roommate: same address and the same phone model, so the same browser hash, but a different machine.
  { subject: 'account:ben', identifiers: ['hardware:HW-22', 'canvas:c-iphone15', ip('203.0.113.20')], at: noon, event: 'login' },
  // A cafe: thirty strangers behind one address.
  ...Array.from({ length: 30 }, (_, i) => ({
    subject: `account:cafe${i}`,
    identifiers: [`hardware:HW-C${i}`, ip('192.0.2.77')],
    at: noon,
    event: 'login',
  })),
])
const trade = await graph.observe({ subject: 'account:ana2', identifiers: ['hardware:HW-7F'], at: noon + 2 * HOUR, event: 'trade' })
console.log('ana2 trades. Cluster changes from that one event:', trade.length === 0 ? 'none (already joined at login)' : trade)
console.log('links of account:ana2:')
console.log(explain(await graph.links('account:ana2')).join('\n'))
console.log('cluster:', (await graph.cluster('account:ana2'))!.members.join(', '))
console.log('links of account:ben (roommate: same address, same phone model):')
console.log(explain(await graph.links('account:ben')).join('\n'))
console.log('cluster of account:ben:', (await graph.cluster('account:ben'))!.members.join(', '))
console.log('links of account:cafe3 (address is past its cap):', (await graph.links('account:cafe3')).length)

console.log('\n2. Ad click to enrollment\n')
// Monday: an ad click lands on the marketing site. Nobody knows who this is.
await graph.observe({ subject: 'visitor:d-481', identifiers: ['device:d-481', ip('203.0.113.50')], at: noon, event: 'visit' })
await graph.touch({ subject: 'visitor:d-481', at: noon, gclid: 'Cj0KCQ-demo', source: 'google', medium: 'cpc', campaign: 'spring', landing: 'https://site.example/start' })
// Wednesday: the same browser returns directly and enrolls. Your server reads the device cookie.
const enrolled = noon + 50 * HOUR
await graph.observe({ subject: 'contact:1001', identifiers: ['device:d-481', email('Pat.Lee@gmail.com')], at: enrolled, event: 'enroll' })

const attribution = await graph.attribute('contact:1001', { at: enrolled })
console.log(`attribution: ${attribution.reason}, via ${attribution.credited?.via.join(' > ')} > visitor:d-481,`, `confidence ${attribution.credited?.confidence}`)

// The outbox records the outcome once and sends it. Here "Google" is a function that prints.
const outbox = createOutbox(graph, store.outbox, {
  targets: [googleAds({ customerId: '123-456-7890', send: async (request) => (console.log('sent to Google:', JSON.stringify(request.events[0])), { requestId: 'demo-1' }) })],
})
await outbox.record({ transactionId: 'enroll-1001', subject: 'contact:1001', at: enrolled, action: '987654321', value: 200, email: 'Pat.Lee@gmail.com' })
console.log('outbox pass:', JSON.stringify(await outbox.run()))
await outbox.restate('enroll-1001', 120)
console.log('after a partial refund:', JSON.stringify(await outbox.run()))

console.log('\n3. A ring\n')
// Four accounts in a row, each sharing one machine with the next. No one link is strong.
const ring = ['account:r1', 'account:r2', 'account:r3', 'account:r4']
await graph.observe(ring.map((subject, i) => ({ subject, identifiers: [`hardware:M${i}`, `hardware:M${i + 1}`], at: noon, event: 'login' })))
console.log('one weak link may not join two groups:', (await graph.cluster('account:r1'))!.members.join(', '), '|', (await graph.cluster('account:r4'))!.members.join(', '))

// Value only ever moves one way inside the first pair.
for (let i = 0; i < 4; i++) await graph.transfer({ id: `trade-${i}`, from: 'account:r2', to: 'account:r1', amount: 250_000, at: noon + i * HOUR, asset: 'gold' })
const held = await graph.transfer({ id: 'trade-held', from: 'account:r2', to: 'account:r1', amount: 250_000, at: noon + 5 * HOUR, asset: 'gold' })
console.log(`a trade between them comes back flagged: relation ${held.relation}, ${held.count} trades, imbalance ${held.imbalance}`)
console.log('collusion report for r1:', (await graph.collusion('account:r1')).map((row) => `${row.subject} sent ${row.received} ${row.asset} over ${row.count} trades`).join('; '))

// A reviewer looks at r3 and r4 and decides they are two people. The decision is recorded and sealed.
await graph.separate('account:r3', 'account:r4', true, { by: 'dana', reason: 'siblings, one family computer' })
console.log('after the review (r3 is now one account tied to r2, so it joins that pair):', (await graph.cluster('account:r3'))!.members.join(', '), '|', (await graph.cluster('account:r4'))!.members.join(', '))
console.log('decisions:', (await graph.decisions()).map((d) => `#${d.seq} ${d.action} ${d.about.join(' / ')} by ${d.by}`).join('; '), '| record sound:', (await graph.audit()).sound)

console.log('\nstored clusters match a full recompute:', (await graph.verify()).length === 0)
