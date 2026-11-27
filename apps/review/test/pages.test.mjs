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

test('Health has what runs and what needs someone: the tiles, a card for each feed, what waits to be sent, the matching rules and the audit hash', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const html = (await (await fetch(firm.graph + '/health', { headers: { cookie } })).text()).split('</main>')[0].replaceAll('<!-- -->', '')
  const ops = await (await fetch(firm.graph + '/review/api/ops', { headers: { authorization: 'Bearer demo' } })).json()
  assert.deepEqual([...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map(([, name]) => name).slice(0, 6), ['Issues', 'Audit log', 'Policy', 'Queued', 'Sent', 'Alerts'])
  // Each feed has its state and a card that says when its last record came and what watches it.
  const feeds = [...html.matchAll(/<li><span class="tile"[^>]*>.*?<\/span><b>([^<]+)<\/b><span class="state"><span class="chip same">OK<\/span><button type="button" class="detail"[^>]*aria-label="([^"]+)"/g)]
  assert.deepEqual(feeds.map(([, name, label]) => [name, label]), ops.feeds.map(feed => [{ touches: 'Visits', calls: 'Calls', results: 'Call results', costs: 'Campaign costs' }[feed.name], { touches: 'Visits', calls: 'Calls', results: 'Call results', costs: 'Campaign costs' }[feed.name] + ', OK']))
  assert.match(html, /<dt>Last record<\/dt><dd>[^<]+<\/dd>.*?<dt>Set by<\/dt><dd>QUIET_TOUCHES_HOURS<\/dd>/)
  // What waits to be sent is the graph's own count, part by part.
  for (const [name, n] of [['Sent', ops.outbox.sent], ['Queued', ops.outbox.pending], ['Held', ops.outbox.held], ['Skipped', ops.outbox.skipped], ['Rejected', ops.outbox.failed]]) assert.ok(html.includes('<span>' + name + '</span> <b>' + n + '</b>'), name + ' ' + n)
  assert.match(html, /<tr class="day"><th scope="rowgroup" colSpan="7">Meets join threshold<\/th><\/tr><tr><td>review<\/td><td class="num edge">1\.00<\/td>/)
  assert.match(html, /<input readOnly="" size="66" aria-label="Verification hash" value="[0-9a-f]{64}"\/>|<input[^>]*aria-label="Verification hash"[^>]*value="[0-9a-f]{64}"/)
  // Retry of a conversion that is not rejected changes nothing, and says so to a page with scripts.
  const retry = fields => fetch(firm.graph + '/health', { method: 'POST', headers: { cookie, origin: firm.graph }, body: new URLSearchParams({ intent: 'retry', transactionId: 'no-such-conversion', target: 'google', ...fields }), redirect: 'manual' })
  const plain = await retry({})
  assert.equal(plain.status, 303)
  assert.equal(plain.headers.get('location'), '/health')
  assert.equal((await retry({ transactionId: '' })).status, 400)
  const guest = await fetch(firm.graph + '/health', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ intent: 'retry', transactionId: 'x', target: 'google' }), redirect: 'manual' })
  assert.ok([302, 303].includes(guest.status) && /signin/.test(guest.headers.get('location')), 'a retry without a session goes to sign-in')
})

test('Channels has what each campaign cost and brought in, ranked and in a table that agrees with the report, and gives the same as a CSV file', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const get = async path => (await (await fetch(firm.graph + path, { headers: { cookie } })).text()).split('</main>')[0].replaceAll('<!-- -->', '')
  const report = await (await fetch(firm.graph + '/review/api/report', { headers: { authorization: 'Bearer demo' } })).json()
  const usd = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
  const html = await get('/channels')
  assert.deepEqual([...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map(([, name]) => name).slice(0, 5), ['Spend', 'Value', 'People', 'Cost per outcome', 'ROAS'])
  assert.ok(html.includes('<b>' + usd(report.total.cost) + '</b>'), 'the spend of the report')
  assert.ok(html.includes('<b>' + usd(report.total.value) + '</b>'), 'the value of the report')
  // Each campaign has a line with its own spend, people and value, and the total is the report's.
  const priced = report.rows.filter(row => row.source !== '(none)')
  assert.ok(priced.length > 1, 'campaigns in the seeded firm')
  for (const row of priced) assert.match(html, new RegExp('<span class="ranked-what" title="' + row.campaign.replace(/[|]/g, '\\|') + '">.*?</span>.*?<td class="num edge">' + usd(row.cost).replace('$', '\\$')), row.campaign)
  assert.match(html, new RegExp('<tr class="sum"><td>Total</td>.*?<td class="num edge">' + usd(report.total.cost).replace('$', '\\$')))
  // The comparison ranks by value first, and by another measure when the address asks.
  const ranked = page => [...page.split('<ol class="ranked">')[1].split('</ol>')[0].matchAll(/<span class="ranked-what">([^<]+)<\/span>/g)].map(([, name]) => name.replaceAll('&amp;', '&'))
  assert.deepEqual(ranked(html), [...priced].sort((x, y) => y.value - x.value).filter(row => row.value > 0).map(row => row.campaign))
  assert.deepEqual(ranked(await get('/channels?rank=Visits')), [...priced].sort((x, y) => y.visits - x.visits).filter(row => row.visits > 0).map(row => row.campaign))
  // A breakdown adds lines under a campaign and leaves its own numbers whole.
  const by = report.dimensions.find(name => name.startsWith('outcome.'))
  const split = await get('/channels?by=' + encodeURIComponent(by))
  assert.match(split, /<tr class="part"><td><\/td><td class="who">/)
  assert.ok(split.includes('<td class="num edge">' + usd(report.total.cost)), 'the total with a breakdown')
  // What followed calls is asked for once a step is chosen.
  assert.doesNotMatch(html, /within \d+ days of the call/)
  assert.match(await get('/channels?step=' + report.steps[0] + '&days=14'), new RegExp(report.steps[0] + ' within 14 days of the call'))
  // The file has one line a campaign and the total, and a cell a spreadsheet would run is given as text.
  const file = await fetch(firm.graph + '/channels/csv', { headers: { cookie } })
  assert.equal(file.headers.get('content-type'), 'text/csv; charset=utf-8')
  assert.equal(file.headers.get('content-disposition'), `attachment; filename="channels-${report.from}-${report.to}.csv"`)
  const lines = (await file.text()).trimEnd().split('\r\n')
  assert.equal(lines.length, report.rows.length + 2)
  assert.match(lines[0], /^Source,Campaign,Campaign ID,Spend,Clicks,Visits,.*People,Missed calls,Value,Cost per outcome,ROAS,Days without cost data$/)
  assert.ok(lines.at(-1).startsWith('Total,,,' + report.total.cost + ',' + report.total.clicks + ',' + report.total.visits + ','), lines.at(-1))
  const guest = await fetch(firm.graph + '/channels/csv', { redirect: 'manual' })
  assert.ok([302, 303].includes(guest.status) && /signin/.test(guest.headers.get('location')), 'the file is for a signed-in reviewer')
})
