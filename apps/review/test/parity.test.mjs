import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startFirm } from '../../../examples/firm/firm.ts'

// The seeded firm, read through the new app, says what the original screen says about it.
let firm, cookie
before(async () => {
  firm = await startFirm({}, { quick: true })
  const login = await fetch(firm.graph + '/signin', { method: 'POST', headers: { origin: firm.graph }, body: new URLSearchParams({ token: 'demo' }), redirect: 'manual' })
  cookie = login.headers.get('set-cookie').split(';')[0]
})
after(() => firm?.close())
const page = async (path, headers = {}) => (await (await fetch(firm.graph + path, { headers: { cookie, ...headers } })).text()).split('</main>')[0].replaceAll('<!-- -->', '')
const active = 'Today is the people active today, with a call or a step, in the time zone of the line under the numbers. Overdue counts only those people.'

test('Board labels its period and explains Today, shown for one day and read out otherwise', async () => {
  const quarter = await page('/board/90')
  assert.match(quarter, /<span id="board-period-label"[^>]*>Period<\/span><nav aria-labelledby="board-period-label" aria-describedby="board-period">/)
  assert.ok(quarter.includes('<p class="sr-only" id="board-period">' + active + '</p>'))
  assert.ok((await page('/board/1')).includes('<p class="meta" id="board-period">' + active + '</p>'))
})
