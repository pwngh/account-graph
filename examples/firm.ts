/**
 * A made-up law firm with three offices and two languages, to show the whole
 * thing running. Nobody in it is real: the names, numbers and amounts come
 * from a seeded generator, and nothing leaves this machine.
 *
 *   npm run firm
 *
 * It starts a throwaway PostgreSQL in Docker (or keeps everything in memory
 * where there is no Docker), the graph server with its reviewer screen, the
 * firm's site and its presenter page, and fills them. docs/demo.md has the
 * script. Ctrl-C stops and deletes all of it.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGraph, createMemoryStore, createOps, createOutbox, googleAds, hashPhone, nameKeys, policyFrom, recordCall } from '../src/index.ts'
import type { Store } from '../src/index.ts'
import { createHandler } from '../src/server.ts'
import { page } from './firm-page.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const SECRET = 'a-demo-secret-that-protects-nothing'

/** The firm's own numbers, each with where it is published. */
export const LINES = {
  '+15550100101': { source: 'google', campaignId: '30111', campaign: 'Search: North', tags: { office_advertised: 'north', language: 'en' } },
  '+15550100102': { source: 'google', campaignId: '30222', campaign: 'Search: River', tags: { office_advertised: 'river', language: 'en' } },
  '+15550100103': { source: 'google', campaignId: '30333', campaign: 'Busqueda: North', tags: { office_advertised: 'north', language: 'es' } },
  '+15550100104': { source: 'listing', medium: 'map', campaign: 'Map listing, River', tags: { office_advertised: 'river', language: 'es' } },
} as const
const CAMPAIGNS = [
  { source: 'google', campaignId: '30111', campaign: 'Search: North', office: 'north', lang: 'en', line: '+15550100101', daily: 84, share: 0.34, client: 0.16 },
  { source: 'google', campaignId: '30222', campaign: 'Search: River', office: 'river', lang: 'en', line: '+15550100102', daily: 61, share: 0.24, client: 0.11 },
  { source: 'google', campaignId: '30333', campaign: 'Busqueda: North', office: 'north', lang: 'es', line: '+15550100103', daily: 38, share: 0.24, client: 0.2 },
  { source: 'meta', campaignId: '40444', campaign: 'Online consultations', office: 'online', lang: 'en', line: '+15550100101', daily: 45, share: 0.18, client: 0.06 },
] as const
const STEPS = {
  call: { value: 5, currency: 'USD' },
  inquiry: { value: 10, currency: 'USD', wait: 48, action: { google: '111' } },
  consultation: { value: 60, currency: 'USD', wait: 120 },
  client: { value: 400, currency: 'USD', action: { google: '333' } },
}
const FIRST = ['Ana', 'Luis', 'Maria', 'Jorge', 'Elena', 'Pat', 'Sam', 'Robin', 'Lee', 'Dana', 'Alex', 'Noor']
const LAST = ['Rivera', 'Santos', 'Moreno', 'Hill', 'Stone', 'Brook', 'Vale', 'Cruz', 'Marsh', 'Field']

export interface Firm {
  /** The graph server with its reviewer screen, and the firm's site with its presenter page. */
  graph: string
  site: string
  close(): Promise<void>
}

/** Starts the firm over a store. With `quick`, it has a tenth of its history, for tests. */
export async function startFirm(store: Store, { ports = [0, 0], quick = false, say = () => {} }: { ports?: [number, number]; quick?: boolean; say?: (line: string) => void } = {}): Promise<Firm> {
  // What is seeded is written down when it happened. Later the clock may be moved forward, to show a night in which nothing rings.
  let writing: number | undefined
  let ahead = 0
  const clock = () => writing ?? Date.now() + ahead
  const policy = policyFrom(JSON.parse(readFileSync(new URL('./household.json', import.meta.url), 'utf8')))
  const graph = createGraph(store, policy, { now: clock })
  const alerts: string[] = []
  const sent: string[] = []
  const site = createServer((request, response) => void answer(request, response))
  await new Promise<void>((resolve) => site.listen(ports[1], '127.0.0.1', resolve))
  const siteAt = `http://localhost:${(site.address() as AddressInfo).port}`

  // An ad platform that takes everything and is not there.
  const outbox = createOutbox(graph, store.outbox, {
    now: clock,
    targets: [googleAds({ customerId: '000-000-0000', send: async (body) => (sent.push(...(body as any).events.map((event: any) => event.transactionId)), { requestId: `made-up-${sent.length}` }) })],
  })
  const ops = createOps(graph, store.ops, { now: clock, url: `${siteAt}/hook`, quiet: { calls: 12 }, returnHours: 24, onError: () => {} })
  const calls = { numbers: LINES, results: 'expected' as const }
  const handler = createHandler(graph, {
    token: 'service-demo', reviewers: { dana: 'demo' }, origins: [siteAt], now: clock, outbox, ops, stages: STEPS, calls, returnHours: 24, limit: false,
    events: ['phone_click'], linkSecret: SECRET, identifierSecret: SECRET, pool: { numbers: ['+15550100111', '+15550100112'], minutes: 15, grace: 120 },
  })
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(ports[0], '127.0.0.1', resolve))
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

  /** Two months of a firm's life. */
  async function fill() {
    const start = Date.now()
    const day = (ago: number) => new Date(start - ago * DAY).toISOString().slice(0, 10)
    // The campaign for online consultations has a week with no costs recorded.
    for (const { source, campaignId, campaign, daily } of CAMPAIGNS) {
      await graph.spend(Array.from({ length: 60 }, (_, ago) => ago).filter((ago) => !(campaignId === '40444' && ago >= 10 && ago < 17)).map((ago) => {
        const amount = Math.round(daily * (0.8 + chance() * 0.4) * 100) / 100
        return { day: day(ago), source, campaignId, campaign, amount, currency: 'USD', clicks: Math.round(amount / 4), impressions: Math.round(amount * 12) }
      }))
    }
    const people = quick ? 40 : 320
    for (let n = 0; n < people; n++) {
      if (n % 80 === 79) say(`  ${n + 1} of ${people} people`)
      let roll = chance()
      const campaign = CAMPAIGNS.find(({ share }) => (roll -= share) < 0) ?? CAMPAIGNS[0]
      const { source, campaignId, office, lang, line } = campaign
      // Most come by day, on weekdays a little more.
      const at = Math.min(start - Math.floor((1 + chance() * 3) * HOUR), Math.floor((start - chance() * 58 * DAY) / DAY) * DAY + Math.floor((14 + chance() * 11) * HOUR))
      const visitor = `visitor:s${n}`
      const contact = `contact:${1000 + n}`
      const from = phoneOf(n)
      writing = at
      await graph.observe({ subject: visitor, identifiers: [`device:s${n}`, `ip:198.51.100.${n % 200}`], at, event: 'visit' })
      await graph.touch({ subject: visitor, at, source, medium: 'cpc', campaignId, campaign: campaign.campaign, [source === 'google' ? 'gclid' : 'fbclid']: `s${n}`, landing: 'https://firm.example.org/', custom: { office, ...(chance() < 0.85 && { lang }) } })
      const called = chance() < 0.62
      let reached = !called
      if (called) {
        const rang = at + Math.floor(1 + chance() * 40) * 60_000
        const roll = chance()
        const answered = roll < 0.66
        const call = { from, to: line, duration: answered ? 120 + Math.floor(chance() * 900) : 20 + Math.floor(chance() * 80), waited: Math.floor(chance() * 60), ...(chance() < 0.8 && { tags: { language: lang } }) }
        writing = rang
        await recordCall(graph, { id: `s${n}`, at: rang, answered, ...(roll > 0.9 && { voicemail: true }), ...call }, { ...calls, now: clock, convert: (outcome) => graph.outcome({ ...outcome, value: STEPS.call.value, currency: 'USD' }) })
        reached = answered
        if (!answered && chance() < 0.82) {
          const back = rang + Math.floor(1 + chance() * 30) * HOUR
          if (back < start) {
            writing = back
            reached = chance() < 0.7
            await recordCall(graph, { id: `b${n}`, direction: 'outbound', from: line, to: from, at: back, duration: reached ? 300 : 25, answered: reached }, { ...calls, now: clock })
          }
        }
      }
      if (!reached || chance() > 0.55) continue
      // They left their number, with staff or in a form, and staff opened a contact for them.
      const asked = at + Math.floor(chance() * 20) * HOUR
      const name = [pick(FIRST), pick(LAST)] as const
      writing = asked
      await graph.observe({ subject: contact, identifiers: [...(called ? [] : [`device:s${n}`]), `phone:${hashPhone(from)}`, `email:made-up-${n}`, ...nameKeys(SECRET, ...name, { dob: `19${60 + (n % 40)}-0${1 + (n % 9)}-1${n % 9}` })], at: asked, event: 'inquiry' })
      if (called) await graph.joinAll([{ a: `caller:${hashPhone(from)}`, b: contact, reason: 'answered by staff' }], { by: 'system:desk' })
      if (called) await graph.observe({ subject: contact, identifiers: [`device:s${n}`], at: asked, event: 'inquiry' })
      const step = async (stage: keyof typeof STEPS, moment: number, value = STEPS[stage].value) => {
        const when = Math.floor(moment)
        if (when > start) return false
        writing = when
        // Some go to the office that is nearest, whatever the ad said.
        const office_served = chance() < 0.18 ? pick(['north', 'river', 'online']) : office
        await graph.outcome({ transactionId: `${stage}-${n}`, subject: contact, at: when, stage, value, currency: 'USD', tags: { office_served, ...(chance() < 0.8 && { language: lang }) } })
        return true
      }
      if (!(await step('inquiry', asked)) || chance() > 0.6) continue
      if (!(await step('consultation', asked + (1 + chance() * 6) * DAY)) || chance() > campaign.client * 3.2) continue
      const signed = Math.floor(asked + (3 + chance() * 25) * DAY)
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
      const [one, other] = [0, 1].map((side) => ({ subject: `contact:${5000 + 2 * n + side}`, identifiers: [phone, `email:home-${n}-${side}`, ...nameKeys(SECRET, FIRST[(n + side * 5) % FIRST.length]!, LAST[n % LAST.length]!, { dob: `19${70 + n}-03-1${side}` })], at: start - (n + 2) * HOUR, event: 'staff entry' }))
      await graph.observe([one!, other!])
    }
  }

  const demo = { phone: '+15550100042', other: 'contact:other-side', line: '+15550100103' }
  const caller = `caller:${hashPhone(demo.phone)}`
  const review = (view: string) => `${graphAt}/review#/${view}`
  /** The scenes, in order. Each does over HTTP what the site, the phone system or the office would, and says what came of it. */
  const scenes: { title: string; text: string; see: [string, string]; run(): Promise<string[]> }[] = [
    {
      title: 'An ad in Spanish brings a visitor', text: 'Somebody presses the ad for the North office. Its address carries office=north and lang=es.', see: ['Channels', review('channels')],
      async run() {
        await browser('/collect', { device: 'demo-visitor', url: `${siteAt}/es`, touch: { gclid: 'demo-click', source: 'google', medium: 'cpc', campaignId: '30333', campaign: 'Busqueda: North', landing: `${siteAt}/es`, custom: { office: 'north', lang: 'es' } } })
        const { touches } = await ask('GET', `/attribute?subject=visitor:demo-visitor&at=${clock()}`)
        return [`The arrival is on record: ${touches[0].campaign}, office ${touches[0].custom.office}, language ${touches[0].custom.lang}.`]
      },
    },
    {
      title: 'They tap the number, and wait in the queue', text: 'The phone system reports the call. It picked up, so a plain call tracker would count it.', see: ['Calls', review('calls')],
      async run() {
        await browser('/event', { device: 'demo-visitor', event: 'phone_click', number: demo.line })
        const call = await ask('POST', '/call', { id: 'demo-1', from: demo.phone, to: demo.line, at: clock(), duration: 95, tags: { language: 'es' } })
        return [`Tied to ${call.visitor} by the tap. State: ${call.state}. Counted: ${call.counted ? 'yes' : 'no'}.`]
      },
    },
    {
      title: 'They hang up before anyone answers', text: 'The result arrives: nobody answered. The call is a miss, and is never counted or sent to the ad platform.', see: ['Board', review('board/90')],
      async run() {
        const { state, counted } = await ask('POST', '/call/result', { id: 'demo-1', answered: false, waited: 95 })
        await outbox.run()
        return [`State: ${state}. Counted: ${counted ? 'yes' : 'no'}. Sent to the ad platform: ${sent.includes('call:demo-1') ? 'yes' : 'no'}.`, 'They are on the Board, under missed and not returned.']
      },
    },
    {
      title: 'Staff ring back', text: 'The return call is answered. Staff open a contact, and say the call is about them.', see: ['Journey', review(`journey/${encodeURIComponent('contact:demo')}`)],
      async run() {
        await ask('POST', '/call', { id: 'demo-2', direction: 'outbound', from: demo.line, to: demo.phone, at: clock(), duration: 410, answered: true })
        await ask('POST', '/identify', { subject: 'contact:demo', phone: demo.phone, name: { first: 'Inés', last: 'Vega' }, dob: '1984-05-06', event: 'inquiry' })
        await ask('POST', '/join', { source: 'desk', pairs: [{ a: caller, b: 'contact:demo', reason: 'answered by staff' }] })
        await ask('POST', '/convert', { transactionId: 'demo-inquiry', subject: 'contact:demo', at: clock(), stage: 'inquiry', tags: { language: 'es' } })
        await outbox.run()
        const { followUp } = await ask('GET', '/call?id=demo-1')
        return [`The miss is ${followUp.state}.`, `The inquiry is credited to the ad click and sent: ${sent.includes('demo-inquiry') ? 'yes' : 'no'}.`]
      },
    },
    {
      title: 'A call to the number on a map listing', text: 'Nobody loaded a page. The number says which listing it is, so the call is filed there.', see: ['Channels', review('channels')],
      async run() {
        const call = await ask('POST', '/call', { id: 'demo-3', from: '+15550100043', to: '+15550100104', at: clock(), duration: 260, answered: true })
        const { touches } = await ask('GET', `/attribute?subject=${call.subject}&at=${clock()}`)
        return [`Filed under ${touches[0].campaign}, advertised office ${touches[0].custom.office_advertised}. Counted: ${call.counted ? 'yes' : 'no'}.`]
      },
    },
    {
      title: 'They become a client of another office', text: 'The ad said North. The River office serves them. Both are kept, under names that cannot be mixed up.', see: ['Channels by office served', review('channels///outcome.office_served')],
      async run() {
        await ask('POST', '/convert', { transactionId: 'demo-client', subject: 'contact:demo', at: clock(), stage: 'client', tags: { office_served: 'river', language: 'es' } })
        await outbox.run()
        const { credited } = await ask('GET', `/attribute?subject=contact:demo&at=${clock()}`)
        return [`Advertised: ${credited.custom.office}. Served: river. Credited to ${credited.campaign} at ${Math.round(credited.confidence * 100)}%.`]
      },
    },
    {
      title: 'The other side of the matter', text: 'A contact on the other side gives the same family phone and email. The case system says the two are never one person.', see: ['Accounts', review(`accounts/${encodeURIComponent('contact:demo')}`)],
      async run() {
        for (const subject of ['contact:demo', demo.other]) await ask('POST', '/identify', { subject, phone: demo.phone, email: 'family@example.org', event: 'staff entry' })
        const { joined } = await ask('GET', `/between?a=contact:demo&b=${demo.other}`)
        await ask('POST', '/separate', { source: 'matters', pairs: [{ a: 'contact:demo', b: demo.other, reason: 'sides of one matter' }] })
        const after = await ask('GET', `/between?a=contact:demo&b=${demo.other}`)
        return [`Before: ${joined ? 'joined, by a phone and an email the family shares' : 'related'}. After: kept apart, whatever they come to share.`, `In one cluster: ${after.joined ? 'yes' : 'no'}.`]
      },
    },
    {
      title: 'One phone, one household', text: 'A parent and a child give one phone. Sharing it relates them, and does not make them one person.', see: ['Decide', review('decide')],
      async run() {
        await ask('POST', '/identify', { subject: 'contact:4801', phone: '+15550100044', name: { first: 'Marta', last: 'Lago' }, dob: '1970-02-03', event: 'staff entry' })
        await ask('POST', '/identify', { subject: 'contact:4802', phone: '+15550100044', name: { first: 'Teo', last: 'Lago' }, dob: '2001-07-08', event: 'staff entry' })
        const { joined, score } = await ask('GET', '/between?a=contact:4801&b=contact:4802')
        return [`${Math.round(score * 100)}% by the phone: ${joined ? 'joined' : 'related, and not joined'}. Someone can decide.`]
      },
    },
    {
      title: 'What the client paid is known later', text: 'The step was worth 400 when they signed. The amount is restated, here and at the ad platform.', see: ['Journey', review(`journey/${encodeURIComponent('contact:demo')}`)],
      async run() {
        await ask('POST', '/restate', { transactionId: 'demo-client', value: 1250 })
        await outbox.run()
        const { values } = await ask('GET', '/outcome?id=demo-client')
        return [`Recorded at ${values[0].value} USD, now ${values.at(-1).value} USD. Both stay on record.`]
      },
    },
    {
      title: 'A night in which nothing rings', text: 'The clock is moved on fourteen hours. The call feed has gone quiet, and somebody is told.', see: ['Health', review('health')],
      async run() {
        ahead += 14 * HOUR
        await ops.check()
        const told = alerts.findLast((text) => text.includes('no calls for'))
        return [told ? `Told: "${told}"` : 'Nobody was told.']
      },
    },
  ]

  let next = 0
  let running = false
  async function answer(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) {
    const url = new URL(request.url ?? '/', siteAt)
    const html = (text: string) => void response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(text)
    try {
      if (url.pathname === '/') return html(page('en', graphAt))
      if (url.pathname === '/es') return html(page('es', graphAt))
      if (url.pathname === '/present') return html(page('present', graphAt))
      if (url.pathname === '/scenes') return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ next, scenes: scenes.map(({ title, text, see }) => ({ title, text, see })) }))
      if (url.pathname === '/hook' && request.method === 'POST') {
        alerts.push(JSON.parse(await new Response(request as unknown as ReadableStream).text()).text)
        return void response.writeHead(204).end()
      }
      if (url.pathname === '/run' && request.method === 'POST') {
        const scene = scenes[next]
        if (!scene || running) return void response.writeHead(409, { 'content-type': 'application/json' }).end('{"error":"There is no next scene to run"}')
        running = true
        const began = performance.now()
        try {
          const lines = await scene.run()
          next += 1
          return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ lines, ms: Math.round(performance.now() - began) }))
        } finally {
          running = false
        }
      }
      response.writeHead(404).end('Not found')
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String((error as Error).message) }))
    }
  }

  await fill()
  // Whoever has waited since before the show is told of now, so that what is told during it is about it.
  await ops.check()
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
async function throwaway(): Promise<{ address: string; stop(): void } | undefined> {
  try {
    const id = execFileSync('docker', ['run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=demo', '-p', '127.0.0.1::5432', 'postgres:16'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const port = execFileSync('docker', ['port', id, '5432']).toString().trim().split('\n')[0]!.split(':').at(-1)
    return { address: `postgres://postgres:demo@127.0.0.1:${port}/postgres`, stop: () => void execFileSync('docker', ['stop', '-t', '1', id], { stdio: 'ignore' }) }
  } catch {
    return undefined
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const made = process.env.DATABASE_URL || process.env.MEMORY ? undefined : await throwaway()
  const address = process.env.DATABASE_URL ?? made?.address
  let store: Store = createMemoryStore()
  let pool: { query(text: string): Promise<unknown>; end(): Promise<void> } | undefined
  if (address) {
    const { default: pg } = await import('pg')
    const { createPostgresStore } = await import('../src/postgres.ts')
    const opened = (pool = new pg.Pool({ connectionString: address }))
    for (let tries = 0; ; tries++) {
      try {
        await opened.query('drop schema if exists firm_demo cascade')
        break
      } catch (error) {
        if (tries > 100) throw error
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    const postgres = createPostgresStore(opened, 'firm_demo')
    await postgres.migrate()
    store = postgres
  }
  console.log(address ? 'Filling a made-up firm in PostgreSQL. This takes a minute or so.' : 'No Docker and no DATABASE_URL, so everything is kept in memory. Filling a made-up firm.')
  const firm = await startFirm(store, { ports: [Number(process.env.PORT ?? 8790), Number(process.env.SITE_PORT ?? 8791)], say: console.log })
  console.log(`
  Presenter page   ${firm.site}/present
  Reviewer screen  ${firm.graph}/review        sign in with the token: demo
  The firm's site  ${firm.site}/?gclid=you&utm_id=30111   and ${firm.site}/es?gclid=you&utm_id=30333

  The script is in docs/demo.md. Ctrl-C stops everything and deletes it.`)
  const stop = async () => {
    await firm.close()
    if (pool) {
      if (!made) await pool.query('drop schema if exists firm_demo cascade')
      await pool.end()
    }
    made?.stop()
    process.exit(0)
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
}
