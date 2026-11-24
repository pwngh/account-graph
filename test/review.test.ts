import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createGraph, createMemoryStore, email, phone } from '../src/index.ts'
import { createHandler } from '../src/server.ts'

// The reviewer screen in a real browser, driven over Chrome's own debugging port.
const chrome = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((path) => path && existsSync(path))

const T0 = 1_700_000_000_000
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(what: string, look: () => Promise<T> | T, seconds = 10): Promise<NonNullable<T>> {
  for (let i = 0; i < seconds * 20; i++) {
    const found = await look()
    if (found) return found
    await pause(50)
  }
  throw new Error(`Waited ${seconds} seconds for ${what}`)
}

/** Opens an address in a browser of its own. `run` evaluates an expression in the page. */
async function browse(address: string) {
  const home = mkdtempSync(join(tmpdir(), 'ag-chrome-'))
  const browser = spawn(chrome!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${home}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', 'about:blank'], { stdio: 'ignore', detached: true })
  const gone = new Promise<void>((resolve) => browser.once('close', () => resolve()))
  const failed = new Promise<never>((_, reject) => browser.once('error', reject))
  failed.catch(() => {})
  const close = async () => {
    // Chrome is several processes. The whole group goes, and what they leave behind is the system's to clear.
    try {
      process.kill(-browser.pid!, 'SIGKILL')
      await gone
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    } catch {}
  }
  try {
    const at = join(home, 'DevToolsActivePort')
    const port = await Promise.race([failed, until('Chrome to start', () => existsSync(at) && readFileSync(at, 'utf8').split('\n')[0], 60)])
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(address)}`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string }
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => ((socket.onopen = resolve), (socket.onerror = reject)))
    const waiting = new Map<number, (answer: any) => void>()
    socket.onmessage = ({ data }) => {
      const answer = JSON.parse(String(data))
      waiting.get(answer.id)?.(answer)
    }
    let id = 0
    socket.onclose = () => waiting.forEach((answer) => answer({ result: { exceptionDetails: { text: 'Chrome went away' } } }))
    const send = (method: string, params: object) => new Promise<any>((resolve) => (waiting.set(++id, resolve), socket.send(JSON.stringify({ id, method, params }))))
    const run = async (expression: string) => {
      const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value
    }
    const press = async (key: string) => {
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 13, ...(type === 'keyDown' && key === 'Enter' && { text: '\r' }) })
    }
    return { run, press, close }
  } catch (error) {
    await close()
    throw error
  }
}

test('the reviewer screen signs with the token, keeps what was typed, and refuses an outdated decision', { skip: !chrome && !process.env.CI ? 'set CHROME to a Chrome or Chromium to run it' : false, timeout: 180_000 }, async (t) => {
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

  // Escape decides nothing. Signing out forgets the token and what was on screen.
  await keepApart('account:3')
  await press('Escape')
  await until('it to close', () => run(`!document.getElementById('ask').open`))
  assert.equal((await decisions()).length, taken)
  await run(`document.getElementById('leave').click()`)
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
  await pause(400)
  assert.deepEqual([...asked, await run('location.href')].filter((each) => /555|example\.com/.test(decodeURIComponent(each))), [])

  await enter('service')
  await until('the service note', async () => (await text('#name')).includes('carry no name'))
})
