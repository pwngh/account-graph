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
    return { run, press, send, close }
  } catch (error) {
    await close()
    throw error
  }
}
