/**
 * Serves the reviewer screen over made-up data, to try it.
 *   npm run review
 * Then open the printed address and enter the reviewer token `demo`.
 */
import { createServer } from 'node:http'
import { createGraph, createHours, createMemoryStore, createOps, createOutbox, dialed, hashPhone, recordCall, recordCallResult, recordNotLead, recordReturn, recordText } from '../src/index.ts'
import { createHandler } from '../src/server.ts'

// What is recorded below is written down at the time it happened, so the months of first record are real ones.
let writing: number | undefined
const store = createMemoryStore()
const graph = createGraph(store, undefined, { now: () => writing ?? Date.now() })
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
for (let i = 0; i < 4; i++) await graph.transfer({ id: `gold-${i}`, from: 'account:ana-alt', to: 'account:ana', amount: 250_000, at: start + (50 + i) * HOUR, asset: 'gold' })
await graph.transfer({ id: 'trade-1', from: 'account:ana', to: 'account:gus', amount: 1_200, at: start + 60 * HOUR, asset: 'gold' })
// A ring: ana pays ana-shop, who pays ben, who pays ana back.
await graph.transfer({ id: 'trade-2', from: 'account:ana', to: 'account:ana-shop', amount: 90_000, at: start + 70 * HOUR, asset: 'gold' })
await graph.transfer({ id: 'trade-3', from: 'account:ana-shop', to: 'account:ben', amount: 85_000, at: start + 71 * HOUR, asset: 'gold' })
await graph.transfer({ id: 'trade-4', from: 'account:ben', to: 'account:ana', amount: 80_000, at: start + 72 * HOUR, asset: 'gold' })
// A reseller's accounts: many in one hand, a few who only look close, and two a reviewer has kept apart.
await graph.observe([
  login('account:max', ['device:m-laptop', 'email:max', 'payment:m-card', 'canvas:m-phone'], 10),
  login('account:max-2', ['device:m-laptop', 'payment:m-card'], 12),
  login('account:max-store', ['device:m-laptop', 'email:max'], 14),
  login('account:deals4u', ['payment:m-card', 'phone:m-burner'], 30),
  login('account:quickflip', ['phone:m-burner', 'device:m-tablet'], 44),
  login('account:flipper77', ['device:m-tablet'], 52),
  login('visitor:m-914', ['device:m-laptop'], 9),
  login('lead:m-signup', ['email:max'], 11),
  ...['rosa', 'tomas', 'wen'].map((name, i) => login(`account:${name}`, ['canvas:m-phone', `email:${name}`], 60 + i)),
  login('account:wen-work', ['email:wen', 'hardware:hw-wen'], 70),
  login('account:rosa-2', ['email:rosa'], 72),
  login('account:lena', ['device:m-laptop', 'email:lena'], 80),
  login('account:lena-shop', ['email:lena'], 84),
  login('account:rosa', ['address:elm-12'], 90),
  login('account:max', ['address:elm-12'], 91),
  login('account:omar', ['address:elm-12'], 92),
])
for (const other of ['account:lena', 'account:rosa-2']) await graph.separate('account:max', other, true, { by: 'dana', reason: other === 'account:lena' ? 'bought the laptop from max' : 'checked by phone, two people' })
await graph.separate('account:cy', 'account:dee', true, { by: 'dana', reason: 'siblings, one family computer' })

// Two systems that disagree about one pair, and a list of pairs kept apart by a case system.
for (let turn = 0; turn < 2; turn++) {
  await graph.separateAll([{ a: 'account:fay', b: 'account:gus', reason: 'sides of one matter' }, ...(turn ? [] : [{ a: 'account:eve', b: 'account:hal' }])], { by: 'system:cases', reason: 'intake check' })
  await graph.joinAll([{ a: 'account:fay', b: 'account:gus' }], { by: 'system:crm', reason: 'records merged' })
}

// What ana answered about advertising, over time.
await graph.consent('account:ana', { adUserData: true, adPersonalization: true }, { at: start, source: 'banner' })
await graph.consent('account:ana', { adUserData: true, adPersonalization: false }, { at: start + 200 * HOUR, source: 'preferences page' })
await graph.consent('account:ana', { adUserData: false, adPersonalization: false }, { at: start + 400 * HOUR, source: 'browser signal' })

// Marketing: three campaigns with a daily cost, the visitors each brought, and what those visitors went on to do.
const day = (ago: number) => new Date(Date.now() - ago * 24 * HOUR).toISOString().slice(0, 10)
const campaigns = [
  { source: 'google', campaignId: '20111', campaign: 'Search: garden tools', daily: 62.4, visitors: 9, enroll: 3 },
  { source: 'google', campaignId: '20222', campaign: 'Search: brand', daily: 11.75, visitors: 5, enroll: 3 },
  { source: 'meta', campaignId: '90333', campaign: 'Retarget visitors', daily: 28, visitors: 6, enroll: 1 },
]
let lead = 0
for (const { visitors, enroll, daily, ...campaign } of campaigns) {
  // The retargeting campaign's costs stopped arriving after ten days, and the brand campaign's skip a few.
  for (let ago = 29; ago >= 0; ago--) if (!(campaign.source === 'meta' && ago < 20) && !(campaign.campaignId === '20222' && ago % 5 === 1)) await graph.spend({ ...campaign, day: day(ago), amount: daily, currency: 'USD', clicks: Math.round(daily / 2.6), impressions: Math.round(daily * 21), conversions: Math.round(daily / (campaign.source === 'meta' ? 140 : 240) * 100) / 10, ...(campaign.source !== 'meta' && { conversionValue: Math.round(daily * 2.4) }) })
  for (let i = 0; i < visitors; i++) {
    const n = ++lead
    const at = Date.now() - (13 - (n % 13)) * 24 * HOUR
    await graph.observe({ subject: `visitor:v${n}`, identifiers: [`device:v${n}`], at, event: 'visit' })
    await graph.touch({ subject: `visitor:v${n}`, at, campaignId: campaign.campaignId, ...(campaign.source === 'google' ? { gclid: `click-${n}` } : { fbclid: `click-${n}` }), custom: { office: n % 3 ? 'north' : 'river', ...(n % 4 && { lang: n % 2 ? 'en' : 'es' }) } })
    await graph.observe({ subject: `lead:${n}`, identifiers: [`device:v${n}`], at: at + HOUR, event: 'inquiry' })
    await graph.outcome({ transactionId: `inquiry-${n}`, subject: `lead:${n}`, at: at + HOUR, stage: 'inquiry', value: 5, currency: 'USD' })
    if (i < enroll) await graph.outcome({ transactionId: `enrolled-${n}`, subject: `lead:${n}`, at: at + 5 * HOUR, stage: 'enrolled', value: 200, currency: 'USD', tags: { office_served: n % 2 ? 'river' : 'online' } })
  }
}
// Earlier customers, some of whom took weeks and some of whom came back: people beside outcomes, and time beside both.
for (let n = 0; n < 30; n++) {
  const at = Date.now() - (40 + n) * 24 * HOUR
  await graph.observe([{ subject: `visitor:e${n}`, identifiers: [`device:e${n}`], at, event: 'visit' }, { subject: `lead:e${n}`, identifiers: [`device:e${n}`], at, event: 'inquiry' }])
  await graph.touch({ subject: `visitor:e${n}`, at, gclid: `early-${n}`, campaignId: '20111' })
  const enrolled = at + (2 + ((n * 7) % 38)) * 24 * HOUR
  writing = enrolled
  if (enrolled < Date.now()) await graph.outcome({ transactionId: `enrolled-e${n}`, subject: `lead:e${n}`, at: enrolled, stage: 'enrolled', value: 200, currency: 'USD', tags: { office_served: n % 3 ? 'north' : 'river' } })
  if (n % 4 === 0) await graph.outcome({ transactionId: `renewed-e${n}`, subject: `lead:e${n}`, at: Date.now() - n * 12 * HOUR, stage: 'enrolled', value: 100, currency: 'USD' })
}
writing = undefined
// What was collected came in later: more from some, less from others, nothing from a few.
for (let n = 0; n < 30; n += 2) await graph.restate(`enrolled-e${n}`, n % 10 === 0 ? 0 : 120 + ((n * 37) % 260))
// One enrollment nobody's ad can claim.
await graph.observe({ subject: 'lead:walk-in', identifiers: ['email:walk-in'], at: Date.now() - 2 * 24 * HOUR })
await graph.outcome({ transactionId: 'enrolled-walk-in', subject: 'lead:walk-in', at: Date.now() - 2 * 24 * HOUR, stage: 'enrolled', value: 200, currency: 'USD' })

// Two weeks of calls, from a seeded generator so they are the same each time: most answered, some missed, some returned.
let seed = 11
const chance = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff
const numbers = { '+15550100001': { source: 'google', campaignId: '20222' }, '+15550100002': { source: 'mailer', campaign: 'postcard' } }
/** Who was spoken to, and when each number last rang: texts come from some of them. */
const spoken = new Set<string>()
const rang = new Map<string, number>()
for (let i = 0; i < 120; i++) {
  const from = `+1555010${String(100 + Math.floor(chance() * 60)).padStart(4, '0')}`
  const at = Math.floor((Date.now() - 14 * 24 * HOUR + Math.floor(chance() * 14) * 24 * HOUR) / (24 * HOUR)) * 24 * HOUR + Math.floor((8 + chance() * 13) * HOUR) + 6 * HOUR
  if (at > Date.now()) continue
  const roll = chance()
  const to = chance() < 0.7 ? '+15550100001' : chance() < 0.7 ? '+15550100002' : '+15550100003'
  await recordCall(graph, { id: `call-${i}`, from: chance() < 0.04 ? '' : from, to, at, duration: 20 + Math.floor(chance() * 300), ...(chance() < 0.7 && { tags: { language: chance() < 0.3 ? 'es' : 'en' } }) }, { numbers, results: 'expected' })
  if (roll < 0.93) await recordCallResult(graph, { id: `call-${i}`, answered: roll < 0.68, waited: Math.floor(chance() * 90), ...(roll > 0.85 && { voicemail: true }) }, { results: 'expected' })
  if (roll > 0.68 && chance() < 0.4) await recordCall(graph, { id: `back-${i}`, direction: 'outbound', from: to, to: from, at: at + Math.floor(chance() * 20 * HOUR), duration: 60, answered: chance() < 0.6 })
  rang.set(from, Math.max(at, rang.get(from) ?? 0))
  if (roll < 0.68) spoken.add(from)
}
// Texts: one answered by a text, one whose sender asked for no more, and three that wait.
const text = (id: string, from: string, hours: number, rest: object = {}) => recordText(graph, { id, from, to: '+15550100001', at: Date.now() - hours * HOUR, ...rest }, { numbers: { '+15550100001': { source: 'google', campaignId: '20222' } } })
const quiet = [...spoken].filter((from) => from && rang.get(from)! < Date.now() - 64 * HOUR)
const senders = [0, 1, 2, 3, 4].map((n) => quiet[n]!)
await text('t1', senders[0]!, 30, { tags: { language: 'es' } })
await text('t2', senders[0]!, 29)
await text('t3', senders[1]!, 20)
await text('t4', senders[2]!, 4, { tags: { language: 'en' } })
await text('t5', senders[3]!, 50)
await recordText(graph, { id: 't6', direction: 'outbound', from: '+15550100001', to: senders[3]!, at: Date.now() - 49 * HOUR })
await text('t7', senders[4]!, 60, { text: 'STOP' })

// Two missed callers reached from another line, as the office's own system says, and two calls that were nobody's inquiry.
const unanswered: string[] = []
for (let i = 0; i < 120; i++) if ((await graph.keptCall(`call-${i}`))?.result?.answered === false) unanswered.push(`call-${i}`)
for (const id of unanswered.slice(0, 2)) await recordReturn(graph, { id, at: (await graph.keptCall(id))!.at + 3 * HOUR })
await recordNotLead(graph, { call: unanswered[4]!, kind: 'spam' })
await recordNotLead(graph, { call: unanswered[7]!, kind: 'other' })

// What some callers went on to do, for what followed a call. Those rung back or answered sign up a little more often, as made up here.
for (let i = 0; i < 110; i++) {
  const from = `+1555010${String(300 + i).padStart(4, '0')}`
  const at = Date.now() - (45 - (i % 12)) * 24 * HOUR
  const answered = chance() < 0.55
  await recordCall(graph, { id: `past-${i}`, from, to: '+15550100001', at, duration: 30 + Math.floor(chance() * 1100), answered, ...(chance() < 0.8 && { waited: Math.floor(chance() * 25) }), ...(chance() < 0.8 && { tags: { language: chance() < 0.4 ? 'es' : 'en' } }) }, { numbers, results: 'expected' })
  const back = !answered && chance() < 0.5
  if (back) await recordCall(graph, { id: `past-back-${i}`, direction: 'outbound', from: '+15550100001', to: from, at: at + 5 * HOUR, answered: true })
  if (chance() < (answered || back ? 0.3 : 0.15)) {
    await graph.observe({ subject: `lead:p${i}`, identifiers: [`phone:${hashPhone(from)}`], at: at + 48 * HOUR })
    await graph.outcome({ transactionId: `enrolled-p${i}`, subject: `lead:p${i}`, at: at + (30 + Math.floor(chance() * 300)) * HOUR, stage: 'enrolled', value: 200, currency: 'USD' })
  }
}

// One person's whole story, for the Journey view.
const told = Date.now() - 20 * 24 * HOUR
const ana = 'contact:story'
await graph.observe({ subject: 'visitor:story', identifiers: ['device:story', 'ip:192.0.2.44', 'place:US'], at: told, event: 'visit' })
await graph.touch({ subject: 'visitor:story', at: told, gclid: 'story-click', campaignId: '20222', campaign: 'Search: brand', term: 'garden help near me', landing: 'https://example.org/help', custom: { office: 'north', lang: 'es' } })
await graph.observe({ subject: 'visitor:story', identifiers: ['device:story', dialed('+15550100001', told + HOUR)], at: told + HOUR, event: 'phone_click' })
await recordCall(graph, { id: 'story-1', from: '+15550100900', to: '+15550100001', at: told + HOUR + 20_000, duration: 41, waited: 41, answered: false, tags: { language: 'es' } }, { numbers, results: 'expected' })
await recordCall(graph, { id: 'story-2', direction: 'outbound', from: '+15550100001', to: '+15550100900', at: told + 5 * HOUR, duration: 30, answered: false })
await recordCall(graph, { id: 'story-3', direction: 'outbound', from: '+15550100001', to: '+15550100900', at: told + 26 * HOUR, duration: 400, answered: true })
await graph.observe({ subject: ana, identifiers: ['device:story', `phone:${hashPhone('+15550100900')}`], at: told + 30 * HOUR, event: 'signup' })
await graph.consent(ana, { adUserData: true, adPersonalization: false }, { at: told + 30 * HOUR, source: 'sign-up form' })
for (const [hours, value] of [[48, 200], [240, 350], [400, 420.5]] as const) {
  writing = told + hours * HOUR
  if (hours === 48) await graph.outcome({ transactionId: 'story-client', subject: ana, at: writing, stage: 'enrolled', value, currency: 'USD', tags: { office_served: 'river', language: 'es' } })
  else await graph.restate('story-client', value)
}
writing = told + 420 * HOUR
await graph.restate('story-client', 320.5, 'USD', 'refund')
await graph.separate(ana, 'contact:former-spouse', true, { by: 'dana', reason: 'sides of one matter' })
writing = undefined

// An ad platform that takes some conversions and refuses the rest, to have something to send again.
const ready = new Set<string>()
const outbox = createOutbox(graph, store.outbox, {
  targets: [{
    name: 'made_up_ads', restates: false, batch: 1, retryable: () => false, keys: () => ({ email: 'hashed' }), click: () => undefined,
    deliver: async (_action, [item]) => {
      const { transactionId } = item!.job
      if (Number(transactionId.slice(5)) % 3 === 0 && !ready.has(transactionId)) {
        // The second time it is taken.
        ready.add(transactionId)
        throw new Error('This conversion action is not set up in the ad account')
      }
      return {}
    },
  }],
})
for (let n = 1; n <= 9; n++) {
  await graph.consent(`lead:${n}`, { adUserData: true, adPersonalization: true }, { at: Date.now() - 12 * 24 * HOUR })
  await outbox.record({ transactionId: `sent-${n}`, subject: `lead:${n}`, at: Date.now() - n * 24 * HOUR, stage: 'intake', action: { made_up_ads: 'intake' }, value: 150, currency: 'USD', email: `lead${n}@example.com` })
}
await outbox.run()
outbox.start(2_000)

// The example site (examples/site.ts) can report to this server too.
const handler = createHandler(graph, {
  token: 'service-demo',
  outbox,
  ops: createOps(graph, store.ops),
  reviewers: { dana: 'demo' },
  origins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  events: ['brochure', 'phone_click'],
  linkSecret: 'demo-link-secret-not-for-real-use',
  // The steps in order, with what each is worth. The Channels view lists them this way.
  returnHours: 24,
  hours: createHours({ mon: ['08:00-18:00'], tue: ['08:00-18:00'], wed: ['08:00-18:00'], thu: ['08:00-18:00'], fri: ['08:00-17:00'], sat: ['09:00-13:00'] }),
  stages: { phone_click: {}, brochure: { value: 2, currency: 'USD' }, inquiry: { value: 5, currency: 'USD', wait: 72 }, call: { value: 10, currency: 'USD' }, signup: { value: 25, currency: 'USD' }, enrolled: { value: 200, currency: 'USD' } },
  calls: { numbers: { ...numbers, '+15551230001': { source: 'google', campaignId: '20222' } }, results: 'expected' },
})
const port = Number(process.env.PORT ?? 8788)
createServer(handler).listen(port, 'localhost', () => console.log(`reviewer screen: http://localhost:${port}/review  (reviewer dana, token: demo; press Channels for the report)`))
