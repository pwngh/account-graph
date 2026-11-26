import type { PageRules } from './collect.ts'
import { existsSync, readFileSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * The JavaScript of one of this package's browser modules. A built package
 * has it next to this file; a checkout has only the TypeScript, which Node
 * can strip to JavaScript without a build.
 */
function browserModule(name: string): string {
  const built = fileURLToPath(new URL(`./${name}.js`, import.meta.url))
  if (existsSync(built)) return readFileSync(built, 'utf8')
  const source = readFileSync(fileURLToPath(new URL(`./${name}.ts`, import.meta.url)), 'utf8')
  const strip = (nodeModule as { stripTypeScriptTypes?: (code: string) => string }).stripTypeScriptTypes
  if (!strip) throw new Error('Serving the collector from a checkout requires Node 22.13 or later; run `npm run build` instead')
  return strip(source)
}

/**
 * Appended to the collector when it is served as a script tag. The script
 * finds its own address, so the tag needs no configuration: it reports to the
 * server it was loaded from. Options ride on the address:
 *   collect.js?fingerprint=PUBLIC_KEY&region=eu    confirm visitors with Fingerprint
 *   collect.js?canvas=open                         add the open-source FingerprintJS id
 *   collect.js?params=mailing,placement            keep address parameters of your own
 *   collect.js?domains=shop.example,help.example   carry the visitor along links to your other sites
 *   collect.js?forms=all                           add the device id and landing page to every form
 *   collect.js?pool=1                              show this visitor a number of their own in elements marked data-ag-pool
 *   collect.js?text=1                              put this visitor's code in text links, and in elements marked data-ag-code
 * Set `window.accountGraphConsent = { adUserData, adPersonalization }` before
 * the tag to pass a consent banner's answer. Once loaded, the page can call
 * `accountGraph.event('inquiry')`, and taps on phone links and on elements
 * marked `data-ag-event` are reported without any code.
 */
const run = (server: PageRules, classic: boolean) => `
{
  const self = new URL(${classic ? 'document.currentScript.src' : 'import.meta.url'})
  const list = name => self.searchParams.getAll(name).flatMap(value => value.split(',').filter(Boolean))
  const rules = ${JSON.stringify({ ...(server.origins?.length && { origins: server.origins }), ...(server.allowPages && { allowPages: server.allowPages }), ...(server.refusePages && { refusePages: server.refusePages }) })}
  if (!hasPageRules(rules)) {
    for (const name of ['allowPages', 'refusePages']) if (self.searchParams.has(name)) rules[name] = list(name)
  }
  const requireConsent = self.searchParams.get('consent') === 'required'
  const initialConsent = globalThis.accountGraphConsent
  const answer = () => requireConsent ? globalThis.accountGraphConsent : initialConsent
  const options = { ...rules, endpoint: new URL('collect', self).href, requireConsent,
    ...(self.searchParams.has('events') && { events: list('events') }),
    params: list('params'), domains: list('domains'), get consent() { return answer() } }
  const helper = () => import(new URL('fingerprint.js', self).href)
  const key = self.searchParams.get('fingerprint')
  const region = self.searchParams.get('region')
  const endpoints = self.searchParams.get('endpoints')
  if (key) options.fingerprintEvent = active => helper().then(m => active() ? m.fingerprintEvent({ apiKey: key, ...(region && { region }), ...(endpoints && { endpoints }) }, active) : undefined)
  if (self.searchParams.get('canvas') === 'open') options.canvas = active => helper().then(m => active() ? m.openFingerprint(active) : undefined)

  let path
  let visit = options
  let stop = () => {}
  const refresh = () => {
    const here = ready(options) ? new URL(location.href).pathname : undefined
    if (here === path) return
    path = here
    stop()
    visit = options
    if (here === undefined) return
    // A reply that crosses a navigation belongs to the page that asked.
    const controller = new AbortController()
    visit = { ...options, signal: controller.signal, get consent() { return answer() } }
    collect(visit).catch(() => undefined)
    const stops = [watch(visit), fill({ ...visit, all: self.searchParams.get('forms') === 'all', get consent() { return answer() } })]
    if (self.searchParams.get('pool')) stops.push(pool(visit))
    if (self.searchParams.get('text')) stops.push(texts(visit))
    if (options.domains.length) stops.push(carry(visit))
    stop = () => {
      controller.abort()
      for (const end of stops) end()
    }
  }
  globalThis.accountGraph = { event: (name, detail) => event(visit, name, detail).catch(() => undefined),
    fields: form => fields(options.consent, form, options), refresh }
  ${classic ? `let storageGranted = false
  options.storageGranted = () => storageGranted
  globalThis.accountGraph.setStorageGranted = granted => {
    storageGranted = granted === true
    refresh()
    return true
  }` : ''}
  if (canStop(options)) {
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name]
      history[name] = function (...args) {
        const answer = original.apply(this, args)
        refresh()
        return answer
      }
    }
    for (const name of ['popstate', 'hashchange', 'pageshow']) globalThis.addEventListener(name, refresh)
  }
  refresh()
}
`

let scripts: { collect: string; fingerprint: string } | undefined

/** Only the public page patterns go in the script served to a site. */
export function browserScripts(rules: PageRules = {}, format: 'module' | 'classic' = 'module'): { collect: string; fingerprint: string } {
  scripts ??= { collect: browserModule('collect'), fingerprint: browserModule('fingerprint-browser') }
  // Tag Manager injects a classic script. Keep its functions private as they are in the module.
  const classic = format === 'classic'
  const start = run(rules, classic)
  const collect = classic ? `(() => {\n'use strict'\n${scripts.collect.replace(/^export /gm, '')}${start}\n})()` : scripts.collect + start
  return { collect, fingerprint: scripts.fingerprint }
}

/** Headers for a script any site may load. */
export const scriptHeaders = {
  'content-type': 'text/javascript; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff',
}
