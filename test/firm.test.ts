import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startFirm } from '../examples/firm.ts'
import { createMemoryStore } from '../src/index.ts'
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
  for (let i = 0; i < scenes; i++) {
    await press('Space')
    await until(`scene ${i + 1}`, async () => {
      assert.equal(await run(`document.getElementById('problem').textContent`), '')
      return ((await run(`document.querySelectorAll('li.done').length`)) as number) === i + 1
    })
  }
  const told = (await run(`[...document.querySelectorAll('li.done .told')].map((each) => [...each.children].map((line) => line.textContent))`)) as string[][]
  for (const [i, lines] of told.entries()) assert.ok(Number.parseInt(lines.at(-1)!, 10) < 1000, `scene ${i + 1} took ${lines.at(-1)}`)
  const said = told.map((lines) => lines.slice(0, -1).join(' '))
  for (const [i, expected] of [
    /office north, language es/, /by the tap\. State: waiting\. Counted: no/, /State: missed\. Counted: no\. Sent to the ad platform: no/, /The miss is returned\..*sent: yes/,
    /Filed under Map listing, River/, /Advertised: north\. Served: river/, /Before: joined.*In one cluster: no/, /85% by the phone: related, and not joined/, /Recorded at 400 USD, now 1250 USD/, /no calls for 12 hours/,
  ].entries()) assert.match(said[i]!, expected)
  // There is nothing after the last.
  assert.equal(await run(`document.getElementById('next').disabled`), true)

  // What each scene changed is on the view it points to.
  const links = (await run(`[...document.querySelectorAll('li a')].map((each) => each.href)`)) as string[]
  const screen = await browse(`${firm.graph}/review`)
  t.after(screen.close)
  await until('the screen', () => screen.run(`typeof load === 'function'`))
  await screen.run(`sessionStorage.setItem('token', 'demo')`)
  for (const [i, shown] of [
    'Busqueda: North', 'How calls were placed', 'Missed, not returned', 'returned after', 'Map listing, River', 'river', 'kept apart', 'contact:4801', '1,250', 'Calls have gone quiet',
  ].entries()) {
    await screen.run(`location.href = ${JSON.stringify(links[i])}; location.reload()`)
    await until(`"${shown}" after scene ${i + 1}`, async () => ((await screen.run(`document.getElementById('view')?.textContent ?? ''`).catch(() => '')) as string).includes(shown))
    assert.equal(await screen.run(`document.getElementById('notice').textContent`), '')
  }
  // The site shows a visitor from an ad a number of their own, in their language.
  await screen.run(`location.href = ${JSON.stringify(`${firm.site}/es?gclid=you&utm_id=30333`)}`)
  await until('a pool number', async () => ((await screen.run(`document.querySelector('.call')?.textContent ?? ''`).catch(() => '')) as string).includes('(555) 010-011'))
})
