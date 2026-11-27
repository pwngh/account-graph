import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startFirm } from '../../../examples/firm/firm.ts'

const WIDTHS = [375, 1024, 1280, 1440, 1920]

test('an overdue person on the Board and the history of a missed call can be read at each width', { skip: !process.env.CHROME && 'set CHROME to measure the pages in a browser', timeout: 120000 }, async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  // The firm keeps its own clock. A call missed four days before it is past the day the firm allows for a call back.
  const { at } = await (await fetch(firm.graph + '/review/api/board?days=90', { headers: { authorization: 'Bearer demo' } })).json()
  const missed = at - 4 * 86400_000
  const base = { type: 'call', direction: 'inbound', from: '+15550100087', to: '+15550100102' }
  const entries = [
    { ...base, key: 'layout-earlier', at: missed - 86400_000, duration: 45, result: { answered: true } },
    { ...base, key: 'layout-missed', at: missed, duration: 44, result: { answered: false, waited: 21 }, tags: { office: 'north' } },
  ]
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({ entries }) })
  assert.ok((await written.json()).results.every(result => result.ok))
  const day = at => new Date(at).toISOString().slice(0, 10)
  const calls = '/calls?from=' + day(missed - 2 * 86400_000) + '&to=' + day(at)
  const { browse, until } = await import('../../../test/chrome.ts')
  const { run, send, close } = await browse(firm.graph + '/signin?next=' + encodeURIComponent('/board/90'))
  t.after(close)
  await until('the sign-in form', () => run("Boolean(document.querySelector('input[name=token]'))").catch(() => false))
  await run(`{
    const input = document.querySelector('input[name=token]')
    input.value = 'demo'
    input.form.requestSubmit()
  }`)
  // Opening another page before the sign-in has answered would cancel it.
  await until('the Board after signing in', () => run(`location.pathname === '/board/90' && Boolean(document.querySelector('.board'))`).catch(() => false), 20)
  const sizes = selector => run(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})].map(each => { const box = each.getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)] }))`).then(JSON.parse)
  const open = async (width, path, selector) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 })
    await send('Page.navigate', { url: firm.graph + path })
    await until(selector + ' at ' + width, () => run(`location.pathname === ${JSON.stringify(path.split('?')[0])} && Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false), 20)
  }
  for (const width of WIDTHS) {
    await open(width, '/board/90', '.board-age.apart')
    const names = await sizes('.board li:has(.board-age.apart) .subject')
    assert.ok(names.length > 0, 'an overdue person at ' + width)
    // A name is one line of text. One letter per line is a few pixels wide and hundreds tall.
    for (const [wide, tall] of names) assert.ok(wide >= 64 && tall <= 28, `an overdue name is ${wide} by ${tall} at ${width}`)
    assert.ok((await sizes('.board li .detail')).every(([wide, tall]) => wide === 17 && tall === 17), 'the mark that opens a card at ' + width)
    const ages = await sizes('.board-age.apart')
    for (const [, tall] of ages) assert.ok(tall <= 28, `how long overdue is ${tall} tall at ${width}`)
    assert.equal(await run(`document.querySelector('.board').scrollWidth > document.documentElement.clientWidth && getComputedStyle(document.querySelector('.board')).overflowX === 'visible'`), false, 'the Board stays in the page at ' + width)

    await open(width, calls, '.story li')
    const told = await sizes('.story li .what')
    assert.ok(told.length >= 2, 'the history of the missed call at ' + width)
    for (const [wide, tall] of told) assert.ok(wide >= 160 && tall <= 200, `a line of the history is ${wide} by ${tall} at ${width}`)
  }
})
