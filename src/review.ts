import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** The hash that lets the browser run this one inline block and nothing else. */
function allow(html: string, tag: 'script' | 'style'): string {
  const body = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html)?.[1]
  if (body === undefined) throw new Error(`review.html has no <${tag}> block`)
  return `'sha256-${createHash('sha256').update(body).digest('base64')}'`
}

let page: { html: string; headers: Record<string, string> } | undefined

/**
 * The reviewer screen: one page with no outside assets. It holds no data and
 * no secret; the reviewer types the access token, and the page calls the
 * server's own routes with it. The policy lets the page run only the script
 * and style it shipped with, and talk only to the server it came from.
 *
 * The file is read on first use, so a server that never serves the screen
 * does not need it.
 */
export function reviewPage(): { html: string; headers: Record<string, string> } {
  if (page) return page
  // A browser hashes the text with every line ending as a plain newline, so serve and hash it that way.
  const html = readFileSync(new URL('./review.html', import.meta.url), 'utf8').replace(/\r\n?/g, '\n')
  return (page = {
    html,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src ${allow(html, 'script')}; style-src ${allow(html, 'style')}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
}
