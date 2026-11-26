import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** The hash that lets the browser run this one inline block and nothing else. */
const allow = (body: string) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`

/** The scripts of the reviewer screen, in the order the page runs them: what every view uses, each view in menu order, then the start. */
const SCRIPTS = ['core', 'detail', 'graph', 'accounts', 'journey', 'board', 'decide', 'calls', 'channels', 'health', 'help', 'palette', 'start']

// A browser hashes the text with every line ending as a plain newline, so serve and hash it that way.
const read = (file: string) => readFileSync(new URL(`./review/${file}`, import.meta.url), 'utf8').replace(/\r\n?/g, '\n')

let page: { html: string; headers: Record<string, string> } | undefined

/**
 * The reviewer screen, which is one page with no outside assets. It holds no data and
 * no secret; the reviewer types the access token, and the page calls the
 * server's own routes with it. The policy lets the page run only the script
 * and style it shipped with, and talk only to the server it came from. Its one
 * image is its own icon, and no text is ever turned into markup.
 *
 * The files are read on first use, so a server that never serves the screen
 * does not need them.
 */
export function reviewPage(): { html: string; headers: Record<string, string> } {
  if (page) return page
  const style = read('style.css')
  const script = SCRIPTS.map((name) => read(`${name}.js`)).join('\n')
  // Replaced by functions, so a dollar sign in the files means itself.
  const html = read('page.html').replace('/* style.css */', () => style).replace('/* scripts */', () => script)
  return (page = {
    html,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src ${allow(script)}; style-src ${allow(style)}; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
    },
  })
}
