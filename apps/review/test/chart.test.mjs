import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ticksOf } from '../app/views/report-words.js'
import { startFirm } from '../../../examples/firm/firm.ts'

test('the lines of the Journey chart fall on whole hours of the reviewer zone and name each day once', () => {
  const ticks = ticksOf(Date.UTC(2026, 10, 15, 23, 10), Date.UTC(2026, 10, 17, 0, 24), 'America/Chicago')
  assert.deepEqual(ticks.map(tick => [tick.text, tick.over]), [['6 PM', 'Sun, Nov 15'], ['12 AM', 'Mon, Nov 16'], ['6 AM', undefined], ['12 PM', undefined], ['6 PM', undefined]])
  assert.ok(ticks.every(tick => tick.part >= 0 && tick.part <= 1))
  // A longer span takes a longer step, so the lines stay few enough to read.
  const year = ticksOf(Date.UTC(2025, 0, 3), Date.UTC(2026, 1, 9), 'UTC')
  assert.ok(year.length > 0 && year.length <= 8, String(year.length))
  assert.ok(year.every(tick => tick.over === undefined && /^[A-Z][a-z]{2} \d{1,2}$/.test(tick.text)))
  // One moment is a chart too.
  assert.deepEqual(ticksOf(Date.UTC(2026, 0, 1, 12, 30), Date.UTC(2026, 0, 1, 12, 30)), [])
})

test('Journey has a lane for each kind of event, a mark for each on the chart, and the time of day on each row', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const get = async path => (await (await fetch(firm.graph + path, { headers: { cookie } })).text()).split('</main>')[0].replaceAll('<!-- -->', '')
  const board = await get('/board/90')
  const journey = /href="(\/journey\/caller[^"]+)"/.exec(board)?.[1]
  assert.ok(journey, 'a caller on the Board')
  const html = await get(journey)
  assert.match(html, /<h2 class="page-title"><svg class="mark-view"[^>]*>.*?<\/svg><bdi title="caller:[0-9a-f]+">caller:/)
  const lanes = [...html.matchAll(/<div class="name (\w+)"><svg class="glyph \1"/g)].map(([, kind]) => kind)
  assert.ok(lanes.includes('call'), lanes.join())
  const rows = [...html.matchAll(/<li class="timeline-entry"[^>]*><span class="num"><time[^>]*title="[^"]+ [A-Z]{2,5}"[^>]*>(\d{1,2}:\d{2} [AP]M)<\/time><\/span><span class="chip kind (\w+)"><svg class="glyph (\w+)"/g)]
  assert.ok(rows.length > 0, 'rows of the timeline')
  // Every kind in the timeline has its lane, and the chart has no more marks than the timeline has rows.
  assert.deepEqual([...new Set(rows.map(([, , kind]) => kind))].sort(), [...lanes].sort())
  const marks = [...html.matchAll(/<a class="mark (\w+)( missed)?" href="#[^"]+"/g)]
  assert.ok(marks.length > 0 && marks.length <= rows.length, marks.length + ' marks, ' + rows.length + ' rows')
  // The mark of a call nobody answered is the same on the chart and in the timeline.
  assert.equal(marks.some(([, kind, missed]) => kind === 'call' && missed), rows.some(([, , kind, look]) => kind === 'call' && look === 'missed'))
})

test('Matches has the queue beside the strongest pair, the two records side by side, the evidence and what joining would do', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const get = async path => (await (await fetch(firm.graph + path, { headers: { cookie } })).text()).split('</main>')[0].replaceAll('<!-- -->', '')
  const html = await get('/decide')
  const queue = [...html.matchAll(/<a class="queue-pair"( aria-current="true")? href="\/decide\?pair=([^"]+)"[^>]*><span class="queue-names"><span title="([^"]+)">[^<]+<\/span><span title="([^"]+)">/g)]
  assert.ok(queue.length > 1, 'pairs in the queue')
  assert.deepEqual(queue.map(([, current]) => Boolean(current)), queue.map((_, i) => i === 0), 'the first pair is the one open')
  const [, , , a, b] = queue[0]
  assert.match(html, new RegExp('<div class="versus-who">.*?<bdi>' + a + '</bdi>.*?<div class="versus-who">.*?<bdi>' + b + '</bdi>'))
  for (const name of ['Identifiers', 'Events', 'Active', 'Linked IDs', 'Separated from']) assert.ok(html.includes('<div class="versus-name" role="rowheader">' + name + '</div>'), name)
  assert.match(html, /<p class="pair-effect" role="status">(After joining: \d+ (person|people) \(.+ IDs?\)|Joining changes no groups\.)<\/p>/)
  assert.match(html, /<div class="pair-why"><p class="inbox-age">Evidence<\/p><div class="reason"><b>\w+<\/b> \d+% · \d+ IDs · /)
  assert.match(html, /<summary aria-keyshortcuts="j">Join<kbd>J<\/kbd><\/summary>/)
  // The second pair opens by its own address, and Skip from the last goes back to the first.
  const second = await get('/decide?pair=' + queue[1][2].replaceAll('&amp;', '&'))
  assert.match(second, new RegExp('<span class="meta">2 of ' + queue.length + '</span>'))
  const last = await get('/decide?pair=' + queue.at(-1)[2].replaceAll('&amp;', '&'))
  assert.match(last, new RegExp('<a class="button choice"[^>]* href="/decide\\?pair=' + queue[0][2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'))
  assert.match(last, /<a class="button choice"[^>]*aria-keyshortcuts="s"/)
})
