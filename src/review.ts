import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./review.html', import.meta.url), 'utf8')

/** The hash that lets the browser run this one inline block and nothing else. */
function allow(tag: 'script' | 'style'): string {
  const body = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html)?.[1]
  if (body === undefined) throw new Error(`review.html has no <${tag}> block`)
  return `'sha256-${createHash('sha256').update(body).digest('base64')}'`
}

/**
 * The reviewer screen: one page with no outside assets. It holds no data and
 * no secret; the reviewer types the access token, and the page calls the
 * server's own routes with it. The policy below lets the page run only the
 * script and style it shipped with, and talk only to the server it came from.
 */
export const reviewPage = {
  html,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src ${allow('script')}; style-src ${allow('style')}; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  },
}
