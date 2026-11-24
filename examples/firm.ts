/**
 * A made-up law firm with three offices and two languages, to show the whole
 * thing running. Nobody in it is real: the names, numbers and amounts come
 * from a seeded generator, and nothing leaves this machine.
 *
 *   npm run firm
 *
 * It starts a throwaway PostgreSQL in Docker (or keeps everything in memory
 * where there is no Docker, or with MEMORY=1), the graph server with its reviewer screen, the
 * firm's site and a stage to present it on, and fills them. docs/demo.md has the
 * script. Ctrl-C stops and deletes all of it.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGraph, createMemoryStore, createOps, createOutbox, googleAds, hashPhone, nameKeys, policyFrom, recordCall } from '../src/index.ts'
import type { Store } from '../src/index.ts'
import { reviewPage } from '../src/review.ts'
import { createHandler } from '../src/server.ts'
import { clockScript, landing } from './firm-page.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const SECRET = 'a-demo-secret-that-protects-nothing'

/** The firm's own numbers, each with where it is published. */
export const LINES = {
  '+15550100101': { source: 'google', campaignId: '30111', campaign: 'Search: North', tags: { office_advertised: 'north', language: 'en' } },
  '+15550100102': { source: 'google', campaignId: '30222', campaign: 'Search: River', tags: { office_advertised: 'river', language: 'en' } },
  '+15550100103': { source: 'google', campaignId: '30333', campaign: 'Busqueda: North', tags: { office_advertised: 'north', language: 'es' } },
  '+15550100104': { source: 'listing', medium: 'map', campaign: 'Map listing, River', tags: { office_advertised: 'river', language: 'es' } },
  '+15550100105': { source: 'meta', campaignId: '40444', campaign: 'Online consultations', tags: { office_advertised: 'online', language: 'en' } },
} as const
const CAMPAIGNS = [
  { source: 'google', campaignId: '30111', campaign: 'Search: North', office: 'north', lang: 'en', line: '+15550100101', daily: 84, share: 0.34, client: 0.16 },
  { source: 'google', campaignId: '30222', campaign: 'Search: River', office: 'river', lang: 'en', line: '+15550100102', daily: 61, share: 0.24, client: 0.11 },
  { source: 'google', campaignId: '30333', campaign: 'Busqueda: North', office: 'north', lang: 'es', line: '+15550100103', daily: 38, share: 0.24, client: 0.2 },
  { source: 'meta', campaignId: '40444', campaign: 'Online consultations', office: 'online', lang: 'en', line: '+15550100105', daily: 45, share: 0.18, client: 0.06 },
] as const
const STEPS = {
  call: { value: 5, currency: 'USD', action: { google: '222' } },
  inquiry: { value: 10, currency: 'USD', wait: 48, action: { google: '111' } },
  intake: { value: 20, currency: 'USD' },
  signed: { value: 40, currency: 'USD' },
  scheduled: { value: 60, currency: 'USD' },
  client: { value: 400, currency: 'USD', action: { google: '333' } },
}
const FIRST = ['Ana', 'Luis', 'Maria', 'Jorge', 'Elena', 'Pat', 'Sam', 'Robin', 'Lee', 'Dana', 'Alex', 'Noor']
const LAST = ['Rivera', 'Santos', 'Moreno', 'Hill', 'Stone', 'Brook', 'Vale', 'Cruz', 'Marsh', 'Field']

export interface Firm {
  /** The graph server with its reviewer screen and the stage, and the firm's site. */
  graph: string
  site: string
  close(): Promise<void>
}

/** Starts the firm over a store. With `quick`, it has a tenth of its history, for tests. `restart` is asked for from the stage, and starts over. */
export async function startFirm(store: Store, { ports = [0, 0], quick = false, say = () => {}, restart }: { ports?: [number, number]; quick?: boolean; say?: (line: string) => void; restart?: () => void } = {}): Promise<Firm> {
  // What is seeded is written down when it happened. The story takes a Monday to a Thursday that have passed, and each scene moves the clock on to when it happens.
  let writing: number | undefined
  const monday = new Date()
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 3) % 7 || 7) - 3)
  const when = (days: number, hour: number, minute: number) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + days, hour, minute).getTime()
  let ahead = when(0, 8, 50) - Date.now()
  const clock = () => writing ?? Date.now() + ahead
  const policy = policyFrom(JSON.parse(readFileSync(new URL('./household.json', import.meta.url), 'utf8')))
  const graph = createGraph(store, policy, { now: clock })
  const alerts: string[] = []
  const sent: { id: string; value: number | undefined }[] = []
  const wasSent = (id: string) => sent.some((each) => each.id === id)
  const site = createServer((request, response) => void answer(request, response))
  await once(site.listen(ports[1], '127.0.0.1'), 'listening')
  const siteAt = `http://localhost:${(site.address() as AddressInfo).port}`

  // An ad platform that takes everything and is not there.
  const outbox = createOutbox(graph, store.outbox, {
    now: clock,
    targets: [googleAds({ customerId: '000-000-0000', send: async (body) => (sent.push(...body.events.map((event: any) => ({ id: event.transactionId, value: event.conversionValue }))), { requestId: `made-up-${sent.length}` }) })],
  })
  const ops = createOps(graph, store.ops, { now: clock, url: `${siteAt}/hook`, quiet: { calls: 12 }, returnHours: 24, onError: () => {} })
  const calls = { numbers: LINES, results: 'expected' as const }
  const handler = createHandler(graph, {
    token: 'service-demo', reviewers: { dana: 'demo' }, origins: [siteAt], now: clock, outbox, ops, stages: STEPS, calls, returnHours: 24, limit: false,
    events: ['phone_click'], linkSecret: SECRET, identifierSecret: SECRET, pool: { numbers: ['+15550100111', '+15550100112'], minutes: 15, grace: 120 },
  })
  // The reviewer screen goes by the demo's clock: the page is served with it, and every answer carries it. The stage is the same page with the caller's phone and the scenes.
  const { html, headers } = reviewPage()
  const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
  const beside = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\r\n?/g, '\n')
  const stage = { style: beside('stage.css'), script: `const STAGE = ${JSON.stringify({ phone: `${siteAt}/es?phone=1` })}\n${beside('stage.js')}` }
  const server = createServer((request, response) => {
    response.setHeader('x-demo-ahead', ahead)
    const path = `${request.method} ${new URL(request.url ?? '/', 'http://localhost').pathname}`
    const json = (status: number, body: object) => void response.writeHead(status, { 'content-type': 'application/json', 'x-demo-ahead': ahead }).end(JSON.stringify(body))
    if (path === 'GET /stage/scenes') return json(200, { boot, ready, next, scenes: scenes.map(({ run, ...scene }) => scene) })
    // A page elsewhere cannot send the header, so only the stage moves the story on.
    if (path === 'POST /stage/run') return void (request.headers['x-stage'] ? runScene().then(([status, body]) => json(status, body)) : json(403, { error: 'Only the stage runs scenes' }))
    if (path === 'POST /stage/restart') {
      if (!request.headers['x-stage']) return json(403, { error: 'Only the stage starts over' })
      if (!restart || running || !ready) return json(409, { error: !restart ? 'This demo cannot start over by itself' : ready ? 'A scene is running' : 'The sample data is still loading' })
      json(202, {})
      return restart()
    }
    if (path !== 'GET /review' && path !== 'GET /stage') return handler(request, response)
    const staged = path === 'GET /stage'
    const first = `${clockScript(ahead)}${staged ? `\nsessionStorage.getItem('token') ?? sessionStorage.setItem('token', 'demo')` : ''}`
    let policy = headers['content-security-policy']!.replace('script-src ', () => `script-src ${hash(first)}${staged ? ` ${hash(stage.script)}` : ''} `)
    if (staged) policy = policy.replace('style-src ', () => `style-src ${hash(stage.style)} `) + `; frame-src ${siteAt}`
    let text = html.replace('<style>', () => `<script>${first}</script>\n<style>`)
    if (staged) text = text.replace('</head>', () => `<style>${stage.style}</style></head>`).replace('</body>', () => `<script>${stage.script}</script></body>`)
    response.writeHead(200, { ...headers, 'content-security-policy': policy }).end(text)
  })
  await once(server.listen(ports[0], '127.0.0.1'), 'listening').catch((error) => {
    site.close()
    throw error
  })
  const graphAt = `http://localhost:${(server.address() as AddressInfo).port}`
  const ask = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: 'Bearer service-demo' }): Promise<any> => {
    const response = await fetch(graphAt + path, { method, headers: { 'user-agent': 'Mozilla/5.0 (the demo)', ...headers }, ...(body !== undefined && { body: JSON.stringify(body) }) })
    const told = response.status === 204 ? undefined : await response.json()
    if (!response.ok) throw new Error(`${method} ${path}: ${(told as { error?: string })?.error}`)
    return told
  }
  const browser = (path: string, body: object) => ask('POST', path, body, { origin: siteAt })

  let seed = 20261124
  const chance = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff
  const pick = <T>(list: readonly T[]): T => list[Math.floor(chance() * list.length)]!
  const phoneOf = (n: number) => `+1555010${String(1000 + n).slice(-4)}`

  const spentOn = new Set<string>()
  /** What every campaign cost on a day. The one for online consultations has a week with no costs recorded. */
  async function spend(at: number, ago = 0) {
    const day = new Date(at).toISOString().slice(0, 10)
    if (spentOn.has(day)) return
    spentOn.add(day)
    await graph.spend(CAMPAIGNS.filter(({ campaignId }) => !(campaignId === '40444' && ago >= 10 && ago < 17)).map(({ source, campaignId, campaign, daily }) => {
      const amount = Math.round(daily * (0.8 + chance() * 0.4) * 100) / 100
      return { day, source, campaignId, campaign, amount, currency: 'USD', clicks: Math.round(amount / 4), impressions: Math.round(amount * 12) }
    }))
  }
  let others = 0
  /** Moves the clock on to a moment of the story. It never goes back. */
  async function at(days: number, hour: number, minute: number) {
    const now = clock()
    const then = Math.max(now + 1000, when(days, hour, minute))
    for (let day = now + DAY; day < then + DAY; day += DAY) await spend(Math.min(day, then))
    // The phones ring on in between, by day, and are answered.
    for (let rang = now + 2 * HOUR; rang < then; rang += 2 * HOUR) {
      if (new Date(rang).getHours() < 9 || new Date(rang).getHours() > 17) continue
      const { lang, line } = pick(CAMPAIGNS)
      writing = rang
      await recordCall(graph, { id: `day-${rang}`, from: phoneOf(2000 + ++others), to: line, at: rang, duration: 120 + Math.floor(chance() * 600), answered: true, tags: { language: lang } }, { ...calls, now: clock, convert: (outcome) => graph.outcome({ ...outcome, value: STEPS.call.value, currency: 'USD' }) })
    }
    writing = undefined
    ahead = then - Date.now()
  }
  const known = new Set<string>()
  /** A contact called after a made-up person, and a number where there are several. */
  const contactOf = (first: string, last: string) => {
    const name = `contact:${first}-${last}`.toLowerCase()
    let id = name
    for (let n = 2; known.has(id); n++) id = `${name}-${n}`
    known.add(id)
    return id
  }

  /** Two months of a firm's life. */
  async function fill() {
    const start = clock()
    for (let ago = 59; ago >= 0; ago--) await spend(start - ago * DAY, ago)
    const people = quick ? 40 : 320
    for (let n = 0; n < people; n++) {
      if (n % 80 === 79) say(`  ${n + 1} of ${people} people`)
      let roll = chance()
      const campaign = CAMPAIGNS.find(({ share }) => (roll -= share) < 0) ?? CAMPAIGNS[0]
      const { source, campaignId, office, lang, line } = campaign
      // Most come by day, on weekdays a little more.
      const at = Math.min(start - Math.floor((1 + chance() * 3) * HOUR), Math.floor((start - chance() * 58 * DAY) / DAY) * DAY + Math.floor((14 + chance() * 11) * HOUR))
      const visitor = `visitor:s${n}`
      const from = phoneOf(n)
      writing = at
      await graph.observe({ subject: visitor, identifiers: [`device:s${n}`, `ip:198.51.100.${n % 200}`], at, event: 'visit' })
      await graph.touch({ subject: visitor, at, source, medium: 'cpc', campaignId, campaign: campaign.campaign, [source === 'google' ? 'gclid' : 'fbclid']: `s${n}`, landing: 'https://firm.example.org/', custom: { office, ...(chance() < 0.85 && { lang }) } })
      const called = chance() < 0.62
      let reached = !called
      let met = at
      if (called) {
        const rang = at + Math.floor(1 + chance() * 40) * 60_000
        const roll = chance()
        const answered = roll < 0.74
        const call = { from, to: line, duration: answered ? 120 + Math.floor(chance() * 900) : 20 + Math.floor(chance() * 80), waited: Math.floor(chance() * 60), ...(chance() < 0.8 && { tags: { language: lang } }) }
        writing = rang
        await recordCall(graph, { id: `s${n}`, at: rang, answered, ...(roll > 0.9 && { voicemail: true }), ...call }, { ...calls, now: clock, convert: (outcome) => graph.outcome({ ...outcome, value: STEPS.call.value, currency: 'USD' }) })
        reached = answered
        met = rang + (call.duration + call.waited) * 1000
        // Staff call back the same day, and again on the next ones until somebody picks up.
        for (let tries = 0, back = rang; !reached && tries < 4; tries++) {
          back += Math.floor(1 + chance() * (tries === 0 ? 5 : 7)) * HOUR
          if (back >= start) break
          writing = back
          reached = tries === 2 || chance() < 0.75
          met = back + 300_000
          await recordCall(graph, { id: `b${n}-${tries}`, direction: 'outbound', from: line, to: from, at: back, duration: reached ? 300 : 25, answered: reached }, { ...calls, now: clock })
        }
      }
      if (!reached || chance() > 0.55) continue
      // They left their number, with staff or in a form, and staff opened a contact for them.
      const asked = met + Math.floor(chance() * 20) * HOUR
      if (asked > start) continue
      const name = [pick(FIRST), pick(LAST)] as const
      const contact = contactOf(...name)
      writing = asked
      await graph.observe({ subject: contact, identifiers: [...(called ? [] : [`device:s${n}`]), `phone:${hashPhone(from)}`, `email:made-up-${n}`, ...nameKeys(SECRET, ...name, { dob: `19${60 + (n % 40)}-0${1 + (n % 9)}-1${n % 9}` })], at: asked, event: 'inquiry' })
      if (called) await graph.joinAll([{ a: `caller:${hashPhone(from)}`, b: contact, reason: 'answered by staff' }], { by: 'system:desk' })
      if (called) await graph.observe({ subject: contact, identifiers: [`device:s${n}`], at: asked, event: 'inquiry' })
      const step = async (stage: keyof typeof STEPS, moment: number, value: number = STEPS[stage].value) => {
        const when = Math.floor(moment)
        if (when > start) return false
        writing = when
        // Some go to the office that is nearest, whatever the ad said.
        const office_served = chance() < 0.18 ? pick(['north', 'river', 'online']) : office
        await graph.outcome({ transactionId: `${stage}-${n}`, subject: contact, at: when, stage, value, currency: 'USD', tags: { office_served, ...(chance() < 0.8 && { language: lang }) } })
        return true
      }
      if (!(await step('inquiry', asked)) || (chance() > 0.6 && start - asked < 30 * HOUR)) continue
      // They fill in the form, sign, and are scheduled with a director, some not as far.
      let moment = asked
      let reachedAll = true
      for (const [stage, least, most, share] of [['intake', 0.02, 0.5, 1], ['signed', 0.02, 0.4, 0.92], ['scheduled', 0.05, 0.6, 0.95]] as const) {
        moment += (least + chance() * (most - least)) * DAY
        if (chance() > share || !(await step(stage, moment))) {
          reachedAll = false
          break
        }
      }
      if (!reachedAll || chance() > campaign.client * 2.2) continue
      const signed = Math.floor(moment + (2 + chance() * 24) * DAY)
      if (!(await step('client', signed))) continue
      // What was collected came later: less from some, more from others, nothing from a few.
      const settled = signed + (4 + chance() * 12) * DAY
      if (settled < start) {
        writing = Math.floor(settled)
        await graph.restate(`client-${n}`, chance() < 0.15 ? 0 : Math.round(250 + chance() * 1400))
      }
    }
    writing = undefined
    // Households: a phone on two contacts of two names, which the preset only relates.
    for (let n = 0; n < (quick ? 3 : 9); n++) {
      const phone = `phone:${hashPhone(phoneOf(900 + n))}`
      const [one, other] = [0, 1].map((side) => ({ subject: contactOf(FIRST[(n + side * 5) % FIRST.length]!, LAST[n % LAST.length]!), identifiers: [phone, `email:home-${n}-${side}`, ...nameKeys(SECRET, FIRST[(n + side * 5) % FIRST.length]!, LAST[n % LAST.length]!, { dob: `19${70 + n}-03-1${side}` })], at: start - (n + 2) * HOUR, event: 'staff entry' }))
      await graph.observe([one!, other!])
    }
  }

  const demo = { phone: '+15550100042', contact: 'contact:ines-vega', other: 'contact:tomas-vega', line: '+15550100103' }
  const caller = `caller:${hashPhone(demo.phone)}`
  const review = (view: string) => `${graphAt}/review#/${view}`
  /** The scenes, in order. Each does over HTTP what the site, the phone system or the office would, and says what came of it. */
  /** What a scene says came of it, and for some: how sure the credit of the contact's ad is, and what the firm's own screens and the phone show. */
  interface Told { lines: string[]; credit?: { share: number; campaign: string | null }; link?: string }
  /** The phone and the firm's own screen once a scene has run. */
  interface Shown { phone?: string; caption?: string; seconds?: number; desk?: { name: string; fields: [string, string][]; done: string } }
  const person = (view: string) => `#/${view}/${encodeURIComponent(demo.contact)}`
  const visitor = `#/accounts/${encodeURIComponent('visitor:v-4821')}`
  /** The best credit of the contact's ad: how sure, and whose it is once it is sure enough. */
  async function credit() {
    const { credited, touches } = await ask('GET', `/attribute?subject=${demo.contact}&at=${clock()}`)
    return { share: Math.max(0, ...touches.map((touch: { confidence: number }) => touch.confidence)), campaign: (credited?.campaign ?? null) as string | null }
  }
  /** A signed link for the contact, as staff would text it. */
  const linkTo = async (page: string): Promise<string> => (await ask('POST', '/link', { url: `${siteAt}/es/${page}`, subject: demo.contact })).url
  /** The contact opens the link in the browser they came with. The script tag reads the token and takes it out of the address. */
  const opens = (url: string) => browser('/collect', { device: 'v-4821', url: url.split('?')[0], known: new URL(url).searchParams.get('ag') })
  const steps = (stage: keyof typeof STEPS, tags: object = {}) => ask('POST', '/convert', { transactionId: `demo-${stage}`, subject: demo.contact, at: clock(), stage, tags: { language: 'es', ...tags } })
  const links: Record<string, string> = {}

  /** The scenes, in order. Each does over HTTP what the site, the phone system or the office would, and says what came of it. */
  const scenes: { title: string; text: string; see: [string, string]; stage?: string; spot?: string[]; shown?: Shown; run(): Promise<Told> }[] = [
    {
      title: 'Ad visit', text: 'They search, tap the Spanish ad for the North office, and land on the site.', see: ['Channels', review('channels')], stage: `#/journey/${encodeURIComponent('visitor:v-4821')}`, spot: ['Busqueda: North'], shown: { phone: 'site' },
      async run() {
        await at(0, 9, 2)
        await browser('/collect', { device: 'v-4821', url: `${siteAt}/es`, touch: { gclid: 'demo-click', source: 'google', medium: 'cpc', campaignId: '30333', campaign: 'Busqueda: North', landing: `${siteAt}/es`, custom: { office: 'north', lang: 'es' } } })
        const { touches } = await ask('GET', `/attribute?subject=visitor:v-4821&at=${clock()}`)
        return { lines: [`Visit recorded: ${touches[0].campaign}, office ${touches[0].custom.office}, language ${touches[0].custom.lang}.`] }
      },
    },
    {
      title: 'Tap to call', text: 'They tap the phone number. The phone system reports a connected call and holds it for a result.', see: ['Calls', review('calls')], stage: visitor, shown: { phone: 'calling', seconds: 22 },
      async run() {
        await at(0, 9, 4)
        await browser('/event', { device: 'v-4821', event: 'phone_click', number: demo.line })
        const call = await ask('POST', '/call', { id: 'demo-1', from: demo.phone, to: demo.line, at: clock(), duration: 95, tags: { language: 'es' } })
        return { lines: [`Linked to ${call.visitor} by the tap. State: ${call.state}. Counted: ${call.counted ? 'yes' : 'no'}.`] }
      },
    },
    {
      title: 'Missed call', text: 'The result reports no answer. The call is excluded from outcomes and conversions.', see: ['Board', review('board/90')], spot: [caller.slice(0, 16)], shown: { phone: 'missed', seconds: 95 },
      async run() {
        await at(0, 9, 6)
        const { state, counted } = await ask('POST', '/call/result', { id: 'demo-1', answered: false, waited: 95 })
        await outbox.run()
        return { lines: [`State: ${state}. Counted: ${counted ? 'yes' : 'no'}. Sent to the ad platform: ${wasSent('call:demo-1') ? 'yes' : 'no'}.`, 'The caller is on the Board under Missed calls.'] }
      },
    },
    {
      title: 'Callback', text: 'Staff call back, and are answered.', see: ['Calls', review(`journey/${encodeURIComponent(caller)}`)], stage: `#/journey/${encodeURIComponent(caller)}`, spot: ['Outbound'], shown: { phone: 'talking', seconds: 410 },
      async run() {
        await at(0, 14, 0)
        await ask('POST', '/call', { id: 'demo-2', direction: 'outbound', from: demo.line, to: demo.phone, at: clock(), duration: 410, answered: true })
        const { followUp } = await ask('GET', '/call?id=demo-1')
        return { lines: [`Missed call: ${followUp.state}.`] }
      },
    },
    {
      title: 'Details entered', text: 'On the call, staff enter the name, phone and date of birth.', see: ['Accounts', review(`accounts/${encodeURIComponent(demo.contact)}`)], stage: person('accounts'), shown: { phone: 'talking', caption: 'Staff take the details', desk: { name: 'New contact', fields: [['Name', 'Inés Vega'], ['Phone', '(555) 010-0042'], ['Date of birth', 'May 6, 1984'], ['Matter', 'Divorce, with children']], done: 'Contact saved' } },
      async run() {
        await at(0, 14, 6)
        await ask('POST', '/identify', { subject: demo.contact, phone: demo.phone, name: { first: 'Inés', last: 'Vega' }, dob: '1984-05-06', event: 'inquiry' })
        await steps('inquiry')
        const sure = await credit()
        return { lines: [`The call and the visit are now tied to a name. Ad credit: ${Math.round(sure.share * 100)}%, below the 90% it takes.`], credit: sure }
      },
    },
    {
      title: 'Form texted', text: 'Staff text a signed link to the intake form.', see: ['Accounts', review(`accounts/${encodeURIComponent(demo.contact)}`)], stage: person('accounts'), shown: { phone: 'text-form' },
      async run() {
        await at(0, 14, 8)
        links.form = await linkTo('datos')
        return { lines: ['Signed link made for the contact. Not opened yet.'], credit: await credit(), link: links.form }
      },
    },
    {
      title: 'Form opened', text: 'They open the link in the browser they came with, which is now known to be theirs.', see: ['Accounts', review(`accounts/${encodeURIComponent(demo.contact)}`)], stage: person('accounts'), shown: { phone: 'form' },
      async run() {
        await at(0, 14, 12)
        await opens(links.form!)
        // The inquiry waited for an ad to be credited, and is sent now.
        await outbox.run()
        const sure = await credit()
        return { lines: [`We now know whose phone this is. Ad credit: ${Math.round(sure.share * 100)}%, to ${sure.campaign}.`], credit: sure }
      },
    },
    {
      title: 'Form sent', text: 'They fill in the form and send it.', see: ['Board', review('board/7')], spot: ['contact:ines-vega'], shown: { phone: 'form-sent' },
      async run() {
        await at(0, 14, 17)
        await steps('intake')
        return { lines: ['Step recorded: intake. On the same person, with no second contact.'] }
      },
    },
    {
      title: 'Documents signed', text: 'Staff text a link to the documents. They open it and sign.', see: ['Board', review('board/7')], spot: ['contact:ines-vega'], shown: { phone: 'signed' },
      async run() {
        await at(0, 14, 31)
        await opens(await linkTo('firmar'))
        await steps('signed')
        return { lines: ['Step recorded: signed.'] }
      },
    },
    {
      title: 'Director scheduled', text: 'Staff schedule a call with a director.', see: ['Board', review('board/7')], spot: ['contact:ines-vega'], shown: { phone: 'text-time', caption: 'Staff schedule the director', desk: { name: 'Schedule', fields: [['With', 'M. Ortega, director'], ['When', 'Wednesday, 11:00 AM'], ['How', 'By phone, in Spanish']], done: 'Call scheduled' } },
      async run() {
        await at(0, 14, 36)
        await steps('scheduled', { director: 'ortega' })
        return { lines: ['Step recorded: scheduled, director ortega.'] }
      },
    },
    {
      title: 'Director calls', text: 'On Wednesday the director calls, and is answered.', see: ['Journey', review(`journey/${encodeURIComponent(demo.contact)}`)], stage: person('journey'), spot: ['scheduled', 'Outbound'], shown: { phone: 'director', seconds: 1290 },
      async run() {
        await at(2, 11, 0)
        await ask('POST', '/call', { id: 'demo-4', direction: 'outbound', from: demo.line, to: demo.phone, at: clock(), duration: 1290, answered: true, tags: { language: 'es' } })
        return { lines: ['Outbound call answered, on the same timeline.'] }
      },
    },
    {
      title: 'Enrollment texted', text: 'Staff text a signed link to enroll and pay.', see: ['Journey', review(`journey/${encodeURIComponent(demo.contact)}`)], stage: person('journey'), spot: ['scheduled', 'Outbound'], shown: { phone: 'text-pay' },
      async run() {
        await at(2, 11, 24)
        links.pay = await linkTo('inscripcion')
        return { lines: ['Signed link made for the contact. Not opened yet.'], link: links.pay }
      },
    },
    {
      title: 'Paid', text: 'They open the link and pay. The payment page is the firm’s, and reports the payment.', see: ['Journey', review(`journey/${encodeURIComponent(demo.contact)}`)], stage: person('journey'), spot: ['client'], shown: { phone: 'paid' },
      async run() {
        await at(2, 11, 29)
        await opens(links.pay!)
        await steps('client', { office_served: 'river', director: 'ortega' })
        const { credited } = await ask('GET', `/attribute?subject=${demo.contact}&at=${clock()}`)
        return { lines: [`Payment recorded: 400 USD. Advertised: ${credited.custom.office}. Served: river. Attributed to ${credited.campaign} at ${Math.round(credited.confidence * 100)}%.`] }
      },
    },
    {
      title: 'Conversion sent', text: 'The payment is sent to the ad platform as a conversion of the first ad click.', see: ['Journey', review(`journey/${encodeURIComponent(demo.contact)}`)], stage: person('journey'), spot: ['client'], shown: {},
      async run() {
        await at(2, 11, 40)
        await outbox.run()
        return { lines: [`Sent to the sample ad platform: ${wasSent('demo-client') ? `${sent.findLast((each) => each.id === 'demo-client')!.value} USD, for the first ad click` : 'no'}.`] }
      },
    },
    {
      title: 'Value change', text: 'The client value is updated from the initial 400 USD and restated at the ad platform.', see: ['Journey', review(`journey/${encodeURIComponent(demo.contact)}`)], stage: person('journey'), spot: ['from 400 USD to 1,250 USD'],
      async run() {
        await at(3, 16, 0)
        await ask('POST', '/restate', { transactionId: 'demo-client', value: 1250 })
        await outbox.run()
        const { values } = await ask('GET', '/outcome?id=demo-client')
        return { lines: [`Initial value ${values[0].value} USD, current value ${values.at(-1).value} USD.`, `Sent to the ad platform: ${sent.filter((each) => each.id === 'demo-client').at(-1)?.value} USD.`] }
      },
    },
    {
      title: 'Separation', text: 'An opposing party shares the family phone and email. The case system separates the two contacts.', see: ['Accounts', review(`accounts/${encodeURIComponent(demo.contact)}`)], stage: person('accounts'),
      async run() {
        await at(3, 16, 30)
        for (const subject of [demo.contact, demo.other]) await ask('POST', '/identify', { subject, phone: demo.phone, email: 'family@example.org', event: 'staff entry' })
        const { joined } = await ask('GET', `/between?a=${demo.contact}&b=${demo.other}`)
        await ask('POST', '/separate', { source: 'matters', pairs: [{ a: demo.contact, b: demo.other, reason: 'sides of one matter' }] })
        const after = await ask('GET', `/between?a=${demo.contact}&b=${demo.other}`)
        return { lines: [`Before: ${joined ? 'joined by a shared phone and email' : 'related'}. After: separated.`, `Same cluster: ${after.joined ? 'yes' : 'no'}.`] }
      },
    },
    {
      title: 'Listing call', text: 'A call to a number published on a map listing is attributed to that listing.', see: ['Channels', review('channels')], spot: ['Map listing, River'],
      async run() {
        await at(3, 16, 40)
        const call = await ask('POST', '/call', { id: 'demo-3', from: '+15550100043', to: '+15550100104', at: clock(), duration: 260, answered: true })
        const { touches } = await ask('GET', `/attribute?subject=${call.subject}&at=${clock()}`)
        return { lines: [`Attributed to ${touches[0].campaign}, advertised office ${touches[0].custom.office_advertised}. Counted: ${call.counted ? 'yes' : 'no'}.`] }
      },
    },
    {
      title: 'Shared phone', text: 'A parent and a child share a phone. The link is below the join threshold and waits for review.', see: ['Matches', review('decide')], spot: ['marta-lago'],
      async run() {
        await at(3, 16, 45)
        await ask('POST', '/identify', { subject: 'contact:marta-lago', phone: '+15550100044', name: { first: 'Marta', last: 'Lago' }, dob: '1970-02-03', event: 'staff entry' })
        await ask('POST', '/identify', { subject: 'contact:teo-lago', phone: '+15550100044', name: { first: 'Teo', last: 'Lago' }, dob: '2001-07-08', event: 'staff entry' })
        const { joined, score } = await ask('GET', '/between?a=contact:marta-lago&b=contact:teo-lago')
        return { lines: [`Linked at ${Math.round(score * 100)}% by phone: ${joined ? 'joined' : 'related'}.`] }
      },
    },
    {
      title: 'Stale feed', text: 'The clock advances 14 hours without a call, and an alert is sent.', see: ['Health', review('health')], spot: ['Calls feed is stale'],
      async run() {
        ahead += 14 * HOUR
        await ops.check()
        const told = alerts.findLast((text) => text.includes('no calls for'))
        return { lines: [told ? `Alert: "${told}"` : 'No alert was sent.'] }
      },
    },
  ]

  /** Which start this is, so the stage sees when another has begun. */
  const boot = randomUUID()
  /** Nothing is run until the sample data is in. */
  let ready = false
  let next = 0
  let running = false
  /** Runs the next scene: what to answer with. */
  async function runScene(): Promise<[number, object]> {
    const scene = scenes[next]
    if (!ready) return [409, { error: 'The sample data is still loading' }]
    if (!scene || running) return [409, { error: 'There is no next scene to run' }]
    running = true
    const began = performance.now()
    try {
      const told = await scene.run()
      next += 1
      return [200, { ...told, ms: Math.round(performance.now() - began) }]
    } catch (error) {
      return [500, { error: String((error as Error).message) }]
    } finally {
      running = false
    }
  }
  async function answer(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) {
    const url = new URL(request.url ?? '/', siteAt)
    const html = (text: string) => void response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(text)
    try {
      const phone = url.searchParams.has('phone')
      if (url.pathname === '/') return html(landing('en', graphAt, phone))
      if (url.pathname === '/es') return html(landing('es', graphAt, phone))
      if (url.pathname === '/present') return void response.writeHead(302, { location: `${graphAt}/stage` }).end()
      if (url.pathname === '/hook' && request.method === 'POST') {
        alerts.push(JSON.parse(await new Response(request as unknown as ReadableStream).text()).text)
        return void response.writeHead(204).end()
      }
      response.writeHead(404).end('Not found')
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String((error as Error).message) }))
    }
  }

  await fill()
  // Whoever has waited since before the show is told of now, so that what is told during it is about it.
  await ops.check()
  ready = true
  return {
    graph: graphAt,
    site: siteAt,
    async close() {
      for (const each of [server, site]) {
        each.closeAllConnections()
        await new Promise((resolve) => each.close(resolve))
      }
    },
  }
}

/** A throwaway PostgreSQL in Docker, or undefined where there is none. */
function throwaway(): { address: string; stop(): void } | undefined {
  // Named before it is asked for, so it can be removed however far that got.
  const name = `account-graph-firm-${randomUUID()}`
  const stop = () => {
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
    } catch {}
  }
  try {
    execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=demo', '-p', '127.0.0.1::5432', 'postgres:16'], { stdio: 'ignore' })
    const port = execFileSync('docker', ['port', name, '5432'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0]!.split(':').at(-1)
    return { address: `postgres://postgres:demo@127.0.0.1:${port}/postgres`, stop }
  } catch {
    stop()
    return undefined
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let made: ReturnType<typeof throwaway>
  let firm: Firm | undefined
  let end: (() => Promise<void>) | undefined
  let stopping = false
  // In place before anything else is started, so stopping half way leaves nothing behind either.
  const stop = async (code: number) => {
    if (stopping) return
    stopping = true
    await firm?.close().catch(() => {})
    await end?.().catch(() => {})
    made?.stop()
    process.exit(code)
  }
  process.once('SIGINT', () => void stop(0))
  process.once('SIGTERM', () => void stop(0))
  try {
    made = process.env.MEMORY ? undefined : throwaway()
    let fresh = async (): Promise<Store> => createMemoryStore()
    if (made) {
      const { default: pg } = await import('pg')
      const { createPostgresStore } = await import('../src/postgres.ts')
      const pool = new pg.Pool({ connectionString: made.address })
      pool.on('error', () => {})
      end = () => pool.end()
      for (let tries = 0; ; tries++) {
        try {
          await pool.query('select 1')
          break
        } catch (error) {
          if (tries > 100) throw error
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
      // The database was made for this demo alone, so starting over empties it.
      fresh = async () => {
        await pool.query('drop schema if exists account_graph cascade')
        const postgres = createPostgresStore(pool)
        await postgres.migrate()
        return postgres
      }
    }
    console.log(made ? 'Loading sample data into PostgreSQL. This takes about a minute.' : 'Loading sample data into memory.')
    const ports: [number, number] = [Number(process.env.PORT ?? 8790), Number(process.env.SITE_PORT ?? 8791)]
    const begin = async () => {
      firm = await startFirm(await fresh(), {
        ports, say: console.log,
        restart: () => void (async () => {
          console.log('Starting over.')
          await firm?.close()
          await begin()
        })().catch((error) => {
          if (!stopping) console.error(error)
          void stop(1)
        }),
      })
      return firm
    }
    firm = await begin()
    console.log(`
  Stage            ${firm.graph}/stage
  Reviewer screen  ${firm.graph}/review        sign in with the token: demo
  Sample site      ${firm.site}/?gclid=you&utm_id=30111   and ${firm.site}/es?gclid=you&utm_id=30333

  See docs/demo.md for the script. Press Ctrl-C to stop and delete the data.`)
  } catch (error) {
    if (!stopping) console.error(error)
    await stop(1)
  }
}
