/**
 * Gets Google access tokens for a service account, for sending conversions
 * with `ingest`. The service account must be a user on the Google Ads account.
 * https://developers.google.com/identity/protocols/oauth2/service-account
 */
import { createSign } from 'node:crypto'

/** The two fields this needs from a service-account key file. */
export interface ServiceAccount {
  client_email: string
  private_key: string
}

export interface TokenOptions {
  /** Defaults to the Data Manager scope. */
  scope?: string
  fetch?: typeof fetch
  now?: () => number
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * Returns a function that resolves to a valid access token. It asks Google
 * for a new one only when the last is within a minute of expiring.
 */
export function createGoogleTokens(account: ServiceAccount, options: TokenOptions = {}): () => Promise<string> {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const scope = options.scope ?? 'https://www.googleapis.com/auth/datamanager'
  let token: { value: string; until: number } | undefined
  let pending: Promise<string> | undefined

  async function request(): Promise<string> {
    const issued = Math.floor(now() / 1000)
    const unsigned =
      encode({ alg: 'RS256', typ: 'JWT' }) +
      '.' +
      encode({ iss: account.client_email, scope, aud: TOKEN_URL, iat: issued, exp: issued + 3600 })
    const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url')}`
    const response = await fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    })
    const body = (await response.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
    if (!response.ok || !body.access_token) {
      throw new Error(`Google rejected the token request with ${response.status} ${body.error ?? ''}: ${body.error_description ?? ''}`)
    }
    token = { value: body.access_token, until: now() + (body.expires_in ?? 3600) * 1000 - 60_000 }
    return token.value
  }

  return () => {
    if (token && token.until > now()) return Promise.resolve(token.value)
    pending ??= request().finally(() => (pending = undefined))
    return pending
  }
}
