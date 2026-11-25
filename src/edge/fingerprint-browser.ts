/**
 * Runs in the browser. Gets a fingerprint to hand to `collect`.
 */

export interface FingerprintAgentOptions {
  /** The workspace's public API key. */
  apiKey: string
  /** The workspace's region, when it is not the US. */
  region?: 'eu' | 'ap'
  /** Your own subdomain that proxies to Fingerprint, so blockers do not drop the request. */
  endpoints?: string
}

/**
 * Identifies the visitor with Fingerprint and returns the event id. Send the
 * event id to the server, which confirms it and reads the visitor id there.
 * Resolves to undefined when the agent is blocked or fails.
 */
export async function fingerprintEvent(options: FingerprintAgentOptions): Promise<string | undefined> {
  try {
    const url = `https://fpjscdn.net/v4/${encodeURIComponent(options.apiKey)}`
    const agent = await (await import(/* @vite-ignore */ url)).start({
      ...(options.region && { region: options.region }),
      ...(options.endpoints && { endpoints: options.endpoints }),
    })
    const result = await agent.get()
    return typeof result?.event_id === 'string' ? result.event_id : undefined
  } catch {
    return undefined
  }
}

/**
 * Computes the open-source FingerprintJS visitor id. Nothing confirms it, and
 * devices of one model often share it, so pass it to `collect` as `canvas`.
 */
export async function openFingerprint(): Promise<string | undefined> {
  try {
    const url = 'https://openfpcdn.io/fingerprintjs/v5'
    const agent = await (await import(/* @vite-ignore */ url)).load()
    const result = await agent.get()
    return typeof result?.visitorId === 'string' ? result.visitorId : undefined
  } catch {
    return undefined
  }
}
