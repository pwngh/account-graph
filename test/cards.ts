import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import { accountGraph } from '../src/index.ts'
import type { LocalOptions, RecordEntry } from '../src/index.ts'
import { createEdge } from '../src/edge/index.ts'
import { hashPhone } from '../tools/internals.ts'
import { browse, pause, until } from './chrome.ts'

// What the tests of the detail cards share: a firm with a call in each state, and a browser signed in to its screen.
export const HOUR = 3_600_000
export const MINUTE = 60_000
export const LINE = '+15550100001'
export const SITE = 'https://www.firm.example.org'
export const from = (n: number) => `+155501001${n}`
export const caller = (n: number) => `caller:${hashPhone(from(n))}`

/** A firm with calls in each of the five states, what became of them, and one person with every kind of event. */
export async function firm(where: Partial<LocalOptions>, more: Partial<LocalOptions> = {}) {
  const start = Math.floor(Date.now() / MINUTE) * MINUTE
  let clock = start
  const at = (hours: number) => (clock = start + Math.round(hours * HOUR))
  const graph = accountGraph({
    ...where, now: () => clock, linkSecret: 'l'.repeat(32), identifierSecret: 'i'.repeat(32), workers: false, fetch: async () => Response.json({}),
    stages: { call: {}, inquiry: { value: 10, currency: 'USD', wait: 48 }, client: { value: 400, currency: 'USD' } },
    phones: { numbers: { [LINE]: { source: 'listing', medium: 'map', campaign: 'Map listing' } }, resultsExpectedWithinMinutes: 30, returnHours: 24 },
    monitor: { quietHours: { calls: 12 } }, targets: { answered: 0.5, returned: 0.25, callbackHours: 2 }, ...more,
  } as LocalOptions)
  const edge = createEdge(graph, { token: 'service', reviewers: { dana: 'dana-token' }, origins: [SITE], events: ['phone_click'], limit: false })
  const server = createServer(edge).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let keys = 0
  async function record(entry: Record<string, unknown>): Promise<any> {
    const { results: [result] } = await graph.record({ entries: [{ key: `k-${++keys}`, at: clock, ...entry } as unknown as RecordEntry] })
    assert.ok(result!.ok, `${entry.type}: ${JSON.stringify(result)}`)
    return (result as { value: unknown }).value
  }
  const call = (key: string, n: number, more: object = {}) => record({ type: 'call', key, direction: 'inbound', from: from(n), to: LINE, ...more })
  const missed = { answered: false, waited: 95 }
  // Answered, long ago, so there is a first call of hers before the one she is missed on.
  at(-80); await call('ada-0', 11, { duration: 120, result: { answered: true, waited: 12 }, tags: { language: 'es' } })
  // Ada comes from an ad, taps, hangs up in the queue, is tried once, and is reached four hours and twenty minutes after.
  at(-72)
  await record({ type: 'arrival', subject: 'visitor:v1', source: 'google', medium: 'cpc', campaign: 'North | Family law | Search', campaignId: '20111', adGroupId: 'g-7', term: 'family lawyer', landing: `${SITE}/es`, referrer: 'https://search.example.org/?q=x', clicks: { gclid: 'click-1' }, custom: { lang: 'es' } })
  at(-72 + 1 / 60)
  const tapped = await fetch(`${base}/collect`, { method: 'POST', headers: { origin: SITE, 'user-agent': 'Mozilla/5.0 (a visitor)' }, body: JSON.stringify({ kind: 'event', device: 'v1', event: 'phone_click', number: LINE }) })
  assert.ok(tapped.ok)
  at(-72 + 2 / 60); await call('ada-1', 11, { duration: 95, tags: { language: 'es' } })
  at(-72 + 4 / 60); await record({ type: 'call_update', call: 'ada-1', change: { kind: 'result', result: missed } })
  at(-70); await record({ type: 'call', key: 'ada-2', direction: 'outbound', from: LINE, to: from(11), duration: 20, result: { answered: false } })
  at(-72 + 2 / 60 + 4 + 20 / 60); await record({ type: 'call', key: 'ada-3', direction: 'outbound', from: LINE, to: from(11), duration: 410, result: { answered: true } })
  at(-67); await record({ type: 'profile', subject: 'contact:ada', facts: { phone: from(11), device: 'v1', name: { first: 'Ada', last: 'Vale' } }, event: 'inquiry' })
  await graph.decide({ key: 'merge-1', at: clock, by: 'system:desk', action: 'merge', pairs: [{ a: 'contact:ada', b: caller(11), reason: 'answered by staff' }, { a: 'contact:ada', b: 'visitor:v1', reason: 'their browser' }] })
  await record({ type: 'conversion', key: 'ada-inquiry', subject: 'contact:ada', stage: 'inquiry', tags: { language: 'es' } })
  at(-66.5); await record({ type: 'restatement', of: { type: 'conversion', key: 'ada-inquiry' }, change: { kind: 'correct', value: 25 } })
  await record({ type: 'consent', subject: 'contact:ada', consent: { adUserData: true, adPersonalization: false }, source: 'banner' })
  await record({ type: 'link', subject: 'contact:ada', url: `${SITE}/form`, purpose: 'form', expires: clock + 24 * HOUR })
  await record({ type: 'text', key: 'ada-text', direction: 'outbound', from: LINE, to: from(11) })
  // Voicemail, not returned. Missed with a number that was hidden. Missed, and reached as another system says.
  at(-50); await call('bea-1', 12, { duration: 40, result: { answered: false, voicemail: true, waited: 20 } })
  at(-30); await record({ type: 'call', key: 'hid-1', direction: 'inbound', to: LINE, duration: 15, result: { answered: false } })
  at(-28); await call('cal-1', 13, { duration: 30, result: { answered: false } })
  at(-27); await record({ type: 'call_update', call: 'cal-1', change: { kind: 'returned', reachedAt: clock } })
  // Answered, unknown, and waiting for its result. One more is spam.
  at(-20); await call('dee-1', 14, { duration: 300, result: { answered: true, waited: 12 } })
  at(-10); await call('eli-1', 15, { duration: 60 })
  at(-9); await call('spam-1', 16, { duration: 60, result: { answered: true } })
  await record({ type: 'restatement', of: { type: 'call', key: 'spam-1' }, change: { kind: 'not_lead', why: 'spam' } })
  at(-3); for (const n of [1, 2]) await record({ type: 'text', key: `flo-${n}`, at: clock + n * MINUTE, direction: 'inbound', from: from(17), to: LINE, tags: { language: 'es' } })
  at(-0.05); await call('gus-1', 18, { duration: 10 })
  at(0)
  return { graph, base, start, record, at, call, close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await edge.drain(); await graph.close() } }
}

const url = process.env.DATABASE_URL
export const STORES: Record<string, () => Promise<[Partial<LocalOptions>, () => Promise<unknown>]>> = {
  memory: async () => [{ memory: true } as Partial<LocalOptions>, async () => {}],
  ...(url && {
    async postgres() {
      const schema = `ag_detail_${process.pid}`
      const drop = async () => {
        const pool = new pg.Pool({ connectionString: url })
        await pool.query(`drop schema if exists ${schema} cascade`)
        await pool.end()
      }
      return [{ databaseUrl: url, schema, receiptSecrets: ['r'.repeat(32)] } as Partial<LocalOptions>, drop]
    },
  }),
}

/** A browser on the screen, signed in, and what a test does in it. */
export async function screen(base: string) {
  const browser = await browse(`${base}/review`)
  const { run, send } = browser
  await until('the page', () => run(`typeof load === 'function' && typeof palette !== 'undefined'`).catch(() => false))
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await run(`(() => { const t = document.getElementById('token'); t.value = 'dana-token'; t.dispatchEvent(new Event('change')) })()`)
  await until('the sign in', () => run(`me === 'dana' && opening === 0`))
  const go = async (hash: string) => {
    await run(`location.hash = ${JSON.stringify(hash)}; load()`)
    await until(hash, () => run(`opening === 0 && place().name === ${JSON.stringify(hash.split('/')[1])} && $('view').childElementCount > 0`))
    await pause(120)
    assert.equal(await run(`$('notice').textContent`), '')
  }
  const find = (key: string) => `document.querySelector('[data-key^=${JSON.stringify(`detail ${key}`)}]')`
  const middle = (node: string) => run(`(() => { const n = ${node}; n.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); const r = n.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`) as Promise<[number, number]>
  const mouse = (type: string, x: number, y: number) => send('Input.dispatchMouseEvent', { type, x, y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
  const click = async (node: string) => {
    const [x, y] = await middle(node)
    await mouse('mouseMoved', x, y)
    await mouse('mousePressed', x, y)
    await mouse('mouseReleased', x, y)
  }
  const key = async (name: string, shift = false) => {
    const code = { Enter: 13, ' ': 32, Escape: 27, Tab: 9, ArrowDown: 40 }[name]!
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0, ...(type === 'keyDown' && (name === 'Enter' ? { text: '\r' } : name === ' ' ? { text: ' ' } : {})) })
  }
  const shown = () => run(`$('card').matches(':popover-open')`) as Promise<boolean>
  const hinted = () => run(`$('hint').matches(':popover-open')`) as Promise<boolean>
  const focused = () => run(`document.activeElement.id || document.activeElement.dataset.key || document.activeElement.textContent`) as Promise<string>
  const settled = () => until('the card to fill', () => run(`$('card').matches(':popover-open') && !document.querySelector('#card .waiting-lines')`))
  /** What the open card says, by row. */
  const says = async (box = '#card') => Object.fromEntries((await run(`[...document.querySelectorAll('${box} .detail-rows > div')].map((row) => [row.firstChild.textContent, row.lastChild.textContent])`)) as [string, string][])
  const text = (selector: string) => run(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`) as Promise<string>
  const links = () => run(`[...document.querySelectorAll('#card .detail-links a')].map((a) => [a.textContent, a.getAttribute('href'), a.target, a.rel])`) as Promise<string[][]>
  const card = async (hash: string, name: string) => {
    if ((await run('location.hash')) !== hash) await go(hash)
    // The card that is open may lie over the next place.
    if (await shown()) await key('Escape')
    await click(find(name))
    await settled()
    return says()
  }
  return { ...browser, go, find, click, mouse, middle, key, shown, hinted, focused, settled, says, text, links, card }
}
export type Screen = Awaited<ReturnType<typeof screen>>
/** How a time is written in a card, by the browser that writes it. */
export const written = (page: Screen, at: number, exact = false) => page.run(`moment(${at}, ${exact})`) as Promise<string>

