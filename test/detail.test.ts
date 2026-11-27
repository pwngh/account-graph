import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { LocalOptions } from '../src/index.ts'
import { internalsOf } from '../src/client/internals.ts'
import { HOUR, MINUTE, LINE, from, caller, firm, STORES, screen, written } from './cards.ts'
import { chrome, pause, until, without } from './chrome.ts'

// The detail cards of the reviewer screen, in a real browser, against what was recorded.
for (const [store, open] of Object.entries(STORES)) test(`every card is true to what was recorded, on ${store}`, { skip: without, timeout: 180_000 }, async (t) => {
  assert.ok(chrome, 'CI needs a browser')
  const [where, drop] = await open()
  const made = await firm(where)
  t.after(async () => { await made.close(); await drop() })
  const { start } = made
  const page = await screen(made.base)
  t.after(page.close)
  const ago = (hours: number) => start + Math.round(hours * HOUR)

  // Eight inbound calls count: two answered, three missed, one voicemail, one unknown and one waiting. One more is spam.
  const answered = await page.card('#/calls', 'calls.answered')
  assert.deepEqual([answered['Answered by a person'], answered['All inbound calls'], answered['Missed · voicemail'], answered['Waiting · unknown result'], answered['Previous 30 days'], answered['Weakest hour, of 5 calls or more']], ['2', '8', '3 · 1', '1 · 1', undefined, undefined])
  assert.deepEqual([await page.text('#card-title'), await page.text('#card .detail-worth'), await page.text('#card .detail-sum')], ['Answered', '25%', '25% = 2 answered ÷ 8 calls'])
  assert.match(await page.text('#card .detail-say'), /^Target 50%, set by you\. Not met: 2 more answered calls would reach it\./)
  const inbound = await page.card('#/calls', 'calls.inbound')
  assert.deepEqual([inbound['Inbound calls'], inbound['Not a lead, left out'], inbound['Missed, number withheld']], ['8', '1', '1'])
  // Two periods and twenty calls are what it takes to call something a range.
  assert.equal(Object.keys({ ...inbound, ...answered }).some((name) => name.startsWith('Your last')), false)
  const missed = await page.card('#/calls', 'calls.missed')
  assert.deepEqual([missed.Missed, missed.Voicemail, missed.Returned, missed['Called again'], missed['Number withheld'], missed['After hours'], missed['In open hours']], ['3', '1', '2', '0', '1', undefined, undefined])
  assert.equal(await page.text('#card .detail-sum'), '50% = 4 missed ÷ 8 calls')
  const returned = await page.card('#/calls', 'calls.returned')
  assert.deepEqual([returned.Returned, returned['Reported, with no call'], returned['Called again'], returned['Still open'], returned['Number withheld'], returned['Median time to return'], returned['Time limit']], ['2', '1', '0', '1', '1', '1 h', '24 h'])
  assert.match(await page.text('#card .detail-say'), /^Target 25% of those who could be called back, set by you\. Met\. Not compared with the days before/)
  const waits = await page.card('#/calls', 'calls.awaiting')
  assert.deepEqual([waits['Awaiting callback'], waits.Oldest, waits['Past the limit of 24 h'], waits.Voicemail, waits['Tried already'], waits['Credited to a source']], ['1', `${await written(page, ago(-50))} · 2 days 2 h ago`, '1', '1', '0', '1'])
  assert.match(await page.text('#card .detail-say'), /^Target 2 h by the clock, set by you\. Not met: 1 has waited longer\./)

  // Each row of Call results says how many, of what, and where they are listed.
  assert.deepEqual(await page.card('#/calls', 'calls.result Voicemail'), { Calls: '1', 'All inbound calls': '8', Share: '13%' })
  assert.deepEqual([await page.text('#card-title'), await page.text('#card .detail-sum'), (await page.links()).map(([text]) => text)], ['Voicemail', '13% = 1 voicemail ÷ 8 calls', ['View Missed Calls', 'Call Results, opens in a new tab']])
  assert.deepEqual(await page.card('#/calls', 'calls.result Returned'), { Calls: '2', 'Missed and voicemail': '4', Share: '50%' })
  assert.deepEqual([await page.text('#card .detail-sum'), (await page.links()).length], ['50% = 2 returned ÷ 4 missed', 1])
  assert.match(await page.text('#card .detail-say'), /^Not compared with the days before/)
  assert.deepEqual(await page.card('#/calls', 'calls.result Not a lead'), { Calls: '1' })
  assert.match(await page.text('#card .detail-say'), /^Calls marked as not a lead are left out of every other count\./)

  // The five states, in the list and in a journey. Nothing is said where nothing is known.
  const listed = await page.card('#/calls', 'call bea-1 list')
  assert.deepEqual(listed, { Called: await written(page, ago(-50), true), 'How we know': `Reported, ${await written(page, ago(-50))}`, 'Duration · wait': '40 s · 20 s', Returned: 'Not yet, 2 days 2 h so far', 'Time limit': '24 h · late by 26 h', 'Came from': 'listing · Map listing', 'Tied by': 'The number they dialed' })
  assert.deepEqual([await page.text('#card-title'), await page.text('#card .detail-worth')], ['Voicemail', 'Inbound'])
  const ada = `#/journey/${encodeURIComponent('contact:ada')}`
  assert.deepEqual(await page.card(ada, 'call ada-1 timeline'), {
    Called: await written(page, ago(-72 + 2 / 60), true), 'How we know': `Reported, ${await written(page, ago(-72 + 4 / 60))}`, 'They waited': '95 s, the whole call',
    Returned: `${await written(page, ago(-72 + 2 / 60 + 4 + 20 / 60))} · 4 h 20 min`, 'Attempts before that': '1', 'Time limit': '24 h · inside it',
    'Came from': 'google · North | Family law | Search', 'Tied by': 'Tap to call, one visitor', Language: 'es', 'Same caller': '1 earlier',
  })
  assert.deepEqual((await page.links()).map(([text]) => text), ['Show Return Call', 'Call Results, opens in a new tab'])
  assert.match(await page.text('#card .detail-say'), /^Missed means nobody spoke to them and they left no voicemail\. Returned means/)
  assert.deepEqual(await page.card(ada, 'call ada-0 timeline'), { Called: await written(page, ago(-80), true), 'How we know': `Reported, ${await written(page, ago(-80))}`, 'Duration · wait': '120 s · 12 s', 'Came from': 'listing · Map listing', 'Tied by': 'The number they dialed', Language: 'es', 'Same caller': `next ${await written(page, ago(-72 + 2 / 60))}` })
  assert.equal((await page.card(ada, 'call ada-2 timeline'))['How we know'], `Reported, ${await written(page, ago(-70))}`)
  assert.deepEqual([await page.text('#card-title'), await page.text('#card .detail-worth')], ['Call not answered', 'Outbound'])
  for (const [n, id, title, how, rest] of [[15, 'eli-1', 'Call with no result', 'No result was sent', { Duration: '60 s' }], [18, 'gus-1', 'Call waiting for a result', 'No result yet', { Duration: '10 s' }], [14, 'dee-1', 'Answered call', `Reported, ${await written(page, ago(-20))}`, { 'Duration · wait': '300 s · 12 s' }]] as const) {
    const { Called: _, ...said } = await page.card(`#/journey/${encodeURIComponent(caller(n))}`, `call ${id} timeline`)
    assert.deepEqual(said, { 'How we know': how, ...rest, 'Came from': 'listing · Map listing', 'Tied by': 'The number they dialed' })
    assert.equal(await page.text('#card-title'), title)
  }
  const told = await page.card(`#/journey/${encodeURIComponent(caller(13))}`, 'call cal-1 timeline')
  assert.deepEqual([told.Returned, told['Time limit'], (await page.links()).length], [`${await written(page, ago(-27))} · 1 h · reported, with no call`, '24 h · inside it', 1])
  const hidden = await page.card(`#/journey/${encodeURIComponent('call:hid-1')}`, 'call hid-1 timeline')
  assert.deepEqual([hidden.Returned, hidden['Time limit'], hidden['Same caller'], hidden.Duration], ['Number withheld', undefined, undefined, '15 s'])

  // The board: where somebody stands and since when, how late, and what brought them there.
  const person = await page.card('#/board/90', 'board.person contact:ada')
  const day = (at: number) => page.run(`new Date(${at}).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })`)
  assert.deepEqual(person, {
    'At this step since': `${await written(page, ago(-67))} · 2 days 19 h`, 'Limit for inquiry': '2 days · overdue by 19 h', Reached: `call ${await day(ago(-80))} → inquiry ${await day(ago(-67))}`, 'Next step': 'client',
    Value: '25 USD · at first 10 USD', 'Last call': `Outbound, answered, ${await written(page, ago(-72 + 2 / 60 + 4 + 20 / 60))}`, 'First visit': `${await day(ago(-72))} · google · North | Family law | Search`,
    IDs: person.IDs, 'Consent for ads': 'measurement granted, personalization denied',
  })
  assert.match(person.IDs!, /^3 · strongest \d+%/)
  const waiting = await page.card('#/board/90', `board.person ${caller(12)}`)
  assert.deepEqual([waiting['Waiting since'], waiting['Limit for a call back'], waiting['Last call'], waiting['Credited to'], waiting['First visit']], [`${await written(page, ago(-50))} · 2 days 2 h`, '24 h · overdue by 26 h', `Inbound, voicemail, ${await written(page, ago(-50))}`, 'listing · Map listing', undefined])
  assert.deepEqual((await page.links()).map(([text, href]) => [text, href]), [['Open Journey', `#/journey/${encodeURIComponent(caller(12))}`], ['Account', `#/accounts/${encodeURIComponent(caller(12))}`], ['Show Missed Call', `#/journey/${encodeURIComponent(caller(12))}/bea-1`]])
  const texted = await page.card('#/board/90', `board.text ${caller(17)}`)
  assert.deepEqual(texted, { 'Texts waiting': '2', 'Came from': 'listing · Map listing', Tags: 'language: es', 'First of them': `${await written(page, ago(-3) + MINUTE)} · 2 h 59 min ago`, Latest: `${await written(page, ago(-3) + 2 * MINUTE)} · 2 h 58 min ago` })
  const overdue = await page.card('#/board/90', 'board.overdue')
  assert.deepEqual([overdue['Missed calls'], overdue.inquiry], ['1 of 1 over 24 h', '1 of 1 over 2 days'])
  for (const name of ['people', 'fresh', 'advanced']) assert.ok(await page.card('#/board/90', `board.${name}`))

  // A feed nobody watches is said to be that, with the setting that would watch it.
  const calls = await page.card('#/health', 'health.feed calls')
  assert.deepEqual([calls['Last record'], calls.Limit, calls.Counted, calls['Set by']], [await written(page, ago(-0.05)), '12 h · 11 h 57 min left', 'Around the clock', 'QUIET_CALLS_HOURS'])
  const unwatched = await page.card('#/health', 'health.feed touches')
  assert.deepEqual([await page.text('#card .detail-worth'), unwatched.Limit, unwatched['Not set']], ['Not monitored', undefined, 'QUIET_TOUCHES_HOURS'])
  assert.match(await page.text('#card .detail-say'), /Set QUIET_TOUCHES_HOURS to a number of hours/)
  assert.equal((await page.card('#/health', 'health.feed costs'))['Last record'], 'None yet')

  // The chart beside: every kind of event has rows, and what was asked for of a sighting is there.
  await page.go(ada)
  const kinds = (await page.run(`Object.keys(WHAT).filter((kind) => document.querySelector('.chart .lane.' + kind))`)) as string[]
  assert.deepEqual(kinds, ['visit', 'sighting', 'call', 'text', 'link', 'outcome', 'value', 'consent', 'decision'])
  const panels: Record<string, Record<string, string>> = {}
  await page.run(`charted.zoom = 'Day'; load()`)
  await until('the day', () => page.run(`opening === 0 && !document.querySelector('.chart .heap')`))
  for (const kind of kinds) {
    await page.run(`document.querySelector('.chart .lane.${kind} .mark').click()`)
    await until(`the panel of ${kind}`, () => page.run(`!document.querySelector('.chart .told').hidden && !document.querySelector('.chart .told .waiting-lines')`))
    panels[kind] = await page.says('.chart .told')
    assert.match(panels[kind]!.UTC!, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
  }
  // Seen with the browser the contact was seen with, which the account says and the journey does not.
  assert.equal(panels.sighting!['IDs sharing this device'], '2')
  assert.deepEqual(panels.value!, { ...panels.value, From: '10 USD', To: '25 USD', Outcome: `inquiry, ${await written(page, ago(-67))}` })
  assert.deepEqual([panels.consent!['Ad measurement'], panels.consent!.Source, panels.link!.Purpose, panels.link!.Opened, panels.link!['Still valid'], panels.text!.Text, panels.decision!.By, panels.decision!.Reason], ['Granted', 'banner', 'form', 'Not opened', 'No', 'Sent', 'system desk', 'answered by staff'])

  // Nothing a card says is a number of anybody's, or an identifier.
  const everything = JSON.stringify([answered, inbound, missed, returned, waits, listed, told, hidden, person, waiting, texted, overdue, panels])
  assert.doesNotMatch(everything, /\+1555|tel:|phone:|device:|dialed:|click-1|[?&]q=/)
})

test('every card survives nothing known, and every link of one leads somewhere', { skip: without, timeout: 120_000 }, async (t) => {
  const made = await firm({ memory: true } as Partial<LocalOptions>)
  t.after(made.close)
  const page = await screen(made.base)
  t.after(page.close)
  // Each place on each page names a card there is.
  const places = new Set<string>()
  for (const hash of ['#/calls', '#/board/90', '#/health', `#/journey/${encodeURIComponent('contact:ada')}`]) {
    await page.go(hash)
    const found = (await page.run(`[...document.querySelectorAll('[data-key^="detail "]')].map((each) => each.about.key)`)) as string[]
    assert.ok(found.length > 0, hash)
    for (const each of found) places.add(each)
  }
  const keys = (await page.run(`Object.keys(DETAILS)`)) as string[]
  assert.deepEqual([...places].filter((key) => !keys.includes(key)), [])
  assert.deepEqual(keys.filter((key) => !places.has(key) && key !== 'chart.mark' && key !== 'chart.number').sort(), [])
  // Asked of nothing, of empty data, and of every part of it missing, none breaks, and none shows a row of nothing.
  const broken = await page.run(`(async () => {
    const bad = []
    const empty = (kind) => ({ kind, at: 1, subject: 's', identifiers: null, call: {}, text: {}, link: {}, outcome: {}, touch: {}, answer: {}, decision: {} })
    const data = [undefined, {}, { summary: null, then: null, open: null, board: null, goals: null, limits: null, row: null, feed: null, text: null, call: null, entry: null, list: null },
      { summary: {}, then: {}, open: {}, board: { columns: [] }, goals: {}, limits: {}, row: { subject: 's', at: 1 }, feed: { name: 'calls' }, text: { subject: 's', at: 1 }, call: { id: 'c', subject: 's', at: 1 }, list: [] },
      { summary: { total: { calls: 0, answered: 0, missed: 0, voicemail: 0 }, cells: [], closed: null, returnedWithin: null }, open: { calls: [], next: null, at: 1 }, board: { at: 1, columns: [{ step: null, wait: null, people: 0, fresh: 0, late: null, done: null, rows: [] }] }, row: { subject: 's', at: 1, value: null }, column: null },
      ...Object.keys(WHAT).flatMap((kind) => [{ entry: { kind, at: 1, subject: 's' }, entries: [], ties: {}, at: 1 }, { entry: empty(kind), entries: [empty(kind)], ties: {}, at: 2, limits: null }])]
    for (const [key, { now }] of Object.entries(DETAILS)) for (const each of data) for (const short of [false, true]) {
      try {
        const said = now(each, short)
        for (const [name, value] of said?.rows ?? []) if (isKnown(value) && /NaN|undefined|null|Invalid/.test(name + (value.textContent ?? value))) bad.push(key + ': ' + name + ' ' + value)
      } catch (error) { bad.push(key + ' ' + JSON.stringify(each) + ' ' + error.stack) }
    }
    const real = api
    for (const [key, { more }] of Object.entries(DETAILS)) for (const each of data.slice(0, 2)) try { await more?.(each) } catch (error) { bad.push(key + ' more ' + error.stack) }
    // A journey with nothing in it.
    for (const key of ['call', 'board.person', 'board.text']) { lately.set('/journey?subject=s', { at: Date.now(), answer: Promise.resolve({ entries: [], subjects: {}, next: null, more: 0 }) }); try { await DETAILS[key].more(data[3]) } catch (error) { bad.push(key + ' more ' + error.stack) } }
    lately.clear()
    return bad
  })()`)
  assert.deepEqual(broken, [])
  // A link that leads out of the screen and the project's own pages is not shown.
  assert.deepEqual(await page.run(`['#/calls', DOCS + 'calls.md', 'https://elsewhere.example', 'javascript:x', '//x', undefined].map(linkable)`), [true, true, false, false, false, false])
  const anchors = new Map<string, Set<string>>()
  for (const name of ['calls', 'operations', 'report']) anchors.set(name, new Set([...readFileSync(new URL(`../docs/${name}.md`, import.meta.url), 'utf8').matchAll(/^#+ (.+)$/gm)].map((match) => match[1]!.toLowerCase().replace(/[^\w -]/g, '').replaceAll(' ', '-'))))
  const views = (await page.run(`[...views.keys()]`)) as string[]
  let seen = 0
  for (const [hash, names] of [['#/calls', ['calls.inbound', 'calls.answered', 'calls.missed', 'calls.returned', 'calls.awaiting', 'calls.result Missed', 'call bea-1 list']], ['#/board/90', ['board.people', 'board.overdue', 'board.fresh', 'board.advanced', 'board.person', 'board.text']], ['#/health', ['health.feed calls']], [`#/journey/${encodeURIComponent('contact:ada')}`, ['call ada-1 timeline', 'chart.wait']]] as const) for (const name of names) {
    await page.card(hash, name)
    for (const [, href, target, rel] of await page.links()) {
      seen += 1
      if (href!.startsWith('#/')) assert.ok(views.includes(href!.split('/')[1]!), href)
      else {
        const [file, anchor] = href!.slice('https://github.com/pwngh/account-graph/blob/main/docs/'.length).split('#')
        assert.ok(anchors.get(file!.replace('.md', ''))?.has(anchor!), href)
        assert.deepEqual([target, rel], ['_blank', 'noopener'])
      }
    }
  }
  assert.ok(seen >= 20)
})

test('a card opens, closes, stays through a refresh, and says when something is not available', { skip: without, timeout: 180_000 }, async (t) => {
  const made = await firm({ memory: true } as Partial<LocalOptions>)
  t.after(made.close)
  const page = await screen(made.base)
  t.after(page.close)
  const { run, key, shown, hinted, focused, find, text } = page
  assert.deepEqual(await run(`[goals, limits]`), [{ answered: 0.5, returned: 0.25, callbackHours: 2 }, { returnHours: 24, openHours: false }])

  // By a click, Enter and Space. The focus goes into the card, and back to its icon.
  await page.go('#/calls')
  assert.deepEqual(await run(`(() => { const n = ${find('calls.answered')}; return [n.getAttribute('aria-label'), n.getAttribute('aria-haspopup'), n.getAttribute('aria-expanded')] })()`), ['Details of Answered, 25%', 'dialog', 'false'])
  for (const way of ['click', 'Enter', ' ']) {
    if (way === 'click') await page.click(find('calls.answered'))
    else {
      await run(`${find('calls.answered')}.focus()`)
      await key(way)
    }
    await page.settled()
    assert.deepEqual([await focused(), await run(`${find('calls.answered')}.getAttribute('aria-expanded')`), await run(`[$('card').getAttribute('role'), $('card').getAttribute('aria-modal'), $($('card').getAttribute('aria-labelledby')).textContent]`)], ['card', 'true', ['dialog', null, 'Answered']])
    await key('Escape')
    assert.deepEqual([await shown(), await focused(), await run(`${find('calls.answered')}.getAttribute('aria-expanded')`)], [false, 'detail calls.answered ', 'false'])
  }
  // A second press closes it, and so do the close button and a press elsewhere. Another icon closes the first.
  for (const close of [() => page.click(find('calls.answered')), () => page.click(`document.querySelector('#card .detail-shut')`), () => page.click(`document.querySelector('.page-title')`)]) {
    await page.click(find('calls.answered'))
    assert.equal(await shown(), true)
    await close()
    assert.deepEqual([await shown(), await focused()], [false, 'detail calls.answered '])
  }
  await page.click(find('calls.answered'))
  await page.click(find('calls.inbound'))
  assert.deepEqual([await text('#card-title'), await run(`[...document.querySelectorAll('#view [aria-expanded=true]')].map((each) => each.dataset.key)`)], ['Inbound calls', ['detail calls.inbound ']])
  // Tabbed out of either end, the focus is back at its icon.
  await page.settled()
  await key('Tab', true)
  assert.equal(await focused(), 'detail calls.inbound ')
  // A help icon still has its own words, and the card goes when it is pressed.
  await page.click(`document.querySelector('.tiles .info')`)
  assert.deepEqual([await shown(), (await text('#info')).startsWith('Inbound calls')], [false, true])
  await key('Escape')
  // Leaving the page closes it.
  await page.click(find('calls.inbound'))
  await run(`location.hash = '#/health'`)
  await until('it to close', async () => !(await shown()))

  // Read again by itself, the page has other numbers, and the card has them too, and keeps the keyboard.
  await page.go('#/calls')
  await page.click(find('calls.answered'))
  await page.settled()
  await run(`document.querySelector('#card .detail-links a').focus()`)
  made.at(0.01)
  await made.call('new-1', 19, { duration: 200, result: { answered: true, waited: 5 } })
  await run(`look()`)
  await until('the new numbers', async () => (await page.says())['All inbound calls'] === '9')
  assert.deepEqual([await shown(), await text('#card .detail-worth'), await text('#card .detail-sum'), await focused(), await run(`${find('calls.answered')}.getAttribute('aria-expanded')`)], [true, '33%', '33% = 3 answered ÷ 9 calls', 'View Missed Calls', 'true'])
  // It is the new icon it goes back to.
  await key('Escape')
  assert.equal(await focused(), 'detail calls.answered ')
  // Where what it is of is gone, so is the card.
  await page.click(find('call bea-1 list'))
  await page.settled()
  made.at(0.02)
  await made.record({ type: 'call', key: 'bea-2', direction: 'outbound', from: LINE, to: from(12), duration: 100, result: { answered: true } })
  await run(`look()`)
  await until('it to go', async () => !(await shown()))

  // What has to be asked for shows that it waits, says what went wrong, and can be asked again.
  await page.go('#/board/90')
  await run(`(() => { lately.clear(); const real = window.fetch; window.up = () => (window.fetch = real); window.down = true; window.fetch = async (...all) => { if (String(all[0]).includes('/journey')) { await new Promise((done) => (window.release = done)); if (window.down) return new Response('{"error":"The database is away"}', { status: 503, headers: { 'content-type': 'application/json' } }) } return real(...all) } })()`)
  await page.click(find('board.person contact:ada'))
  assert.ok(await run(`document.querySelectorAll('#card .waiting-lines i').length === 3 && document.querySelectorAll('#card .detail-rows > div').length === 2`))
  await run(`window.release()`)
  await until('the problem', async () => (await text('#card .detail-failed')).startsWith('Not available: The database is away'))
  assert.match((await page.says())['Limit for inquiry']!, /^2 days · overdue by 19 h/)
  await run(`window.down = false`)
  await page.click(`document.querySelector('.detail-failed button')`)
  await until('it to wait again', () => run(`document.querySelector('#card .waiting-lines') !== null && document.querySelector('.detail-failed') === null`))
  await run(`window.release()`)
  await page.settled()
  assert.deepEqual([(await page.says())['Next step'], await focused()], ['client', 'card'])
  // Asked within the minute, it is not asked again.
  await key('Escape')
  await run(`window.release = undefined`)
  await page.click(find('board.person contact:ada'))
  await page.settled()
  assert.equal(await run(`window.release === undefined`), true)
  await run(`void window.up()`)
  // Its links open in place, and one of a part of the page brings that into view.
  await page.click(`[...document.querySelectorAll('#card a')].find((a) => a.textContent === 'Account')`)
  await until('the account', () => run(`location.hash === '#/accounts/contact%3Aada' && opening === 0`))
  assert.equal(await shown(), false)
  await page.go('#/calls')
  await page.click(find('calls.answered'))
  await page.settled()
  await page.click(`[...document.querySelectorAll('#card a')].find((a) => a.textContent === 'Calls by Hour')`)
  await until('the hours', async () => (await focused()) === 'calls-hours')
  await page.go('#/journey/contact%3Aada')
  // The view read again under a pointer that rests on an icon, before the press or between the press and its release, as a late change of address does. The press still opens its card. A pulse right after it reads the view again, and the card stays with the new icon.
  const icon = find('call ada-1 timeline')
  await run(`(() => { const real = window.fetch; window.up = () => (window.fetch = real); window.fetch = async (...all) => { if (String(all[0]).includes('/journey')) await new Promise((done) => (window.release = done)); return real(...all) } })()`)
  const reread = async (start: string) => {
    await run(`window.old = ${icon}; window.release = undefined; ${start}`)
    await until('the journey to be asked', () => run(`typeof window.release === 'function'`))
    await run(`window.release()`)
    await until('the view read again', () => run(`!old.isConnected && pending === 0`))
  }
  const late = `dispatchEvent(new HashChangeEvent('hashchange'))`
  const expanded = async () => [await shown(), await text('#card-title'), await run(`${icon}.getAttribute('aria-expanded')`)]
  for (const pressed of [false, true]) {
    let [x, y] = await page.middle(icon)
    await page.mouse('mouseMoved', x, y)
    if (!pressed) {
      await reread(late)
      // The view read again may lay out a pixel or two apart, because scrollbars and fonts differ by system. The pointer goes to where the icon now is.
      const [nx, ny] = await page.middle(icon)
      if (nx !== x || ny !== y) console.error(`the icon moved from ${x},${y} to ${nx},${ny} when the view was read again`)
      ;[x, y] = [nx, ny]
      await page.mouse('mouseMoved', x, y)
    }
    await page.mouse('mousePressed', x, y)
    if (pressed) await reread(late)
    await page.mouse('mouseReleased', x, y)
    await page.settled()
    assert.deepEqual(await expanded(), [true, 'Missed call', 'true'], pressed ? 'pressed' : 'resting')
    if (!pressed) await key('Escape')
  }
  await reread(`beat = undefined; void look()`)
  await page.settled()
  assert.deepEqual(await expanded(), [true, 'Missed call', 'true'])
  await run(`void window.up()`)
  await page.click(`[...document.querySelectorAll('#card a')].find((a) => a.textContent === 'Show Return Call')`)
  await until('the return call', () => run(`location.hash.endsWith('/ada-3') && document.querySelector('.timeline-entry.found')?.textContent.includes('410 s')`))

  // The list of missed calls is walked with the arrow keys, and its icon opens without choosing another.
  await made.call('ivy-1', 10, { duration: 20, result: { answered: false } })
  await page.go('#/calls')
  assert.equal(await run(`document.querySelector('.inbox-list').getAttribute('role') + [...document.querySelectorAll('.inbox-call')].map((each) => each.getAttribute('role')).join()`), 'gridrow')

  // On the chart: pointed at, a mark says what it is and stays while the card is pointed at. Escape hides it.
  await page.go('#/journey/contact%3Aada')
  // The visit from the ad. The one before it is a number dialed.
  const mark = `document.querySelectorAll('.chart .lane.visit .mark')[1]`
  const away = () => page.mouse('mouseMoved', 600, 20)
  const point = async (node: string) => {
    const [x, y] = await page.middle(node)
    await away()
    await until('nothing shown', async () => !(await hinted()))
    await page.mouse('mouseMoved', x, y)
    const began = Date.now()
    await until('the short card', hinted)
    return Date.now() - began
  }
  await point(mark)
  assert.deepEqual([await text('#hint b'), (await page.says('#hint')).Campaign, await run(`document.querySelectorAll('#hint button, #hint a').length`), await run(`${mark}.getAttribute('aria-describedby')`)], ['Visit', 'North | Family law | Search', 0, 'hint'])
  const [hx, hy] = await run(`(() => { const r = $('hint').getBoundingClientRect(); return [r.x + 60, r.y + 30] })()`)
  await page.mouse('mouseMoved', hx, hy)
  await pause(400)
  assert.equal(await hinted(), true)
  await key('Escape')
  assert.equal(await hinted(), false)
  // Moved off, it goes. A mark that comes to stand under a pointer at rest shows nothing.
  await point(mark)
  await away()
  await until('it to go', async () => !(await hinted()))
  // By the keyboard it comes with the focus and goes with it.
  await run(`(() => { document.querySelector('.chart .track').focus() })()`)
  for (let i = 0; i < 12 && !(await run(`document.activeElement === ${mark}`)); i++) await key('Tab')
  await until('it by the keyboard', hinted)
  await key('Tab')
  assert.equal(await run(`document.activeElement === ${mark}`), false)
  await until('that of the next', async () => (await text('#hint b')) !== 'Visit')
  // A number says what it holds, and the wait from when to when.
  await run(`document.activeElement.blur()`)
  await point(`document.querySelector('.chart .heap')`)
  assert.match(await text('#hint b'), /^\d+ [a-z ]+$/)
  assert.ok(Object.keys(await page.says('#hint')).length > 0)
  await point(`document.querySelector('.chart .wait')`)
  assert.equal(await text('#hint b'), 'Returned after 4 h 20 min')
  await page.click(`document.querySelector('.chart .wait')`)
  await page.settled()
  assert.deepEqual([await hinted(), (await page.says())['Attempts before that'], (await page.links()).map(([words]) => words)], [false, '1', ['Missed Call', 'Return Call']])
  // Read again by itself, the chart is drawn anew, and the card of a wait on it stays.
  made.at(0.04)
  await made.call('new-2', 21, { duration: 5, result: { answered: true } })
  await run(`window.old = document.querySelector('.chart .wait'); look()`)
  await until('the new chart', () => run(`!window.old.isConnected && document.querySelector('.chart .wait') !== null`))
  await pause(300)
  assert.deepEqual([await shown(), await run(`document.querySelector('.chart .wait').getAttribute('aria-expanded')`)], [true, 'true'])
  await page.click(`[...document.querySelectorAll('#card a')].find((a) => a.textContent === 'Return Call')`)
  assert.match(await text('.chart .told'), /Outbound.*Answered/)
  // Pressed, a mark opens beside the chart as before, and does not say the same twice.
  await page.click(mark)
  await until('the mark pressed', () => run(`${mark}.getAttribute('aria-pressed') === 'true'`))
  assert.deepEqual([await hinted(), (await page.says('.chart .told'))['Ad group'], (await page.says('.chart .told')).Referrer, await run(`${mark}.getAttribute('aria-pressed')`)], [false, 'g-7', 'search.example.org', 'true'])

  // Both color schemes: every word of a card can be read.
  for (const scheme of ['dark', 'light']) {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await page.go('#/board/90')
    await page.click(find('board.person contact:ada'))
    await page.settled()
    await pause(250)
    const poor = await run(`(() => {
      const light = (color) => { const [r, g, b] = color.match(/[\\d.]+/g).map(Number).map((n) => n / 255).map((n) => (n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
      const under = light(getComputedStyle($('card')).backgroundColor)
      return [...document.querySelectorAll('#card dt, #card dd, #card p, #card b, #card a, #card h4, #card .detail-worth, #card .detail-shut')].map((node) => [node.className || node.tagName, light(getComputedStyle(node).color)]).map(([name, over]) => [name, (Math.max(over, under) + 0.05) / (Math.min(over, under) + 0.05)]).filter(([, ratio]) => ratio < 4.5)
    })()`)
    assert.deepEqual(poor, [], scheme)
    await key('Escape')
  }
  // Colors the reader forces keep the border.
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
  await page.click(find('board.person contact:ada'))
  assert.equal(await run(`getComputedStyle($('card')).borderTopStyle + getComputedStyle($('card')).borderTopWidth`), 'solid1px')
  await key('Escape')
  await page.send('Emulation.setEmulatedMedia', { features: [] })

  // On a phone a tap opens it at the foot, as wide as the screen, and nothing hovers. The page is no wider than it was.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  const tap = async (node: string) => {
    const [x, y] = await page.middle(node)
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  for (const [hash, name] of [['#/calls', 'calls.answered'], ['#/board/90', 'board.person contact:ada'], ['#/health', 'health.feed costs'], ['#/journey/contact%3Aada', 'call ada-1 timeline']] as const) {
    await page.go(hash)
    await tap(find(name))
    await page.settled()
    await pause(250)
    assert.deepEqual(await run(`(() => { const r = $('card').getBoundingClientRect(); return [r.left, Math.round(r.width), Math.round(r.bottom), document.documentElement.scrollWidth <= 390] })()`), [0, 390, 844, true], hash)
    assert.ok((await run(`(() => { const r = getComputedStyle(${find(name)}, '::after'); return parseFloat(r.width) })()`)) >= 24)
    await tap(`document.querySelector('#card .detail-shut')`)
    await until('it to close', async () => !(await shown()))
  }
  await tap(`document.querySelector('.chart .lane.visit .mark')`)
  await pause(400)
  assert.deepEqual([await hinted(), await run(`document.querySelector('.chart .told').hidden`)], [false, false])

  // Signed out, nothing of it is left.
  await tap(`document.querySelector('.chart .told .shut')`)
  await run(`$('leave').click()`)
  assert.deepEqual([await shown(), await run(`lately.size`)], [false, 0])
  // Asked for by whoever signs in, what they set themselves is the server's answer.
  const internals = internalsOf(made.graph)!
  assert.deepEqual((await internals()).options.targets, { answered: 0.5, returned: 0.25, callbackHours: 2 })
})
