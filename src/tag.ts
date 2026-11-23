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
  if (!strip) throw new Error('Serving the collector from a checkout needs Node 22.13 or later; run `npm run build` instead')
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
 * Set `window.accountGraphConsent = { adUserData, adPersonalization }` before
 * the tag to pass a consent banner's answer. Once loaded, the page can call
 * `accountGraph.event('inquiry')`, and taps on phone links and on elements
 * marked `data-ag-event` are reported without any code.
 */
const RUN = `
{
  const self = new URL(import.meta.url)
  const options = { endpoint: new URL('collect', self).href }
  const helper = () => import(new URL('fingerprint.js', self).href)
  const key = self.searchParams.get('fingerprint')
  const region = self.searchParams.get('region')
  const endpoints = self.searchParams.get('endpoints')
  if (key) options.fingerprintEvent = helper().then((m) => m.fingerprintEvent({ apiKey: key, ...(region && { region }), ...(endpoints && { endpoints }) })).catch(() => undefined)
  if (self.searchParams.get('canvas') === 'open') options.canvas = helper().then((m) => m.openFingerprint()).catch(() => undefined)
  const params = self.searchParams.get('params')
  if (params) options.params = params.split(',').filter(Boolean)
  if (globalThis.accountGraphConsent) options.consent = globalThis.accountGraphConsent
  collect(options).catch(() => undefined)
  globalThis.accountGraph = { event: (name, detail) => event(options, name, detail).catch(() => undefined) }
  watch(options)
  globalThis.accountGraph.fields = fields
  fill({ all: self.searchParams.get('forms') === 'all' })
    const domains = self.searchParams.get('domains')
  if (domains) carry({ ...options, domains: domains.split(',').filter(Boolean) })
}
`

let scripts: { collect: string; fingerprint: string } | undefined

/** The two scripts the server hands to browsers: the collector, run on load, and the fingerprint helpers it loads on request. */
export function browserScripts(): { collect: string; fingerprint: string } {
  return (scripts ??= { collect: browserModule('collect') + RUN, fingerprint: browserModule('integrations/fingerprint-browser') })
}

/** Headers for a script any site may load. */
export const scriptHeaders = {
  'content-type': 'text/javascript; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff',
}
