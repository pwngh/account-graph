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
    // A name or a number is shown whole, on two or three lines where the card is narrow. One letter per line is a few pixels wide and hundreds tall.
    for (const [wide, tall] of names) assert.ok(wide >= 64 && tall <= 64, `an overdue name is ${wide} by ${tall} at ${width}`)
    assert.equal(await run(`[...document.querySelectorAll('.board li:has(.board-age.apart) .subject')].every(each => each.scrollWidth <= each.clientWidth + 1 && getComputedStyle(each).textOverflow !== 'ellipsis')`), true, 'an overdue name is whole at ' + width)
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

test('a campaign name is shown whole on Channels, Board and Calls, at a laptop and a phone width', { skip: !process.env.CHROME && 'set CHROME to measure the pages in a browser', timeout: 120000 }, async t => {
  const firm = await startFirm({}, { quick: true })
  t.after(() => firm.close())
  const { at } = await (await fetch(firm.graph + '/review/api/board?days=90', { headers: { authorization: 'Bearer demo' } })).json()
  const day = at => new Date(at).toISOString().slice(0, 10)
  // A name longer than any column, such as an ad platform exports: account, region, practice, match type and audience.
  const long = 'North and River offices | Family law and custody | Search | Exact match | Returning visitors in Spanish'
  const entries = [
    { type: 'cost', key: 'long-cost', at, rows: [{ day: day(at), source: 'google', amount: 25, currency: 'USD', campaignId: '55555', campaign: long, clicks: 9 }] },
    { type: 'arrival', key: 'long-arrival', at: at - 3600_000, subject: 'visitor:long-name', source: 'google', campaign: long, campaignId: '55555', landing: 'https://www.firm.example.org/' },
    { type: 'call', key: 'long-call', at: at - 4 * 86400_000, direction: 'inbound', from: '+15550100077', to: '+15550100102', duration: 30, result: { answered: false, waited: 20 } },
  ]
  const written = await fetch(firm.graph + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service-demo', 'content-type': 'application/json' }, body: JSON.stringify({ entries }) })
  assert.ok((await written.json()).results.every(result => result.ok))
  const { browse, until } = await import('../../../test/chrome.ts')
  const { run, send, close } = await browse(firm.graph + '/signin?next=' + encodeURIComponent('/channels'))
  t.after(close)
  await until('the sign-in form', () => run("Boolean(document.querySelector('input[name=token]'))").catch(() => false))
  await run(`{
    const input = document.querySelector('input[name=token]')
    input.value = 'demo'
    input.form.requestSubmit()
  }`)
  await until('Channels after signing in', () => run(`location.pathname === '/channels' && Boolean(document.querySelector('.campaign-report'))`).catch(() => false), 20)
  // What is cut short: text wider than its box, or a box that hides what does not fit behind an ellipsis.
  const cut = selector => run(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})].filter(each => each.scrollWidth > each.clientWidth + 1 || getComputedStyle(each).textOverflow === 'ellipsis').map(each => each.textContent.slice(0, 60)))`).then(JSON.parse)
  const pages = [
    ['/channels', '.campaign-report', '.campaign-report td:nth-child(2) .ranked-what, .campaign-report td:nth-child(2) .reason, .ranked .ranked-what'],
    ['/board/90', '.board li', '.board-meta > span'],
    ['/calls?from=' + day(at - 6 * 86400_000) + '&to=' + day(at), '.inbox-call', '.inbox-from'],
  ]
  for (const width of [375, 1280]) {
    for (const [path, ready, names] of pages) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 })
      await send('Page.navigate', { url: firm.graph + path })
      await until(ready + ' at ' + width, () => run(`location.pathname === ${JSON.stringify(path.split('?')[0])} && Boolean(document.querySelector(${JSON.stringify(ready)}))`).catch(() => false), 20)
      assert.ok(await run(`document.querySelectorAll(${JSON.stringify(names)}).length > 0`), 'names on ' + path)
      assert.deepEqual(await cut(names), [], 'cut short on ' + path + ' at ' + width)
    }
    // The long name is in the table and in the ranking, letter for letter.
    await send('Page.navigate', { url: firm.graph + '/channels?rank=Spend' })
    await until('the long campaign at ' + width, () => run(`[...document.querySelectorAll('.campaign-report .ranked-what')].some(each => each.textContent === ${JSON.stringify(long)})`).catch(() => false), 20)
    assert.ok(await run(`[...document.querySelectorAll('.ranked .ranked-what')].some(each => each.textContent === ${JSON.stringify(long)})`), 'the long name in the ranking at ' + width)
    assert.deepEqual(await cut('.campaign-report td:nth-child(2) .ranked-what, .ranked .ranked-what'), [], 'the long name cut short at ' + width)
  }
})
