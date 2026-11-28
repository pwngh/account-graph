import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detailReply } from '../app/views/report-words.js'
import { startFirm } from '../../../examples/firm/firm.ts'

test('a board row has its historical details in HTML, in its signed-in resource and on a standalone page', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({token:'demo'}), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const get = path => fetch(firm.graph + path, { headers: { cookie } })
  let board
  for (let i = 0; i < 100; i++) {
    board = (await (await get('/board/90')).text()).split('</main>')[0]
    if (board.includes('item=board.person.')) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const html = /href="(\/details\/board\/90[^"]+item=board\.person\.[^"]+)"/.exec(board)?.[1].replaceAll('&amp;', '&')
  assert.ok(html, 'row links to its own details')
  assert.match(board, /At this step since|Waiting since/)
  const resource = html.replace('/details/', '/card/')
  const row = await (await get(resource)).json()
  assert.equal(row.card.type, 'board.person')
  assert.ok(row.card.rows.some(([name]) => name === 'IDs'), 'journey history supplied a card row')
  assert.match(board, /<dt>IDs<\/dt>/)
  assert.match(await (await get(html)).text(), /<dt>IDs<\/dt>/)
  assert.equal((await get(resource + '-changed')).status, 404)
  const guest = await fetch(firm.graph + resource, {redirect:'manual'})
  assert.ok([302,303].includes(guest.status))
  assert.match(guest.headers.get('location'), /signin/)
})

test('Calls compares periods and shows the selected missed call and its history without JavaScript', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const at = Date.UTC(2025, 1, 12, 16)
  const base = { type: 'call', direction: 'inbound', from: '+15550100088', to: '+15550100102' }
  const entries = [
    { ...base, key: 'earlier-example', at: at - 86400_000, duration: 45, result: { answered: true } },
    { ...base, key: 'missed-example', at, duration: 24, result: { answered: false, waited: 24 } },
  ]
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({entries}) })
  assert.ok((await written.json()).results.every(r => r.ok))
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({token:'demo'}), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const get = path => fetch(firm.graph + path, { headers: { cookie } })
  const url = '/calls?from=2025-02-12&to=2025-02-12'
  const report = (await (await get(url)).text()).split('</main>')[0].replaceAll('<!-- -->','')
  for (const label of ['previously 100%', 'Calls by starting hour', 'Call attribution', 'Duration 45 s', '24 s', 'Calls by hour']) assert.ok(report.includes(label), label)
  const row = /href="(\/details\/calls[^"]+item=call\.[^"]+)"/.exec(report)[1].replaceAll('&amp;', '&').replace('/details/', '/card/')
  const snapshot = crypto.randomUUID()
  const response = await get(row + '&snapshot=' + snapshot)
  assert.equal(response.status, 200)
  const model = await response.json()
  assert.equal(model.card.title, 'Missed call')
  assert.equal(model.snapshot, snapshot)
  assert.equal(detailReply(model.card, snapshot, model), model)
  assert.equal(detailReply(model.card, crypto.randomUUID(), model), undefined, 'a later render of the same row discards the older answer')
  assert.equal(detailReply({href: '/details/another'}, snapshot, model), undefined, 'another card never draws this answer')
  const filtered = (await (await get(url + '&result=voicemail')).text()).split('</main>')[0]
  assert.doesNotMatch(filtered, /class="inbox-story"/)
})

test('each row of Call results has a card: the count, what it is a share of, the share and the days before', async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const at = Date.UTC(2025, 2, 5, 16)
  let line = 0
  // Each call is from another number, so none of them returns or repeats another.
  const call = (key, hours, result) => ({ type: 'call', direction: 'inbound', from: '+1555010' + String(2000 + line++), to: '+15550100102', key, at: at + hours * 3600_000, duration: 30, result })
  const entries = [
    call('before-answered', -24, { answered: true }), call('before-missed', -23, { answered: false, waited: 20 }),
    call('answered-1', 0, { answered: true }), call('answered-2', 1, { answered: true }),
    call('missed-1', 2, { answered: false, waited: 20 }), call('voicemail-1', 3, { answered: false, voicemail: true, waited: 20 }),
  ]
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({entries}) })
  assert.ok((await written.json()).results.every(r => r.ok))
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({token:'demo'}), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const get = path => fetch(firm.graph + path, { headers: { cookie } })
  const report = (await (await get('/calls?from=2025-03-05&to=2025-03-05')).text()).split('</main>')[0].replaceAll('<!-- -->','')
  const links = [...report.matchAll(/href="(\/details\/calls[^"]+item=calls\.result\.[^"]+)"/g)].map(([, href]) => href.replaceAll('&amp;', '&'))
  const cards = {}
  for (const href of links) {
    const { card } = await (await get(href.replace('/details/', '/card/'))).json()
    cards[card.title] = card
  }
  // Nothing was marked as not a lead, so that row and its card are not there.
  assert.deepEqual(Object.keys(cards), ['Answered', 'Missed', 'Voicemail', 'Waiting', 'Unknown', 'Returned', 'Called again'])
  assert.deepEqual([cards.Voicemail.rows, cards.Voicemail.sum, cards.Voicemail.links.map(({ text, href }) => [text, href])],
    [[['Calls', '1'], ['All inbound calls', '4'], ['Share', '25%'], ['Previous day', '0 · 0%']], '25% = 1 voicemail ÷ 4 calls', [['View Missed Calls', '#calls-missed'], ['Call Results', '/guide/call-results']]])
  assert.deepEqual(cards.Missed.rows.at(-1), ['Previous day', '1 · 50%'])
  // A return is a share of the callers nobody spoke to, and is not compared with the day before.
  assert.deepEqual([cards.Returned.rows, cards.Returned.sum, cards.Returned.say], [[['Calls', '0'], ['Missed and voicemail', '2'], ['Share', '0%']], '0% = 0 returned ÷ 2 missed', ['Not compared with the days before: the newest callers have had less time to be reached.']])
  assert.deepEqual(cards.Answered.links.map(({ text }) => text), ['Call Results'])
  // The card is in the page for a reader without scripts, named apart from the tile of the same title, and has a page of its own.
  assert.ok(report.includes('aria-label="Details of Missed, 1, in Call results"'), 'the row names its card')
  assert.ok(report.includes('<dt>Missed and voicemail</dt>'), 'the card is in the page')
  assert.match(await (await get(links[2])).text(), /<h2>Voicemail<\/h2>[^]*<dt>All inbound calls<\/dt><dd>4<\/dd>/)
})
