import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A real browser, driven over Chrome's own debugging port. Undefined where there is none. */
export const chrome = process.env.CHROME

/** Only launch the browser chosen by the caller. */
export const without = !chrome ? 'set CHROME to a Chrome or Chromium to run it' : false

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export async function until<T>(what: string, look: () => Promise<T> | T, seconds = 10): Promise<NonNullable<T>> {
  for (let i = 0; i < seconds * 20; i++) {
    const found = await look()
    if (found) return found
    await pause(50)
  }
  throw new Error(`Waited ${seconds} seconds for ${what}`)
}

/** Opens an address in a browser of its own. `run` evaluates an expression in the page, and `send` asks Chrome itself. */
export async function browse(address: string) {
  const home = mkdtempSync(join(tmpdir(), 'ag-chrome-'))
  const browser = spawn(chrome!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${home}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-default-browser-check', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]', '--user-agent=Mozilla/5.0 (a test that is not a bot)', 'about:blank'], { stdio: 'ignore', detached: true })
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
    return { ...pageCommands(socket), close }
  } catch (error) {
    await close()
    throw error
  }
}

/** Run commands on an open DevTools connection. Each reply belongs to one pending request. */
export function pageCommands(socket: Pick<WebSocket, 'addEventListener' | 'send' | 'readyState'>) {
  const waiting = new Map<number, { resolve: (reply: any) => void, reject: (error: Error) => void }>()
  socket.addEventListener('message', event => {
    const reply = JSON.parse(String(event.data))
    const request = waiting.get(reply.id)
    if (!request) return
    waiting.delete(reply.id)
    request.resolve(reply)
  })
  socket.addEventListener('close', () => {
    for (const request of waiting.values()) request.reject(new Error('Chrome closed the debugging connection'))
    waiting.clear()
  })
  let sequence = 0
  async function send(method: string, params: object) {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Chrome closed the debugging connection')
    const id = ++sequence
    const reply = await new Promise<any>((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        waiting.delete(id)
        reject(error)
      }
    })
    if (reply.error) throw new Error(`${method}: ${reply.error.message} (${reply.error.code})`)
    if (!reply.result || typeof reply.result !== 'object') throw new Error(method + ': DevTools returned no result')
    return reply
  }
  async function run(expression: string) {
    const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    if (!result.result) throw new Error('Runtime.evaluate returned no evaluated value')
    return result.result.value
  }
  async function press(key: string) {
    const space = key === 'Space' || key === ' '
    const code = space ? 'Space' : key
    const text = space ? ' ' : key === 'Enter' ? '\r' : undefined
    const virtual = space ? 32 : key === 'Escape' ? 27 : 13
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: space ? ' ' : key, code, windowsVirtualKeyCode: virtual, ...(type === 'keyDown' && text && { text }) })
  }
  return { run, send, press }
}
