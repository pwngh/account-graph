/**
 * Three stories on made-up data, through the package's own calls: duplicate
 * accounts on a game platform, an enrollment traced back to an ad click, and
 * a decision about two people. Run with `node demo.ts`.
 */
import { createServer } from 'node:http'
import { accountGraph, parseWebhook, verifyWebhook } from './src/index.ts'
import { runWorkers } from './src/testing/index.ts'

const HOUR = 3_600_000
const noon = Date.UTC(2026, 10, 23, 18)

// A receiver of events. It checks each before it reads it.
const heard: string[] = []
const receiver = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const webhook = { headers: request.headers as Record<string, string>, body }
  const genuine = await verifyWebhook(webhook, { secret: 'a-demo-secret', now: noon + 60 * HOUR, maxAgeMs: 300_000 })
  if (genuine) heard.push(...parseWebhook(webhook).map((event) => event.type))
  response.writeHead(genuine ? 204 : 401).end()
}).listen(0, '127.0.0.1')
await new Promise((resolve) => receiver.once('listening', resolve))

const graph = accountGraph({
  memory: true,
  now: () => noon + 60 * HOUR,
  // An ad platform that takes everything: what would be sent is printed.
  ads: { meta: { pixelId: '555', accessToken: 'made-up', siteUrl: 'https://site.example/' } },
  fetch: async (address, init) => {
    if (String(address).startsWith('http://127.0.0.1')) return fetch(address, init)
    const [event] = JSON.parse(String(init?.body)).data
    console.log('sent to Meta:', JSON.stringify({ event_name: event.event_name, event_id: event.event_id, custom_data: event.custom_data }))
    return Response.json({ events_received: 1, fbtrace_id: 'demo-1' })
  },
  webhook: { url: `http://127.0.0.1:${(receiver.address() as { port: number }).port}/`, secret: 'a-demo-secret' },
})
await runWorkers(graph)
const members = async (subject: string) => (await graph.lookup({ kind: 'person', subjects: [subject], at: noon })).people[0]!.members.join(', ')

console.log('1. Duplicate accounts\n')
const login = (subject: string, hours: number, facts: { ip?: string; identifiers: string[] }) => ({ type: 'profile' as const, key: `login ${subject} ${hours}`, at: noon + hours * HOUR, subject, facts, event: 'login' })
await graph.record({ entries: [
  login('account:ana', 0, { ip: '203.0.113.20', identifiers: ['hardware:HW-7F', 'canvas:c-iphone15'] }),
  login('account:ana2', 1, { ip: '198.51.100.4', identifiers: ['hardware:HW-7F', 'canvas:c-iphone15'] }),
  // A roommate: same address and the same phone model, so the same browser hash, but a different machine.
  login('account:ben', 0, { ip: '203.0.113.20', identifiers: ['hardware:HW-22', 'canvas:c-iphone15'] }),
  // A cafe: thirty strangers behind one address.
  ...Array.from({ length: 30 }, (_, i) => login(`account:cafe${i}`, 0, { ip: '192.0.2.77', identifiers: [`hardware:HW-C${i}`] })),
] })
console.log('account:ana2 is', await members('account:ana2'))
console.log('account:ben, the roommate, is', await members('account:ben'))
console.log('account:cafe3 is', await members('account:cafe3'))
const { results: [trade] } = await graph.record({ entries: [{ type: 'transfer', key: 'trade-1', at: noon + 2 * HOUR, from: 'account:ana2', to: 'account:ana', amount: 250_000, asset: 'gold' }] })
console.log('a trade between the two comes back flagged:', trade!.ok && trade!.value)

console.log('\n2. Ad click to enrollment\n')
const enrolled = noon + 50 * HOUR
// Monday: an ad click lands on the site, and nobody knows who this is. Wednesday: the same browser returns and enrolls.
await graph.record({ entries: [
  { type: 'arrival', key: 'click-481', at: noon, subject: 'visitor:d-481', source: 'facebook', medium: 'cpc', campaign: 'spring', campaignId: '42', clicks: { fbclid: 'demo-click' }, landing: 'https://site.example/start' },
  { type: 'profile', key: 'visit-481', at: noon, subject: 'visitor:d-481', facts: { device: 'd-481' } },
  { type: 'profile', key: 'enroll-1001', at: enrolled, subject: 'contact:1001', facts: { device: 'd-481', email: 'Pat.Lee@gmail.com' } },
  { type: 'conversion', key: 'enroll-1001', at: enrolled, subject: 'contact:1001', stage: 'enrolled', value: 200, currency: 'USD', actions: { meta: 'Lead' }, email: 'Pat.Lee@gmail.com' },
] })
const { arrival } = (await graph.lookup({ kind: 'person', subjects: ['contact:1001'], at: enrolled })).people[0]!
console.log(`credited to ${arrival!.campaign} at ${arrival!.confidence}, by the ${arrival!.how}`)
await runWorkers(graph)
const refund = { type: 'restatement' as const, key: 'refund-1', at: enrolled + HOUR, of: { type: 'conversion' as const, key: 'enroll-1001' }, change: { kind: 'refund' as const, amount: 80 } }
console.log('after a partial refund:', JSON.stringify((await graph.record({ entries: [refund] })).results[0]))
console.log('the same refund again:', JSON.stringify((await graph.record({ entries: [refund] })).results[0]))
const { value: report } = await graph.report({ kind: 'campaigns', window: { from: '2026-11-23', to: '2026-11-25', timeZone: 'UTC' } })
console.log('report:', report.rows.map((row) => `${row.source} ${row.campaignId}: ${row.outcomes} for ${row.value}`).join('; '))

console.log('\n3. A decision\n')
const pairs = [{ a: 'account:ana', b: 'account:ana2' }]
const { decisions } = await graph.lookup({ kind: 'person', subjects: ['account:ana'], at: noon })
const unmerged = await graph.decide({ key: 'ticket-7', at: enrolled, by: 'dana', seen: decisions, action: 'unmerge', pairs })
console.log('nobody joined them, the graph did:', JSON.stringify(unmerged))
console.log('so they are split:', JSON.stringify(await graph.decide({ key: 'ticket-8', at: enrolled, by: 'dana', seen: decisions, action: 'split', pairs: pairs.map((pair) => ({ ...pair, reason: 'sisters, one family computer' })) })))
console.log('account:ana2 is now', await members('account:ana2'))
const late = await graph.decide({ key: 'ticket-9', at: enrolled, by: 'lee', seen: decisions, action: 'merge', pairs })
console.log('someone who had not seen that:', late.ok || late.reason)
const forgotten = await graph.forget({ key: 'request-3', at: enrolled, by: 'dana', subjects: ['contact:1001'], platforms: 'report' })
console.log('contact:1001 is deleted:', JSON.stringify(forgotten.ok && forgotten.value.sent))
console.log('a late retry brings nobody back:', JSON.stringify((await graph.record({ entries: [refund] })).results[0]))
await runWorkers(graph)
console.log(`\nthe receiver heard ${heard.length} events: ${[...new Set(heard)].join(', ')}`)
await graph.close()
receiver.close()
