/**
 * Tells people when something needs them, by posting to a webhook. The body
 * is `{ "text": "…" }`, which Slack, Mattermost and Discord's Slack-style
 * address all take.
 */
export interface AlertOptions {
  /** The webhook to post to. */
  url: string
  /** The least time between two alerts about the same thing, in milliseconds. Defaults to ten minutes. */
  every?: number
  fetch?: typeof fetch
  now?: () => number
  /** Hears about an alert that could not be delivered. Defaults to `console.error`. */
  onError?: (error: unknown) => void
}

/** Sends `text` unless something with the same `about` was sent in the last `every` milliseconds. Resolves to whether it was sent. */
export type Alerter = (about: string, text: string) => Promise<boolean>

/**
 * Returns a function that posts an alert. It never throws: an alert that
 * cannot be delivered is reported to `onError` and dropped, so a broken
 * webhook cannot break what it was reporting on.
 */
export function createAlerter(options: AlertOptions): Alerter {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const every = options.every ?? 10 * 60_000
  const last = new Map<string, number>()
  return async (about, text) => {
    const at = now()
    if (at - (last.get(about) ?? -Infinity) < every) return false
    if (last.size >= 1000) last.clear()
    last.set(about, at)
    try {
      const response = await fetcher(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 3000) }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`The alert webhook answered ${response.status}`)
      return true
    } catch (error) {
      ;(options.onError ?? console.error)(error)
      return false
    }
  }
}
