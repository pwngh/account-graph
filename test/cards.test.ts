import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LocalOptions } from '../src/index.ts'
import { internalsOf } from '../src/client/internals.ts'
import { recordCall } from '../tools/internals.ts'
import { LINE, caller, firm, from, screen } from './cards.ts'
import { chrome, pause, until, without } from './chrome.ts'

// What a card says and holds, against what changed while it was asked for: another card, another reviewer, a decision, a write.
const memory = { memory: true } as Partial<LocalOptions>
/** Holds the answers to the addresses that hold `part` until `release()`, and then answers them, or refuses them with 503. */
const holding = (part: string, refused = false) => `(() => {
  lately.clear()
  window.real ??= window.fetch
  window.fetch = async (...asked) => {
    if (!String(asked[0]).includes(${JSON.stringify(part)})) return window.real(...asked)
    await new Promise((done) => (window.release = done))
    return ${refused} ? new Response('{"error":"The database is away"}', { status: 503, headers: { 'content-type': 'application/json' } }) : window.real(...asked)
  }
})()`

test('an answer is drawn only in the card that asked for it, and only for whoever asked', { skip: without, timeout: 120_000 }, async (t) => {
  assert.ok(chrome, 'CI needs a browser')
  const made = await firm(memory)
  t.after(made.close)
  const page = await screen(made.base)
  t.after(page.close)
  const { run, key, find, text } = page
  const bea = `board.person ${caller(12)}`
  const only = async () => [await text('#card-title'), Object.keys(await page.says()), (await page.links()).map(([words]) => words)]

  // Asked for one, closed, and another opened: the answer of the first is not drawn in the second.
  await page.go('#/board/90')
  await run(holding('contact%3Aada'))
  await page.click(find('board.person contact:ada'))
  await key('Escape')
  await page.click(find(bea))
  await page.settled()
  const theirs = await only()
  await run(`window.release()`)
  await pause(300)
  assert.deepEqual(await only(), theirs)
  assert.equal(theirs[1]!.includes('Reached'), false)
  // Nor is it said not to be available in a card that asked for nothing.
  await key('Escape')
  await run(holding('contact%3Aada', true))
  await page.click(find('board.person contact:ada'))
  await key('Escape')
  await page.click(find('board.people'))
  await run(`window.release()`)
  await pause(300)
  assert.deepEqual([await text('#card-title'), await text('#card .detail-failed')], ['People', ''])
  await key('Escape')

  // Signed out while it is asked for, the card is put away with all it said, and the next reviewer is shown nothing of it.
  await run(holding('contact%3Aada'))
  await page.click(find('board.person contact:ada'))
  await page.settled().catch(() => {})
  await run(`$('leave').click()`)
  assert.deepEqual(await run(`[$('card').matches(':popover-open'), $('card-title').textContent, document.querySelector('#card .detail-worth').textContent, document.querySelector('#card .detail-body').textContent, lately.size, JSON.stringify(goals)]`), [false, '', '', '', 0, '{}'])
  await run(`(() => { const t = $('token'); t.value = 'service'; t.dispatchEvent(new Event('change')) })()`)
  await until('the service token', () => run(`me === null && opening === 0`))
  await page.go('#/board/90')
  await page.click(find(bea))
  await page.settled()
  const next = await only()
  await run(`window.release()`)
  await pause(300)
  assert.deepEqual(await only(), next)
  assert.equal(next[0], theirs[0])

  // The short card of the chart is put away too.
  await run(`window.fetch = window.real`)
  await key('Escape')
  await page.go('#/journey/contact%3Aada')
  const mark = `document.querySelectorAll('.chart .lane.visit .mark')[1]`
  const [x, y] = await page.middle(mark)
  await page.mouse('mouseMoved', 600, 20)
  await page.mouse('mouseMoved', x, y)
  await until('the short card', page.hinted)
  await run(`$('leave').click()`)
  assert.deepEqual([await page.hinted(), await text('#hint')], [false, ''])
})

test('what a card was told is let go of when anything is written, decided or a minute old', { skip: without, timeout: 120_000 }, async (t) => {
  const made = await firm(memory)
  t.after(made.close)
  const page = await screen(made.base)
  t.after(page.close)
  const { run, key, find } = page
  const ada = 'board.person contact:ada'
  // Written by another system while the card is open: the card says what the row says.
  assert.match((await page.card('#/board/90', ada))['Last call']!, /^Outbound, answered/)
  made.at(0.01)
  await made.call('ada-9', 11, { duration: 33, result: { answered: true } })
  await run(`look()`)
  await until('the call in the card', async () => (await page.says())['Last call']?.startsWith('Inbound, answered'))
  await key('Escape')
  // Decided here: the visit of someone deleted is in no card, within the minute too.
  assert.match((await page.card('#/board/90', ada))['First visit']!, /North \| Family law \| Search/)
  await key('Escape')
  await run(`api('POST', '/forget', { subjects: ['visitor:v1'], reason: 'asked to' })`)
  await run(`load()`)
  await until('the view again', () => run(`opening === 0`))
  assert.equal((await page.card('#/board/90', ada))['First visit'], undefined)
  await key('Escape')
  // Kept for a minute and no longer, by the clock and by a timer.
  assert.deepEqual(await run(`(async () => {
    lately.clear()
    const real = setTimeout
    let held
    window.setTimeout = (done, ms) => (ms === 60000 ? (held = done) : real(done, ms))
    const first = recent('/policy')
    window.setTimeout = real
    const again = recent('/policy') === first
    held()
    const dropped = !lately.has('/policy')
    const stamp = Date.now
    const kept = recent('/policy')
    Date.now = () => stamp() + 61000
    const later = recent('/policy') !== kept
    Date.now = stamp
    await Promise.all([first, kept])
    return [again, dropped, later]
  })()`), [true, true, true])
})

test('a card says only what is so: who can still be reached, who waits, and who reported it', { skip: without, timeout: 120_000 }, async (t) => {
  const made = await firm(memory)
  t.after(made.close)
  // Somebody missed who got through by calling again. A missed call said to be spam. A result that says how long they waited and nothing else.
  made.at(-6); await made.call('fay-1', 20, { duration: 9, result: { answered: false } })
  made.at(-5); await made.call('fay-2', 20, { duration: 90, result: { answered: true } })
  made.at(-4); await made.call('spam-2', 21, { duration: 9, result: { answered: false } })
  await made.record({ type: 'restatement', of: { type: 'call', key: 'spam-2' }, change: { kind: 'not_lead', why: 'spam' } })
  // A phone system may report the wait and leave the answer unknown, as a line that picks up does.
  const { engine } = await internalsOf(made.graph)!()
  await recordCall(engine.graph, { id: 'wo-1', from: from(22), to: LINE, at: made.at(-3), duration: 50, waited: 30 })
  made.at(0)
  const page = await screen(made.base)
  t.after(page.close)
  const { run, text } = page

  // Of five missed, two were returned, one is still open, one hid their number and one got through: two of three who could be called back, and one more would meet it.
  await page.go('#/calls')
  await run(`goals = { answered: 0.0001, returned: 1 }; load()`)
  await until('the view again', () => run(`opening === 0`))
  const returned = await page.card('#/calls', 'calls.returned')
  assert.deepEqual([returned.Returned, returned['Called again'], returned['Still open'], returned['Number withheld']], ['2', '1', '1', '1'])
  assert.match(await text('#card .detail-say'), /^Target 100% of those who could be called back, set by you\. Not met: 2 of 3 were returned, and 1 more would reach it\./)
  // A share that is more than nothing is not said to be none.
  await page.card('#/calls', 'calls.answered')
  assert.match(await text('#card .detail-say'), /^Target 0\.01%, set by you\. Met\./)
  // The hours of the report are in its zone, and a moment of a call names the browser's.
  const inbound = await page.card('#/calls', 'calls.inbound')
  assert.equal(inbound['Hours are in'], 'UTC')
  assert.match((await page.card('#/journey/' + encodeURIComponent(caller(22)), 'call wo-1 timeline')).Called!, /:00 [A-Z]{2,5}|GMT/)

  // Said to be spam, a missed call waits for nobody.
  const spam = await page.card('#/journey/' + encodeURIComponent(caller(21)), 'call spam-2 timeline')
  assert.deepEqual([await text('#card-title'), await text('#card .detail-worth'), spam.Returned, spam['Time limit'], spam['Attempts so far']], ['Missed call', 'Inbound · Spam', undefined, undefined, undefined])
  assert.doesNotMatch(await text('#card .detail-say'), /Returned/)
  assert.doesNotMatch(await run(`[...document.querySelectorAll('.timeline-entry .what')].find((each) => each.textContent.includes('Spam')).textContent`), /Not returned/)
  // A result that does not say whether anybody answered is said to be one.
  const told = await page.card('#/journey/' + encodeURIComponent(caller(22)), 'call wo-1 timeline')
  assert.deepEqual([told['How we know'], told['Duration · wait']], ['Reported, but not whether anybody answered', '50 s · 30 s'])
  // Answered is whatever was reported, by the phone system or by staff.
  await page.card('#/journey/' + encodeURIComponent(caller(14)), 'call dee-1 timeline')
  assert.match(await text('#card .detail-say'), /^Answered means your phone system or staff reported that a person spoke to them\.$/)
  // Without ALERT_WEBHOOK nothing is posted, and the card does not say it is.
  await page.card('#/health', 'health.feed calls')
  assert.match(await text('#card .detail-say'), /Past the limit it is marked stale\. ALERT_WEBHOOK is not set, so nothing is posted\./)
  // A limit may be the one there is by default, so it is not said to be set by anybody.
  await page.card('#/board/90', `board.person ${caller(12)}`)
  assert.equal(await text('#card .detail-say'), 'Overdue means longer here than the limit for a call back.')
  // Counted while you were open is a count, and not a part anybody can change.
  assert.deepEqual(await run(`DETAILS['calls.missed'].now({ summary: { total: { calls: 3, missed: 2, voicemail: 0 }, closed: { missed: 1, voicemail: 0 }, cells: [] } }).say.at(-1)`), ['In open hours', ' counts those who called while you were open.'])
})
