/**
 * Gets Microsoft Advertising access tokens from a refresh token, for the
 * `microsoftAds` target. An access token lasts about an hour; the refresh
 * token is what you keep.
 * https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-get-tokens
 */

export interface MicrosoftTokenOptions {
  /** The Application (client) ID of your app registration. */
  clientId: string
  /** The refresh token from the consent step. Microsoft may answer with a newer one, which is used from then on. */
  refreshToken: string
  /** Only for a web app registration. A public client has none. */
  clientSecret?: string
  fetch?: typeof fetch
  now?: () => number
}

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const SCOPE = 'https://ads.microsoft.com/msads.manage offline_access'

/** Returns a function that resolves to a valid access token, asking Microsoft only when the last is within a minute of expiring. */
export function createMicrosoftTokens(options: MicrosoftTokenOptions): () => Promise<string> {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  let refreshToken = options.refreshToken
  let token: { value: string; until: number } | undefined
  let pending: Promise<string> | undefined

  async function request(): Promise<string> {
    const response = await fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: options.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: SCOPE,
        ...(options.clientSecret && { client_secret: options.clientSecret }),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
    if (!response.ok || !body.access_token) {
      throw new Error(`Microsoft rejected the token request with ${response.status} ${body.error ?? ''}: ${(body.error_description ?? '').split('\n')[0]}`)
    }
    if (body.refresh_token) refreshToken = body.refresh_token
    token = { value: body.access_token, until: now() + (body.expires_in ?? 3600) * 1000 - 60_000 }
    return token.value
  }

  return () => {
    if (token && token.until > now()) return Promise.resolve(token.value)
    pending ??= request().finally(() => (pending = undefined))
    return pending
  }
}
