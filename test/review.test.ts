import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createGraph, createMemoryStore, defaultPolicy, email, hashPhone, phone, recordCall, recordNotLead, recordReturn, recordText } from '../tools/internals.ts'
import { createOps } from '../src/core/ops.ts'
import { createHandler } from './harness.ts'
import { browse, chrome, pause, until, without } from './chrome.ts'

// The reviewer screen in a real browser.
const T0 = 1_700_000_000_000
test('the reviewer screen signs with the token, keeps what was typed, and refuses an outdated decision', { skip: without, timeout: 180_000 }, async (t) => {
  assert.ok(chrome, 'CI needs a browser')
  const store = createMemoryStore()
  const graph = createGraph(store)
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
  const served = await fetch(`${base}/review`)
  assert.match(served.headers.get('content-security-policy')!, /img-src data:; .*frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'$/)
  // The token is asked for only once it is known that there is none, so a reload never shows the field for a moment.
  assert.match(await served.text(), /<label id="token-label" hidden>[^]*<main id="view" tabindex="-1"><\/main>/)
  assert.deepEqual(['cross-origin-opener-policy', 'cross-origin-resource-policy', 'x-robots-tag'].map((name) => served.headers.get(name)), ['same-origin', 'same-origin', 'noindex, nofollow'])
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
  await until('the page', () => run(`typeof load === 'function'`).catch(() => false))
  await enter('nobody-token')
  await until('the refusal', async () => (await text('#notice')).includes('Invalid access token'))
  assert.equal(await shown('#token'), true)

  await enter('dana-token')
  await until('the name', async () => (await text('#name')) === 'dana')
  assert.deepEqual([await shown('#token'), await run(`document.getElementById('by') === null`)], [false, true])

  // The connection drops while a decision is being saved, and the question and the reason stay.
  await keepApart('account:2')
  await until('what it would do', async () => (await text('#ask-effect')).includes('Details'))
  assert.equal(await text('#ask-effect'), 'Before: 1 person (3 IDs). After: 2 people (2, 1 IDs).DetailsBefore account:1 (3)After account:2 (2), account:1 (1)')
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
  const problem = await until('the conflict', async () => ((await text('#ask-problem')).includes('lee made a decision') ? text('#ask-problem') : ''))
  assert.match(problem, /Joined account:1 and account:2, "same person, two emails"/)
  assert.deepEqual(await run(`[document.getElementById('ask').open, document.getElementById('ask-reason').value]`), [true, 'brothers, one family email'])

  // A third decision lands before the answer, so that one is shown in turn. Having seen it, the reviewer may decide, with Enter.
  assert.equal(await text('#ask-yes'), 'Continue')
  await graph.ignore('email:other', true, { by: 'lee' })
  await graph.join('account:2', 'account:9', { by: 'lee', reason: 'and a third' })
  await run(`document.getElementById('ask-yes').click()`)
  await until('the second conflict', async () => (await text('#ask-problem')).includes('and a third'))
  await run(`document.getElementById('ask-reason').focus()`)
  await press('Enter')
  await until('the decision', async () => (await text('#notice')).includes('saved'))
  assert.deepEqual((await decisions()).at(-1), ['separate', 'account:1 account:2', 'dana', 'brothers, one family email'])

  // Refused and cancelled, the screen reads again and shows why.
  await keepApart('account:3')
  assert.deepEqual([await text('#ask-problem'), await text('#ask-yes')], ['', 'Separate'])
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
  assert.match(await text('.graph .card'), /account:3.*Related.*email/)
  await graph.observe({ subject: 'account:3', identifiers: ['ip:near'], at: T0 })
  await graph.observe({ subject: 'account:40', identifiers: ['ip:near', 'email:forty'], at: T0 })
  await graph.observe([{ subject: 'account:3', identifiers: ['canvas:near'], at: T0 }, { subject: 'account:40', identifiers: ['canvas:near'], at: T0 }])
  await run(`[...document.querySelectorAll('.graph .card button')].find((each) => each.textContent === 'Show links').click()`)
  await until('the ties of another', async () => (await marks()).includes('account:40'))
  const places = await until('it to come to rest', async () => {
    const one = await run(`JSON.stringify([...drawn.spots])`)
    await pause(300)
    return one === (await run(`JSON.stringify([...drawn.spots])`)) && one
  })
  await run(`load(beat)`)
  assert.deepEqual([await run(`JSON.stringify([...drawn.spots])`), (await marks()).includes('account:40'), (await text('.graph .card')).includes('account:3')], [places, true, true])
  // An answer the server made before its newest write is read again on the next look.
  assert.deepEqual(await run(`(async () => {
    const real = fetch
    globalThis.fetch = async (path, ...rest) => {
      const answer = await real(path, ...rest)
      return path === '/review/api/pulse' ? answer : new Response(await answer.text(), { status: answer.status, headers: { age: '1' } })
    }
    await load()
    const dated = beat
    globalThis.fetch = real
    await load()
    return [dated ?? null, typeof beat]
  })()`), [null, 'string'])
  // Nothing on it is too near anything else: no disc, name or line.
  const marked = `[...document.querySelectorAll('.graph .node')].map((mark) => mark.node)`
  assert.deepEqual(await run(`(() => { const nodes = ${marked}; const edges = [...document.querySelectorAll('.graph .edge')].map((mark) => mark.edge); const taken = nodes.map((node) => ({ node, boxes: shapes(node) })); return [nodes.length > 3, edges.length > 2, [...crowding(nodes, [])].length, edges.every((edge) => freeOf(edge, course(edge), taken))] })()`), [true, true, 0, true])
  // Opened where there is no room, as in a pane that is shut, it is drawn once there is.
  assert.deepEqual(await run(`(async () => {
    const ids = ['account:a', 'account:b', 'account:c']
    const graph = graphOf({ subject: ids[0], cluster: { id: ids[0], members: ids, oversized: false }, links: [], edges: [[0, 1], [0, 2]].map(([a, b]) => ({ a: ids[a], b: ids[b], score: 0.95, level: 'same' })), separated: [], verdicts: [], apart: [] }, [])
    const kept = { ...drawn, spots: new Map(drawn.spots) }
    const host = document.createElement('div')
    host.style.width = '0'
    host.append(graph)
    document.body.append(host)
    graph.begin()
    await new Promise((resolve) => setTimeout(resolve, 200))
    host.style.width = '900px'
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const places = [...graph.querySelectorAll('.node')].map(({ node }) => Number.isFinite(node.x) && Number.isFinite(node.y))
    host.remove()
    Object.assign(drawn, kept)
    return places
  })()`), [true, true, true])
  // Measured by the browser, not by the layout: of a crowded graph no name is on another name, a disc, or a line.
  const touching = await run(`(async () => {
    const ids = Array.from({ length: 24 }, (_, n) => ['account:somebody-with-a-name-', 'lead:a', 'visitor:of-the-site-'][n % 3] + n)
    const ties = ids.slice(1).flatMap((id, n) => [...new Set([ids[(n * 7) % (n + 1)], ids[(n * 5 + 2) % (n + 1)]])].map((a) => ({ a: a < id ? a : id, b: a < id ? id : a, score: 0.95, level: 'same' })))
    const graph = graphOf({ subject: ids[0], cluster: { id: ids[0], members: ids, oversized: false }, links: [], edges: ties, separated: [], verdicts: [], apart: [] }, [])
    const kept = { ...drawn, spots: new Map(drawn.spots) }
    const host = document.createElement('div')
    host.style.width = '1200px'
    host.append(graph)
    document.body.append(host)
    graph.begin()
    // At rest once nothing has moved for a while.
    const places = () => [...graph.querySelectorAll('.node')].map((mark) => mark.getAttribute('transform')).join() + graph.querySelector('.stage > svg > g').getAttribute('transform')
    let same = 0
    for (let was = '', tries = 0; same < 5 && tries < 100; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      same = places() === was ? same + 1 : 0
      was = places()
    }
    const marks = [...graph.querySelectorAll('.node')]
    const box = (node) => node.getBoundingClientRect()
    const meet = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    const parts = marks.map((mark) => ({ disc: box(mark.querySelector('.disc')), name: box(mark.querySelector('.name')) }))
    const bad = []
    parts.forEach((one, i) => parts.forEach((two, j) => {
      if (i < j && meet(one.name, two.name)) bad.push('names ' + i + ' ' + j)
      if (i < j && meet(one.disc, two.disc)) bad.push('discs ' + i + ' ' + j)
      if (meet(one.name, two.disc)) bad.push('name ' + i + ' on disc ' + j)
    }))
    for (const line of graph.querySelectorAll('.edge .line')) {
      const long = line.getTotalLength(), to = line.getScreenCTM()
      for (let at = 0; ; at = Math.min(long, at + 1)) {
        const p = line.getPointAtLength(at).matrixTransform(to)
        parts.forEach(({ name }, i) => p.x > name.left && p.x < name.right && p.y > name.top && p.y < name.bottom && bad.push('a line on name ' + i))
        if (at >= long) break
      }
    }
    host.remove()
    Object.assign(drawn, kept)
    const pairs = [...graph.querySelectorAll('.edge')].filter((mark) => mark.querySelector('.line').getTotalLength() > 0).map((mark) => mark.edge.a + ' ' + mark.edge.b).sort().join()
    return [same, marks.length, ties.length > 24 && pairs === ties.map(({ a, b }) => a + ' ' + b).sort().join(), [...new Set(bad)]]
  })()`)
  assert.deepEqual(touching, [5, 24, true, []])
  // A refresh does not take the graph from under a hand, and one kind of tie can be hidden.
  await run(`document.querySelector('.graph').classList.add('held')`)
  assert.equal(await run(`interrupting()`), true)
  await run(`document.querySelector('.graph').classList.remove('held')`)
  await run(`document.querySelector('.graph .keys .apart').click()`)
  assert.equal(await run(`getComputedStyle(document.querySelector('.graph .edge.apart')).display`), 'none')
  await run(`document.querySelector('.graph .keys .apart').click()`)
  await key('account:3', 'Escape')
  assert.equal(await shown('.graph .card'), false)

  // What cannot be undone is held. Pressed for a moment, or with Enter in a field, it does nothing.
  await run(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Delete…').click()`)
  await run(`document.getElementById('ask-reason').focus()`)
  for (let i = 0; i < 2; i++) await press('Enter')
  await run(`(() => { const yes = document.getElementById('ask-yes'); for (const type of ['pointerdown', 'pointerup']) yes.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0 })); yes.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })) })()`)
  assert.deepEqual([await run(`document.getElementById('ask').open`), await text('#ask-problem'), (await decisions()).length], [true, 'Hold the button to confirm.', taken])
  await press('Escape')
  await until('it to close', () => run(`!document.getElementById('ask').open`))
  await until('an ordinary button again', () => run(`!document.getElementById('ask-yes').classList.contains('hold')`))
  // Asking a platform to retract is offered where one can be asked, left off, and sent only when chosen.
  assert.equal(await run(`document.getElementById('ask-option-label').hidden`), true)
  await run(`retraction = { targets: ['microsoft'], always: false }; load()`)
  await until('the option', () => run(`(() => { if (opening > 0) return false; [...document.querySelectorAll('button')].find((b) => b.textContent === 'Delete…').click(); return document.getElementById('ask').open })()`))
  // The dialog comes in over a moment, and may still be on its way out from before.
  await until('the option to be seen', () => shown('#ask-option-label'))
  assert.deepEqual([await text('#ask-option-text'), await run(`document.getElementById('ask-option').checked`)], ['Ask microsoft to retract conversions', false])
  await press('Escape')
  await until('it to close again', () => run(`!document.getElementById('ask').open`))
  await run(`retraction = { targets: [], always: false }; load()`)

  // Escape decides nothing. Signing out forgets the token and what was on screen.
  await keepApart('account:3')
  await press('Escape')
  await until('it to close', () => run(`!document.getElementById('ask').open`))
  assert.equal((await decisions()).length, taken)
  await run(`decided.push({ a: 'x', b: 'y', what: 'apart' }); skipped.add('x y'); sweep = { cursor: null }`)
  await run(`document.getElementById('leave').click()`)
  assert.deepEqual(await run(`[decided.length, skipped.size, drawn.spots.size, drawn.more.size, sweep === undefined]`), [0, 0, 0, 0, true])
  await until('the token field', () => shown('#token'))
  assert.deepEqual([await run(`sessionStorage.getItem('token')`), (await text('#view')).includes('account:1'), await shown('#who')], ['', false, false])
  await enter('dana-token')
  await until('the name again', async () => (await text('#name')) === 'dana')

  // Having seen one conflict says nothing about another subject named instead.
  await until('the join', () => run(`[...document.querySelectorAll('button')].some((b) => b.textContent === 'Join with…')`))
  await run(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Join with…').click()`)
  await graph.join('account:20', 'account:21', { by: 'lee', reason: 'the first other' })
  await graph.join('account:30', 'account:31', { by: 'lee', reason: 'the second other' })
  const name = (other: string) => run(`(() => { const o = document.getElementById('ask-other'); o.value = '${other}'; o.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('ask-yes').click() })()`)
  await run(`document.getElementById('ask-reason').value = 'kept all along'`)
  await name('account:30')
  await until('the conflict about the first', async () => (await text('#ask-problem')).includes('the second other'))
  await name('account:20')
  await until('the conflict about the second', async () => (await text('#ask-problem')).includes('the first other'))
  assert.deepEqual(await run(`[document.getElementById('ask-yes').textContent, document.getElementById('ask-reason').value]`), ['Continue', 'kept all along'])
  await run(`document.getElementById('ask-yes').click()`)
  await until('the join to be taken', async () => (await decisions()).at(-1)![3] === 'kept all along')
  // The question is open until its answer comes, and until then nobody can search.
  await until('the question to close', () => run(`!document.getElementById('ask').open && opening === 0`))
  // Found by phone, one person opens at once. Two with one email are offered, and nobody is said to be nobody.
  const look = (what: string) => run(`(() => { const s = document.getElementById('subject'); s.value = ${JSON.stringify(what)}; s.dispatchEvent(new Event('input')); document.getElementById('find').requestSubmit() })()`)
  await look('(713) 555-0194')
  await until('the caller', async () => (await text('#detail h3')) === 'caller:1')
  assert.doesNotMatch(await text('#detail > section:first-child'), /First seen here|Created in your system/)
  await look('both@example.com')
  await until('the choice', async () => (await text('#notice')).includes('person:1, person:2'))
  await look('nobody@example.com')
  await until('nobody', async () => (await text('#notice')).includes('No results'))
  // What is the start of nobody's id, or of several, is not put in the address either.
  for (const [what, said] of [['555 01', 'No results'], ['person:', 'person:1, person:2']] as const) {
    await look(what)
    await until(what, async () => (await text('#notice')).includes(said))
  }
  assert.ok(!(await run('location.href')).includes('person'))
  // What is typed while something opens stays as typed.
  await run(`(() => { load(); const s = document.getElementById('subject'); s.value = 'typed meanwhile'; s.dispatchEvent(new Event('input')) })()`)
  await until('it to open', () => run(`opening === 0`))
  assert.equal(await run(`document.getElementById('subject').value`), 'typed meanwhile')
  // An answer that comes after something else was opened is too late, and opens nothing.
  await run(`(() => { const real = window.fetch; window.fetch = async (...all) => { if (all[0] !== '/review/api/find') return real(...all); window.fetch = real; await new Promise((resolve) => (window.answer = resolve)); const response = await real(...all); const body = await response.json(); return { ok: true, status: 200, headers: response.headers, json: async () => { setTimeout(() => (window.answered = true), 0); return body } } }; const s = document.getElementById('subject'); s.value = 'person:2'; document.getElementById('find').requestSubmit(); location.hash = '#/accounts/person%3A1' })()`)
  await until('what was opened', async () => (await text('#detail h3')) === 'person:1' && (await run(`document.getElementById('subject').value`)) === 'person:1')
  await run(`window.answer()`)
  // Set in a task after the one that handles the answer.
  await until('the late answer', () => run(`window.answered`))
  assert.deepEqual([await run(`location.hash`), await text('#detail h3')], ['#/accounts/person%3A1', 'person:1'])
  await run(`(() => { const s = document.getElementById('subject'); s.value = 'typed meanwhile'; s.dispatchEvent(new Event('input')) })()`)
  // A search made while something opens is answered, and the answer stays when the view comes, or when it fails.
  for (const broken of [false, true]) {
    await run(`(() => { const all = views.get('accounts'), real = all.show; all.show = async (...given) => { all.show = real; await new Promise((resolve) => (window.release = resolve)); if (${broken}) throw new Error('the view broke'); return real(...given) }; notice(''); load(); document.getElementById('find').requestSubmit() })()`)
    await until('its answer', async () => (await text('#notice')).includes('No results'))
    assert.ok((await run(`opening`)) > 0)
    // The answer can come before the view is asked for what it shows.
    await until('the view to be asked', () => run(`Boolean(window.release)`))
    await run(`(() => { window.release(); window.release = undefined })()`)
    await until('it to open', () => run(`opening === 0`))
    assert.match(await text('#notice'), /No results/)
    assert.equal(await run(`document.getElementById('subject').value`), 'typed meanwhile')
    assert.equal((await text('#view')).includes('the view broke'), broken)
  }
  await look('person:2')
  await until('the exact one', async () => (await text('#detail h3')) === 'person:2')
  await pause(400)
  assert.deepEqual([...asked, await run('location.pathname + location.search + location.hash')].filter((each) => /555|example\.com/.test(decodeURIComponent(each))), [])

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
  const calls = await until('the calls', async () => ((await text('#view')).includes('Not a lead') ? text('#view') : ''))
  assert.match(calls, /1 reported by another system/)
  for (const [from, said] of [['+17135550181', 'Returned after 10 min (reported)'], ['+17135550182', 'Spam']]) {
    await run(`location.hash = ${JSON.stringify(`#/journey/${encodeURIComponent(`caller:${hashPhone(from!)}`)}`)}`)
    await until(said!, async () => (await text('#view')).includes(said!))
  }
  // A report somebody signed names them.
  await graph.sayReturn({ call: 'told-1', key: 'signed', at: Date.now(), reachedAt: rang + 600_000, by: 'dana' })
  await run(`location.hash = '#/calls'`)
  await until('the calls again', async () => (await text('#view')).includes('Not a lead'))
  await run(`location.hash = ${JSON.stringify(`#/journey/${encodeURIComponent(`caller:${hashPhone('+17135550181')}`)}`)}`)
  await until('who reported', async () => (await text('#view')).includes('Returned after 10 min (reported by dana)'))

  // What a platform claims stands beside what is credited, and a value it did not give is not a number.
  await graph.spend({ day: today, source: 'google', campaign: '=1+1', amount: 1234.5, clicks: 3, conversions: 7.5 })
  await run(`location.hash = '#/channels'`)
  const claims = await until('the claim', () => run(`document.querySelector('.claims')?.innerText`)) as string
  assert.ok(!claims.includes('[object'), claims)
  assert.match(claims, /google\s+=1\+1\s+1\s+7\.5\s+0\s+No data/)

  // What had reached an ad platform of someone forgotten stays until it is put away, as it is kept nowhere.
  await run(`sentOn([{ transactionId: 'gone-1', target: 'google', action: '333', at: ${rang}, state: 'not_requested', note: 'may not have arrived' }])`)
  assert.match(await text('.sent-on'), /google333.*gone-1Not requestedmay not have arrived/)
  await press('Escape')
  await press('Escape')
  assert.equal(await shown('.sent-on'), true)
  await run(`[...document.querySelectorAll('.sent-on button')].at(-1).click()`)
  await until('it to be put away', () => run(`document.querySelector('.sent-on') === null`))

  // An icon beside a term shows its definition, and Escape puts it away.
  assert.equal(await run(`Object.values(HELP).every(([name, text]) => name && text.endsWith('.'))`), true)
  await run(`location.hash = '#/health'`)
  await until('an icon', () => run(`document.querySelector('.tiles .info') !== null && opening === 0`))
  await run(`document.querySelector('.tiles .info').click()`)
  assert.deepEqual([await shown('#info'), (await text('#info')).startsWith('Issues')], [true, true])
  await press('Escape')
  assert.equal(await shown('#info'), false)

  // A text nobody has answered waits on the Board, and is gone from it once someone has.
  const texted = Date.now() - 3_600_000
  const lane = () => run(`document.querySelector('.board section[aria-label="Unanswered texts"]')?.innerText ?? ''`) as Promise<string>
  for (const n of [1, 2]) await recordText(graph, { id: `in-${n}`, from: '+17135550188', to: '+15550100001', at: texted + n, tags: { language: 'es' } })
  await run(`location.hash = '#/board'`)
  await until('the texts', async () => /1 person[^]*Unattributed · es[^]*2 unanswered/.test(await lane()))
  await recordText(graph, { id: 'out-1', direction: 'outbound', from: '+15550100001', to: '+17135550188', at: texted + 60_000 })
  await run(`load()`)
  await until('the texts to be gone', async () => (await run(`opening === 0`)) && (await lane()) === '')

  // Every view has a guide that goes forward, back and shut, and says where it is.
  for (const view of ['accounts', 'journey', 'board', 'decide', 'calls', 'channels', 'health']) {
    await run(`location.hash = '#/${view}'`)
    await until(`the lesson of ${view}`, () => run(`document.querySelector('[aria-current=page]').dataset.view === '${view}' && document.querySelector('.page-head .explain') !== null && opening === 0`))
    await run(`document.querySelector('.explain').click()`)
    const steps = (await run(`GUIDES['${view}'].steps.length`)) as number
    const passed = (await run(`(() => { const next = [...document.querySelectorAll('.lesson-foot button')].at(-1); const said = []; for (let i = 0; i < ${steps}; i++) { said.push(document.querySelector('.lesson-said').textContent); if (i < ${steps} - 1) next.click() } return [said, next.textContent] })()`)) as [string[], string]
    assert.deepEqual([new Set(passed[0]).size, passed[1]], [steps, 'Done'])
    await run(`document.querySelector('.lesson-foot button').click()`)
    assert.equal(await text('.lesson-foot .meta'), `${steps - 1} of ${steps}`)
    await press('Escape')
    await until('it to shut', () => run(`document.querySelector('dialog.lesson') === null`))
  }
  // Each thing a step places, and each line it draws, is in its guide.
  assert.deepEqual(await run(`Object.entries(GUIDES).flatMap(([view, { in: has, steps }]) => steps.flatMap(([, at, joins = []], i) => [...Object.keys(at), ...joins.flatMap(([a, b]) => [a, b].filter((id) => !at[id]).concat(a, b))].filter((id) => !has[id] || !at[id]).map((id) => view + ' ' + i + ' ' + id)))`), [])

  // A refund is named where the value changed, and has a column of its own.
  await graph.observe({ subject: 'lead:refund', identifiers: ['device:refund'], at: rang })
  await graph.outcome({ transactionId: 'refund-1', subject: 'lead:refund', at: rang, stage: 'enrolled', value: 200, currency: 'USD' })
  await graph.restate('refund-1', 150, 'USD', 'refund')
  await run(`location.hash = '#/journey/lead%3Arefund'`)
  await until('the refund', async () => (await text('#view')).includes('from 200 USD to 150 USD · Refund'))
  await run(`location.hash = '#/channels'`)
  await until('its column', () => run(`[...document.querySelectorAll('th')].some((th) => th.textContent === 'Refunded') && ![...document.querySelectorAll('th')].some((th) => th.textContent === 'Written off')`))

  const record = 'contact:dates'
  const related = 'contact:linked'
  const separated = 'contact:apart'
  const others = ['visitor:dates', 'caller:dates', 'call:dates']
  await graph.observe([record, related, separated, ...others].map((subject, i) => ({ subject, at: T0 + i, identifiers: [i < 2 ? 'email:dates' : 'device:' + subject] })))
  await store.write(async tx => {
    await tx.setCreatedAt(record, T0 - 100, T0, 'born')
    await tx.setCreatedAt(separated, T0 - 300, T0 + 2, 'apart')
  })
  for (const id of [separated, ...others]) await graph.separate(record, id)
  await run(`location.hash = '#/accounts/contact%3Adates'`)
  await until('the dates on the account', async () => (await text('#detail h3')) === record)
  const lines = (selector: string) => run(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(line => [line.firstChild.textContent.trim(), line.querySelector('time').dateTime, line.querySelector('time').title.endsWith(line.querySelector('time').dateTime)])`)
  const first = (at: number) => ['First seen here', new Date(at).toISOString(), true]
  const created = (at: number) => ['Created in your system', new Date(at).toISOString(), true]
  assert.deepEqual(await lines('#detail > section:first-child > .meta'), [first(T0), created(T0 - 100)])
  const row = (subject: string) => `.links td.who:has(a[title="${subject}"])`
  assert.deepEqual(await lines(row(related) + ' .meta'), [first(T0 + 1)])
  assert.deepEqual(await lines(row(separated) + ' .meta'), [first(T0 + 2), created(T0 - 300)])
  for (const id of others) {
    assert.ok((await text(row(id))).includes(id))
    assert.deepEqual(await lines(row(id) + ' .meta'), [])
  }

  await enter('service')
  await until('the service note', async () => (await text('#name')) === 'Service token')
})

test('a further page that fails is told on its own view and not on the next', { skip: without, timeout: 120_000 }, async (t) => {
  assert.ok(chrome, 'CI needs a browser')
  const graph = createGraph(createMemoryStore())
  await graph.observe([1, 2].map((n) => ({ subject: `account:${n}`, identifiers: [`email:${n}`], at: T0 })))
  const handler = createHandler(graph, { token: 'service', origins: [] })
  const server = createServer((request, response) => void handler(request, response)).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => (server.closeAllConnections(), void server.close()))
  const { run, close } = await browse(`http://127.0.0.1:${(server.address() as AddressInfo).port}/review#/accounts/account%3A1`)
  t.after(close)
  const text = (selector: string) => run(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`) as Promise<string>
  await until('the page', () => run(`typeof paged === 'function'`).catch(() => false))
  await run(`(() => { const t = document.getElementById('token'); t.value = 'service'; t.dispatchEvent(new Event('change')) })()`)
  await until('the account', async () => (await text('#detail h3')) === 'account:1')
  // A page asked for here, which fails only when the test says so.
  const ask = () => run(`(() => {
    const more = paged(document.createElement('table'), 'after', 'More', () => new Promise((_, fail) => { window.failPage = fail }))
    document.getElementById('view').append(more)
    more.querySelector('button').click()
  })()`)
  const fail = (message: string) => run(`window.failPage(new Error(${JSON.stringify(message)}))`)

  await ask()
  await until('the request', () => run(`typeof window.failPage === 'function'`))
  await fail('page one failed')
  await until('the problem', async () => (await text('#notice')).includes('page one failed'))

  await run(`window.failPage = undefined`)
  await ask()
  await until('the second request', () => run(`typeof window.failPage === 'function'`))
  await run(`location.hash = '#/accounts/account%3A2'`)
  await until('the other account', async () => (await text('#detail h3')) === 'account:2')
  await fail('page two failed')
  await pause(500)
  assert.equal((await text('#notice')).includes('page two failed'), false)
})

test('pairs among older sightings are reached from Matches, a page of records at a time', { skip: without, timeout: 120_000 }, async (t) => {
  assert.ok(chrome, 'CI needs a browser')
  let now = T0
  const store = createMemoryStore()
  const graph = createGraph(store, defaultPolicy, { now: () => now })
  await graph.observe(['account:old-1', 'account:old-2'].map((subject) => ({ subject, at: T0, identifiers: ['canvas:old'] })))
  // Ten thousand newer sightings, on a hundred records with nothing in common, push the old pair out of the recent queue.
  now++
  await store.write((tx) => tx.addSightings(Array.from({ length: 10_000 }, (_, i) => ({ subject: `a:${i % 100}`, identifier: `canvas:alone-${i % 100}`, at: T0, recorded: now }))))
  now++
  await graph.observe(['account:new-1', 'account:new-2'].map((subject) => ({ subject, at: T0, identifiers: ['canvas:new'] })))
  const handler = createHandler(graph, { token: 'service', origins: [] })
  const server = createServer((request, response) => void handler(request, response)).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => (server.closeAllConnections(), void server.close()))
  const { run, close } = await browse(`http://127.0.0.1:${(server.address() as AddressInfo).port}/review#/decide`)
  t.after(close)
  const text = (selector: string) => run(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`) as Promise<string>
  const inQueue = () => run(`[...document.querySelectorAll('.queue-pair .queue-names')].map((each) => each.textContent)`) as Promise<string[]>
  const press = (label: string) => run(`[...document.querySelectorAll('#view button')].find((each) => each.textContent === ${JSON.stringify(label)}).click()`)
  await until('the page', () => run(`typeof load === 'function'`).catch(() => false))
  await run(`(() => { const t = document.getElementById('token'); t.value = 'service'; t.dispatchEvent(new Event('change')) })()`)
  await until('the recent pair', async () => (await inQueue()).some((names) => names.includes('new-1')))
  assert.ok(!(await inQueue()).some((names) => names.includes('old-1')))
  assert.match(await text('#older'), /^Pairs among sightings before .+ are not in this queue\.Check older records$/)

  // The first hundred records have no pending pair. The next page has both.
  await press('Check older records')
  await until('the first records', async () => (await text('#older')).startsWith('Checking every record, a:0 to a:99.'))
  assert.equal(await text('#view .muted'), 'No pending matches in these records')
  await press('Next records')
  await until('the old pair', async () => (await inQueue()).some((names) => names.includes('old-1')))
  assert.match(await text('#older'), /^Checking every record, account:new-1 to account:old-2\. These are the last\.Back to recent$/)
  await press('Back to recent')
  await until('the recent queue again', async () => (await text('#older')).startsWith('Pairs among sightings before'))
})

test('Health says when sends are stopped, why, since when, and how to resume', { skip: without, timeout: 120_000 }, async (t) => {
  assert.ok(chrome, 'CI needs a browser')
  const store = createMemoryStore()
  const graph = createGraph(store)
  const ops = createOps(graph, store.ops, {})
  const handler = createHandler(graph, { token: 'service', origins: [], ops, sendsPaused: async () => ({ at: Date.now() - 120_000, reason: 'checking a wrong tie' }) })
  const server = createServer((request, response) => void handler(request, response)).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => (server.closeAllConnections(), void server.close()))
  const { run, close } = await browse(`http://127.0.0.1:${(server.address() as AddressInfo).port}/review#/health`)
  t.after(close)
  await until('the page', () => run(`typeof load === 'function'`).catch(() => false))
  await run(`(() => { const t = document.getElementById('token'); t.value = 'service'; t.dispatchEvent(new Event('change')) })()`)
  await until('the stop', () => run(`document.getElementById('view').textContent.includes('Sends to ad platforms are paused.')`))
  const said = (await run(`document.getElementById('view').textContent`)) as string
  assert.match(said, /checking a wrong tie\. Since .+\. Run account-graph sends resume once the cause is fixed\./)
})
