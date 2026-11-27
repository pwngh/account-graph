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
  assert.match(quarter, /<span id="board-period-label"[^>]*>Period<\/span><nav class="segments" aria-labelledby="board-period-label" aria-describedby="board-period">/)
  assert.ok(quarter.includes('<p class="sr-only" id="board-period">' + active + '</p>'))
  assert.ok((await page('/board/1')).includes('<p class="meta" id="board-period">' + active + '</p>'))
})

test('Calls offers the original period presets, counted from today in the report zone', async () => {
  const calls = await page('/calls')
  const range = /name="from" value="(\d{4}-\d{2}-\d{2})"[^]*?name="to" value="(\d{4}-\d{2}-\d{2})"/.exec(calls)
  assert.ok(range, 'the period form')
  const [, from, today] = range
  const day = n => new Date(Date.parse(today + 'T00:00:00Z') - n * 86400_000).toISOString().slice(0, 10)
  const presets = Object.fromEntries([...calls.matchAll(/<a (aria-current="page" )?href="\/calls\?from=([\d-]+)&amp;to=([\d-]+)"[^>]*>([^<]+)<\/a>/g)].map(([, current, start, end, label]) => [label, [start, end, Boolean(current)]]))
  assert.deepEqual(presets, {
    Today: [today, today, false], Yesterday: [day(1), day(1), false], '7 days': [day(6), today, false],
    '30 days': [day(29), today, from === day(29)], 'This month': [today.slice(0, 8) + '01', today, false],
  })
})

test('Calls copies the time of the selected missed call', { skip: !process.env.CHROME && 'set CHROME to copy a call time in a browser', timeout: 60000 }, async t => {
  const at = Date.UTC(2025, 1, 12, 16)
  const entries = [{ type: 'call', direction: 'inbound', from: '+15550100089', to: '+15550100102', key: 'copied-example', at, duration: 24, result: { answered: false, waited: 24 } }]
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({ entries }) })
  assert.ok((await written.json()).results.every(result => result.ok))
  const { browse, until } = await import('../../../test/chrome.ts')
  const { run, close } = await browse(firm.graph + '/signin?next=' + encodeURIComponent('/calls?from=2025-02-12&to=2025-02-12'))
  t.after(close)
  await until('the sign-in form', () => run("Boolean(document.querySelector('input[name=token]'))").catch(() => false))
  await run(`{
    const input = document.querySelector('input[name=token]')
    input.value = 'demo'
    input.form.requestSubmit()
  }`)
  await until('the Copy time button', () => run(`[...document.querySelectorAll('.inbox-facts button')].some(button => button.textContent === 'Copy time')`).catch(() => false), 20)
  const called = await run(`document.querySelector('.inbox-facts dd time').textContent`)
  await run(`[...document.querySelectorAll('.inbox-facts button')].find(button => button.textContent === 'Copy time').click()`)
  const said = await until('the copy result', () => run(`document.querySelector('.inbox-facts [role=status]').textContent`))
  // A headless browser may refuse the clipboard. The page then shows the time to copy by hand.
  assert.ok(said === 'Copied' || said === called, said)
})
