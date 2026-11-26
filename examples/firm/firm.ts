/**
 * A made-up law firm with three offices and two languages, to show the whole
 * thing running. Nobody in it is real: the names, numbers and amounts come
 * from a seeded generator, and nothing leaves this machine.
 *
 *   npm run firm
 *   npm run firm -- injury
 *
 * It uses PostgreSQL (or memory with MEMORY=1), the graph server with its reviewer screen, the
 * firm's site and a stage to present it on, and fills them. docs/demo.md has the
 * scenes. Ctrl-C stops and deletes all of it.
 */
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer, type RequestListener } from 'node:http'
import { reviewListener } from '../../apps/review/server.mjs'
import type { Stage, StageState, SceneResult } from './stage-state.ts'
import type { AddressInfo } from 'node:net'
import { accountGraph } from '../../src/index.ts'
import type { CallValue, LocalOptions, RecordEntry, RecordValue } from '../../src/index.ts'
import { createEdge } from '../../src/edge/index.ts'
import { reviewPage } from '../../src/edge/review.ts'
import { runWorkers } from '../../src/testing/index.ts'
// The months before the story are written straight into the graph, as a program of this repository may. The story itself only uses what the package ships.
import { internalsOf } from '../../src/client/internals.ts'
import { hashPhone } from '../../tools/internals.ts'
import { clockScript, landing } from './firm-page.ts'
import { PRACTICES } from './practice.ts'
import { ADDRESS, DAY, HOUR, SECRET, campaignsOf, firmHistory, linesOf, stepsOf } from './history.ts'
import { loadFirmHistory } from './load-history.ts'

export { campaignsOf } from './history.ts'

export interface Firm {
  /** The graph server with its reviewer screen and the stage, and the firm's site. */
  graph: string
  site: string
  close(): Promise<void>
}

/** Where the firm keeps everything. Left out, in memory. */
export interface Kept {
  databaseUrl?: string
}

interface Options {
  ports?: [number, number]
  quick?: boolean
  practice?: keyof typeof PRACTICES
  say?: (line: string) => void | Promise<void>
  restart?: () => void
}

async function round(databaseUrl: string | undefined, graphAt: string, sitePort: number, changed: () => void, { quick = false, practice = 'family', say }: Options) {
  const schema = 'firm_' + randomUUID().replaceAll('-', '')
  const kind = PRACTICES[practice]
  const STEPS = stepsOf(kind)
  const names = campaignsOf(kind)
  const LINES = linesOf(names)
  // What is seeded is written down when it happened. The story takes a Monday to a Thursday that have passed, and each scene moves the clock on to when it happens.
  let writing: number | undefined
  const monday = new Date()
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 3) % 7 || 7) - 3)
  const when = (days: number, hour: number, minute: number) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + days, hour, minute).getTime()
  let ahead = when(0, 8, 50) - Date.now()
  const clock = () => writing ?? Date.now() + ahead
  const { name, ...builtIn } = JSON.parse(readFileSync(new URL('../household.json', import.meta.url), 'utf8')).kinds
  const alerts: string[] = []
  const sent: { id: string; value: number | undefined }[] = []
  const wasSent = (id: string) => sent.some((each) => each.id === id)
  const site = createServer((request, response) => void answer(request, response))
  await once(site.listen(sitePort, '127.0.0.1'), 'listening')
  const siteAt = `http://localhost:${(site.address() as AddressInfo).port}`

  // An ad platform that takes everything and is not there. The key is made here and opens nothing.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const platform: typeof fetch = async (address, init) => {
    const to = String(address)
    if (to.startsWith(siteAt)) return fetch(address, init)
    if (to.includes('oauth2')) return Response.json({ access_token: 'made-up', expires_in: 3600 })
    const { events } = JSON.parse(String(init?.body)) as { events: { transactionId: string; conversionValue?: number }[] }
    sent.push(...events.map((event) => ({ id: event.transactionId, value: event.conversionValue })))
    return Response.json({ requestId: `made-up-${sent.length}` })
  }
  const settings = {
    policy: { kinds: builtIn, ...(name && { customKinds: { name } }) } as NonNullable<LocalOptions['policy']>,
    now: clock, fetch: platform, stages: STEPS, linkSecret: SECRET, identifierSecret: SECRET, workers: false, timeoutMs: 120_000,
    phones: { numbers: LINES, resultsExpectedWithinMinutes: 30, returnHours: 24, pool: { numbers: ['+15550100111', '+15550100112'], minutes: 15, graceMinutes: 120 } },
    ads: { google: { customerId: '000-000-0000', serviceAccount: { client_email: 'demo@example.org', private_key: privateKey } } },
    alerts: { url: `${siteAt}/hook` }, targets: { answered: 0.9, returned: 0.8, callbackHours: 4 }, monitor: { quietHours: { touches: 24, calls: 12, results: 24, costs: 48 } },
  }
  const firm = accountGraph(databaseUrl ? { ...settings, databaseUrl, schema, receiptSecrets: [SECRET] } : { ...settings, memory: true })
  const { engine, ops } = await internalsOf(firm)!().catch(async error => {
    site.closeAllConnections()
    await new Promise(resolve => site.close(resolve))
    await firm.close()
    throw error
  })
  const { graph } = engine
  const handler = createEdge(firm, { token: 'service-demo', reviewers: { dana: 'demo' }, origins: [siteAt], limit: false, events: ['phone_click', 'text_click'] })
  const edge: RequestListener = (request, response) => {
    response.setHeader('x-demo-ahead', ahead)
    const path = request.method + ' ' + new URL(request.url ?? '/', graphAt).pathname
    // A visit to the demo's own site is recorded at the firm's address, as the seeded ones are.
    if (path === 'POST /collect') {
      const read = request[Symbol.asyncIterator].bind(request)
      request[Symbol.asyncIterator] = async function* () {
        const chunks: Buffer[] = []
        for await (const chunk of read()) chunks.push(chunk)
        yield Buffer.from(Buffer.concat(chunks).toString().replace(`"landing":"${siteAt}`, `"landing":"${ADDRESS}`))
      }
    }
    if (path !== 'GET /legacy') return handler(request, response)
    const { html, headers } = reviewPage()
    const script = clockScript(ahead)
    const hash = createHash('sha256').update(script).digest('base64')
    const policy = headers['content-security-policy']!.replace('script-src ', "script-src 'sha256-" + hash + "' ")
    response.writeHead(200, { ...headers, 'content-security-policy': policy }).end(html.replace('<style>', () => '<script>' + script + '</script><style>'))
  }
  const asked = async (path: string, init: RequestInit): Promise<any> => {
    const response = await fetch(graphAt + path, { ...init, headers: { 'user-agent': 'Mozilla/5.0 (the demo)', ...init.headers } })
    const told = response.status === 204 ? undefined : await response.json()
    if (!response.ok) throw new Error(`${path}: ${(told as { error?: string })?.error}`)
    return told
  }
  /** What a page of the site sends. */
  const browser = (body: object) => asked('/collect', { method: 'POST', body: JSON.stringify(body), headers: { origin: siteAt } })
  /** What the reviewer screen reads. */
  const screen = (path: string) => asked(`/review/api${path}`, { headers: { authorization: 'Bearer demo' } })
  /** What the office, the phone system or the matters say, over HTTP, as their own programs would. */
  const office = accountGraph({ url: graphAt, token: 'service-demo', timeoutMs: 120_000 })
  let keys = 0
  async function record<T extends RecordEntry['type']>(entry: Omit<Extract<RecordEntry, { type: T }>, 'key' | 'at'> & { key?: string; at?: number }): Promise<RecordValue[T]> {
    const { results: [result] } = await office.record({ entries: [{ key: `demo-${boot}-${++keys}`, at: clock(), ...entry } as unknown as RecordEntry] })
    if (!result!.ok) throw new Error(`${entry.type}: ${result!.reason}`)
    return result!.value as unknown as RecordValue[T]
  }
  const personOf = async (subject: string) => (await office.lookup({ kind: 'person', subjects: [subject], at: clock() })).people[0]!

  /** Which start this is, so the stage sees when another has begun. */
  const boot = randomUUID()
  let progress = '0 of ' + (quick ? 40 : 320) + ' people'
  const historyProgress = async (line: string) => {
    progress = line
    changed()
    await say?.(line)
  }
  const history = firmHistory(kind, clock, at => { writing = at }, quick, historyProgress)
  const loadHistory = () => loadFirmHistory(engine, history.fill, historyProgress)
  /** Moves the clock on to a moment of the story. It never goes back. */
  async function at(days: number, hour: number, minute: number) {
    const now = clock()
    const then = Math.max(now + 1000, when(days, hour, minute))
    for (let day = now + DAY; day < then + DAY; day += DAY) await history.spend(graph, Math.min(day, then))
    // Others go on arriving and ringing in between, by day, and are answered.
    for (let rang = now + 2 * HOUR; rang < then; rang += 2 * HOUR) {
      if (new Date(rang).getHours() < 9 || new Date(rang).getHours() > 17) continue
      await history.other(graph, rang)
    }
    writing = undefined
    ahead = then - Date.now()
  }
  const demo = { phone: '+15550100042', contact: 'contact:ines-vega', other: 'contact:tomas-vega', line: '+15550100103' }
  const caller = `caller:${hashPhone(demo.phone)}`
  const review = (view: string) => `${graphAt}/${view}`
  /** The scenes, in order. Each does over HTTP what the site, the phone system or the office would, and says what came of it. */
  /** What a scene says came of it, and for some: how sure the credit of the contact's ad is, and what the firm's own screens and the phone show. */
  interface Told { lines: string[]; credit?: { share: number; campaign: string | null }; link?: string; card?: { title: string; path: string; fields: [string, string][] }; checked?: string }
  /** The phone and the firm's own screen once a scene has run. */
  interface Shown { phone?: string; caption?: string; seconds?: number; desk?: { name: string; fields: [string, string][]; done: string } }
  const person = (view: string) => `#/${view}/${encodeURIComponent(demo.contact)}`
  const visitor = `#/accounts/${encodeURIComponent('visitor:v-4821')}`
  /** The best credit of the contact's ad: how sure, and whose it is once it is sure enough. */
  async function credit() {
    const { arrival, possible } = await personOf(demo.contact)
    return { share: (arrival ?? possible)?.confidence ?? 0, campaign: arrival?.campaign ?? null }
  }
  /** A signed link for the contact, as staff would text it. */
  const linkTo = async (page: string, purpose: string): Promise<string> => (await record<'link'>({ type: 'link', key: randomUUID(), url: `${siteAt}/es/${page}`, subject: demo.contact, purpose, expires: clock() + 30 * DAY })).url
  /** What became of the newest link sent for a purpose, in words. */
  const became = async (purpose: string) => {
    const { entries } = await office.lookup({ kind: 'journey', subject: demo.contact })
    const { at: made, opened } = entries.flatMap((entry) => (entry.kind === 'link' && entry.purpose === purpose ? [entry] : [])).at(-1)!
    return opened === null ? `Link for ${purpose}: not opened` : `Link for ${purpose}: opened after ${Math.round((opened - made) / 60_000)} minutes`
  }
  /** The contact opens the link in the browser they came with. The script tag reads the token and takes it out of the address. */
  const opens = (url: string) => browser({ device: 'v-4821', url: url.split('?')[0], link: new URL(url).searchParams.get('ag') })
  const steps = (stage: string, tags: object = {}) => record<'conversion'>({ type: 'conversion', key: `demo-${stage}`, subject: demo.contact, stage, tags: { language: 'es', ...tags } as Record<string, string> })
  const links: Record<string, string> = {}
  const forms = new Map<string, number>()
  /** A text staff send the contact. Only its time and the two numbers are kept. */
  const sends = (id: string) => record<'text'>({ type: 'text', key: id, direction: 'outbound', from: demo.line, to: demo.phone })

  /** The scenes, in order. Each does over HTTP what the site, the phone system or the office would, and says what came of it. */
  const scenes: { title: string; text: string; see: [string, string]; stage?: string; spot?: string[]; /** The detail card it opens, by its key. */ open?: string; shown?: Shown; run(): Promise<Told> }[] = [
    {
      title: 'Ad visit', text: 'They search, tap the Spanish ad for the North office, and land on the site.', see: ['Channels', review('channels')], stage: `#/journey/${encodeURIComponent('visitor:v-4821')}`, spot: [names.spanish], shown: { phone: 'site' },
      async run() {
        await at(0, 9, 2)
        await browser({ device: 'v-4821', url: `${siteAt}/es`, touch: { gclid: 'demo-click', source: 'google', medium: 'cpc', campaignId: '30333', campaign: names.spanish, landing: `${ADDRESS}/es`, custom: { office: 'north', lang: 'es' } } })
        const arrival = (await personOf('visitor:v-4821')).arrival!
        return { lines: [`Visit recorded: ${arrival.campaign}, office ${arrival.custom.office}, language ${arrival.custom.lang}.`] }
      },
    },
    {
      title: 'Tap to call', text: 'They tap the phone number. While it rings the firm’s screen says which ad they came from. The call is held for a result.', see: ['Calls', review('calls')], stage: visitor, shown: { phone: 'calling', seconds: 22 },
      async run() {
        await at(0, 9, 4)
        await browser({ kind: 'event', device: 'v-4821', event: 'phone_click', number: demo.line })
        // What whoever picks up would see, asked while it rings. It writes nothing.
        const ringing = await office.lookup({ kind: 'caller', from: demo.phone, to: demo.line, at: clock() })
        const card = { title: 'Incoming call', path: 'lookup caller', fields: [['Caller', `${ringing.known ? 'Has called before' : 'New'}, (555) 010-0042`], ['Came from', `${ringing.arrival!.source} · ${ringing.arrival!.campaign}`], ['Page', new URL(ringing.arrival!.landing!).pathname], ['Waiting for a call back', ringing.waiting.calls === 0 ? 'No missed calls' : `${ringing.waiting.calls} missed`]] as [string, string][] }
        const call: CallValue = await record<'call'>({ type: 'call', key: 'demo-1', direction: 'inbound', from: demo.phone, to: demo.line, duration: 95, tags: { language: 'es' } })
        return { lines: [`Linked to ${call.visitor} by the tap. State: ${call.state}. Counted: ${call.counted ? 'yes' : 'no'}.`], card }
      },
    },
    {
      title: 'Missed call', text: 'The result reports no answer. The call is excluded from outcomes and conversions.', see: ['Board', review('board/90')], spot: [caller.slice(0, 16)], shown: { phone: 'missed', seconds: 95 },
      async run() {
        await at(0, 9, 6)
        const { state, counted } = await record<'call_update'>({ type: 'call_update', call: 'demo-1', change: { kind: 'result', result: { answered: false, waited: 95 } } })
        await runWorkers(firm)
        return { lines: [`State: ${state}. Counted: ${counted ? 'yes' : 'no'}. Sent to the ad platform: ${wasSent('call:demo-1') ? 'yes' : 'no'}.`, 'The caller is on the Board under Missed calls.'] }
      },
    },
    {
      title: 'Callback', text: 'Staff call back, and are answered.', see: ['Calls', review(`journey/${encodeURIComponent(caller)}`)], stage: `#/journey/${encodeURIComponent(caller)}`, spot: ['Outbound'], shown: { phone: 'talking', seconds: 410 },
      async run() {
        await at(0, 14, 0)
        await record<'call'>({ type: 'call', key: 'demo-2', direction: 'outbound', from: demo.line, to: demo.phone, duration: 410, result: { answered: true } })
        const missed = await office.lookup({ kind: 'record', type: 'call', key: 'demo-1', at: clock() })
        return { lines: [`Missed call: ${missed?.type === 'call' && missed.followUp!.state}.`] }
      },
    },
    {
      title: 'Details entered', text: 'On the call, staff enter the name, phone and date of birth.', see: ['Accounts', review(`accounts/${encodeURIComponent(demo.contact)}`)], stage: person('accounts'), shown: { phone: 'talking', caption: 'Staff take the details', desk: { name: 'New contact', fields: [['Name', 'Inés Vega'], ['Phone', '(555) 010-0042'], ['Date of birth', 'May 6, 1984'], ['Matter', kind.matter]], done: 'Contact saved' } },
      async run() {
        await at(0, 14, 6)
        // Asked before they are saved, so nobody is entered twice. It writes nothing.
        const facts = { phone: demo.phone, name: { first: 'Inés', last: 'Vega' }, dob: '1984-05-06' }
        const { candidates } = await office.lookup({ kind: 'match', facts, at: clock() })
        const [met] = candidates
        const checked = `${candidates.some(({ subject }) => subject.startsWith('contact:')) ? 'Possible duplicate' : 'No duplicate on file'}${met ? ` · a ${met.subject.split(':')[0]}${met.members.some((member) => member.startsWith('visitor:')) ? ' and a site visit' : ''}, by ${met.kinds[0]}` : ''}`
        await record<'profile'>({ type: 'profile', subject: demo.contact, facts, createdAt: clock(), event: 'inquiry' })
        await steps('inquiry')
        const sure = await credit()
        return { lines: [`The call and the visit are now tied to a name. Ad credit: ${Math.round(sure.share * 100)}%, below the 90% it takes.`], credit: sure, checked }
      },
    },
    {
      title: 'Form texted', text: 'Staff text a signed link to the intake form.', see: ['Accounts', review(`accounts/${encodeURIComponent(demo.contact)}`)], stage: person('accounts'), shown: { phone: 'text-form' },
      async run() {
        await at(0, 14, 8)
        links.form = await linkTo('datos', 'form')
        await sends('demo-text-1')
        return { lines: [`Text recorded. ${await became('form')}.`], credit: await credit(), link: links.form }
      },
    },
    {
      title: 'Form opened', text: 'They open the link in the browser they came with, which is now known to be theirs.', see: ['Accounts', review(`accounts/${encodeURIComponent(demo.contact)}`)], stage: person('accounts'), shown: { phone: 'form' },
      async run() {
        await at(0, 14, 12)
        await opens(links.form!)
        // The inquiry waited for an ad to be credited, and is sent now.
        await runWorkers(firm)
        const sure = await credit()
        return { lines: [`We now know whose browser this is. Ad credit: ${Math.round(sure.share * 100)}%, to ${sure.campaign}.`], credit: sure }
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
      title: kind.scenes.papers[0], text: kind.scenes.papers[1], see: ['Board', review('board/7')], spot: ['contact:ines-vega'], shown: { phone: 'signed' },
      async run() {
        await at(0, 14, 25)
        const documents = await linkTo(kind.links.papersPage, kind.links.papers)
        await sends('demo-text-2')
        await at(0, 14, 31)
        await opens(documents)
        await steps(kind.papers)
        return { lines: [`Step recorded: ${kind.papers}.`] }
      },
    },
    {
      title: kind.scenes.scheduled[0], text: kind.scenes.scheduled[1], see: ['Board', review('board/7')], spot: ['contact:ines-vega'], shown: { phone: 'text-time', caption: `Staff schedule the ${kind.lead}`, desk: { name: 'Schedule', fields: [['With', `M. Ortega, ${kind.lead}`], ['When', 'Wednesday, 11:00 AM'], ['How', 'By phone, in Spanish']], done: 'Call scheduled' } },
      async run() {
        await at(0, 14, 36)
        await steps('scheduled', { [kind.lead]: 'ortega' })
        await sends('demo-text-3')
        return { lines: [`Step recorded: scheduled, ${kind.lead} ortega.`] }
      },
    },
    {
      title: kind.scenes.lead[0], text: kind.scenes.lead[1], see: ['Journey', review(`journey/${encodeURIComponent(demo.contact)}`)], stage: person('journey'), spot: ['scheduled', 'Outbound'], shown: { phone: 'director', seconds: 1290 },
      async run() {
        await at(2, 11, 0)
        await record<'call'>({ type: 'call', key: 'demo-4', direction: 'outbound', from: demo.line, to: demo.phone, duration: 1290, result: { answered: true }, tags: { language: 'es' } })
        return { lines: ['Outbound call answered, on the same timeline.'] }
      },
    },
    {
      title: kind.scenes.lastSent[0], text: kind.scenes.lastSent[1], see: ['Journey', review(`journey/${encodeURIComponent(demo.contact)}`)], stage: person('journey'), spot: [`Link sent · ${kind.links.last}`], shown: { phone: 'text-pay' },
      async run() {
        await at(2, 11, 24)
        links.pay = await linkTo(kind.links.lastPage, kind.links.last)
        await sends('demo-text-4')
        return { lines: [`Text recorded. ${await became(kind.links.last)}.`], link: links.pay }
      },
    },
    {
      title: kind.scenes.lastOpened[0], text: kind.scenes.lastOpened[1], see: ['Journey', review(`journey/${encodeURIComponent(demo.contact)}`)], stage: person('journey'), spot: [`Link sent · ${kind.links.last}`], shown: { phone: 'pay' },
      async run() {
        await at(2, 11, 27)
        await opens(links.pay!)
        return { lines: [`${await became(kind.links.last)}. ${kind.told.lastOpen}`] }
      },
    },
    {
      title: kind.scenes.won[0], text: kind.scenes.won[1], see: ['Journey', review(`journey/${encodeURIComponent(demo.contact)}`)], stage: person('journey'), spot: [kind.won], shown: { phone: 'paid' },
      async run() {
        await at(2, 11, 29)
        await steps(kind.won, { office_served: 'river', [kind.lead]: 'ortega' })
        const credited = (await personOf(demo.contact)).arrival!
        return { lines: [`${kind.told.won}: ${kind.value} USD. Advertised: ${credited.custom.office}. Served: river. Attributed to ${credited.campaign} at ${Math.round(credited.confidence * 100)}%.`] }
      },
    },
    {
      title: kind.scenes.sent[0], text: kind.scenes.sent[1], see: ['Journey', review(`journey/${encodeURIComponent(demo.contact)}`)], stage: person('journey'), spot: [kind.won], shown: {},
      async run() {
        await at(2, 11, 40)
        await runWorkers(firm)
        return { lines: [`Sent to the sample ad platform: ${wasSent(`demo-${kind.won}`) ? `${sent.findLast((each) => each.id === `demo-${kind.won}`)!.value} USD, for the first ad click` : 'no'}.`] }
      },
    },
    {
      title: kind.scenes.value[0], text: kind.scenes.value[1], see: ['Journey', review(`journey/${encodeURIComponent(demo.contact)}`)], stage: person('journey'), spot: [`from ${kind.value.toLocaleString('en-US')} USD to ${kind.later.toLocaleString('en-US')} USD`],
      async run() {
        await at(3, 16, 0)
        await record<'restatement'>({ type: 'restatement', of: { type: 'conversion', key: `demo-${kind.won}` }, change: { kind: 'correct', value: kind.later } })
        await runWorkers(firm)
        const won = await office.lookup({ kind: 'record', type: 'conversion', key: `demo-${kind.won}`, at: clock() })
        const values = won?.type === 'conversion' ? won.values : []
        return { lines: [`Initial value ${values[0]!.value} USD, current value ${values.at(-1)!.value} USD.`, `Sent to the ad platform: ${sent.filter((each) => each.id === `demo-${kind.won}`).at(-1)?.value} USD.`] }
      },
    },
    {
      title: kind.scenes.apart[0], text: kind.scenes.apart[1], see: ['Accounts', review(`accounts/${encodeURIComponent(demo.contact)}`)], stage: person('accounts'),
      async run() {
        await at(3, 16, 30)
        for (const subject of [demo.contact, demo.other]) await record<'profile'>({ type: 'profile', subject, facts: { phone: demo.phone, email: 'family@example.org' }, event: 'staff entry' })
        const together = async () => (await personOf(demo.contact)).members.includes(demo.other)
        const joined = await together()
        await office.decide({ key: `matter-${boot}`, at: clock(), by: 'system:matters', action: 'split', pairs: [{ a: demo.contact, b: demo.other, reason: 'sides of one matter' }] })
        const after = { joined: await together() }
        // What a firm's own conflict check could ask before it takes a matter. It writes nothing.
        const { conflicts } = await office.lookup({ kind: 'conflicts', subjects: [demo.contact, demo.other] })
        const card = { title: 'Conflict check', path: 'lookup conflicts', fields: [['People asked about', 'Inés Vega, Tomás Vega'], ['Answer', conflicts[0]?.how === 'recorded' ? 'Kept apart, on record' : 'None known'], ['Rests on', conflicts[0] ? Object.values(conflicts[0].rests).join(', ') : 'Nothing on record']] as [string, string][] }
        return { lines: [`Before: ${joined ? 'joined by a shared phone and email' : 'related'}. After: separated.`, `Same cluster: ${after.joined ? 'yes' : 'no'}.`], card }
      },
    },
    {
      title: 'Shared line', text: 'The other side calls from the family phone. Staff say who the call was with, and it is on that timeline.', see: ['Journey', review(`journey/${encodeURIComponent(demo.other)}`)], spot: ['Record holder confirmed'],
      async run() {
        await at(3, 16, 34)
        await record<'call'>({ type: 'call', key: 'demo-5', direction: 'inbound', from: demo.phone, to: demo.line, duration: 180, result: { answered: true } })
        const onTimeline = async () => (await office.lookup({ kind: 'journey', subject: demo.contact })).entries.some((entry) => entry.kind === 'call' && entry.call === 'demo-5')
        const before = await onTimeline()
        const shown = await office.lookup({ kind: 'party', call: 'demo-5' })
        await record<'call_update'>({ type: 'call_update', key: 'demo-party-1', call: 'demo-5', change: { kind: 'party', role: 'self', subject: demo.other, by: 'dana', seen: shown?.key ?? null } })
        const now = await office.lookup({ kind: 'record', type: 'call', key: 'demo-5', at: clock() })
        return { lines: [`By the number, on Inés’s timeline: ${before ? 'yes' : 'no'}. Said by dana: ${now?.type === 'call' ? now.subject : 'nothing'}.`, `On Inés’s timeline now: ${(await onTimeline()) ? 'yes' : 'no'}.`] }
      },
    },
    {
      title: 'Two at one call', text: 'Somebody else at the firm has the same call open, and saves another answer. They are told of the first.', see: ['Journey', review(`journey/${encodeURIComponent(demo.other)}`)], spot: ['Record holder confirmed'],
      async run() {
        await at(3, 16, 36)
        // Sent as their own program would: they saw a call nobody had said anything of.
        const { results: [second] } = await office.record({ entries: [{ type: 'call_update', key: `demo-party-2-${boot}`, at: clock(), call: 'demo-5', change: { kind: 'party', role: 'self', subject: demo.contact, by: 'lee', seen: null } }] })
        const stands = await office.lookup({ kind: 'party', call: 'demo-5' })
        const refused = second && !second.ok && second.reason === 'STALE' ? `Refused: ${second.by} answered first` : 'Taken'
        const card = { title: 'Who was on this call', path: 'record call_update', fields: [['Saved by', 'lee, Inés Vega'], ['Answer', refused], ['Stands', `${stands && 'subject' in stands ? 'Tomás Vega' : 'Nobody'}, by ${stands?.by}`]] as [string, string][] }
        return { lines: [`${refused}. The call stays as dana left it.`], card }
      },
    },
    {
      title: 'Listing call', text: 'A call to a number published on a map listing is attributed to that listing.', see: ['Channels', review('channels')], spot: [names.listing],
      async run() {
        await at(3, 16, 40)
        const call: CallValue = await record<'call'>({ type: 'call', key: 'demo-3', direction: 'inbound', from: '+15550100043', to: '+15550100104', duration: 260, result: { answered: true } })
        const arrival = (await personOf(call.subject)).arrival!
        return { lines: [`Attributed to ${arrival.campaign}, advertised office ${arrival.custom.office_advertised}. Counted: ${call.counted ? 'yes' : 'no'}.`] }
      },
    },
    {
      title: 'Web form', text: 'Somebody else comes from an ad, and sends the form on the site in place of calling.', see: ['Board', review('board/7')], spot: ['contact:rosa-marin'],
      async run() {
        await at(3, 16, 42)
        await browser({ device: 'v-5107', url: `${siteAt}/`, touch: { gclid: 'demo-click-2', source: 'google', medium: 'cpc', campaignId: '30222', campaign: names.river, landing: `${ADDRESS}/`, custom: { office: 'river', lang: 'en' } } })
        const { status } = await fetch(`${siteAt}/inquiry`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ first: 'Rosa', last: 'Marin', phone: '(555) 010-0046', texts: 'yes', lang: 'en', ag_device: 'v-5107' }) })
        if (status !== 303) throw new Error(`The form was answered ${status}`)
        const credited = (await personOf('contact:rosa-marin')).arrival!
        return { lines: [`Step recorded: inquiry. Credited to ${credited.campaign} at ${Math.round(credited.confidence * 100)}%, by the browser.`] }
      },
    },
    {
      title: 'Shared phone', text: 'A parent and a child share a phone. The link is below the join threshold and waits for review.', see: ['Matches', review('decide')], spot: ['marta-lago'],
      async run() {
        await at(3, 16, 45)
        await record<'profile'>({ type: 'profile', subject: 'contact:marta-lago', facts: { phone: '+15550100044', name: { first: 'Marta', last: 'Lago' }, dob: '1970-02-03' }, event: 'staff entry' })
        await record<'profile'>({ type: 'profile', subject: 'contact:teo-lago', facts: { phone: '+15550100044', name: { first: 'Teo', last: 'Lago' }, dob: '2001-07-08' }, event: 'staff entry' })
        const { joined, score } = await screen('/between?a=contact:marta-lago&b=contact:teo-lago')
        return { lines: [`Linked at ${Math.round(score * 100)}% by phone: ${joined ? 'joined' : 'related'}.`] }
      },
    },
    {
      title: 'Join kept', text: 'The parent is on file twice. Staff join the two, then separate parent and child. The join holds.', see: ['Accounts', review('accounts/contact:marta-lago')],
      async run() {
        await at(3, 16, 47)
        await record<'profile'>({ type: 'profile', subject: 'contact:marta-lago-2', facts: { phone: '+15550100044', name: { first: 'Marta', last: 'Lagos' } }, event: 'staff entry' })
        await office.decide({ key: `join-${boot}`, at: clock(), by: 'dana', action: 'merge', pairs: [{ a: 'contact:marta-lago', b: 'contact:marta-lago-2', reason: 'one person, entered twice' }] })
        for (const marta of ['contact:marta-lago', 'contact:marta-lago-2']) await office.decide({ key: `apart-${marta}-${boot}`, at: clock(), by: 'dana', action: 'split', pairs: [{ a: marta, b: 'contact:teo-lago', reason: 'parent and child' }] })
        const [martas, family] = [await screen('/between?a=contact:marta-lago&b=contact:marta-lago-2'), await screen('/between?a=contact:marta-lago&b=contact:teo-lago')]
        return { lines: [`Marta’s two contacts: ${martas.joined ? 'joined' : 'apart'}. Marta and Teo: ${family.joined ? 'joined' : 'separated'}.`] }
      },
    },
    {
      title: 'Newborns', text: 'Twins are entered on their first day, before they have names. A placeholder name and a birthday in common do not make them one.', see: ['Matches', review('decide')], spot: ['newborn-1'],
      async run() {
        await at(3, 16, 49)
        const dob = new Date(clock() - DAY).toISOString().slice(0, 10)
        for (const n of [1, 2]) await record<'profile'>({ type: 'profile', subject: `contact:newborn-${n}`, facts: { phone: '+15550100048', name: { first: 'Baby Girl', last: 'Ibarra' }, dob }, event: 'staff entry' })
        const { joined, score } = await screen('/between?a=contact:newborn-1&b=contact:newborn-2')
        return { lines: [`Linked at ${Math.round(score * 100)}%: ${joined ? 'joined' : 'related'}.`] }
      },
    },
    {
      title: 'Stop on a retry', text: 'A text is reported twice, the first time without its words. The second says STOP, and is not lost.', see: ['Journey', review(`journey/${encodeURIComponent(`caller:${hashPhone('+15550100046')}`)}`)], spot: ['Asked for no more texts'],
      async run() {
        await at(3, 16, 51)
        const text = { type: 'text', key: 'demo-text-5', direction: 'inbound', from: '+15550100046', to: '+15550100102', at: clock() } as const
        await record<'text'>(text)
        const before = (await personOf('contact:rosa-marin')).textsOptedOut
        const again = await record<'text'>({ ...text, text: 'STOP' })
        const after = (await personOf('contact:rosa-marin')).textsOptedOut
        return { lines: [`First: ${before ? 'no more texts' : 'may be texted'}. Again, with STOP: ${after ? 'no more texts' : 'may be texted'}.${again.optOutAdded ? ' The opt-out was added.' : ''}`] }
      },
    },
    {
      title: 'What is behind a number', text: 'The icon beside a number opens what it is made of, and how it stands to the target the firm set.', see: ['Calls', review('calls')], open: 'calls.answered',
      async run() {
        return { lines: ['Opened from the number. Nothing was recorded.'] }
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

  /** Nothing is run until the sample data is in. */
  let ready = false
  let next = 0
  let running = false
  let last: SceneResult = {lines: []}
  let ms = 0
  let problem = ''
  const state = (): StageState => ({revision: 0, boot, ready, running, next, ms, error: problem, progress, site: siteAt, told: last, clock: clock(), practice: kind.stage, scenes: scenes.map(({run, ...scene}) => scene)})
  /** Runs the next scene: what to answer with. */
  async function runScene(): Promise<[number, object]> {
    const scene = scenes[next]
    if (!ready) return [409, { error: 'The sample data is still loading' }]
    if (!scene || running) return [409, { error: 'There is no next scene to run' }]
    running = true
    problem = ''
    changed()
    const began = performance.now()
    try {
      const told = await scene.run()
      // A signed form link belongs to the scene runner. Only the presentation fields go on stage.
      const {link: _privateLink, ...shown} = told
      last = shown
      next += 1
      ms = Math.round(performance.now() - began)
      return [200, last]
    } catch (error) {
      problem = String((error as Error).message)
      return [500, {error: problem}]
    } finally {
      running = false
      changed()
    }
  }
  async function answer(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) {
    const url = new URL(request.url ?? '/', siteAt)
    const html = (text: string) => void response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(text)
    try {
      const phone = url.searchParams.has('phone')
      const asked = url.searchParams.has('sent')
      if (url.pathname === '/') return html(landing('en', graphAt, phone, asked, practice))
      if (url.pathname === '/es') return html(landing('es', graphAt, phone, asked, practice))
      if (url.pathname === '/inquiry' && request.method === 'POST') return await inquired(request, response)
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

  /**
   * The form on the site: a new contact, with the browser it was filled in on. Where it is about somebody else, the contact is
   * that person, and the browser and the number are those of whoever wrote. What was written, and whether they may be texted,
   * is kept by the firm's own system and not here.
   */
  async function inquired(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) {
    const form = new URLSearchParams((await new Response(request as unknown as ReadableStream).text()).slice(0, 4000))
    const word = (name: string) => (form.get(name) ?? '').trim().slice(0, 60)
    const other = word('about_other') === 'yes'
    const [first, last] = other ? [word('their_first'), word('their_last')] : [word('first'), word('last')]
    const device = word(other ? 'ag_speaker_device' : 'ag_device')
    const slug = `${first}-${last}`.normalize('NFKD').toLowerCase().replace(/[^a-z-]/g, '')
    if (!first || !last || word('phone').replace(/\D/g, '').length < 10) return void response.writeHead(400).end('A name and a phone number are needed')
    const before = forms.get(slug) ?? 0
    forms.set(slug, before + 1)
    const subject = `contact:${slug}${before > 0 ? `-${before + 1}` : ''}`
    const wrote = { ...(device && { device }), phone: word('phone') }
    await record<'profile'>({ type: 'profile', subject, facts: { ...(!other && wrote), name: { first, last } }, ...(other && { speaker: wrote }), event: 'inquiry' })
    await record<'conversion'>({ type: 'conversion', key: `form-${randomUUID()}`, subject, stage: 'inquiry', tags: { language: form.get('lang') === 'es' ? 'es' : 'en' } })
    response.writeHead(303, { location: `${form.get('lang') === 'es' ? '/es' : '/'}?sent=1#write` }).end()
  }

  const seeded = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
    await loadHistory()
    await ops.check()
    ready = true
  }).catch(() => { problem = 'Sample history could not be loaded. Restart to try again.' }).finally(changed)
  return {
    state, edge, runScene, site: siteAt,
    async close() {
      await seeded
      site.closeAllConnections()
      await new Promise(resolve => site.close(resolve))
      await office.close()
      await handler.drain()
      await firm.close()
      if (databaseUrl) {
        const {default: pg} = await import('pg')
        const pool = new pg.Pool({connectionString: databaseUrl})
        try { await pool.query('drop schema if exists ' + schema + ' cascade') } finally { await pool.end() }
      }
    },
  }
}

/** Keep the public listener and stage sessions alive while a restart replaces the graph. */
export async function startFirm({databaseUrl}: Kept, options: Options = {}): Promise<Firm> {
  const ports = options.ports ?? [0, 0]
  let active: Awaited<ReturnType<typeof round>> | undefined
  let app: Awaited<ReturnType<typeof reviewListener>> | undefined
  let restarting: Promise<void> | undefined
  let restartError = ''
  const watchers = new Set<() => void>()
  let revision = 0
  const changed = () => { revision += 1; for (const notify of watchers) notify() }
  let initialized!: () => void
  const listening = new Promise<void>(resolve => { initialized = resolve })
  const server = createServer(async (req,res) => {
    const host = req.headers.host?.split(':')[0]
    if (host !== '127.0.0.1' && host !== 'localhost') return void res.writeHead(403).end()
    const path = (req.url ?? '/').split('?')[0]!
    if (!app) await listening
    if (!active || !app) return void res.writeHead(503).end('The firm could not start. Check its terminal and reload.')
    if (/^\/(v1\/|review\/api\/|collect(?:[/.]|$)|legacy$|calls\/twilio|texts\/twilio)/.test(path)) return active.edge(req,res)
    return app(req,res)
  })
  await once(server.listen(ports[0], '127.0.0.1'), 'listening')
  const address = 'http://localhost:' + (server.address() as AddressInfo).port
  const stage: Stage = {
    state() {
      const state = {...active!.state(), revision}
      return restarting || restartError ? {...state, ready: false, running: !!restarting, progress: 'Starting over…', error: restartError} : state
    },
    subscribe(notify) { watchers.add(notify); return () => watchers.delete(notify) },
    async change(intent, boot, expected) {
      const state = stage.state()
      if (boot !== state.boot || expected !== state.next || state.running) return 'The scene has changed. Use the current controls.'
      if (intent === 'run') {
        if (!state.ready) return 'The sample data is still loading.'
        const [status, body] = await active!.runScene()
        return status === 200 ? undefined : (body as {error: string}).error
      }
      if (intent !== 'restart' || !(state.ready || state.error)) return 'The scene cannot be started over yet.'
      options.restart?.()
      const sitePort = Number(new URL(active!.site).port)
      restarting = (async () => {
        if (!restartError) await active!.close()
        active = await round(databaseUrl, address, sitePort, changed, options)
        restartError = ''
      })().catch(() => { restartError = 'The firm could not restart. Try again.' }).finally(() => { restarting = undefined; changed() })
      changed()
    },
  }
  try {
    active = await round(databaseUrl, address, ports[1], changed, options)
    app = await reviewListener({graphUrl: address, secret: randomUUID() + randomUUID(), eventsToken: 'service-demo', stage})
  } catch (error) {
    server.close()
    await active?.close()
    throw error
  } finally {
    initialized()
  }
  return {graph: address, site: active.site, async close() {
    await restarting
    app?.stop()
    await active?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }}
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
    execFileSync('docker', ['run', '--pull=never', '--rm', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=demo', '-p', '127.0.0.1::5432', 'postgres:16'], { stdio: 'ignore' })
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
    const memory = process.env.MEMORY === '1'
    made = !memory && !process.env.DATABASE_URL ? throwaway() : undefined
    const databaseUrl = memory ? undefined : process.env.DATABASE_URL || made?.address
    if (!memory && !databaseUrl) throw new Error('Set DATABASE_URL, start local Docker with postgres:16 available, or set MEMORY=1.')
    if (made) {
      const {default: pg} = await import('pg')
      const pool = new pg.Pool({connectionString: databaseUrl})
      end = () => pool.end()
      for (let tries = 0; ; tries++) {
        try { await pool.query('select 1'); break } catch (error) {
          if (tries >= 100) throw error
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }
    }
    const ports: [number, number] = [Number(process.env.PORT ?? 8790), Number(process.env.SITE_PORT ?? 8791)]
    const practice = process.argv[2] === 'injury' ? 'injury' : 'family'
    firm = await startFirm(databaseUrl ? {databaseUrl} : {}, {ports, practice, say: console.log})
    console.log(`
  Stage            ${firm.graph}/stage
  Reviewer screen  ${firm.graph}/accounts      sign in with the token: demo
  Sample site      ${firm.site}/?gclid=you&utm_id=30111   and ${firm.site}/es?gclid=you&utm_id=30333

  See docs/demo.md for the scenes. Press Ctrl-C to stop and delete the data.`)
  } catch (error) {
    if (!stopping) console.error(error)
    await stop(1)
  }
}
