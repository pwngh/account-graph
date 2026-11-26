import assert from 'node:assert/strict'
import { test } from 'node:test'
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
