import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linkedBy, seenAs, ticksOf, tieWords } from '../app/views/report-words.js'
import { csvCell } from '../app/csv.ts'
import { startFirm } from '../../../examples/firm/firm.ts'
import { readFileSync } from 'node:fs'

test('why two records are linked is said in words, and a code that has none is shown as it is', () => {
  assert.deepEqual(['email:abc', 'review:join-3', 'dial:CA77', 'passkey:k1'].map(linkedBy), ['Same email address', 'Joined by staff', 'Tapped the number on the site just before the call', 'passkey'])
  assert.deepEqual(['called:abc', 'phone:abc', 'passkey:k1'].map(seenAs), ['Name on the record', 'Phone number', 'passkey:k1'])
  // Under a name on a Journey the reasons are part of one line, so each begins small.
  assert.equal(tieWords({ how: 'linked', score: 0.98, via: [], kinds: ['dial', 'device', 'passkey'] }, 'contact:1'), 'High confidence · 98% · tapped the number on the site just before the call, same browser or app, passkey')
})

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
  // The heading says who it is by name or number. Its title is the exact ID.
  assert.match(html, /<h2 class="page-title"><svg class="mark-view"[^>]*>.*?<\/svg><bdi title="caller:[0-9a-f]+">[^<]+<\/bdi>/)
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
  // Each side is shown by name or number. Its link's title begins with the exact ID.
  assert.match(html, new RegExp('<div class="versus-who">.*?title="' + a + '[" ].*?<div class="versus-who">.*?title="' + b + '[" ]'))
  for (const name of ['Identifiers', 'Events', 'Active', 'Linked IDs', 'Separated from']) assert.ok(html.includes('<div class="versus-name" role="rowheader">' + name + '</div>'), name)
  assert.match(html, /<p class="pair-effect" role="status">(After joining: \d+ (person|people) \(.+ IDs?\)|Joining changes no groups\.)<\/p>/)
  assert.match(html, /<div class="pair-why"><p class="inbox-age"><span class="term">Evidence<button[^]*?<\/p><div class="reason"><b title="\w+">[A-Z][a-z][^<]+<\/b> \d+% · \d+ IDs · /)
  assert.match(html, /<summary aria-keyshortcuts="j">Join<kbd>J<\/kbd><\/summary>/)
  // The page holds the identifiers of the open pair, for Ignore, and of no other pair.
  const whole = await (await fetch(firm.graph + '/decide', { headers: { cookie } })).text()
  const found = await (await fetch(firm.graph + '/review/api/undecided', { headers: { authorization: 'Bearer demo' } })).json()
  const mine = found.pairs[0].reasons.map(reason => reason.identifier)
  const theirs = found.pairs.slice(1).flatMap(pair => pair.reasons.map(reason => reason.identifier)).filter(identifier => !mine.includes(identifier))
  assert.ok(mine.length > 0 && theirs.length > 0, 'identifiers in the seeded queue')
  assert.ok(mine.every(identifier => whole.includes(identifier)), 'the open pair has its identifiers')
  assert.deepEqual(theirs.filter(identifier => whole.includes(identifier)), [], 'no identifier of a pair that is not open')
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
  assert.deepEqual([...html.matchAll(/<dt><span class="term">([^<]+)<button/g)].map(([, name]) => name).slice(0, 6), ['Issues', 'Audit log', 'Policy', 'Queued', 'Sent', 'Alerts'])
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
  assert.deepEqual([...html.matchAll(/<dt><span class="term">([^<]+)<button/g)].map(([, name]) => name).slice(0, 5), ['Spend', 'Value', 'People', 'Cost per outcome', 'ROAS'])
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
  // With a breakdown the file has the lines the table has, each named, and no spend on a line of a breakdown.
  const parted = await (await fetch(firm.graph + '/review/api/report?by=' + encodeURIComponent(by), { headers: { authorization: 'Bearer demo' } })).json()
  const parts = [...parted.rows, parted.total].reduce((sum, row) => sum + (row.breakdown ?? []).length, 0)
  assert.ok(parts > 0, 'a breakdown in the seeded firm')
  const broken = (await (await fetch(firm.graph + '/channels/csv?by=' + encodeURIComponent(by), { headers: { cookie } })).text()).trimEnd().split('\r\n')
  assert.match(broken[0], /^Source,Campaign,Campaign ID,Breakdown,Spend,/)
  assert.equal(broken.length, parted.rows.length + 2 + parts)
  assert.ok(broken.slice(1).some(line => /^[^,]+,[^,]*,[^,]*,[^,]+,,,,/.test(line)), 'a line of a breakdown, with no spend, clicks or visits')
  // Days are both given or neither, each on the calendar, and in order. Other days than those asked for are never reported.
  for (const query of ['from=2026-09-01', 'to=2026-09-30', 'from=2026-02-31&to=2026-03-05', 'from=2026-09-30&to=2026-09-01', 'from=yesterday&to=today']) {
    for (const path of ['/channels?', '/channels/csv?']) assert.equal((await fetch(firm.graph + path + query, { headers: { cookie } })).status, 400, path + query)
  }
  assert.equal((await fetch(firm.graph + '/channels?from=' + report.from + '&to=' + report.to, { headers: { cookie } })).status, 200)
})

test('a cell of a CSV file that a spreadsheet would run is text, even behind spaces, and a number keeps its sign', () => {
  assert.equal(csvCell('=1+1'), "'=1+1")
  assert.equal(csvCell('  +cmd'), "'  +cmd")
  assert.equal(csvCell('\n=1+1'), '"\'\n=1+1"')
  assert.equal(csvCell('\t@sum'), "'\t@sum")
  assert.equal(csvCell('-5'), "'-5")
  assert.equal(csvCell(-5), '-5')
  assert.equal(csvCell('North | Family law, "Search"'), '"North | Family law, ""Search"""')
  assert.equal(csvCell(null), '')
  assert.equal(csvCell('google'), 'google')
})

test('a reviewer takes a missed caller off the waiting list from Calls: reached, or not a lead, under their own name', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const { at } = await (await fetch(firm.graph + '/review/api/board?days=90', { headers: { authorization: 'Bearer demo' } })).json()
  const day = at => new Date(at).toISOString().slice(0, 10)
  const missed = (key, from) => ({ type: 'call', key, at: at - 3 * 3600_000, direction: 'inbound', from, to: '+15550100102', duration: 20, result: { answered: false, waited: 20 } })
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({ entries: [missed('waits-1', '+15550100061'), missed('waits-2', '+15550100062')] }) })
  assert.ok((await written.json()).results.every(result => result.ok))
  const calls = '/calls?from=' + day(at - 86400_000) + '&to=' + day(at)
  const page = async (path = calls) => (await (await fetch(firm.graph + path, { headers: { cookie } })).text()).replaceAll('<!-- -->', '')
  const waiting = async () => (await (await fetch(firm.graph + '/review/api/calls?from=' + day(at - 86400_000) + '&to=' + day(at), { headers: { authorization: 'Bearer demo' } })).json()).calls.map(call => call.id)
  assert.deepEqual((await waiting()).filter(id => id.startsWith('waits-')).sort(), ['waits-1', 'waits-2'])
  // The open call has both forms, each with the call and a key of its own load.
  const open = async () => {
    const html = await page()
    const forms = [...html.matchAll(/<input type="hidden" name="intent" value="(reached|not_lead)"\/><input type="hidden" name="call" value="([^"]+)"\/><input type="hidden" name="key" value="([0-9a-f-]{36})"\/><input type="hidden" name="at" value="(\d+)"\/>/g)].map(([, intent, call, key, at]) => ({ intent, call, key, at }))
    assert.deepEqual(forms.map(form => form.intent), ['reached', 'not_lead'])
    assert.equal(forms[0].call, forms[1].call)
    return forms
  }
  const post = (fields, headers = { cookie, origin: firm.graph }) => fetch(firm.graph + calls, { method: 'POST', headers, body: new URLSearchParams(fields), redirect: 'manual' })
  // Reached: the call leaves the list, and posting the same form again changes nothing more.
  const [reached] = await open()
  assert.ok(reached.call.startsWith('waits-'), reached.call)
  for (let twice = 0; twice < 2; twice++) {
    const answer = await post(reached)
    assert.equal(answer.status, 303)
    assert.equal(answer.headers.get('location'), calls)
  }
  const left = (await waiting()).filter(id => id.startsWith('waits-'))
  assert.deepEqual(left, [reached.call === 'waits-1' ? 'waits-2' : 'waits-1'])
  // Not a lead: the other leaves too, and Call results counts it as one.
  const [, spam] = await open()
  assert.equal(spam.call, left[0])
  assert.equal((await post({ ...spam, why: 'spam' })).status, 303)
  assert.deepEqual((await waiting()).filter(id => id.startsWith('waits-')), [])
  assert.match(await page(), /<span class="chip ">Not a lead<\/span><\/th><td class="num">1</)
  // A page with scripts is told what was recorded, and nothing is taken without a session, an origin or a call.
  const [again] = await open().catch(() => [undefined])
  if (again) assert.match(await (await post({ ...again, _enhanced: '1' })).text(), /Recorded: the caller was reached/)
  assert.equal((await post({ ...reached, call: '' })).status, 400)
  assert.equal((await post({ ...reached, intent: 'answered' })).status, 400)
  assert.equal((await post({ ...reached, at: String(Number(reached.at) - 2 * 86400_000), key: reached.key + 'old' })).status, 400, 'a form from a page read two days ago')
  assert.equal((await post({ ...reached, at: String(Number(reached.at) + 3600_000), key: reached.key + 'later' })).status, 400, 'a time that has not come')
  const guest = await post(reached, { origin: firm.graph })
  assert.ok([302, 303].includes(guest.status) && /signin/.test(guest.headers.get('location')))
  assert.equal((await post(reached, { cookie, origin: 'https://elsewhere.example' })).status, 403)
})

test('a Board card for a caller who waits has the same two forms, and one page read can say it of two callers', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const board = async () => (await fetch(firm.graph + '/review/api/board?days=90', { headers: { authorization: 'Bearer demo' } })).json()
  const { at } = await board()
  const missed = (key, from, hours) => ({ type: 'call', key, at: at - hours * 3600_000, direction: 'inbound', from, to: '+15550100102', duration: 20, result: { answered: false, waited: 20 } })
  // Three callers wait. The second called twice, and what is said of them is said of the older call.
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({ entries: [missed('waits-1', '+15550100061', 3), missed('waits-2', '+15550100062', 5), missed('waits-2-again', '+15550100062', 2), missed('waits-3', '+15550100063', 4)] }) })
  const subjects = (await written.json()).results.map(result => result.ok && result.value.subject)
  assert.ok(subjects.every(Boolean))
  const waits = async () => (await board()).columns[0].rows.map(row => row.missed).filter(id => id?.startsWith('waits-')).sort()
  // What a service writes is on the Board within moments. What a reviewer says is there at once, as the end of this test finds.
  for (let tries = 0; tries < 50 && (await waits()).length < 3; tries++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(await waits(), ['waits-1', 'waits-2', 'waits-3'])
  // Only a card in Missed calls has the forms. Each is in a popover its own button opens, so it shows with no script, and it is named by the call it is about.
  const html = (await (await fetch(firm.graph + '/board/90', { headers: { cookie } })).text()).replaceAll('<!-- -->', '')
  const cards = [...html.matchAll(/<li><div class="top"><a\b[^>]*\btitle="([^"]+)"[\s\S]*?<\/li>/g)].filter(match => match[0].includes('class="board-acts"'))
  assert.equal(cards.length, (await board()).columns[0].rows.length)
  const ids = new Set()
  const formsOf = Object.fromEntries(cards.map(([card, subject]) => {
    const found = [...card.matchAll(/<button type="button" class="say" popoverTarget="([^"]+)">([^<]+)<\/button><div class="card-pop say-pop" popover="auto" id="([^"]+)" role="dialog" aria-labelledby="([^"]+)"><div class="detail-head"><h4 id="([^"]+)">Missed call, <time dateTime="([^"]+)"[^>]*>[^<]+<\/time><\/h4><button type="button" class="detail-shut" popoverTarget="([^"]+)" popoverTargetAction="hide" aria-label="Close">×<\/button><\/div><form\b[^>]*\baction="\/board\/90"[^>]*\bmethod="post"[^>]*><input type="hidden" name="intent" value="(reached|not_lead)"\/><input type="hidden" name="call" value="([^"]+)"\/><input type="hidden" name="key" value="([0-9a-f-]{36})"\/><input type="hidden" name="at" value="(\d+)"\/>/gi)]
      .map(([, opens, label, id, labelled, heading, time, shuts, intent, call, key, at]) => ({ opens, label, id, labelled, heading, time, shuts, intent, call, key, at }))
    assert.deepEqual(found.map(form => [form.label, form.intent, form.opens === form.id && form.shuts === form.id && form.labelled === form.heading]), [['Reached them', 'reached', true], ['Not a lead', 'not_lead', true]], subject)
    assert.equal(found[0].call, found[1].call, 'both forms of a card are of one call')
    for (const form of found) ids.add(form.id).add(form.heading)
    // The link's title is the ID, then how the person is shown.
    return [subject.split(' ')[0], found]
  }))
  assert.equal(ids.size, cards.length * 4, 'every popover and heading has an ID of its own')
  const [one, twice, third] = subjects.filter((subject, i) => i !== 2).map(subject => formsOf[subject])
  assert.deepEqual([one[0].call, twice[0].call, third[0].call], ['waits-1', 'waits-2', 'waits-3'])
  assert.equal(twice[0].time, new Date(at - 5 * 3600_000).toISOString(), 'the form names the older call by its time')
  assert.ok(one[0].key === twice[0].key && one[0].key === third[0].key, 'the cards are of one page read')
  const post = fields => fetch(firm.graph + '/board/90', { method: 'POST', headers: { cookie, origin: firm.graph }, body: new URLSearchParams(fields), redirect: 'manual' })
  const strip = ({ intent, call, key, at }) => ({ intent, call, key, at })
  // Reached, of two callers from one page read, and the first of them sent twice. The older call was returned, so the newer one no longer waits either.
  for (const form of [one[0], twice[0], one[0]]) {
    const answer = await post(strip(form))
    assert.equal(answer.status, 303)
    assert.equal(answer.headers.get('location'), '/board/90')
  }
  assert.deepEqual(await waits(), ['waits-3'])
  // Not a lead, from the third card. A page with scripts is told what was recorded, to show above the columns.
  assert.match(await (await post({ ...strip(third[1]), why: 'spam', _enhanced: '1' })).text(), /Recorded: not a lead/)
  assert.deepEqual(await waits(), [])
})

test('what a reviewer said of a call is taken back from the call in the caller\'s history', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const { at } = await (await fetch(firm.graph + '/review/api/board?days=90', { headers: { authorization: 'Bearer demo' } })).json()
  const day = at => new Date(at).toISOString().slice(0, 10)
  const hours = n => at - n * 3600_000
  const call = (key, from, to, when, direction, answered) => ({ type: 'call', key, at: when, direction, from, to, duration: answered ? 60 : 20, result: { answered } })
  // One caller missed twice. Another missed once, and the phone system saw the call that returned them.
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({ entries: [
    call('waits-1', '+15550100061', '+15550100102', hours(5), 'inbound', false), call('waits-1-again', '+15550100061', '+15550100102', hours(2), 'inbound', false),
    call('rung-1', '+15550100062', '+15550100102', hours(4), 'inbound', false), call('rung-back', '+15550100102', '+15550100062', hours(3), 'outbound', true)] }) })
  const results = (await written.json()).results
  assert.ok(results.every(result => result.ok), JSON.stringify(results))
  const [subject, , other] = results.map(result => result.value.subject)
  const journey = '/journey/' + encodeURIComponent(subject)
  const calls = '/calls?from=' + day(at - 86400_000) + '&to=' + day(at)
  const waits = async () => (await (await fetch(firm.graph + '/review/api' + calls, { headers: { authorization: 'Bearer demo' } })).json()).calls.map(call => call.id).filter(id => /^(waits|rung)-/.test(id)).sort()
  const post = (path, fields) => fetch(firm.graph + path, { method: 'POST', headers: { cookie, origin: firm.graph }, body: new URLSearchParams(fields), redirect: 'manual' })
  const page = async path => (await (await fetch(firm.graph + path, { headers: { cookie } })).text()).replaceAll('<!-- -->', '').replaceAll('&amp;', '&')
  // The forms in a history, each named by its call and opened by a button of its own.
  const forms = async (path = journey) => [...(await page(path)).matchAll(/<button type="button" class="say" popoverTarget="([^"]+)">Take back<\/button><div class="card-pop say-pop" popover="auto" id="([^"]+)" role="dialog" aria-labelledby="[^"]+"><div class="detail-head"><h4 id="[^"]+">Call, <time dateTime="([^"]+)"[^>]*>[^<]+<\/time><\/h4>[\s\S]*?<form\b[^>]*\baction="([^"]+)"[^>]*\bmethod="post"[^>]*><input type="hidden" name="intent" value="([a-z_]+)"\/><input type="hidden" name="call" value="([^"]+)"\/><input type="hidden" name="key" value="([0-9a-f-]{36})"\/><input type="hidden" name="at" value="(\d+)"\/>/g)]
    .map(([, opens, id, time, action, intent, call, key, at]) => ({ opens, id, time, action, fields: { intent, call, key, at } }))
  // Nothing is said of the first caller yet, and nobody stated the second caller's return, so neither history has anything to take back.
  assert.deepEqual([await waits(), await forms(), await forms('/journey/' + encodeURIComponent(other))], [['waits-1', 'waits-1-again'], [], []])

  // Reached, said as on Calls, between their two calls. The first call is returned and the second still waits.
  const said = { call: 'waits-1', key: crypto.randomUUID(), at: String(hours(3)) }
  assert.equal((await post('/calls', { ...said, intent: 'reached' })).status, 303)
  assert.deepEqual(await waits(), ['waits-1-again'])
  const [reached, ...more] = await forms()
  assert.deepEqual([more, reached.opens === reached.id, reached.action, reached.time, reached.fields.intent, reached.fields.call], [[], true, journey, new Date(hours(5)).toISOString(), 'not_reached', 'waits-1'])
  // The history beside their open call on Calls has the same form, and it posts to Calls.
  const list = await page(calls)
  const open = list.match(new RegExp('<a\\b[^>]*\\bhref="(/calls\\?[^"]+)#call-history"[^>]*\\btitle="' + subject + '[ "]'))?.[1] ?? list.match(new RegExp('<a\\b[^>]*\\btitle="' + subject + '[ "][^>]*\\bhref="(/calls\\?[^"]+)#call-history"'))?.[1]
  assert.ok(open, 'the caller who still waits is in the list')
  const [beside, ...rest] = await forms(open)
  assert.deepEqual([rest, beside.action, beside.fields.intent, beside.fields.call], [[], open, 'not_reached', 'waits-1'])

  // Somebody else takes it back and says it again, after this page was read. This page's form is older than what stands, and says so the first time it is sent.
  const later = n => ({ call: 'waits-1', key: crypto.randomUUID(), at: String(Number(reached.fields.at) + n) })
  assert.equal((await post('/calls', { ...later(1), intent: 'not_reached' })).status, 303)
  assert.deepEqual(await waits(), ['waits-1', 'waits-1-again'])
  assert.equal((await post('/calls', { ...later(2), intent: 'reached' })).status, 303)
  assert.deepEqual(await waits(), [])
  const stale = await post(journey, { ...reached.fields, _enhanced: '1' })
  assert.equal(stale.status, 409)
  assert.match(await stale.text(), /Something newer was said of this call/)
  assert.deepEqual(await waits(), [])
  // That report covers both calls. Only the call it was said of has the form, and sending it twice is one statement.
  // A page read from here on is later than every time this test made up.
  await new Promise(resolve => setTimeout(resolve, 10))
  const [again, ...none] = await forms()
  assert.deepEqual([none, again.time, again.fields.call], [[], new Date(hours(5)).toISOString(), 'waits-1'])
  for (let twice = 0; twice < 2; twice++) {
    const back = await post(journey, again.fields)
    assert.deepEqual([back.status, back.headers.get('location')], [303, journey])
  }
  assert.deepEqual([await waits(), await forms()], [['waits-1', 'waits-1-again'], []])

  // Not a lead, and a lead again.
  assert.equal((await post('/calls', { call: 'waits-1', key: crypto.randomUUID(), at: again.fields.at, intent: 'not_lead' })).status, 303)
  assert.deepEqual(await waits(), ['waits-1-again'])
  await new Promise(resolve => setTimeout(resolve, 10))
  const [lead, ...others] = await forms()
  assert.deepEqual([others, lead.fields.intent, lead.fields.call], [[], 'lead', 'waits-1'])
  assert.match(await (await post(journey, { ...lead.fields, _enhanced: '1' })).text(), /Recorded: the call is a lead again/)
  assert.deepEqual([await waits(), await forms()], [['waits-1', 'waits-1-again'], []])
})

test('the history of a caller names the reviewer who reported them reached', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const { at } = await (await fetch(firm.graph + '/review/api/board?days=90', { headers: { authorization: 'Bearer demo' } })).json()
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({ entries: [{ type: 'call', key: 'waits-1', at: at - 3 * 3600_000, direction: 'inbound', from: '+15550100061', to: '+15550100102', duration: 20, result: { answered: false, waited: 20 } }] }) })
  const [{ value: { subject } }] = (await written.json()).results
  const history = async () => (await (await fetch(firm.graph + '/journey/' + encodeURIComponent(subject), { headers: { cookie } })).text()).replaceAll('<!-- -->', '')
  assert.match(await history(), /Not returned/)
  const said = await fetch(firm.graph + '/calls', { method: 'POST', headers: { cookie, origin: firm.graph }, body: new URLSearchParams({ intent: 'reached', call: 'waits-1', key: crypto.randomUUID(), at: String(at) }), redirect: 'manual' })
  assert.equal(said.status, 303)
  // The reviewer signed in as dana, so the row and the details of the wait both say so.
  const after = await history()
  assert.match(after, /Returned after 3 h \(reported by dana\)/)
  assert.match(after, /Reported by dana, with no call/)
})

test('a reviewer says which record a call was with, and the call moves to the history of that record', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const { at } = await (await fetch(firm.graph + '/review/api/board?days=90', { headers: { authorization: 'Bearer demo' } })).json()
  // A record with a phone number, and a call from that number. The call is in the history of the number, not of the record.
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({ entries: [
    { type: 'profile', key: 'with-profile', at: at - 5 * 3600_000, subject: 'contact:wren', facts: { phone: '+15550100071', name: { first: 'Wren', last: 'Vale' } } },
    { type: 'profile', key: 'with-other', at: at - 4 * 3600_000, subject: 'contact:rowan', facts: { phone: '+15550100071', name: { first: 'Rowan', last: 'Vale' } } },
    { type: 'call', key: 'with-1', at: at - 3 * 3600_000, direction: 'inbound', from: '+15550100071', to: '+15550100102', duration: 90, result: { answered: true } }] }) })
  const results = (await written.json()).results
  assert.ok(results.every(result => result.ok), JSON.stringify(results))
  const [ofRecord, ofOther, ofNumber] = ['contact:wren', 'contact:rowan', results[2].value.subject].map(id => '/journey/' + encodeURIComponent(id))
  const page = async path => (await (await fetch(firm.graph + path, { headers: { cookie } })).text()).replaceAll('<!-- -->', '')
  const post = (path, fields) => fetch(firm.graph + path, { method: 'POST', headers: { cookie, origin: firm.graph }, body: new URLSearchParams(fields), redirect: 'manual' })
  const stands = async () => (await (await fetch(firm.graph + '/v1/lookup', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'party', call: 'with-1' }) })).json())
  // The form on the call's row: its fields, the statement the page showed, the records it offers and the choices.
  const form = async path => {
    const [, label, hidden, body] = (await page(path)).match(/<button type="button" class="say" popoverTarget="[^"]+">((?:Say|Change) who it was)<\/button><div class="card-pop say-pop" popover="auto"[^>]*>[\s\S]*?<form\b[^>]*\baction="([^"]+)"[^>]*>((?:<input type="hidden"[^>]*\/>)+)<fieldset class="call-with"><legend>This call was with<\/legend>([\s\S]*?)<\/fieldset>/)?.filter((part, i) => i !== 2) ?? []
    if (!label) return undefined
    return { label, fields: Object.fromEntries([...hidden.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(([, name, value]) => [name, value])), records: [...body.matchAll(/<option value="([^"]+)"( selected="")?>([^<]*)</g)].map(([, id, picked, name]) => id + (picked ? '*' : '') + ' ' + name), roles: [...body.matchAll(/<input type="radio"[^>]*>/g)].map(([radio]) => radio.match(/value="([a-z]+)"/)[1] + (/ checked=""/.test(radio) ? '*' : '')) }
  }
  assert.equal(await form(ofRecord), undefined, 'the call is not in the history of the record yet')
  const first = await form(ofNumber)
  assert.deepEqual([first.label, first.records, first.roles, first.fields.intent, first.fields.call, first.fields.seen], ['Say who it was', ['contact:rowan Rowan Vale · contact:rowan', 'contact:wren Wren Vale · contact:wren'], ['self', 'representative'], 'party', 'with-1', ''])
  // Nothing is chosen for the reviewer: the list begins on no record. A form with no role, no record, two records, an ID no record has, or an ID the graph made for a caller is refused.
  assert.match(await page(ofNumber), /<select name="subject"><option value="" selected="">Choose a record<\/option>/)
  const refused = async more => { const answer = await post(ofNumber, { ...first.fields, _enhanced: '1', ...more }); return [answer.status, (await answer.text()).match(/Choose who was on the call|Choose a record, or give its ID|not both|No record has this ID/)?.[0]] }
  assert.deepEqual([await refused({ subject: 'contact:wren' }), await refused({ role: 'self' }), await refused({ role: 'self', subject: 'contact:wren', other: 'contact:rowan' }), await refused({ role: 'self', other: 'contact:nobody' }), await refused({ role: 'self', other: results[2].value.subject }), await stands()],
    [[400, 'Choose who was on the call'], [400, 'Choose a record, or give its ID'], [400, 'not both'], [400, 'No record has this ID'], [400, 'No record has this ID'], null])

  // The record holder. The call then belongs to that record alone, and the same form sent twice is one statement.
  for (let twice = 0; twice < 2; twice++) {
    const answer = await post(ofNumber, { ...first.fields, subject: 'contact:wren', role: 'self' })
    assert.deepEqual([answer.status, answer.headers.get('location')], [303, ofRecord + '#call-with-1'], 'the reviewer is taken to the call in the history of the record')
  }
  const said = await stands()
  assert.deepEqual([said.role, said.subject, said.by], ['self', 'contact:wren', 'dana'])
  assert.equal(await form(ofNumber), undefined, 'the call has left the history of the number')
  assert.match(await page(ofRecord), /Record holder confirmed by dana/)
  // In the history of the record the form shows what stands and offers to take it back. The form of the page read before is refused.
  const second = await form(ofRecord)
  assert.deepEqual([second.label, second.records, second.roles, second.fields.seen], ['Change who it was', ['contact:wren* Wren Vale · contact:wren', 'contact:rowan Rowan Vale · contact:rowan'], ['self*', 'representative'], 'dana ' + said.at + ' self'])
  const stale = await post(ofNumber, { ...first.fields, key: crypto.randomUUID(), subject: 'contact:wren', role: 'representative', _enhanced: '1' })
  assert.equal(stale.status, 409)
  assert.match(await stale.text(), /Somebody said who this call was with after this page was read/)
  // So is the same form sent again with another record chosen, which would otherwise be answered as if it had moved the call.
  const other = await post(ofNumber, { ...first.fields, subject: 'contact:rowan', role: 'self' })
  assert.deepEqual([other.status, (await stands()).subject], [409, 'contact:wren'])
  assert.equal((await stands()).role, 'self')

  // Somebody speaking for them. Then the other record on that line, by its ID with the list left as it was, which takes the call into its history.
  assert.equal((await post(ofRecord, { ...second.fields, subject: 'contact:wren', role: 'representative', _enhanced: '1' })).headers.get('location'), ofRecord + '#call-with-1')
  const third = await form(ofRecord)
  assert.deepEqual([(await stands()).role, third.roles], ['representative', ['self', 'representative*']])
  assert.match(await page(ofRecord), /Representative confirmed by dana/)
  assert.equal((await post(ofRecord, { ...third.fields, subject: 'contact:wren', other: 'contact:rowan', role: 'self' })).headers.get('location'), ofOther + '#call-with-1')
  const moved = await stands()
  assert.deepEqual([moved.role, moved.subject, await form(ofRecord), (await form(ofOther)).records], ['self', 'contact:rowan', undefined, ['contact:rowan* Rowan Vale · contact:rowan', 'contact:wren Wren Vale · contact:wren']])
})

test('a join a reviewer made is undone from the account page, and the two are undecided again', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const { at } = await (await fetch(firm.graph + '/review/api/board?days=90', { headers: { authorization: 'Bearer demo' } })).json()
  // Two records that share nothing.
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({ entries: [
    { type: 'profile', key: 'join-ash', at: at - 5 * 3600_000, subject: 'contact:ash', facts: { email: 'ash@example.org' } },
    { type: 'profile', key: 'join-birch', at: at - 4 * 3600_000, subject: 'contact:birch', facts: { email: 'birch@example.org' } },
    // A third that the graph itself links to the first, by a shared email.
    { type: 'profile', key: 'join-cedar', at: at - 3 * 3600_000, subject: 'contact:cedar', facts: { email: 'ash@example.org' } }] }) })
  assert.ok((await written.json()).results.every(result => result.ok))
  const path = '/accounts/' + encodeURIComponent('contact:ash')
  const members = async () => (await (await fetch(firm.graph + '/review/api/subject?subject=contact%3Aash', { headers: { authorization: 'Bearer demo' } })).json()).cluster.members.sort()
  // Every decision form on the page, by what it does and to whom.
  const forms = async () => [...(await (await fetch(firm.graph + path, { headers: { cookie } })).text()).matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(([form]) => Object.fromEntries([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map(([, name, value]) => [name, value]))).filter(fields => fields.intent)
  const post = fields => fetch(firm.graph + path, { method: 'POST', headers: { cookie, origin: firm.graph }, body: new URLSearchParams(fields), redirect: 'manual' })
  const before = await forms()
  // A link the graph made from evidence can be separated. Nobody joined it, so there is no join to undo.
  const linked = forms => forms.filter(form => form.other === 'contact:cedar').map(form => form.intent)
  assert.deepEqual([await members(), linked(before), before.some(form => form.intent === 'unjoin')], [['contact:ash', 'contact:cedar'], ['separate'], false])
  const join = before.find(form => form.intent === 'join' && !form.other)
  assert.ok(join, 'the page has a form that joins another ID')
  // A typo is refused, and nothing is joined.
  const typo = await post({ ...join, other: 'contact:brich' })
  assert.deepEqual([typo.status, await members()], [400, ['contact:ash', 'contact:cedar']])
  assert.equal((await post({ ...join, other: 'contact:birch', reason: 'Same person at intake' })).status, 303)
  assert.deepEqual(await members(), ['contact:ash', 'contact:birch', 'contact:cedar'])
  // The joined row offers to separate the two, and to take the join back. Taking it back leaves no decision between them.
  const after = await forms()
  const row = after.filter(form => form.other === 'contact:birch').map(form => form.intent).sort()
  assert.deepEqual([row, linked(after)], [['separate', 'unjoin'], ['separate']])
  // Why each is linked is said in words, with the graph's code in the title. So is what was seen of the record.
  const account = (await (await fetch(firm.graph + path, { headers: { cookie } })).text()).replaceAll('<!-- -->', '')
  for (const said of ['<b title="review">Joined by staff</b>', '<b title="email">Same email address</b>']) assert.ok(account.includes(said), said)
  assert.match(account, /<td title="email:[0-9a-f]{64}">Email address<\/td>/)
  assert.match(account, /<td title="review:join-\d+">Joined by staff<\/td>/)
  assert.equal((await post({ ...after.find(form => form.intent === 'unjoin'), reason: 'Joined the wrong Birch' })).status, 303)
  const last = await forms()
  assert.deepEqual([await members(), last.filter(form => form.other === 'contact:birch'), linked(last)], [['contact:ash', 'contact:cedar'], [], ['separate']])
})

test('a long Board column is read on, fifty people at a time', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const board = async () => (await fetch(firm.graph + '/review/api/board?days=90', { headers: { authorization: 'Bearer demo' } })).json()
  const { at } = await board()
  // Sixty callers nobody has returned, each a minute after the one before.
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({ entries: Array.from({ length: 60 }, (_, i) => ({ type: 'call', key: 'long-' + String(i).padStart(2, '0'), at: at - (120 - i) * 60_000, direction: 'inbound', from: '+1555010' + (6000 + i), to: '+15550100102', duration: 20, result: { answered: false, waited: 20 } })) }) })
  assert.ok((await written.json()).results.every(result => result.ok))
  for (let tries = 0; tries < 50 && (await board()).columns[0].people < 60; tries++) await new Promise(resolve => setTimeout(resolve, 100))
  const { people } = (await board()).columns[0]
  assert.ok(people >= 60, String(people))
  const page = async path => (await (await fetch(firm.graph + path, { headers: { cookie } })).text()).replaceAll('<!-- -->', '').replaceAll('&amp;', '&')
  // What the first column says under its people, the calls its cards are about, and where a card's details are read.
  const column = html => {
    const [section] = html.match(/<section aria-label="Missed calls" id="column-0"[\s\S]*?<\/section>/) ?? []
    assert.ok(section, 'the Missed calls column')
    return { foot: (section.match(/<p class="muted board-foot">([\s\S]*?)<\/p>/)?.[1] ?? '').replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g, '[$2 $1]'), named: [...section.matchAll(/<a [^>]*aria-label="((?:Next|Previous) 50 in [^"]+)"/g)].map(match => match[1]), calls: [...new Set([...section.matchAll(/name="call" value="([^"]+)"/g)].map(match => match[1]))], details: section.match(/href="(\/details\/board\/90\?[^"]+)"/)?.[1] }
  }
  const first = column(await page('/board/90'))
  assert.equal(first.foot, '1 to 50 of ' + people + ' · [Next 50 /board/90?column=0&from=50#column-0]')
  assert.equal(first.calls.length, 50)
  // The next fifty are the rest, with a way back, and none of them was on the first page. A card there opens its own details.
  const second = column(await page('/board/90?column=0&from=50'))
  assert.equal(second.foot, '51 to ' + people + ' of ' + people + ' · [Previous 50 /board/90#column-0]')
  assert.deepEqual([second.calls.length, second.calls.filter(call => first.calls.includes(call))], [people - 50, []])
  assert.ok(second.calls.includes('long-59'), 'the caller who has waited least is last')
  assert.deepEqual([first.named, second.named], [['Next 50 in Missed calls'], ['Previous 50 in Missed calls']])
  assert.match(second.details ?? '', /column=0&from=50/)
  // The details lead back to the column and the people the card was among.
  const details = await fetch(firm.graph + second.details, { headers: { cookie } })
  assert.equal(details.status, 200)
  assert.match((await details.text()).replaceAll('&amp;', '&'), /<a [^>]*href="\/board\/90\?column=0&from=50#column-0"[^>]*>Back to report<\/a>/)
  // What is said of a caller on a later page is recorded, and the page read again is the same one.
  const said = await fetch(firm.graph + '/board/90?column=0&from=50', { method: 'POST', headers: { cookie, origin: firm.graph }, body: new URLSearchParams({ intent: 'reached', call: 'long-59', key: crypto.randomUUID(), at: String(at) }), redirect: 'manual' })
  assert.deepEqual([said.status, said.headers.get('location')], [303, '/board/90?column=0&from=50'])
  assert.equal((await board()).columns[0].people, people - 1)
  // A place that is no step of fifty is read as the beginning.
  assert.equal(column(await page('/board/90?column=0&from=25')).foot, '1 to 50 of ' + (people - 1) + ' · [Next 50 /board/90?column=0&from=50#column-0]')
  // An address past the end says so and leads back. One that names no column is refused.
  assert.equal(column(await page('/board/90?column=0&from=500')).foot, 'None after 500 of ' + (people - 1) + ' · [Previous 50 /board/90?column=0&from=450#column-0]')
  assert.equal((await fetch(firm.graph + '/board/90?column=99&from=50', { headers: { cookie } })).status, 400)
})

test('the guide of each page is the original screen\'s, and opens from the page title with no script', async t => {
  // The words, the pictures and the drawing are copied from the original screen. Whoever changes one changes the other.
  const original = readFileSync(new URL('../../../src/edge/review/help.js', import.meta.url), 'utf8')
  const copied = readFileSync(new URL('../app/views/guide.jsx', import.meta.url), 'utf8')
  const part = (from, to) => original.slice(original.indexOf(from), original.indexOf(to, original.indexOf(from)) + to.length)
  for (const [from, to] of [['const LESSON_ICONS = {', '\n}\n'], ['const GUIDES = {', '\n}\n'], ['function scene(lesson) {', '\n  return { root, show }\n}\n']]) {
    const block = part(from, to)
    assert.ok(block.length > 200 && copied.includes(block.replace(/^const /, 'export const ')), from)
  }
  const guides = new Function('GLYPHS', part('const GUIDES = {', '\n}\n').replace('const GUIDES =', 'return'))({})
  // Every thing a guide draws has its drawing here: one of the guide's own, or the mark of a view. The two it borrows from the events are in the app's marks.
  const icons = new Function('GLYPHS', part('const LESSON_ICONS = {', '\n}\n').replace('const LESSON_ICONS =', 'return'))({ value: 'value', result: 'result' })
  const marks = readFileSync(new URL('../app/views/marks.tsx', import.meta.url), 'utf8')
  const things = Object.values(guides).flatMap(guide => Object.values(guide.in).filter(([kind]) => kind === 'thing').map(([, what]) => what))
  assert.deepEqual(things.filter(what => typeof icons[what] !== 'string' && !new RegExp('^  ' + what + ": '", 'm').test(marks)), [])
  assert.match(marks, /^  value: 'M[^']+',$/m)
  assert.match(marks, /^  result: 'M[^']+',$/m)
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const get = async path => (await (await fetch(firm.graph + path, { headers: { cookie } })).text()).split('</main>')[0].replaceAll('<!-- -->', '').replaceAll('&#x27;', "'").replaceAll('&amp;', '&')
  const person = /href="(\/journey\/[^"]+)"/.exec(await get('/board/90'))[1]
  const pages = { '/accounts': 'accounts', [person.replace('/journey/', '/accounts/')]: 'accounts', '/accounts/contact%3Anobody': 'accounts', '/journey': 'journey', [person]: 'journey', '/board/90': 'board', '/decide': 'decide', '/calls': 'calls', '/channels': 'channels', '/health': 'health' }
  for (const [path, view] of Object.entries(pages)) {
    const html = await get(path)
    // One button beside the title, named for its guide. It opens the box with the same id, which has every sentence in order.
    const found = [...html.matchAll(/<button type="button" class="explain" title="Guide" aria-label="Guide: ([^"]+)" popoverTarget="([^"]+)">[\s\S]*?<\/button><dialog class="lesson" popover="auto" id="([^"]+)" aria-label="([^"]+)">([\s\S]*?)<\/dialog>/g)]
    assert.equal(found.length, 1, path)
    const [, named, opens, id, label, body] = found[0]
    assert.deepEqual([named, label, opens === id], [guides[view].title, guides[view].title, true], path)
    assert.match(html, new RegExp('<div class="page-head">(<h2 class="page-title">[\\s\\S]*?</h2>)<button type="button" class="explain"'), path + ': the button follows the title')
    assert.deepEqual([...body.matchAll(/<li>([^<]+)<\/li>/g)].map(match => match[1]), guides[view].steps.map(step => step[0]), path)
    assert.equal(/<button type="button" class="lesson-shut" aria-label="Close" popoverTarget="([^"]+)" popoverTargetAction="hide">/.exec(body)?.[1], id, path + ': Close shuts this guide')
  }
})

test('the audit log shows no ID for a deleted record', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const { at } = await (await fetch(firm.graph + '/review/api/board?days=90', { headers: { authorization: 'Bearer demo' } })).json()
  const api = async (path, body) => (await fetch(firm.graph + path, { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
  const made = await api('/v1/record', { entries: [
    { type: 'profile', key: 'gone-ash', at: at - 5 * 3600_000, subject: 'contact:ash', facts: { email: 'ash@example.org' } },
    { type: 'profile', key: 'gone-birch', at: at - 4 * 3600_000, subject: 'contact:birch', facts: { email: 'birch@example.org' } }] })
  assert.ok(made.results.every(result => result.ok))
  assert.ok((await api('/v1/decide', { key: 'gone-join', at: at - 3600_000, by: 'dana', action: 'merge', pairs: [{ a: 'contact:ash', b: 'contact:birch' }] })).ok)
  // The rows of the audit log, as the page words them.
  const log = async () => {
    const html = (await (await fetch(firm.graph + '/accounts', { headers: { cookie } })).text()).replaceAll('<!-- -->', '')
    return [...html.matchAll(/<li><b>([^<]+)<\/b><span class="reason">([\s\S]*?)<\/span>/g)].map(([, action, about]) => action + ': ' + about.replace(/<[^>]+>/g, ''))
  }
  assert.deepEqual((await log()).slice(0, 1), ['Joined: contact:ash · contact:birch'])
  assert.ok((await api('/v1/forget', { key: 'gone-forget', at, by: 'dana', subjects: ['contact:birch'], platforms: 'report' })).ok)
  // The record of decisions keeps the ID, and the page shows it in neither entry. The record that is still there keeps its name.
  const after = await log()
  assert.deepEqual(after.slice(0, 2), ['Deleted data: [Deleted]', 'Joined: contact:ash · [Deleted]'])
  assert.ok(after.every(row => !row.includes('contact:birch')))
  // The ID is in no part of the page a browser is sent, and not in what the graph answers a screen.
  const whole = await (await fetch(firm.graph + '/accounts', { headers: { cookie } })).text()
  assert.doesNotMatch(whole.slice(whole.indexOf('Audit log')), /contact:birch/)
  const answer = await (await fetch(firm.graph + '/review/api/decisions?limit=5', { headers: { authorization: 'Bearer demo' } })).text()
  assert.doesNotMatch(answer, /contact:birch/)
  assert.deepEqual(JSON.parse(answer).decisions.slice(0, 2).map(decision => decision.about), [['[Deleted]'], ['contact:ash', '[Deleted]']])
})

test('the open missed call and the account of its number say what the phone company says of the caller', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const { at } = await (await fetch(firm.graph + '/review/api/board?days=90', { headers: { authorization: 'Bearer demo' } })).json()
  const day = at => new Date(at).toISOString().slice(0, 10)
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({ entries: [{ type: 'call', key: 'said-1', at: at - 3 * 3600_000, direction: 'inbound', from: '+15550100064', to: '+15550100102', duration: 20, result: { answered: false, waited: 20 }, caller: { name: 'WIRELESS CALLER', place: 'Springfield, IL' } }] }) })
  const [{ value: { subject } }] = (await written.json()).results
  const page = async path => (await (await fetch(firm.graph + path, { headers: { cookie } })).text()).replaceAll('<!-- -->', '').replaceAll('&amp;', '&')
  const list = await page('/calls?from=' + day(at - 86400_000) + '&to=' + day(at))
  // The call is opened from the list, and its head says both, as the phone company's words and not as a name.
  const open = list.match(new RegExp('<a\\b[^>]*\\bhref="(/calls\\?[^"]+)#call-history"[^>]*\\btitle="' + subject + '[ "]'))?.[1] ?? list.match(new RegExp('<a\\b[^>]*\\btitle="' + subject + '[ "][^>]*\\bhref="(/calls\\?[^"]+)#call-history"'))?.[1]
  assert.ok(open, 'the caller is in the list')
  const said = '<span class="caller-id">Caller ID: WIRELESS CALLER · Number from Springfield, IL</span>'
  assert.ok((await page(open)).includes(said))
  assert.ok((await page('/accounts/' + encodeURIComponent(subject))).includes(said))
  // In the list of callers they are named by their number still.
  const rows = list.slice(list.indexOf('class="inbox-list'), list.indexOf('id="call-history"'))
  assert.ok(rows.includes(subject) && !rows.includes('WIRELESS CALLER'))
})

test('a term has its definition beside it on every page, in the page from the start', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const get = async path => (await (await fetch(firm.graph + path, { headers: { cookie } })).text()).split('</main>')[0].replaceAll('<!-- -->', '')
  const board = await get('/board/90')
  const person = /href="(\/journey\/[^"]+)"/.exec(board)[1]
  const pages = { '/board/90': ['Board', 'Overdue'], '/calls': ['Inbound calls', 'Returned', 'Awaiting callback'], [person]: ['IDs'], [person.replace('/journey/', '/accounts/')]: ['Linked IDs', 'Largest groups', 'Audit log'], '/decide': ['Pending', 'IDs checked', 'Evidence'], '/channels': ['Spend', 'ROAS', 'Campaigns', 'Clicks'], '/health': ['Issues', 'Matching policy', 'Feeds', 'Matching rules'] }
  for (const [path, names] of Object.entries(pages)) {
    const html = path === '/board/90' ? board : await get(path)
    // Each mark names what it is about, opens the box with the same id, and the box has the name and a sentence.
    const marks = [...html.matchAll(/<button type="button" class="info" popoverTarget="([^"]+)" popoverTargetAction="show" aria-label="About ([^"]+)" aria-describedby="\1">/g)]
    assert.ok(marks.length >= names.length, path + ' has ' + marks.length + ' marks')
    for (const [, id, name] of marks) {
      const box = new RegExp('<span class="info-pop" id="' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '" popover="auto" role="tooltip"><b>' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</b><span class="info-text">[^<]{20,}</span>').exec(html)
      assert.ok(box, path + ': the definition of ' + name)
    }
    for (const name of names) assert.ok(marks.some(([, , said]) => said === name), path + ' defines ' + name)
  }
  // A definition that has arithmetic shows it, and one that depends on the data says so.
  assert.match(await get('/channels'), /<b>ROAS<\/b><span class="info-text">[^<]+<\/span><code>value ÷ spend<\/code>/)
  assert.match(await get('/channels?by=hour'), /<b>Campaigns<\/b><span class="info-text">[^<]+ Splits outcomes within each campaign\./)
})

test('the campaign table is ordered by the column its heading names and narrowed by a word, and the total stays of all', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const get = async path => (await (await fetch(firm.graph + path, { headers: { cookie } })).text()).split('</main>')[0].replaceAll('<!-- -->', '')
  const report = await (await fetch(firm.graph + '/review/api/report', { headers: { authorization: 'Bearer demo' } })).json()
  const names = html => [...html.split('<table class="campaign-report">')[1].split('</table>')[0].matchAll(/<span class="ranked-what" title="([^"]+)">/g)].map(([, name]) => name.replaceAll('&amp;', '&'))
  const by = (value, way) => [...report.rows].sort((x, y) => way * (value(x) - value(y))).map(row => row.campaign)
  // As the report came, then by a number largest first, then smallest first, and the heading says which.
  const plain = await get('/channels')
  assert.deepEqual(names(plain), report.rows.map(row => row.campaign))
  assert.match(plain, /<th scope="col" class="num" aria-sort="none"><a class="sort" href="\/channels\?from=[\d-]+&amp;to=[\d-]+&amp;sort=visits&amp;dir=desc#campaigns"[^>]*>Visits/)
  const most = await get('/channels?sort=visits')
  assert.deepEqual(names(most), by(row => row.visits, -1))
  assert.match(most, /aria-sort="descending"><a class="sort" href="[^"]*sort=visits&amp;dir=asc#campaigns"[^>]*>Visits/)
  const least = await get('/channels?sort=visits&dir=asc')
  assert.deepEqual(names(least), by(row => row.visits, 1))
  // The third press goes back to how the report came.
  assert.match(least, /aria-sort="ascending"><a class="sort" href="\/channels\?from=[\d-]+&amp;to=[\d-]+#campaigns"[^>]*>Visits/)
  assert.deepEqual(names(await get('/channels?sort=campaign')), report.rows.map(row => row.campaign).sort((x, y) => x.localeCompare(y)))
  assert.deepEqual(names(await get('/channels?sort=nothing')), report.rows.map(row => row.campaign), 'a column the table does not have')
  // A word narrows the lines to the campaigns that have it in their source, name or ID. The total is still the report's.
  const word = report.rows[0].campaignId
  const found = await get('/channels?find=' + word)
  assert.deepEqual(names(found), [report.rows[0].campaign])
  assert.ok(found.includes('1 of ' + report.rows.length + ' campaigns. The total is of all of them.'))
  const usd = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
  assert.match(found, new RegExp('<tr class="sum"><td>Total</td>.*?<td class="num edge">' + usd(report.total.cost).replace('$', '\\$')))
  assert.match(await get('/channels?find=no-such-campaign'), /No campaign has &quot;no-such-campaign&quot; in its source, name or ID\./)
  assert.deepEqual(names(await get('/channels?find=META&sort=value')), by(row => row.source === 'meta' ? row.value : -1, -1).filter(name => report.rows.find(row => row.campaign === name).source === 'meta'))
})
