import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startFirm } from '../examples/firm.ts'
import { createMemoryStore, hashPhone } from '../src/index.ts'
import { browse, chrome, until, without } from './chrome.ts'

// The demo, scene by scene, in a real browser: what the presenter's page says, and what the reviewer screen then shows.
test('every scene of the demo runs, says what came of it within a second, and can be seen', { skip: without, timeout: 180_000 }, async (t) => {
  assert.ok(chrome, 'CI needs a browser')
  const firm = await startFirm(createMemoryStore(), { quick: true })
  t.after(() => firm.close())
  const { run, press, close } = await browse(`${firm.site}/present`)
  t.after(close)
  await until('the scenes', () => run(`document.querySelectorAll('#scenes li').length`))
  const scenes = (await run(`document.querySelectorAll('#scenes li').length`)) as number
  assert.equal(scenes, 10)
  const links = (await run(`[...document.querySelectorAll('li a')].map((each) => each.href)`)) as string[]
  const screen = await browse(`${firm.graph}/review`)
  t.after(screen.close)
  await until('the screen', () => screen.run(`typeof load === 'function'`).catch(() => false))
  await screen.run(`sessionStorage.setItem('token', 'demo')`)
  /** What a view of the reviewer screen says, read afresh. */
  const view = async (href: string) => {
    await screen.run(`window.old = true`)
    await screen.run(`location.href = ${JSON.stringify(href)}; location.reload()`)
    await until(href, () => screen.run(`!window.old && typeof loadedAt === 'number' && document.getElementById('view').childElementCount > 0`).catch(() => false))
    assert.equal(await screen.run(`document.getElementById('notice').textContent`), '')
    const text = (await screen.run(`document.getElementById('view').innerText`)) as string
    // The table of campaigns, not the ranking over it.
    return text.includes('\nAttribution') ? text.slice(text.indexOf('\nAttribution')) : text
  }

  const caller = `caller:${hashPhone('+15550100042')}`
  // What each scene says, and what the view it points to says then and did not before.
  const expected: [RegExp, (text: string) => string][] = [
    [/office north, language es/, (text) => row(text, 'Busqueda: North')],
    [/by the tap\. State: waiting\. Counted: no/, (text) => (/Waiting/.test(text) ? text : '')],
    [/State: missed\. Counted: no\. Sent to the ad platform: no/, (text) => (text.includes(caller.slice(0, 14)) ? 'on the board' : '')],
    [/Missed call: returned\..*sent: yes/, (text) => (/returned after/i.test(text) && /answered/i.test(text) ? 'returned' : '')],
    [/Attributed to Map listing, River/, (text) => row(text, 'Map listing, River')],
    [/Advertised: north\. Served: river/, (text) => /river[^]{0,120}/.exec(text.slice(text.indexOf('Busqueda: North')))?.[0] ?? ''],
    [/Initial value 400 USD, current value 1250 USD.*ad platform: 1250 USD/, (text) => (text.includes('from 400 USD to 1,250 USD') ? 'restated' : '')],
    [/Before: joined.*Same cluster: no/, (text) => (text.includes('contact:tomas-vega') && /separated/i.test(text) ? 'separated' : '')],
    [/Linked at 85% by phone: related/, (text) => (text.includes('contact:marta-lago') && text.includes('contact:teo-lago') ? 'a pair' : '')],
    [/no calls for 12 hours/, (text) => (text.includes('Calls feed is stale') ? 'quiet' : '')],
  ]
  function row(text: string, name: string, length = 120) {
    const at = text.indexOf(name)
    return at < 0 ? '' : text.slice(at, at + length)
  }
  for (const [i, [said, seen]] of expected.entries()) {
    const before = seen(await view(links[i]!))
    await press('Space')
    await until(`scene ${i + 1}`, async () => {
      assert.equal(await run(`document.getElementById('problem').textContent`), '')
      return ((await run(`document.querySelectorAll('li.done').length`)) as number) === i + 1
    })
    const told = (await run(`[...document.querySelectorAll('li.done')].at(-1).querySelector('.told').innerText`)) as string
    assert.match(told.replaceAll('\n', ' '), said)
    assert.ok(Number(/(\d+) ms/.exec(told)![1]) < 1000, `scene ${i + 1} took ${told}`)
    const after = seen(await view(links[i]!))
    assert.ok(after && after !== before, `scene ${i + 1} shows on its view: ${JSON.stringify([before, after])}`)
  }
  // There is nothing after the last.
  assert.equal(await run(`document.getElementById('next').disabled`), true)
  // The site shows a visitor from an ad a number of their own, in their language.
  await screen.run(`location.href = ${JSON.stringify(`${firm.site}/es?gclid=you&utm_id=30333`)}`)
  await until('a pool number', async () => ((await screen.run(`document.querySelector('.call')?.textContent ?? ''`).catch(() => '')) as string).includes('(555) 010-011'))
})
