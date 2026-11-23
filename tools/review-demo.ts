/**
 * Serves the reviewer screen over made-up data, to try it.
 *   npm run review
 * Then open the printed address and enter the reviewer token `demo`.
 */
import { createServer } from 'node:http'
import { createGraph, createMemoryStore } from '../src/index.ts'
import { createHandler } from '../src/server.ts'

const graph = createGraph(createMemoryStore())
const HOUR = 3_600_000
const start = Date.now() - 20 * 24 * HOUR
const login = (subject: string, identifiers: string[], hours = 0) => ({ subject, identifiers, at: start + hours * HOUR, event: 'login' })

await graph.observe([
  // One person with three accounts: same machine, and two of them share a phone.
  login('account:ana', ['hardware:hw-7f', 'phone:p-555', 'ip:203.0.113.20']),
  login('account:ana-alt', ['hardware:hw-7f', 'phone:p-555'], 2),
  login('account:ana-shop', ['hardware:hw-7f', 'email:ana-shop'], 30),
  // A roommate: same address and the same phone model, a different machine.
  login('account:ben', ['hardware:hw-22', 'canvas:c-phone15', 'ip:203.0.113.20']),
  login('account:ana', ['canvas:c-phone15'], 1),
  // Two siblings on one family computer.
  login('account:cy', ['device:family-pc', 'email:cy']),
  login('account:dee', ['device:family-pc', 'email:dee'], 5),
  // A front-desk mailbox shared by four customers.
  ...['eve', 'fay', 'gus', 'hal'].map((name, i) => login(`account:${name}`, ['email:front-desk', `hardware:hw-${name}`], 40 + i)),
])
for (let i = 0; i < 4; i++) await graph.transfer({ from: 'account:ana-alt', to: 'account:ana', amount: 250_000, at: start + (50 + i) * HOUR, asset: 'gold' })
await graph.transfer({ from: 'account:ana', to: 'account:gus', amount: 1_200, at: start + 60 * HOUR, asset: 'gold' })
// A ring: ana pays ana-shop, who pays ben, who pays ana back.
await graph.transfer({ from: 'account:ana', to: 'account:ana-shop', amount: 90_000, at: start + 70 * HOUR, asset: 'gold' })
await graph.transfer({ from: 'account:ana-shop', to: 'account:ben', amount: 85_000, at: start + 71 * HOUR, asset: 'gold' })
await graph.transfer({ from: 'account:ben', to: 'account:ana', amount: 80_000, at: start + 72 * HOUR, asset: 'gold' })
await graph.separate('account:cy', 'account:dee', true, { by: 'dana', reason: 'siblings, one family computer' })

// Marketing: three campaigns with a daily cost, the visitors each brought, and what those visitors went on to do.
const day = (ago: number) => new Date(Date.now() - ago * 24 * HOUR).toISOString().slice(0, 10)
const campaigns = [
  { source: 'google', campaignId: '20111', campaign: 'Search: garden tools', daily: 62.4, visitors: 9, enroll: 3 },
  { source: 'google', campaignId: '20222', campaign: 'Search: brand', daily: 11.75, visitors: 5, enroll: 3 },
  { source: 'meta', campaignId: '90333', campaign: 'Retarget visitors', daily: 28, visitors: 6, enroll: 1 },
]
let lead = 0
for (const { visitors, enroll, daily, ...campaign } of campaigns) {
  for (let ago = 13; ago >= 0; ago--) await graph.spend({ ...campaign, day: day(ago), amount: daily, currency: 'USD', clicks: Math.round(daily / 2.6), impressions: Math.round(daily * 21) })
  for (let i = 0; i < visitors; i++) {
    const n = ++lead
    const at = Date.now() - (13 - (n % 13)) * 24 * HOUR
    await graph.observe({ subject: `visitor:v${n}`, identifiers: [`device:v${n}`], at, event: 'visit' })
    await graph.touch({ subject: `visitor:v${n}`, at, campaignId: campaign.campaignId, ...(campaign.source === 'google' ? { gclid: `click-${n}` } : { fbclid: `click-${n}` }) })
    await graph.observe({ subject: `lead:${n}`, identifiers: [`device:v${n}`], at: at + HOUR, event: 'inquiry' })
    await graph.outcome({ transactionId: `inquiry-${n}`, subject: `lead:${n}`, at: at + HOUR, stage: 'inquiry', value: 5, currency: 'USD' })
    if (i < enroll) await graph.outcome({ transactionId: `enrolled-${n}`, subject: `lead:${n}`, at: at + 5 * HOUR, stage: 'enrolled', value: 200, currency: 'USD' })
  }
}
// One enrollment nobody's ad can claim.
await graph.observe({ subject: 'lead:walk-in', identifiers: ['email:walk-in'], at: Date.now() - 2 * 24 * HOUR })
await graph.outcome({ transactionId: 'enrolled-walk-in', subject: 'lead:walk-in', at: Date.now() - 2 * 24 * HOUR, stage: 'enrolled', value: 200, currency: 'USD' })

// The example site (examples/site.ts) can report to this server too.
const handler = createHandler(graph, {
  token: 'service-demo',
  reviewToken: 'demo',
  origins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  events: ['brochure', 'phone_click'],
  linkSecret: 'demo-link-secret-not-for-real-use',
  // The steps in order, with what each is worth. The Channels view lists them this way.
  stages: { phone_click: {}, brochure: { value: 2, currency: 'USD' }, inquiry: { value: 5, currency: 'USD' }, call: { value: 10, currency: 'USD' }, signup: { value: 25, currency: 'USD' }, enrolled: { value: 200, currency: 'USD' } },
  calls: { numbers: { '+15551230001': { source: 'google', campaignId: '20222' } } },
})
const port = Number(process.env.PORT ?? 8788)
createServer(handler).listen(port, 'localhost', () => console.log(`reviewer screen: http://localhost:${port}/review  (reviewer token: demo; press Channels for the report)`))
