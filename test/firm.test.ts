import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startFirm } from '../examples/firm.ts'
import { createMemoryStore, hashPhone } from '../src/index.ts'
import { browse, chrome, until, without } from './chrome.ts'

// The demo, scene by scene, in a real browser: what the stage says, and what the reviewer screen then shows.
test('every scene of the demo runs, says what came of it within a second, and can be seen', { skip: without, timeout: 180_000 }, async (t) => {
  assert.ok(chrome, 'CI needs a browser')
  let restarts = 0
  const firm = await startFirm(createMemoryStore(), { quick: true, restart: () => void (restarts += 1) })
  t.after(() => firm.close())
  const { run, press, close } = await browse(`${firm.graph}/stage`)
  t.after(close)
  const bar = async (name: string) => (await run(`document.getElementById('stage')?.dataset.${name} ?? ''`).catch(() => '')) as string
  // Signed in, with the phone beside the screen.
  await until('the stage', async () => (await bar('running')) === 'false' && (await run(`typeof loadedAt === 'number'`).catch(() => false)))
  assert.equal(await run(`document.body.classList.contains('with-phone') && document.querySelector('.device').dataset.state`), 'ad')
  const { scenes } = (await run(`fetch('/stage/scenes').then((answer) => answer.json())`)) as { scenes: { see: [string, string]; spot?: string[] }[] }
  assert.equal(scenes.length, 10)
  const links = scenes.map(({ see }) => see[1])
  // Only the stage moves the story on.
  assert.equal((await fetch(`${firm.graph}/stage/run`, { method: 'POST' })).status, 403)
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
    await until(`scene ${i + 1}`, async () => (await bar('at')) === String(i + 1) && (await bar('running')) === 'false')
    assert.match((await run(`document.querySelector('#stage .told').textContent`)) as string, said)
    assert.ok(Number(await bar('ms')) < 1000, `scene ${i + 1} took ${await bar('ms')} ms`)
    // The stage opens what the scene changed, without a problem, and the phone goes once the call is over.
    assert.equal(await run(`document.getElementById('notice').textContent`), '')
    assert.equal(await run(`document.body.classList.contains('with-phone')`), i < 4)
    assert.equal(await run(`document.getElementById('stage-light').classList.contains('on')`), Boolean(scenes[i]!.spot), `scene ${i + 1} lights its row`)
    const after = seen(await view(links[i]!))
    assert.ok(after && after !== before, `scene ${i + 1} shows on its view: ${JSON.stringify([before, after])}`)
  }
  // There is nothing after the last.
  assert.equal(await run(`[...document.querySelectorAll('#stage button')].find((each) => each.textContent.startsWith('Next')).hidden`), true)
  // The show plays from the start only.
  await run(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }))`)
  assert.match((await run(`document.querySelector('#stage .told').textContent`)) as string, /Press R to restart/)
  // After the last scene the bar offers to start over. The stage waits for the next start, so nothing else is pressed.
  assert.deepEqual(await run(`[document.querySelector('#stage .primary:not([hidden])').textContent, document.querySelectorAll('#stage .primary:not([hidden])').length]`), ['Restart R', 1])
  assert.equal((await fetch(`${firm.graph}/stage/restart`, { method: 'POST' })).status, 403)
  await run(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))`)
  await until('the restart', () => restarts === 1)
  // The site shows a visitor from an ad a number of their own, in their language.
  await screen.run(`location.href = ${JSON.stringify(`${firm.site}/es?gclid=you&utm_id=30333`)}`)
  await until('a pool number', async () => ((await screen.run(`document.querySelector('.call')?.textContent ?? ''`).catch(() => '')) as string).includes('(555) 010-011'))
})
