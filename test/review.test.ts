import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createGraph, createMemoryStore, email, hashPhone, phone, recordCall, recordNotLead, recordReturn } from '../src/index.ts'
import { createHandler } from '../src/server.ts'
import { browse, chrome, pause, until, without } from './chrome.ts'

// The reviewer screen in a real browser.
const T0 = 1_700_000_000_000
test('the reviewer screen signs with the token, keeps what was typed, and refuses an outdated decision', { skip: without, timeout: 180_000 }, async (t) => {
  assert.ok(chrome, 'CI needs a browser')
  const graph = createGraph(createMemoryStore())
  await graph.observe([1, 2, 3].map((n) => ({ subject: `account:${n}`, identifiers: ['email:e'], at: T0 })))
  await graph.observe({ subject: 'caller:1', identifiers: [phone('7135550194')], at: T0 })
  await graph.observe([1, 2].map((n) => ({ subject: `person:${n}`, identifiers: [email('both@example.com')], at: T0 })))
  let down = false
  const asked: string[] = []
  const handler = createHandler(graph, { token: 'service', reviewers: { dana: 'dana-token', lee: 'lee-token' }, origins: [] })
  const server = createServer((request, response) => (asked.push(request.url!), down && request.method === 'POST' ? void request.socket.destroy() : void handler(request, response))).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  t.after(() => (server.closeAllConnections(), void server.close()))
  const { run, press, close } = await browse(`${base}/review#/accounts/account%3A1`)
  t.after(close)
  const text = (selector: string) => run(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`) as Promise<string>
  const shown = (selector: string) => run(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility() ?? false`) as Promise<boolean>
  const enter = (token: string) => run(`(() => { const t = document.getElementById('token'); t.value = ${JSON.stringify(token)}; t.dispatchEvent(new Event('change')) })()`)
  const keepApart = async (other: string) => {
    await until('the tie', () => run(`[...document.querySelectorAll('tr')].some((row) => row.querySelector('a')?.textContent === '${other}' && row.querySelector('td button:not(.link)'))`))
    await run(`[...document.querySelectorAll('tr')].find((row) => row.querySelector('a')?.textContent === '${other}' && row.querySelector('td button:not(.link)')).querySelector('td button:not(.link)').click()`)
    await until('the question', () => run(`document.getElementById('ask').open`))
  }
  const decisions = async () => (await graph.decisions()).map(({ action, about, by, reason }) => [action, about.join(' '), by, reason])
  await until('the page', () => run(`typeof load === 'function'`))
  await enter('nobody-token')
  await until('the refusal', async () => (await text('#notice')).includes('refused'))
  assert.equal(await shown('#token'), true)

  await enter('dana-token')
  await until('the name', async () => (await text('#name')) === 'Deciding as dana')
  assert.deepEqual([await shown('#token'), await run(`document.getElementById('by') === null`)], [false, true])

  // The connection drops while a decision is being saved: the question and the reason stay.
  await keepApart('account:2')
  await until('what it would do', async () => (await text('#ask-effect')).includes('Which clusters'))
  assert.equal(await text('#ask-effect'), 'Now one person of 3 subjects. After this, 2 people, of 2 and 1 subjects. 2 subjects change cluster.Which clustersNow account:1 (3)After account:2 (2), account:1 (1)')
  await run(`document.getElementById('ask-reason').value = 'brothers, one family email'`)
  down = true
  await run(`document.getElementById('ask-yes').click()`)
  await until('the problem', async () => (await text('#ask-problem')).startsWith('Not saved'))
  assert.deepEqual(await run(`[document.getElementById('ask').open, document.getElementById('ask-reason').value, document.getElementById('ask-yes').disabled]`), [true, 'brothers, one family email', false])
  assert.deepEqual(await decisions(), [])

  // It is back, but Lee has decided meanwhile: refused, with who and why, and the reason still there.
  down = false
  await graph.join('account:1', 'account:2', { by: 'lee', reason: 'same person, two emails' })
  await run(`document.getElementById('ask-yes').click()`)
  const problem = await until('the conflict', async () => ((await text('#ask-problem')).includes('lee decided first') ? text('#ask-problem') : ''))
  assert.match(problem, /Joined account:1 and account:2, "same person, two emails"/)
  assert.deepEqual(await run(`[document.getElementById('ask').open, document.getElementById('ask-reason').value]`), [true, 'brothers, one family email'])

  // A third decision lands before the answer, so that one is shown in turn. Having seen it, the reviewer may decide, with Enter.
  assert.equal(await text('#ask-yes'), 'Decide anyway')
  await graph.ignore('email:other', true, { by: 'lee' })
  await graph.join('account:2', 'account:9', { by: 'lee', reason: 'and a third' })
  await run(`document.getElementById('ask-yes').click()`)
  await until('the second conflict', async () => (await text('#ask-problem')).includes('and a third'))
  await run(`document.getElementById('ask-reason').focus()`)
  await press('Enter')
  await until('the decision', async () => (await text('#notice')).includes('done'))
  assert.deepEqual((await decisions()).at(-1), ['separate', 'account:1 account:2', 'dana', 'brothers, one family email'])

  // Refused and cancelled, the screen reads again and shows why.
  await keepApart('account:3')
  assert.deepEqual([await text('#ask-problem'), await text('#ask-yes')], ['', 'Keep apart'])
  await graph.ignore('email:last', true, { by: 'lee' })
  await graph.join('account:3', 'account:8', { by: 'lee', reason: 'cousins, one account' })
  await run(`document.getElementById('ask-yes').click()`)
  await until('the third conflict', async () => (await text('#ask-problem')).includes('cousins'))
  await press('Escape')
  await until('the new record', async () => (await text('#decisions')).includes('cousins, one account'))
  const taken = (await decisions()).length

  // The graph: one mark a subject, one line a tie. Picked with the keyboard, opened out, and left so by a refresh.
  const marks = () => run(`[...document.querySelectorAll('.graph .node')].map((mark) => mark.node.id).sort().join(' ')`)
  const kinds = () => run(`[...document.querySelectorAll('.graph .edge')].map((line) => line.classList[1]).sort().join(' ')`)
  const key = (id: string, name: string) => run(`[...document.querySelectorAll('.graph .node')].find((mark) => mark.node.id === '${id}').dispatchEvent(new KeyboardEvent('keydown', { key: '${name}', bubbles: true }))`)
  await until('the graph', async () => (await marks()) === 'account:1 account:2 account:3')
  assert.equal(await kinds(), 'apart related')
  await key('account:3', 'Enter')
  assert.match(await text('.graph .card'), /account:3.*tied, not joined.*email/)
  await graph.observe({ subject: 'account:3', identifiers: ['ip:near'], at: T0 })
  await graph.observe({ subject: 'account:40', identifiers: ['ip:near', 'email:forty'], at: T0 })
  await graph.observe([{ subject: 'account:3', identifiers: ['canvas:near'], at: T0 }, { subject: 'account:40', identifiers: ['canvas:near'], at: T0 }])
  await run(`[...document.querySelectorAll('.graph .card button')].find((each) => each.textContent === 'Show its ties').click()`)
  await until('the ties of another', async () => (await marks()).includes('account:40'))
  const places = await until('it to come to rest', async () => {
    const one = await run(`JSON.stringify([...drawn.spots])`)
    await pause(300)
    return one === (await run(`JSON.stringify([...drawn.spots])`)) && one
  })
  await run(`load(beat)`)
  assert.deepEqual([await run(`JSON.stringify([...drawn.spots])`), (await marks()).includes('account:40'), (await text('.graph .card')).includes('account:3')], [places, true, true])
  // Nothing on it is too near anything else: no disc, name or line.
  const marked = `[...document.querySelectorAll('.graph .node')].map((mark) => mark.node)`
  assert.deepEqual(await run(`(() => { const nodes = ${marked}; const edges = [...document.querySelectorAll('.graph .edge')].map((mark) => mark.edge); const taken = nodes.map((node) => ({ node, boxes: shapes(node) })); return [nodes.length > 3, edges.length > 2, [...crowding(nodes, [])].length, edges.every((edge) => freeOf(edge, course(edge), taken))] })()`), [true, true, 0, true])
  // A refresh does not take the graph from under a hand, and one kind of tie can be hidden.
  await run(`document.querySelector('.graph').classList.add('held')`)
  assert.equal(await run(`interrupting()`), true)
  await run(`document.querySelector('.graph').classList.remove('held')`)
  await run(`document.querySelector('.graph .keys .apart').click()`)
  assert.equal(await run(`getComputedStyle(document.querySelector('.graph .edge.apart')).display`), 'none')
  await run(`document.querySelector('.graph .keys .apart').click()`)
  await key('account:3', 'Escape')
  assert.equal(await shown('.graph .card'), false)

  // What cannot be undone is held: pressed for a moment, or Enter in a field, it does nothing.
  await run(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Forget…').click()`)
  await run(`document.getElementById('ask-reason').focus()`)
  for (let i = 0; i < 2; i++) await press('Enter')
  await run(`(() => { const yes = document.getElementById('ask-yes'); for (const type of ['pointerdown', 'pointerup']) yes.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0 })); yes.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })) })()`)
  assert.deepEqual([await run(`document.getElementById('ask').open`), await text('#ask-problem'), (await decisions()).length], [true, 'Hold the button down to confirm.', taken])
  await press('Escape')
  await until('it to close', () => run(`!document.getElementById('ask').open`))
  await until('an ordinary button again', () => run(`!document.getElementById('ask-yes').classList.contains('hold')`))

  // Escape decides nothing. Signing out forgets the token and what was on screen.
  await keepApart('account:3')
  await press('Escape')
  await until('it to close', () => run(`!document.getElementById('ask').open`))
  assert.equal((await decisions()).length, taken)
  await run(`decided.push({ a: 'x', b: 'y', what: 'apart' }); skipped.add('x y')`)
  await run(`document.getElementById('leave').click()`)
  assert.deepEqual(await run(`[decided.length, skipped.size, drawn.spots.size, drawn.more.size]`), [0, 0, 0, 0])
  await until('the token field', () => shown('#token'))
  assert.deepEqual([await run(`sessionStorage.getItem('token')`), (await text('#view')).includes('account:1'), await shown('#who')], ['', false, false])
  await enter('dana-token')
  await until('the name again', async () => (await text('#name')) === 'Deciding as dana')

  // Having seen one conflict says nothing about another subject named instead.
  await until('the join', () => run(`[...document.querySelectorAll('button')].some((b) => b.textContent === 'Join with another…')`))
  await run(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Join with another…').click()`)
  await graph.join('account:20', 'account:21', { by: 'lee', reason: 'the first other' })
  await graph.join('account:30', 'account:31', { by: 'lee', reason: 'the second other' })
  const name = (other: string) => run(`(() => { const o = document.getElementById('ask-other'); o.value = '${other}'; o.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('ask-yes').click() })()`)
  await run(`document.getElementById('ask-reason').value = 'kept all along'`)
  await name('account:30')
  await until('the conflict about the first', async () => (await text('#ask-problem')).includes('the second other'))
  await name('account:20')
  await until('the conflict about the second', async () => (await text('#ask-problem')).includes('the first other'))
  assert.deepEqual(await run(`[document.getElementById('ask-yes').textContent, document.getElementById('ask-reason').value]`), ['Decide anyway', 'kept all along'])
  await run(`document.getElementById('ask-yes').click()`)
  await until('the join to be taken', async () => (await decisions()).at(-1)![3] === 'kept all along')
  // Found by phone, one person opens at once. Two with one email are offered, and nobody is said to be nobody.
  const look = (what: string) => run(`(() => { const s = document.getElementById('subject'); s.value = ${JSON.stringify(what)}; s.dispatchEvent(new Event('input')); document.getElementById('find').requestSubmit() })()`)
  await look('(713) 555-0194')
  await until('the caller', async () => (await text('#detail h3')) === 'caller:1')
  await look('both@example.com')
  await until('the choice', async () => (await text('#notice')).includes('person:1, person:2'))
  await look('nobody@example.com')
  await until('nobody', async () => (await text('#notice')).includes('Nobody'))
  // What is the start of nobody's id, or of several, is not put in the address either.
  for (const [what, said] of [['555 01', 'Nobody'], ['person:', 'person:1, person:2']] as const) {
    await look(what)
    await until(what, async () => (await text('#notice')).includes(said))
  }
  assert.ok(!(await run('location.href')).includes('person'))
  // What is typed while something opens stays as typed.
  await run(`(() => { load(); const s = document.getElementById('subject'); s.value = 'typed meanwhile'; s.dispatchEvent(new Event('input')) })()`)
  await until('it to open', () => run(`opening === 0`))
  assert.equal(await run(`document.getElementById('subject').value`), 'typed meanwhile')
  // An answer that comes after something else was opened is too late, and opens nothing.
  await run(`(() => { const real = window.fetch; window.fetch = async (...all) => { if (all[0] !== '/find') return real(...all); window.fetch = real; await new Promise((resolve) => (window.answer = resolve)); const response = await real(...all); const body = await response.json(); return { ok: true, status: 200, json: async () => { setTimeout(() => (window.answered = true), 0); return body } } }; const s = document.getElementById('subject'); s.value = 'person:2'; document.getElementById('find').requestSubmit(); location.hash = '#/accounts/person%3A1' })()`)
  await until('what was opened', async () => (await text('#detail h3')) === 'person:1' && (await run(`document.getElementById('subject').value`)) === 'person:1')
  await run(`window.answer()`)
  // Set in a task after the one that handles the answer.
  await until('the late answer', () => run(`window.answered`))
  assert.deepEqual([await run(`location.hash`), await text('#detail h3')], ['#/accounts/person%3A1', 'person:1'])
  await run(`(() => { const s = document.getElementById('subject'); s.value = 'typed meanwhile'; s.dispatchEvent(new Event('input')) })()`)
  // A search made while something opens is answered, and the answer stays when the view comes, or when it fails.
  for (const broken of [false, true]) {
    await run(`(() => { const all = views.get('accounts'), real = all.show; all.show = async (...given) => { all.show = real; await new Promise((resolve) => (window.release = resolve)); if (${broken}) throw new Error('the view broke'); return real(...given) }; notice(''); load(); document.getElementById('find').requestSubmit() })()`)
    await until('its answer', async () => (await text('#notice')).includes('Nobody'))
    assert.ok((await run(`opening`)) > 0)
    await run(`window.release()`)
    await until('it to open', () => run(`opening === 0`))
    assert.match(await text('#notice'), /Nobody/)
    assert.equal(await run(`document.getElementById('subject').value`), 'typed meanwhile')
    assert.equal((await text('#view')).includes('the view broke'), broken)
  }
  await look('person:2')
  await until('the exact one', async () => (await text('#detail h3')) === 'person:2')
  await pause(400)
  assert.deepEqual([...asked, await run('location.href')].filter((each) => /555|example\.com/.test(decodeURIComponent(each))), [])

  // A table is saved as it is shown, a name that starts like a formula as text.
  const today = new Date().toISOString().slice(0, 10)
  await graph.spend({ day: today, source: 'google', campaign: '=1+1', amount: 1234.5, clicks: 3 })
  await run(`(() => { window.taken = []; URL.createObjectURL = (blob) => (taken.push(blob), 'blob:none'); HTMLAnchorElement.prototype.click = function () { taken.push(this.download) }; location.hash = '#/channels' })()`)
  await until('the report', async () => (await text('#view')).includes('=1+1'))
  await run(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Today').click()`)
  await until('today alone', async () => (await run('location.hash')) === `#/channels/${today}/${today}` && (await text('#view')).includes('=1+1'))
  await until('the button', () => run(`[...document.querySelectorAll('button')].some((b) => b.textContent === 'Today' && b.ariaPressed === 'true')`))
  await run(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Save as CSV').click()`)
  assert.equal(await run('taken[1]'), `channels-${today}-${today}.csv`)
  const csv = (await run('taken[0].text()')) as string
  assert.match(csv, /"google","'=1\+1",/)
  assert.ok(!/"[=+@]/.test(csv), csv)

  // What another system said of a call is shown as said: reached without a call, and nobody's inquiry.
  const rang = Date.now() - 3_600_000
  for (const [id, from] of [['told-1', '+17135550181'], ['spam-1', '+17135550182']]) await recordCall(graph, { id: id!, from: from!, to: '+17135550100', at: rang, answered: false })
  await recordReturn(graph, { id: 'told-1', at: rang + 600_000 })
  await recordNotLead(graph, { call: 'spam-1', kind: 'spam' })
  await run(`location.hash = '#/calls'`)
  const calls = await until('the calls', async () => ((await text('#view')).includes('No lead') ? text('#view') : ''))
  assert.match(calls, /1 of them only as your own system reported\./)
  for (const [from, said] of [['+17135550181', 'returned after 10 min, as your own system reported'], ['+17135550182', 'Spam, not counted']]) {
    await run(`location.hash = ${JSON.stringify(`#/journey/${encodeURIComponent(`caller:${hashPhone(from!)}`)}`)}`)
    await until(said!, async () => (await text('#view')).includes(said!))
  }

  await enter('service')
  await until('the service note', async () => (await text('#name')).includes('carry no name'))
})
